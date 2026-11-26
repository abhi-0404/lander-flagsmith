import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// 5-minute refresh guard per experiment. Flagsmith answers 429 inside the window, so Lander also remembers
// when it last refreshed (persisted in .lander/state.json) and never fires a refresh it knows will be refused.
export const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** Pure helper: may we refresh again? lastRefreshMs is epoch ms or undefined. */
export function canRefresh(lastRefreshMs: number | undefined, nowMs: number): boolean {
  return lastRefreshMs === undefined || nowMs - lastRefreshMs >= REFRESH_MIN_INTERVAL_MS;
}

/**
 * Parse a 429 body or CLI error text: "Expected available in 289 seconds." Returns seconds, or null when the
 * text is not a refresh throttle response. Real body: {"detail":"A refresh was requested recently. ..."}.
 */
export function parseThrottleSeconds(text: string): number | null {
  if (!/refresh was requested recently|\b429\b|too many requests/i.test(text)) return null;
  const m = /available in (\d+) seconds?/i.exec(text);
  return m ? Number(m[1]) : Math.ceil(REFRESH_MIN_INTERVAL_MS / 1000);
}

type State = Record<string, number>;

/** Per key (for example "<env>:<experimentId>:results") last-refresh timestamps, optionally file backed. */
export class RefreshThrottle {
  private state: State = {};

  /** Pass a file path to persist across runs, or omit for in-memory (tests, fixture replay). */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { refreshes?: State };
        this.state = raw.refreshes ?? {};
      } catch {
        this.state = {};
      }
    }
  }

  canRefresh(key: string, nowMs: number): boolean {
    return canRefresh(this.state[key], nowMs);
  }

  /** Seconds until the next refresh is allowed (0 when allowed now). */
  secondsUntilAllowed(key: string, nowMs: number): number {
    const last = this.state[key];
    if (last === undefined) return 0;
    return Math.max(0, Math.ceil((last + REFRESH_MIN_INTERVAL_MS - nowMs) / 1000));
  }

  recordRefresh(key: string, nowMs: number): void {
    this.state[key] = nowMs;
    this.save();
  }

  /** The server said 429 with "available in N seconds": pretend the last refresh was just early enough. */
  recordRetryAfter(key: string, nowMs: number, retryAfterSeconds: number): void {
    this.state[key] = nowMs + retryAfterSeconds * 1000 - REFRESH_MIN_INTERVAL_MS;
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(this.file)) existing = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
    writeFileSync(this.file, JSON.stringify({ ...existing, refreshes: this.state }, null, 2));
  }
}
