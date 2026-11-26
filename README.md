# Lander

**Other agents start experiments. Lander finishes the ones you already have, and refuses the ones you should not trust.**

Running an A/B test in Flagsmith is easy. Finishing one is where teams stall: someone has to read the numbers, decide
whether they can be trusted, end the experiment, roll out the winner, delete the losing branch from the code, and
retire the flag. Usually nobody does, and the experiment flag lives on for months.

Lander is a command-line agent for that last mile. It scans every experiment in a Flagsmith environment, gives each
one a verdict, and for a real winner it builds a landing plan, waits for a human to approve it, opens a pull request
that removes the losing code, and only then completes the experiment in Flagsmith. Every write is journaled and the
flag change can be rolled back with one command.

Built for the Flagsmith "Toggle Wars" hackathon, Track 2 (AI Agents and Feature Flags).

## What a run looks like

```
$ lander scan --env staging

ID  EXPERIMENT            FLAG             STATUS   EXPOSURES (arms)  BEST ARM, CHANCE TO BEAT CONTROL  VERDICT
--  --------------------  ---------------  -------  ----------------  --------------------------------  ------------------------
1   checkout_cta_test     checkout_cta     running  750 / 750         get-everyones-times 99.2%         SHIP get-everyones-times
2   pricing_banner_test   pricing_banner   running  300 / 300         savings-banner 84.9%              KEEP RUNNING
3   signup_steps_test     signup_steps     running  610 / 390         one-step 94.3%                    DO NOT TRUST
4   onboarding_tips_test  onboarding_tips  running  32 / 30           inline-tips 68.8%                 COLLECTING
5   search_ranking_test   search_ranking   running  800 / 800         semantic 99.3%                    GUARDRAIL HARM

Why
  DO NOT TRUST  signup_steps (experiment 3, primary metric checkout_completed)
    - sample ratio mismatch: observed control 61.0% / one-step 39.0%, expected 50.0% / 50.0% (chi-square p = 3.5e-12);
      likely a tracking or assignment bug
  GUARDRAIL HARM  search_ranking (experiment 5, primary metric checkout_completed)
    - semantic wins checkout_completed (99.3% chance to beat control)
    - semantic is likely worse on guardrail refund_requested (0.0% chance to beat control)
  ...

Not mine (no experiment, left alone): maintenance_mode, new_nav
```

`signup_steps` looks like a 94% winner, but its traffic split is 61/39 when it should be 50/50, so its numbers
cannot be trusted. `search_ranking` wins its primary metric while hurting a guardrail. Lander refuses to land either.
(This output is from the offline fixtures; the same command runs against a live Flagsmith.)

## Commands

| Command | What it does | Writes |
|---|---|---|
| `lander scan` | Refreshes and reads every experiment, prints a verdict table with reasons. `--json` for machines. | Nothing (asks Flagsmith to refresh results, at most once per 5 minutes per experiment) |
| `lander land <flag>` | Re-checks the verdict live, builds a hashed plan (experiment step, flag before-state, exact code edits), shows the diff and a decision brief, asks for typed approval, then applies it. `--dry-run` writes nothing. `--no-code` lands only the flag. `--explain` adds a plain-language brief written by Claude. | Branch, commit, draft PR in the app repo, then the experiment `complete` call |
| `lander apply <plan-id>` | Applies a plan saved earlier, with every gate checked again. | Same as `land` |
| `lander rollback <id>` | Restores the flag's value, enabled state and weights from the journal. | One `flag update` |
| `lander journal verify` | Checks the hash chain of the audit journal. | Nothing |
| `lander retire <flag>` | Checks whether a landed flag can be archived: experiment completed, flag unchanged since landing, PR merged, no references left in the repo. | Nothing (gate check only) |

Exit codes: 0 success, 2 refused by the verdict or a safety gate, 3 the code stage stopped before Flagsmith was touched.

## How the verdict is decided

Code decides; the model never does. The rules in [docs/verdict-rules.md](docs/verdict-rules.md) run in a fixed order
and the first match wins:

1. Completed or not-started experiments are skipped.
2. **Collecting:** any arm under 50 exposures or under 5 conversions waits, with an estimate of how long.
3. **Do not trust:** a sample ratio mismatch (chi-square p < 0.001, computed by Lander itself from the exposure counts),
   or Flagsmith's own SRM flag, or more than 1% excluded identities.
4. **Stale:** results older than 60 minutes are refused.
5. **Do not trust:** a metric whose direction (up or down is good) cannot be read.
6. **Guardrail harm:** a primary winner that is likely worse on any guardrail.
7. **Ship:** a variant with at least 95% chance to beat control **and** a 95% interval on the good side of zero, or
   control when every variant is under 5%.
8. Everything else keeps running, with what it still needs.

The engine fails closed: if Flagsmith's chance-to-win and the interval disagree, nothing ships. A winner that does not
map to a multivariate option is refused.

## How a human stays in control

The model has no write tool. Writes come only from code paths that a person has approved:

- **Plan, then approve.** `land` builds a plan and hashes it (SHA-256 over canonical JSON). Approval means typing the
  first 8 characters of that hash in a real terminal; piped input and CI are refused. Protected environments
  (`LANDER_PROTECTED_ENVS`, default `production`) also need the environment name typed.
- **Re-checked before the write.** Just before writing, Lander reloads the plan from disk and recomputes its hash,
  checks the plan has not expired (30 minutes by default), recomputes the verdict live and refuses if anything changed,
  and refuses if someone edited the flag since the plan was made.
- **Irreversible step last.** Flagsmith cannot reopen a completed experiment, so Lander does the reversible work first:
  branch, exact code edits, the app's own tests, push, draft PR. Only when the PR exists does it call `complete`. If
  the code stage fails, Flagsmith is untouched.
- **Journal and rollback.** Each step is appended to `.lander/journal.jsonl` with a hash chain, including the flag's
  state before and after. `lander rollback` restores the flag from that record and refuses if the flag has been
  edited since. Environment keys never appear in plans or the journal.

## The code change

The pull request is made by a deterministic codemod, not a model. For a flag read like this:

```tsx
const variant = useVariant(FLAG_KEYS.checkoutCta);
if (variant === "get-everyones-times") {
  return <button className="cta cta-everyone">Get everyone&apos;s times</button>;
}
return <button className="cta cta-invite">Copy invite link</button>;
```

it keeps the winning branch, deletes the losing branches and the flag read, then removes imports that became unused,
the flag key constant, the tests of the deleted branches, and components only the deleted branch used. Each edit is an
exact string replacement with the file's hash before and after, and all of it is inside the plan hash. Any pattern it
does not recognise stops the run (`--no-code` lands the flag alone). The demo app is
[lander-demo-shop](https://github.com/abhi-0404/lander-demo-shop).

## How Lander uses Flagsmith

| Surface | Used for |
|---|---|
| Flagsmith CLI (`flagsmith flag get`, `flagsmith flag update`) | Reading the flag before and after, and the rollback write |
| Flagsmith Admin API through `flagsmith api` | Experiments, results and exposures, refreshing results, completing the experiment with the winner, listing flags without an experiment |
| Flagsmith Node SDK (`@flagsmith/nodejs`) | The traffic simulator that generates demo exposures and conversions |
| Claude API (`@anthropic-ai/sdk`, optional) | `--explain`: rewrites the decision brief in plain words. It has no tools and its output is not part of the plan hash. |

## Lander compared with other agents

| | Prompt-to-experiment agents | Stale-flag sweepers | Lander |
|---|---|---|---|
| Works on experiments that already exist | No, it creates new ones | Yes, by flag state | Yes, by the experiment result |
| Decides which branch survives | n/a | Guesses from on/off state | From the experiment's winner, with SRM and guardrail checks |
| Refuses untrustworthy results | Rarely | No | Yes, and says why |
| Who writes | Often the model | A CI job | Code, after a typed human approval |
| Undo | Varies | Revert the PR | Journaled rollback of the flag, PR is a normal draft |

## Quick start

Requirements: Node 22+, pnpm, and for live runs the [Flagsmith CLI](https://docs.flagsmith.com) v2, `git` and `gh`.

**Offline, no keys needed:**

```
pnpm install
pnpm lander scan --fixtures fixtures/demo
pnpm lander land checkout_cta --env staging --fixtures fixtures/demo --dry-run
```

Fixture runs are labelled as replays and can never be applied.

**Live:**

1. Copy `.env.example` to `.env` and fill in `FLAGSMITH_API_KEY`, `FLAGSMITH_PROJECT_ID`, `LANDER_ENV_STAGING`,
   `LANDER_ENV_PRODUCTION`, and the server-side keys for the simulator. `ANTHROPIC_API_KEY` is optional.
2. Clone `lander-demo-shop` next to this folder (or set `LANDER_REPO_PATH`).
3. Seed and generate traffic, then run:

```
pnpm seed --env staging                 # flags, metric, experiments (--dry-run prints the commands)
pnpm simulate --env staging             # deterministic traffic through the Node SDK
pnpm lander scan --env staging
pnpm lander land checkout_cta --env staging
pnpm lander rollback <id>
pnpm lander journal verify
```

`pnpm seed --reset --env staging` removes what the seed created so the demo can be run again.

To run against a self-hosted Flagsmith, put its URLs and keys in another env file and set `LANDER_ENV_FILE` to it in
the shell (for example `LANDER_ENV_FILE=.env.local-stack`).

## Tested against

- 201 unit and integration tests (`pnpm test`): the verdict engine, SRM, plan hashing and approval, apply and rollback
  against a fake Flagsmith, the codemod, and the full code stage against throwaway git repos.
- A live end-to-end run against a self-hosted Flagsmith 2.295.2 with 8,131 simulated exposures: `scan` refused the SRM
  experiment, `land` completed the winning experiment and Flagsmith rolled the winner out to 100%, `rollback` restored
  the flag, and `journal verify` passed with the environment key absent from the journal. The four bugs this run
  found are fixed, each with a regression test.

## Limits

- Not yet run against Flagsmith Cloud. Experiments there are in beta; the field names Lander reads are taken from a
  self-hosted Flagsmith with the same API.
- Environments with v2 feature versioning are not detected; rollback assumes a non-versioned environment.
- `retire` checks the gates but does not archive the flag.
- The codemod handles the `if (variant === "...") return` pattern. Anything else stops the run rather than guessing.
- The plan hash proves integrity, not authorship: anyone who can write to `.lander/` can write a plan. That is why
  the verdict and the flag state are checked live again before every write.

## Project layout

```
src/
  scan.ts, land.ts         command orchestration
  verdict/                 verdict engine and SRM test (pure, no I/O)
  flagsmith/               CLI wrapper, API adapter, schemas, refresh throttle, flag state
  plan/                    plan builder, hash, approval, brief, PR body
  executor/                apply, rollback, journal, git and gh steps, retire gates
  repo/                    codemod, diff, path guard, residue search
  agent/explain.ts         optional Claude rewrite of the brief
tools/seed, tools/simulator  demo data and traffic
fixtures/demo, fixtures/real offline replay data
```

## License

MIT
