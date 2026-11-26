# Lander demo script (2:30 video)

For the person recording the Track 2 video. It runs against the self-hosted Flagsmith stack in `../flagscope/stack`
(the only live Flagsmith Lander has keys for), with the offline fixtures as the fallback take.

## Before recording (about 30 minutes)

1. **Start the stack** in `../flagscope/stack` (see its README) and open the Flagsmith dashboard in a browser tab.
2. **Reset and reseed** (experiment 11 was completed in the last live run, and a completed experiment cannot be reopened):

   ```
   $env:LANDER_ENV_FILE = ".env.local-stack"
   pnpm seed --reset --env staging
   pnpm seed --env staging
   $env:LANDER_ENV_FILE = "$PWD\.env.local-stack"   # absolute: simulate runs inside tools/simulator
   pnpm simulate --env staging --seed 4242 --scale 3
   ```

3. **Check the table.** `pnpm lander scan --env staging` must show `checkout_cta` SHIP and `signup_steps` DO NOT TRUST.
   In the last run `pricing_banner` also shipped (98.8%). That is fine to show, or run the simulator with a smaller
   `--scale` if you want it to read KEEP RUNNING.
4. **Demo shop:** `../lander-demo-shop` must be on `main`, clean, and up to date with `origin`, with no
   `lander/land-checkout_cta-*` branch left locally or on GitHub. `gh auth status` must show the right account.
5. **Rehearse the PR step once** on a throwaway run. The code stage (push and `gh pr create`) has passed its tests
   but has not yet run against real GitHub. If it fails on camera, record with `--no-code` and show the diff from
   `--dry-run` instead.
6. **Terminal:** large font (18 pt or more), dark theme, about 120 columns, clear history. Hide the `.env` files.
7. **Time saved:** time yourself landing one experiment by hand once (read results, end it in the UI, roll out,
   find and delete the losing code, run tests, open a PR). Note the minutes for the recap card. Do not put a
   number on screen you did not measure.

## The take

| Time | Screen | Say |
|---|---|---|
| 0:00-0:08 | Flagsmith dashboard, Experiments page, several running experiments | "Running an A/B test in Flagsmith is easy. Finishing one is where teams stall." |
| 0:08-0:18 | Editor: `lander-demo-shop/src/components/CheckoutButton.tsx`, the `if (variant === ...)` branch | "Someone has to read the numbers, end the test, ship the winner, and delete the losing code. Usually nobody does." |
| 0:18-0:25 | Title card: **Lander**. "Other agents start experiments. Lander finishes the ones you already have." | "This is Lander. It finishes the experiments you already have, and refuses the ones you should not trust." |
| 0:25-0:45 | `pnpm lander scan --env staging` | "One command reads every experiment through the Flagsmith API and gives each one a verdict. The rules are plain code, not a model." |
| 0:45-1:00 | Zoom on the `signup_steps` DO NOT TRUST row and its reason | "This one looks like a 99 percent winner, but its traffic split is 63 to 37 when it should be 50-50. A sample ratio mismatch: the data is broken, so Lander refuses to ship it." |
| 1:00-1:20 | `pnpm lander land checkout_cta --env staging`: verdict, plan, code diff, brief | "On a real winner it builds a plan: complete the experiment, roll out the winner, and a code diff that deletes the losing branch. Nothing has changed yet." |
| 1:20-1:30 | The approval prompt; type the 8-character code | "To approve, I type the code of this exact plan. If the plan file is edited, the code changes and the approval fails. No terminal, no approval." |
| 1:30-1:50 | Lander output: tests pass, PR opened, experiment completed. Switch to the dashboard: experiment completed, winner at 100% | "First it opens the pull request and runs the app's tests. Only then does it complete the experiment, because that is the one step Flagsmith cannot undo." |
| 1:50-2:05 | GitHub draft PR: red/green diff, the brief as the description | "The losing code goes away in a normal pull request. The experiment's result decided which branch survives." |
| 2:05-2:18 | `pnpm lander rollback <id>`, then `pnpm lander journal verify` | "Every step is in a hash-chained journal, and one command puts the flag back." |
| 2:18-2:30 | Recap card: "API and CLI read and write, code decides, a human approves, the irreversible step goes last". Measured time saved. Repo URL. | "Flagsmith runs the experiment. Lander lands it." |

Notes on the take:

- The SRM numbers on screen come from your seeded run: read them off the table instead of reciting the ones above.
- The rollback id is the apply journal id that `apply` prints, not the plan id. The prompt names its source, so read
  the code it shows.
- Do not say Lander uses the Flagsmith MCP server: it does not. It uses the CLI and the Admin API (`flagsmith api`).
- If you have the Anthropic key in `.env`, `--explain` adds a plain-language brief. It is optional; skip it if the
  take is running long.

## Optional extra shots (if there is time)

- **Drift check:** save a plan with `land`, cancel at the prompt, change the `checkout_cta` flag in the dashboard, then
  `pnpm lander apply <plan-id>`: Lander sees the flag changed since the plan was made and refuses. Good proof that approval is not a
  blank cheque.
- **Guardrail harm:** `pnpm lander scan --fixtures fixtures/demo` shows `search_ranking` winning its primary metric
  and being refused for hurting `refund_requested`.

## Fallback take (no stack, no network)

Everything except the writes can be shown offline. The output is labelled FIXTURES REPLAY.

```
pnpm lander scan --fixtures fixtures/demo
pnpm lander land checkout_cta --env staging --fixtures fixtures/demo --dry-run
```

Use clips from the live run for the apply, dashboard and PR shots, and say on screen that the table is a replay.

## After recording

Reset the stack again (`pnpm seed --reset --env staging`, then seed and simulate) so the next take starts clean,
and close or delete the demo PR and branch on GitHub.
