# Flagsmith CLI v2: real command syntax (plan A2 #23)

Recorded 2026-11-25 from `flagsmith --help` and sub-command help on `flagsmith version v2.0.0`
(`C:\Users\kumar\.local\bin\flagsmith.exe`). No `flagsmith login` was run and no API call was made, so
nothing here has been checked against a live server. Items marked UNVERIFIED need the Phase 0 spike.

## Answer to A2 #23: the method flag for `flagsmith api`

`-X, --method <METHOD>` (default `GET`). Verified in `flagsmith api --help`.

```
flagsmith api <path> [flags]
  -X, --method string     HTTP method (default "GET")
  -F, --field key=value   typed field, builds a JSON body, POST is implied (repeatable)
  -f, --raw-field k=v     string field (repeatable)
      --input string      request body from a file, or - for stdin
  -H, --header 'N: v'     extra header (repeatable)
  -i, --include           include status line and headers
      --sdk               call the SDK API with the environment key instead of the Admin API
```

Examples straight from the help text:

```
flagsmith api api/v1/organisations/
flagsmith api api/v1/projects/ -F name="Acme" -F organisation=13
flagsmith api api/v1/projects/102/ -X DELETE
flagsmith api --sdk api/v1/flags/
```

Notes for Lander:
- The path is `api/v1/...` (no leading slash in the examples; Lander strips one if present).
- Nested bodies (experiments, `complete`) cannot be expressed well with `-F`. Use `--input -` and pipe JSON on
  stdin. `src/flagsmith/cli.ts` does exactly this with `execFile` and an argument array.
- Typed `-F` values are the way to send a scalar, e.g. `-F rollout_decision=variant -F rollout_variant=42`
  (UNVERIFIED whether the CLI types `42` as a number). Prefer `--input -`.
- There is no `--include`-free way to read the HTTP status: a non-2xx response is expected to give a non-zero exit
  code (UNVERIFIED). Phase 0: confirm, and capture the error body shape.

## Global flags (every command)

```
      --api-url string        Flagsmith API base URL (env FLAGSMITH_API_URL), default https://api.flagsmith.com
  -c, --config-path string    path to flagsmith.json (env FLAGSMITH_CONFIG_PATH)
  -e, --environment string    environment as its CLIENT-SIDE SDK key (env FLAGSMITH_ENVIRONMENT)
      --jq string             filter JSON output through a jq expression (implies --json)
      --json                  JSON output (env FLAGSMITH_JSON_OUTPUT)
      --no-input              never prompt or open a browser; fail if input is missing (env FLAGSMITH_NO_INPUT)
      --organisation string   organisation ID or name (env FLAGSMITH_ORGANISATION)
  -p, --project string        project ID or name (env FLAGSMITH_PROJECT)
      --sdk-api-url string    SDK API base URL for flag evaluation (env FLAGSMITH_SDK_API_URL)
      --yes                   answer confirmations affirmatively
```

Consequences:
- `-e` takes the environment's client-side key (the same key used as `{env}` in the Admin API paths), not a
  server-side key and not an environment id or name. This matches `LANDER_ENV_STAGING` in `.env.example`.
- Always pass `--json --no-input` from scripts; Lander does (`globalArgs()` in `src/flagsmith/cli.ts`).
- Place global flags after the subcommand or before it; both are normal for this CLI style (the seed script
  puts them last and its `--dry-run` output shows the exact argv).

## Credentials (no login was run)

`flagsmith login [--no-browser]`, `flagsmith logout`, `flagsmith auth status`, `flagsmith auth token`
(prints the active Admin API credential). `flagsmith config` shows the resolved context and where each value
came from (run with no login it shows everything as `default`).

The binary contains the strings `FLAGSMITH_API_KEY`, `FLAGSMITH_ACCESS_TOKEN` and `FLAGSMITH_ENVIRONMENT_KEY`,
which strongly suggests an env-var credential path, but the help does not document it (INFERRED).
Phase 0: run `FLAGSMITH_API_KEY=<master key> flagsmith auth status` to see whether the master key from
`.env` is enough or whether a browser `flagsmith login` is required. The seed script relies on whichever works.

## Commands Lander uses

| Need | Command |
|---|---|
| Read before-state (A2 #8) | `flagsmith flag get <feature> -e <env key> --json` (also `--segment <id\|name>`, `--identifier <id>`) |
| Roll back value (A2 #11) | `flagsmith flag update <feature> --value <v> [--type string\|integer\|boolean] [--enable\|--disable]` |
| Roll back weights (A2 #11) | `flagsmith flag update <feature> --weight <key\|id>=<pct> [--weight ...]` (repeatable or comma separated) |
| Verify served value (A2 #10) | `flagsmith evaluate <feature> --identity <id> --json` (alias `eval`; also `--trait k=v`, `--test`, `--js`) |
| List flags in env | `flagsmith flag list [--feature <name>] [--segment <x>] [--identities]` |
| Archive (A2 #15) | `flagsmith feature update <feature> --archive` (and `--unarchive`). This is a first-class command, so the `PATCH is_archived` REST call from the plan is not needed (UNVERIFIED that it calls the same endpoint) |
| Create MV flag (A2 #17) | `flagsmith feature create <name> [--value v] [--enabled] [--description d] [--variants @file\|-\|inline JSON]` |
| Add variant (A2 #17) | `flagsmith feature variant add <feature> --value <v> --key <key> --weight <pct> [--type string\|integer\|boolean]` |
| Inspect feature | `flagsmith feature get <feature>`, `flagsmith feature variant list <feature>` |
| Variant ops | `feature variant update\|delete <feature> <id\|key>` |
| Delete feature (A2 #22) | `flagsmith feature delete <feature>` |
| Env list / keys | `flagsmith environment list`, `environment get <env>`, `environment key create\|list\|delete` (server-side SDK keys, value shown once), `environment document` (JSON for local SDK evaluation) |
| Projects | `flagsmith project list`, `project get`, `project create` |
| Bind a folder | `flagsmith init [--create-project n] [--create-environment n]` writes `flagsmith.json` |

Not first-class (use `flagsmith api`): experiments (create, start, pause, complete, results, exposures, refresh),
metrics, warehouse connections.

Other top-level commands present: `organisation`, `segment`, `completion`, `config`.

## Exact `flagsmith api` calls Lander makes (all UNVERIFIED payloads, to be captured as fixtures)

```
# refresh then read results (A2 #4, #5). Throttle: once per 5 minutes per experiment.
flagsmith api api/v1/environments/<ENV>/experiments/<ID>/results/refresh/ -X POST --json --no-input
flagsmith api api/v1/environments/<ENV>/experiments/<ID>/results/ --json --no-input
flagsmith api api/v1/environments/<ENV>/experiments/<ID>/exposures/refresh/ -X POST --json --no-input
flagsmith api api/v1/environments/<ENV>/experiments/<ID>/exposures/ --json --no-input

# end the experiment and roll out the winner (A2 #9). Irreversible.
echo '{"rollout_decision":"variant","rollout_variant":<MV_OPTION_ID>}' |
  flagsmith api api/v1/environments/<ENV>/experiments/<ID>/complete/ -X POST --input - --json --no-input
```

Equivalent from Lander: `flagsmithApi("POST", path, { body })` in `src/flagsmith/cli.ts` (stdin, no shell).

## Behaviours to confirm in the Phase 0 spike

1. Does `flagsmith api` exit non-zero on HTTP 4xx and print the body? (Needed for error handling.)
2. Is `FLAGSMITH_API_KEY` honoured as the credential, or is a browser login mandatory?
3. JSON shape of `feature get --json` (seed.ts reads `id` and `variants[].id/.key`, with a fallback to
   `multivariate_options`) and of `flag get --json`.
4. Does `--input -` accept the experiment-create body with nested arrays? (Expected yes.)
5. Does `feature delete` work for a feature whose experiment is completed? (A2 #22.)
