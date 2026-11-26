import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { canonicalJson } from "../plan/hash.js";

/**
 * Append-only JSONL with a hash chain (S12). Every line carries the previous line's hash, so editing, deleting or reordering a
 * line is detectable with `verify()`. It is tamper evident, not tamper proof: someone who rewrites the whole file and every hash
 * can still do it, which is why the Flagsmith audit log remains the second record.
 */

export type JournalType =
  | "approval"
  | "code_started"
  | "code_done"
  | "code_stopped"
  | "code_failed"
  | "apply_started"
  | "step_done"
  | "apply_done"
  | "apply_failed"
  | "rollback_started"
  | "rollback_done"
  | "rollback_failed";

export interface JournalEntry {
  seq: number;
  ts: string;
  /** First 12 hex chars of `hash`: what `lander rollback <journal-id>` takes. */
  id: string;
  type: JournalType;
  /** Id of the plan this belongs to (12 hex), when there is one. */
  planId: string | null;
  user: string;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
}

export const GENESIS = "0".repeat(64);
export const JOURNAL_ID_LENGTH = 12;

const entryHash = (e: Omit<JournalEntry, "hash" | "id">): string => createHash("sha256").update(canonicalJson(e)).digest("hex");

export type VerifyResult = { ok: true; entries: number } | { ok: false; entries: number; line: number; reason: string };

export class Journal {
  constructor(
    readonly path = ".lander/journal.jsonl",
    private readonly now: () => number = Date.now,
    private readonly user: () => string = () => userInfo().username,
  ) {}

  readAll(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l, i) => {
        try {
          return JSON.parse(l) as JournalEntry;
        } catch {
          throw new Error(`journal ${this.path}: line ${i + 1} is not valid JSON`);
        }
      });
  }

  append(type: JournalType, planId: string | null, data: Record<string, unknown>): JournalEntry {
    const all = this.readAll();
    const last = all[all.length - 1];
    const base = {
      seq: (last?.seq ?? 0) + 1,
      ts: new Date(this.now()).toISOString(),
      type,
      planId,
      user: this.user(),
      data,
      prev: last?.hash ?? GENESIS,
    };
    const hash = entryHash(base);
    const entry: JournalEntry = { ...base, id: hash.slice(0, JOURNAL_ID_LENGTH), hash };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  verify(): VerifyResult {
    let entries: JournalEntry[];
    try {
      entries = this.readAll();
    } catch (err) {
      return { ok: false, entries: 0, line: 0, reason: err instanceof Error ? err.message : String(err) };
    }
    let prev = GENESIS;
    for (const [i, e] of entries.entries()) {
      const { hash, id, ...rest } = e;
      if (e.prev !== prev) return { ok: false, entries: entries.length, line: i + 1, reason: "previous hash does not match (a line was removed, reordered or edited)" };
      if (entryHash(rest) !== hash) return { ok: false, entries: entries.length, line: i + 1, reason: "content does not match its hash (the line was edited)" };
      if (id !== hash.slice(0, JOURNAL_ID_LENGTH)) return { ok: false, entries: entries.length, line: i + 1, reason: "id does not match its hash" };
      if (e.seq !== i + 1) return { ok: false, entries: entries.length, line: i + 1, reason: "sequence number is wrong" };
      prev = hash;
    }
    return { ok: true, entries: entries.length };
  }
}
