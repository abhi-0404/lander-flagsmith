# HANDOFF: lander-flagsmith

Last updated: 2026-11-26 (Phase 3: code edits, PR before complete, retire dry run). Plan of record: `../../AI Agents and Feature Flags/02-verification-and-plan.md`.

## What exists

- Scaffold per plan B2: `package.json` (ESM, bin `lander`, pnpm 12.6.0), `tsconfig.json` (strict, NodeNext, ES2023, typecheck all),
  `tsconfig.build.json` (emits `src` to `dist`), `vitest.config.ts`, `pnpm-workspace.yaml` (root + `tools/simulator`), `.env.example` (exactly B5),
  `.gitignore` (`.env`, `.lander/`, `dist/`, `node_modules/`), MIT `LICENSE`.
- `src/cli.ts`: commander CLI. `scan` is real (Phase 1). `land` (renamed from `plan`, per B2), `apply`, `rollback`, `retire` are stubs.
- Real code (small, tested): `src/config.ts` (zod env validation), `src/flagsmith/cli.ts` (execFile wrapper for `flagsmith`, flag key
  validation, argv builder), `src/flagsmith/readTools.ts` (MCP read allowlist), `src/flagsmith/refreshThrottle.ts` (5 minute guard, pure),
  `src/plan/hash.ts` (canonical JSON + SHA-256), `src/output/colors.ts`.
- Stubs with a one-line comment saying what they will do and in which phase: everything else under `src/` (mcp, adapter, verdict, agent,
  repo, plan builder/render/approve, executor, table).
- `tools/seed/seed.ts` (works with `--dry-run` today, real run needs keys), `tools/seed/reset.ts` (stub), `tools/demoFlags.ts`
  (shared flag definitions), `tools/simulator/simulate.ts` + `plan.ts` (deterministic traffic plan, tested).
- `docs/cli-facts.md`: the real Flagsmith CLI v2 syntax (answers A2 #23: `flagsmith api <path> -X <METHOD> --input -`).
- Tests: `src/config.test.ts`, `test/safety.test.ts`, `test/plan.test.ts`, `test/simulator-plan.test.ts`.

## Dependencies (pinned on disk where the brief named a version)

Runtime: `zod 4.6.7`, `@modelcontextprotocol/sdk 1.32.1`, `@anthropic-ai/sdk ^1.13.0`, `commander ^15.1.0`.
Dev: `vitest 4.1.12`, `typescript ^7.0.2`, `tsx ^4.23.15`, `@types/node ^22.20.5`.
`tools/simulator`: `@flagsmith/nodejs 9.5.0` (floor 9.1.0).
`pnpm-workspace.yaml` has `allowBuilds: esbuild: true` so pnpm 12 stops failing on esbuild's install script (it validates the binary only).

## Anthropic SDK findings

`@anthropic-ai/sdk` 1.13.0 has `client.beta.messages.toolRunner(...)` (see `lib/tools/BetaToolRunner.d.ts`), `max_iterations` in the runner
settings, `fallbacks` on the request, and `@anthropic-ai/sdk/helpers/beta/zod` with `betaZodTool` and `betaZodOutputFormat`.
The zod helper imports `zod/v4` and the SDK peer range is `zod ^3.25.0 || ^4.0.0`, so it works with zod 4.6.7. No major swap needed.

## How to run

```
pnpm install
pnpm lander --help                  # tsx src/cli.ts
pnpm test                           # vitest
pnpm typecheck                      # tsc --noEmit over src, test, tools
pnpm build                          # emits dist/ (bin target dist/cli.js)
pnpm seed --env staging --dry-run   # prints every flagsmith command, needs no keys
pnpm simulate --env staging --dry-run   # prints the deterministic traffic plan, needs no keys
```

## What needs keys or the Phase 0 spike

1. Copy `.env.example` to `.env`. Fill `FLAGSMITH_API_KEY`, `FLAGSMITH_PROJECT_ID`, `LANDER_ENV_STAGING`, `LANDER_ENV_PRODUCTION`,
   `FLAGSMITH_SERVER_KEY_STAGING`, `FLAGSMITH_SERVER_KEY_PRODUCTION`, `ANTHROPIC_API_KEY`.
2. Confirm how the CLI authenticates: `flagsmith login`, or whether `FLAGSMITH_API_KEY` is honoured (see `docs/cli-facts.md`).
3. `pnpm seed --env staging` (warehouse, metric, 3 MV flags with keyed variants, kill switch, 3 started experiments), then
   `pnpm simulate --env staging`. Run today so warehouse latency is behind us, top up daily.
4. Seed payloads marked UNVERIFIED (warehouse body for Cloud, `feature get --json` field names, experiment `feature_state_value` shape) are the first
   things to correct from the spike. The script prints the raw response when a field is missing.
5. Simulator risks (A2 #21): exposure recording is assumed to happen in `getExperimentFlag`; events are back-dated by overriding `Date.now()` during
   the run, which assumes the SDK stamps events with `Date.now()` (true in 9.5.0 `events.js`). Server-side evaluation of the `variant` field on local
   evaluation is assumed; if it is undefined the script falls back to comparing the flag value with the variant key (they are equal by design).
6. Save every JSON response from the lifecycle spike into `fixtures/`, then build Phase 1 against them.

## Phase 1 (2026-11-26): read side and verdicts

Built with no Flagsmith Cloud keys, against real responses from a self-hosted Flagsmith 2.295.2 (same API).

- `fixtures/real/`: captured unchanged from a self-hosted Flagsmith 2.295.2 (experiment list, detail, results, null results, exposures, refresh
  202 null and the 429 body, features list, MV options). One experiment, three arms (control, variant_a, variant_b).
- `fixtures/demo/`: SYNTHETIC, 5 experiments plus 2 flags with no experiment, shaped exactly like the real payloads. Scenarios: clear winner
  (checkout_cta), 85 percent (pricing_banner), 61/39 SRM (signup_steps), collecting (onboarding_tips), wins primary but guardrail harm
  (search_ranking). Regenerate by editing the JSON; the generator was a throwaway script.
- `src/flagsmith/schemas.ts`: zod (loose objects) for experiment list/detail, results, exposures, features. `parseWith` gives readable errors.
- `src/flagsmith/adapter.ts`: `FlagsmithAdapter` over one `ApiCall` (`flagsmith api <path> -X <METHOD> --json --no-input` via `cliTransport`).
  `collect()` = detail + refresh results and exposures (throttled) + settle + read. 429 never throws: it becomes a `throttled` outcome and the
  retry-after is remembered. Handles the 429 as CLI error text or as a body with exit 0 (CLI behaviour on non-2xx is still UNVERIFIED).
- `src/flagsmith/refreshThrottle.ts`: `RefreshThrottle` class, optionally persisted in `.lander/state.json`.
- `src/flagsmith/fixtureTransport.ts`: read-only `ApiCall` over a fixture folder (per-id files, generic fallback).
- `src/verdict/srm.ts` (chi-square, own incomplete gamma, no deps) and `src/verdict/engine.ts`; rules in `docs/verdict-rules.md`.
- `src/scan.ts` + `src/output/table.ts`: `runScan`, `renderScan`. `src/config.ts` gained `resolveEnvironmentKey` (staging/production to the
  `LANDER_ENV_*` key, anything else taken as a raw key).
- Tests: `src/verdict/*.test.ts`, `test/adapter.test.ts`, `test/scan.test.ts`, `test/helpers.ts` (synthetic builder). 88 tests total.

```
pnpm lander scan --fixtures fixtures/demo                 # offline demo, clock frozen at the fixtures' as_of ("replay")
pnpm lander scan --fixtures fixtures/real --json
pnpm lander scan --env staging [--json] [--no-refresh] [--now <iso>] [--project <id>]   # live, needs .env and flagsmith login
```

Phase 1 gaps and notes:
- Not tested against Flagsmith Cloud. Unverified: `chance_to_win` orientation for decrease-direction metrics, results shape with several
  metrics, whether `flagsmith api` exits non-zero with the body on 4xx, `FLAGSMITH_API_KEY` auth for the CLI.
- MCP (`src/flagsmith/mcp.ts`) is still a stub: scan reads through the CLI wrapper only. MCP is only needed for the agent in Phase 2.
- `--replay` from the plan is spelled `--fixtures <dir>`.
- Not-mine rows come from `GET api/v1/projects/<id>/features/` (needs `FLAGSMITH_PROJECT_ID` or `--project`); a failure is a warning only.
- No LLM is involved in `scan`.

## Reviewer pass (2026-11-26)

Verdict engine made fail closed (see the new section in `docs/verdict-rules.md`): metric direction is now read and enforced,
guardrail harm is checked on the interval too, missing primary or guardrail inference never ships, unmapped winners are refused.
Flag keys can no longer start with `-` or `.`. `scan --fixtures` output carries `source: fixtures` in JSON and a FIXTURES REPLAY
banner in text. 101 tests.

## Phase 2 (2026-11-26): land, apply, rollback, journal, brief

```
pnpm lander land checkout_cta --env staging --fixtures fixtures/demo --dry-run   # offline: plan + brief, writes nothing
pnpm lander land checkout_cta --env staging [--dry-run] [--explain] [--ttl 30]   # live (needs .env + flagsmith login)
pnpm lander apply <plan-id>          # resume a saved plan, same gates
pnpm lander rollback <journal-id|plan-id> [--dry-run]
pnpm lander journal verify           # hash chain check of .lander/journal.jsonl
```

Flow of `land`: (1) re-collect evidence and recompute the verdict live, refuse unless SHIP (reasons printed, exit 2); (2) build the plan
(rollout decision, MV option id, flag before-state read with `flagsmith flag get`, one irreversible `POST .../complete/` step, empty `codeEdits`,
deterministic brief) and hash it (canonical JSON SHA-256); (3) save `.lander/plans/<id>/plan.json` (+ `brief.md`), id = first 12 hex of the hash;
(4) typed approval in a real TTY: the first 8 hash chars, plus the environment name for envs in `LANDER_PROTECTED_ENVS`; non-TTY is refused before any
prompt; (5) `applyPlan`: reload plan from disk and recompute the hash, TTL (default 30 min, `--ttl`), key fingerprint, approval proof, step equals the
rollout decision, verdict re-check (decision, kind, winner, option id must equal the plan), flag drift check, then journal `approval` and `apply_started`
(before-state) BEFORE the write, then `complete`, read back, journal `apply_done` with before and after.
`rollback` finds `apply_started` for the id, refuses on a broken chain, other key, or a flag edited since the apply, asks for typed approval, restores
value, enabled and weights with `flag update`, journals `rollback_*`. The experiment stays completed.

Code map: `src/plan/{types,builder,brief,store,approve,render,hash}.ts`, `src/flagsmith/{flagState,landPort}.ts` (`LandPort` = the seam the fake adapter in
`test/fakePort.ts` implements), `src/executor/{apply,rollback,journal}.ts`, `src/agent/explain.ts`, `src/land.ts` (orchestration), `src/repo/edits.ts` (seam in Phase 2, real codemod in Phase 3:
`CodeEditProvider`, `noCodeEdits`). `ApiCall` now takes an optional body. Tests: `test/land.test.ts` (42 cases), 143 total.

Decisions and deviations:
- `--dry-run` writes nothing at all (no plan file, no journal). `--fixtures` without `--dry-run` is an error; a fixtures plan can never be saved or applied.
- `land` accepts only named envs (staging, production), never a raw key, so keys never reach plans or journals (plans store a key fingerprint).
- `--explain` rewrites the brief with `@anthropic-ai/sdk` (`LANDER_EXPLAIN_MODEL`, no tools, output is commentary only and is not in the hash); skipped with a note when
  `ANTHROPIC_API_KEY` is empty or the call fails. The agent loop (client, tools, prompts) is still a stub; it is not needed for land.
- No `--override` (S7) yet. S6 ordering (PR before `complete`) arrived with Phase 3 (see below).
- Approval for rollback types the prefix of the journal entry hash.

UNVERIFIED against live Flagsmith (same list as Phase 1, plus): the `flag get --json` shape (the normalizer in `flagState.ts` accepts likely spellings and the journal keeps the raw
response), what `complete` leaves behind on the flag, `flag update --value=... --weight=id=pct` argument forms, and whether v2 feature versioning environments reject rollback
(no detection yet: keep demo envs non-versioned). Never run against production without the Phase 0 spike on staging.

## What is left

The agent loop and MCP client (only if the brief should use tools),
`--override` with a reason (S7), v2 versioning detection, a staging end-to-end run of land/apply/rollback, README, architecture and demo script docs, `seed --reset`.

## Phase 3 (2026-11-26): code edits, PR before complete, retire

```
pnpm lander land checkout_cta --env staging --fixtures fixtures/demo --dry-run   # now also prints the code diff (reads ../lander-demo-shop, writes nothing)
pnpm lander land checkout_cta --env staging [--no-code]                          # live: plan with diff, typed approval, then PR first, complete last
pnpm lander apply <plan-id>                                                      # same code stage when the saved plan has edits
pnpm lander retire checkout_cta --env staging                                    # gate checks only, archives nothing (cut list item 6)
```

- `src/repo/edits.ts`: deterministic codemod (no model). Pattern: `const v = useVariant(FLAG_KEYS.x); if (v === "<key>") { ...return } return ...`. Keeps the winning
  branch (a control winner keeps the fall-through), deletes losing branches and the flag read, then removes imports it made unused, the flag key constant, tests of the
  deleted branches (and the "flag missing" fallback test when a variant wins), and a component only the deleted branch imported. Anything else (else branch, branch that
  does not return, unknown key, unknown flag usage such as `useFlags([...])`) throws `CodemodError`: fail closed, use `--no-code` to land only the flag.
  Edits are exact-match (`oldString` unique) with `baseSha256` and `resultSha256` per file, inside the plan hash (`LandPlan.codeEdits`, plus `LandPlan.code`:
  base branch, losing keys, flag key props). `verifyEdits` re-checks everything at apply time (file hash, uniqueness, result hash, path jail). LF normalised, CRLF kept on write.
  `CodeEditProvider` is still the seam if a model is ever allowed to propose edits.
- `src/repo/diff.ts` (LCS line diff, about 100 lines, no dependency), `fsGuard.ts` (path jail, deny list, secret redaction), `search.ts` (file walk, residue check).
- `src/executor/{runner,git,github,codeChange}.ts`: B6 flow with an injectable `Runner` (execFile only; pnpm goes through cmd.exe on Windows with fixed, checked args).
  Order: refuse non-root repo, dirty tree, wrong branch, base behind origin, existing branch; verify edits; `git switch -c lander/land-<flag>-<planid>`; write edits;
  residue check; `pnpm test`; refuse stray changed files; commit (plain message, no trailers, no author change); no `origin` stops here; `git push -u origin`;
  `gh pr create --draft --base --head --title --body-file .lander/plans/<id>/pr.md`; PR URL from stdout.
- S6 in `applyPlan`: after the typed approval is journaled and all drift checks pass, the code stage runs BEFORE `apply_started` and `complete`. Journal: `code_started`,
  then `code_done` (PR URL, branch, commit, losing keys) or `code_failed` or `code_stopped` (no remote). A failed or stopped code stage throws and Flagsmith is untouched.
  A failed stage leaves the branch; re-running the same plan is refused until it is deleted (message says how). `land` exit code 3 for code stage stops, 2 for verdict refusals.
- `src/executor/retire.ts`: gate checks (experiment completed, flag still in the landed state, PR merged via `gh pr view`, zero references in the repo) with PASS/FAIL/UNKNOWN,
  exit 2 when not ready. Other environments are INFO only (cannot be read). It does not archive: `flagsmith feature update <flag> --archive` is documented but not wired.
- Tests: `test/codemod.test.ts`, `test/codeflow.test.ts` (throwaway git repos under the OS temp dir, copied from `lander-demo-shop/src`; `git push`, `fetch`, `gh`, `pnpm test` are
  stubbed by an injected runner; a guard refuses any git call outside the temp dir). They skip when the sibling demo shop folder is missing. 190 tests total.
- Verified by hand (not in the suite): all 6 codemod scenarios (3 flags x variant/control winner) applied to a temp copy of the shop with its real `pnpm test` and `tsc --noEmit` green.

Decisions and deviations:
- No runtime freeze guard: the plan only has a calendar feature freeze (Nov 28 18:00), so nothing was built.
- No `--override` (S7) and no model-proposed edits (cut list item 8: deterministic codemod is the primary path).
- The PR body quotes the journal `approval` entry id (the PR URL is journaled next to it afterwards).
- Plan TTL is checked before the code stage only; tests can take minutes, and once the PR exists `complete` is not blocked by expiry.
- "Up to date base": the code stage runs `git fetch` and refuses when behind `origin/<base>`; a failing fetch is ignored.
- UNVERIFIED: `gh pr create` output format on this gh version (the URL is matched by regex), `gh pr view --json state`, real push to a remote. Nothing here has been run against GitHub.
- The real `lander-demo-shop` and `lander-flagsmith` folders are not git repos and nothing in this phase ran git or gh in them.

## Rules in force

pnpm only. No commits, pushes or repo creation unless the owner asks. No AI attribution anywhere, including Lander's own future commit messages and PR bodies.
No em or en dashes.

## Last verified output

2026-11-26 (Phase 3 reviewer): `pnpm typecheck`, `pnpm test` (193 passed) and `pnpm build` green; `lander-demo-shop` `pnpm test` 9 passed.

## Phase 2 reviewer pass (2026-11-26)

Fixed (tests in `test/land.test.ts`, "reviewer hardening"): one apply per plan (journal `apply_started` for the plan id refuses a replay);
`applyPlan` checks the typed hash prefix and refuses on a broken journal chain before writing; read-back failure after the write is journaled
(`apply_failed`, stage `readback`, written true); the environment key is masked in CLI error text and in journaled errors; `CI`/`GITHUB_ACTIONS`
and similar refuse approval even with a TTY; `--explain` output has terminal escapes stripped; `lander apply` refuses a plan made before its
environment became protected. 152 tests.

Still open: rollback of an orphan `apply_started` (no `apply_done`) has no drift check and the current state is shown only after approval;
`--ttl` has no upper cap; the plan hash is integrity, not a MAC (anyone who can write `.lander/` can forge a plan, which is why the plan is
re-rendered and the verdict and flag state are re-checked live before the write).

## Phase 3 reviewer pass (2026-11-26)

Fixed (tests in `test/codemod.test.ts` and `test/codeflow.test.ts`):
- Codemod: a branch "returns" only when its LAST top-level statement is a `return` (was: any line starting with `return`, so a branch with
  only a nested return could fall through and lose the control tail). `;` inside JSX text (`&apos;`) is not a statement end.
- `applyPlan` re-reads the flag after the code stage (tests can take minutes) and, on drift, journals `code_stopped` (with the PR URL) and
  throws `DriftDetected` before `complete`, so rollback never restores a stale before-state.
- Base branch name validated before any git call; `retire` only passes an anchored PR URL to `gh pr view`; test guard `assertTemp` now needs
  a path separator after the temp dir (a sibling like `Temp2` no longer passes). Test that `retire` is read only. 193 tests.

Still open: brace matching does not understand regex literals (a `/\{/` in a component can mis-parse; tests and the human diff are the net);
CLI `apply` takes the repo path from the current `.env`, not the plan (file hashes still bind the edits).

## Live end-to-end run against the local Track 3 stack (2026-11-26)

Self-hosted Flagsmith 2.295.2 from `../flagscope/stack`, keys in `.env.local-stack` (git-ignored), run with
`LANDER_ENV_FILE=.env.local-stack` (absolute path for `pnpm simulate`, which runs in `tools/simulator`).

- `pnpm simulate --env staging --seed 4242 --scale 3`: 8131 exposures. `scan`: checkout_cta SHIP (100%, +46.3%), pricing_banner SHIP
  (98.8%), signup_steps DO NOT TRUST (99.0% chance to win, refused for SRM 63.2/36.8, p = 7.3e-39). `land signup_steps --dry-run` exits 2.
- `land checkout_cta --no-code` saved plan c01eecffcb7a; `apply` (typed approval in a real terminal) completed experiment 11 and Flagsmith
  rolled out get-everyones-times (weight 13 = 100, experiment segment override removed). `rollback` restored weight 13 = 0, value copy-invite.
  `journal verify`: 8 entries, chain intact; the environment key appears nowhere in the journal.
- Four bugs found live and fixed, each with a regression test:
  1. results `inference: { "<arm>": null }` crashed `scan` (now `{}`, arm stays a variant). Commit 163a97e.
  2. `flag get` / `flag update` failed with "no project": FLAGSMITH_PROJECT_ID is now passed as FLAGSMITH_PROJECT. Commit 25bd014.
  3. Completed experiment detail has `experiment_rollout: null`: the post-apply read-back failed after the write (journaled as
     `apply_failed`, stage readback, written true). Schema now nullable.
  4. `flag update` needs `--yes` without a terminal (added after Lander's own typed approval), and the CLI echoed the environment key in
     its prompt text: CLI error output is now masked (`maskOutput`).
- Note: the hash prefix for `rollback` is the apply journal id (9a6c980b here), not the plan id. Worth a clearer prompt in the demo.
- Experiment 11 on the local stack is now completed; `pnpm seed --reset --env staging` then `pnpm seed --env staging` recreates it.
