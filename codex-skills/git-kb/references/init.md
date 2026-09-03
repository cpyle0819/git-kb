# init — set up the data repo

Payload: optional (a clone URL, a local path, or instructions). Goal: end with
a valid kb-data repo (holds `entries/` + `kb.json`) and
`~/.codex/git-kb/kb-config.json` pointing at it. This is the config file that
explicit skill invocations use when no plugin-scoped config is present.

**If already configured** (`data_dir` set to a valid repo): tell the user what
it points at and ask whether they want to change it. Stop if no.

**If not configured**: ask how they want to provide the repo (unless the payload
already answers). Three ways:
- **Clone an existing repo** — `git clone <url> <path>` (some hosts need a
  custom clone command). For sensitive data, use an internal git host.
- **Register an existing local clone** — use the given path as-is.
- **Start a new repo** — `mkdir -p <path>`, `git init <path>`, create
  `entries/` and `kb.json` (`{"schema_version": 1, "next_id": 1}`). No remote
  needed yet — the skill prompts for one on the first `NO_REMOTE` push.

**Confirm before any clone / init / mkdir** — state exactly what you'll run and where.

After obtaining the path: validate it's a git repo containing `entries/` and
`kb.json`. If it lacks them, stop and tell the user — don't scaffold over an
unknown repo.

Write `{"data_dir": "<resolved-absolute-path>"}` to
`~/.codex/git-kb/kb-config.json` (create the parent directory if needed), then
run `../../scripts/run-node.sh ../../scripts/kb-build-index.js` to generate
`kb-index.json` (used by the auto-trigger hook). Hook processes also honor
`<plugin data>/kb-config.json` when Codex provides plugin env vars. Direct
script runs can pin a config file with `KB_CONFIG_PATH=/path/to/kb-config.json`.
You do not need to write the plugin-scoped path directly. Confirm setup is
complete.
