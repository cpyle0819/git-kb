---
name: kb
description: Automatic knowledge-base (kb) retrieval for every prompt. Uses keywords to keep the user's session hydrated with appropriate context.
argument-hint: <verb> <content> # verb = init|add|search|edit
model: sonnet
effort: low
allowed-tools: Read, Write(${CLAUDE_PLUGIN_DATA}/kb-config.json), Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js *), Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js *), Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-build-index.js), Bash(git clone *), Bash(git init *), Bash(mkdir *), AskUserQuestion
---

# /kb — git-backed knowledge base

You are operating the user's personal knowledge base. It is a **git repo of
markdown entries** (the `kb-data` repo). There is no database and no server —
git is the persistence layer and the markdown files are the source of truth.

## Dispatch first — do only what the verb needs

The first token of `$ARGUMENTS` is the verb: `init`, `add`, `search`, or
`edit`; the payload is what remains. If the verb is none of these, tell the
user the valid verbs and stop (no natural-language fallback in v1).

**Do NOT do any setup up front.** Each verb does exactly the setup it needs:

- `init` — the one explicit setup step: point the KB at its `data_dir` (clone
  an existing repo, register an existing local clone, or start a fresh one) and
  write `${CLAUDE_PLUGIN_DATA}/kb-config.json`. See [init](#init--set-up-the-data-repo).
- `search` — needs nothing first. The helper script resolves `data_dir` and
  validates it itself. Just run it (below).
- `add` — needs the spec (to write a valid entry); helper handles `data_dir`/git.
- `edit` — like `add`, for changing an EXISTING entry in place (facts/refinements).

`data_dir` is the local clone of the **kb-data** repo (holds `entries/` and
`kb.json`), read from **`${CLAUDE_PLUGIN_DATA}/kb-config.json`** (key `data_dir`;
resolve `~`). It is set up only by `init`.

---

## Gotchas

- **Heredoc must start with `node`** — the allowed-tools pattern is `Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js *)`. Using `cat entry.md | node kb-save.js` won't match and the call will be blocked.
- **Check for `SAVED`/`EDITED`, not just absence of `ERROR:`** — kb-save.js also exits 0 on `NO_CHANGES` (identical content after pull). This is not an error; it commonly means a prior save already succeeded.
- **Pull failure = hard abort** — if `git pull` fails (network/auth/diverged), kb-save.js exits 6 with `ERROR: git pull failed — refusing to write against a stale DB.` The commit never happens. Fix connectivity before retrying.
- **Merge conflict after pull** — prints `ERROR: git pull left a merge conflict.` (code 6). Don't retry blindly — the user must resolve it in the data repo first.
- **Local commit without push** — `push:` line says `committed locally but NOT pushed`. The entry IS saved. Don't re-run kb-save.js (it will find NO_CHANGES and obscure the local-only state). Relay the message and suggest retrying push later.
- **`NO_REMOTE` ≠ push failure** — means no git remote configured. Ask the user for the URL and run `kb-save.js --set-remote <url>`. Never call `--set-remote` unless the push line explicitly said `NO_REMOTE` — if origin already exists it will error.
- **`id: __ID__` must be unquoted** — `id: '__ID__'` causes kb-save.js to exit 2: `ERROR: stdin frontmatter must contain id: __ID__`.
- **Anchor entry before dependent entries** — links validate against entries present at save time. Save the anchor first to get its real kb-NNNN id, then save dependents.
- **`--type` filter is case-sensitive lowercase** — `lesson_learned` works; `LessonLearned` silently returns no matches.
- **kb-build-index.js runs automatically after every save/edit** — don't call it manually after `add`/`edit`. Only run it explicitly after `init` or if the index is suspected corrupt.
- **Five entry types, not four** — the authoritative list is in kb-save.js: `factual_reference`, `decision`, `pattern_convention`, `lesson_learned`, `bookmark`.

---

**Not configured yet?** `search`/`add`/`edit` each run a helper that resolves
`data_dir` itself. If a helper exits with a `data_dir` `ERROR:` (config missing,
path absent, or not a valid repo), stop and point the user to `/kb init`:

> KB isn't set up yet. Run `/kb init` to point it at your kb-data repo
> (clone URL, an existing local clone, or a new repo).

---

### init — set up the data repo

Payload: optional (a clone URL, a local path, or instructions). Goal: end with
a valid kb-data repo (holds `entries/` + `kb.json`) and
`${CLAUDE_PLUGIN_DATA}/kb-config.json` pointing at it. This is the only place
`data_dir` gets configured.

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
`${CLAUDE_PLUGIN_DATA}/kb-config.json` (the only file the skill writes
directly), then run `node ${CLAUDE_SKILL_DIR}/scripts/kb-build-index.js` to
generate `kb-index.json` (used by the auto-trigger hook). Confirm setup is
complete.

---

### add — capture knowledge

Payload: the freeform knowledge to store. You draft + review; the bundled
`kb-save.js` helper does ALL the mechanical work (pull, id assignment, write,
manifest bump, commit, push, spec validation) in one allowlisted call.

**If the payload references a file or URL** rather than containing the knowledge
itself ("summarize this PDF", "add what's at <url>"), read/extract it first with
your normal available tools, then draft from the result. The skill bundles no
extractor — just use what's available.

**Keep entries atomic — one logical fact / idea per entry.** If a source is
large (a paper, a long doc), do NOT write one giant entry. Split it into a few
focused entries and link them (e.g. a `factual_reference` for the core
thesis, separate entries for distinct findings, joined with `part_of` /
`relates_to`). Atomic entries keep search scannable and the graph meaningful.

1. **Find candidate link targets.** To propose `links`, you need the ids of
   related existing entries: run the search helper with terms from the new
   knowledge (`node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js "<term>" ...`) and
   note the `kb-NNNN` ids of genuine matches. Only link to ids it returns.
2. **Draft the entry** (use `id: __ID__` as a placeholder — the helper assigns
   the real id):
   - **`type`** — `bookmark` if the input is a URL/link to save (requires a
     `url:` frontmatter field); `decision` if it states a choice + rationale;
     `lesson_learned` for a debugging insight/gotcha; `pattern_convention` for a
     reusable rule; otherwise `factual_reference`.
   - `url` (frontmatter field) — required for `bookmark`, optional for others.
   - `title` + a concise markdown body (for bookmarks: body is optional
     notes/context about _why_ you saved it).
   - `tags` (free-form).
   - `links` — closed `rel` set only; `to:` only ids confirmed in step 1.
     **`rel` guidance:** `supersedes` ONLY when `to:` is the specific entry being
     replaced (if the replaced thing has no entry, use `relates_to`); `part_of`
     for component-of; `depends_on` for requires/builds-on; `mentions` for a
     passing reference; `relates_to` as the generic fallback.
   - **Direction matters.** `part_of`/`depends_on`/`supersedes` read FROM this
     entry: write them from the **child / dependent / consumer** toward the
     parent / dependency (a component is `part_of` its system; a tool that reads
     another's data `depends_on` it). If a directional rel would read backwards,
     flip the direction — don't downgrade to `relates_to`. Reserve `relates_to`
     for when no directional rel fits _either way_ (peer ties, person↔team
     leadership). Torn between two rels in the SAME direction → prefer the weaker.
   - `created`/`updated` = today.
3. **Save immediately** — pipe the entry to the helper via heredoc redirect
   (IMPORTANT: start the command with `node`, not `cat | node`):
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --slug "<slug-from-title>" <<'EOF'`
   It resolves `data_dir`, pulls (if upstream), assigns a collision-free id,
   validates against the spec (closed enums, no dangling links), writes the
   file, bumps `kb.json`, commits, and pushes. It prints `SAVED kb-NNNN ...`
   with a `push:` line (a failed push keeps the local commit — relay that and
   suggest retrying later). If it prints an `ERROR:` line, fix the entry and retry;
   if the error is about `data_dir`, stop and point the user to `/kb init`.

   **Splitting into multiple entries:** the helper assigns each id at save time,
   so you can't reference a sibling's id before it exists. Save the **anchor**
   entry first, read the `SAVED kb-NNNN` it prints, then save the dependent
   entries with `links:` pointing at that real id. One `kb-save.js` call per
   entry.

### edit — change an existing entry in place

Payload: a target (id or description) + the change. Use `edit` for **factual
corrections and refinements** to an existing entry. **For a decision that was
replaced** by new thinking, do NOT edit in place — `add` a new entry with a
`supersedes` link to the old one, preserving the history.

1. **Identify the entry.** If the payload names an id (`kb-NNNN`), use it; else
   run the search helper to find it. The search helper returns the full body of
   top hits — **use that content directly; do NOT re-read the entry file.** If
   the entry wasn't in the search results, read it then, but only then.
2. **Draft the full updated entry** using the content from step 1. Do NOT read
   the spec file — the type/rel/direction rules are already in this skill
   (`add` section above). Keep the real `id:` (not `__ID__`), apply the change,
   bump `updated:` to today, keep `created:` as-is.
3. **Save immediately** — pipe the full updated entry via heredoc redirect
   (IMPORTANT: start the command with `node`, not `cat | node`):
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --edit <id> [--slug "<new-slug>"] <<'EOF'`
   (include `--slug` only if the title changed enough to warrant a rename — the
   helper does a `git mv`). It validates, overwrites in place (no new id, no
   `next_id` bump), commits `edit kb-NNNN: ...`, and pushes. It prints
   `EDITED kb-NNNN` + a `push:` line; relay a failed push and suggest retrying later.
   On an `ERROR:` line, fix and retry.

### search — recall knowledge

Payload: the query. **Do no setup** — no config read, no `data_dir` check, no
pull, no spec, no file reads. The helper does all of that. Two steps only:

1. **Expand the query** into a handful of synonyms / related terms yourself —
   this is how we recover semantic recall without embeddings (e.g. a query about
   "shipping" should also try "deploy", "release", "pipeline"). Then run the
   helper in the SAME step, passing each term as a separate argument:
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js "<term1>" "<term2>" ...`
   **Optional filter:** add `--type <type>` to restrict results to a single entry
   type (e.g. `--type bookmark "*"` lists all bookmarks; `--type decision "*"`
   lists all decisions). Use `"*"` as the term to list all matching the type
   without further keyword filtering.
   The helper resolves `data_dir` from the config, parses entry frontmatter (no
   grep), scores matches (title > tag > url > body), and prints ranked results.
   The top hits include their **full body**, and `links:` are resolved to target
   titles — so you have everything to answer AND to offer related entries in one
   call. Special outputs: `NO_MATCHES` (nothing matched) or a line starting
   `ERROR:` — a `data_dir` `ERROR:` means setup is incomplete; stop and point
   the user to `/kb init`.
2. Answer the user's question directly from the returned content (the top hits'
   full bodies are already present — do NOT read files again). Then, if useful,
   mention the resolved `links:` as related entries to explore. Only read a full
   file or walk a link further if the user asks.
   **For bookmarks:** always show the actual FULL `url:` value from the output —
   that IS the entry's primary content. Never substitute a description for the
   URL, and never truncate URLs (no `…`). Present bookmark lists as a flat
   list (not a table) so URLs have room and are copy-pasteable.

---

### First-time remote setup

When the `push:` line from `kb-save.js` says `NO_REMOTE`, the data repo has no
git remote yet. **Ask the user for the kb-data remote URL** (the URL must come
from them — for sensitive data, use an internal git host). On their confirmation:
`node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --set-remote "<url>"`
This adds `origin`, pushes all commits, and sets upstream. Never invent a URL.

---

## Rules

- **Never invent `type` or `rel` values** outside the closed enums in the spec.
- **Never write the inverse of a link** on the target entry (edges are directed,
  stored once).
- **Never commit secrets/credentials** — git history is permanent.
- Keep one entry per file; one logical fact per entry.
- **State what a thing IS, not what it isn't.** Write positively. If someone is
  _not_ a manager, don't say "not a manager" — say their actual role.
- **Minimize tool calls.** The search helper already returns full bodies + link
  titles. Do not re-read files the helper already returned. Do not read the spec
  file for edit (the rules are in this skill). One search + one save = the
  target for edit.
- All git operations use `-C <data_dir>` so they run against the data repo
  regardless of the session's current directory.
