// NEVER imported by agent/. Draft PRs through the owner's own `gh` login. No token is read or stored here.
import type { Runner } from "./runner.js";

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

export interface PrRequest {
  repo: string;
  base: string;
  head: string;
  title: string;
  /** Absolute path of the markdown body (written by Lander before this call). */
  bodyFile: string;
}

const URL_RE = /https:\/\/[^\s]+\/pull\/\d+/;

/** `gh pr create --draft ...`. The PR URL is read from stdout. */
export async function createDraftPr(run: Runner, req: PrRequest): Promise<string> {
  const r = await run("gh", ["pr", "create", "--draft", "--base", req.base, "--head", req.head, "--title", req.title, "--body-file", req.bodyFile], { cwd: req.repo });
  if (r.code !== 0) throw new GithubError(`gh pr create failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  const url = URL_RE.exec(r.stdout)?.[0] ?? URL_RE.exec(r.stderr)?.[0];
  if (!url) throw new GithubError(`gh pr create succeeded but printed no pull request URL: ${r.stdout.trim().slice(0, 200)}`);
  return url;
}

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";

/** `gh pr view <url> --json state`. UNKNOWN when gh is missing or fails (retire reports it, never guesses). */
export async function prState(run: Runner, repo: string, url: string): Promise<PrState> {
  // Anchored: a journaled value that is not just a PR URL (say one starting with "-") never reaches gh.
  if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(url)) return "UNKNOWN";
  const r = await run("gh", ["pr", "view", url, "--json", "state"], { cwd: repo });
  if (r.code !== 0) return "UNKNOWN";
  try {
    const s = (JSON.parse(r.stdout) as { state?: unknown }).state;
    return s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
