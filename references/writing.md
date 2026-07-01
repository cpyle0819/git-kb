# Writing to the KB — `add` and `edit`

Both verbs draft a markdown entry and hand it to `kb-save.js`, which does ALL the
mechanical work (pull, id assignment, write, manifest bump, commit, push,
validation) in one allowlisted call. You draft + review; the helper does the rest.

## Gotchas (read before saving)

- **Heredoc must start with `node`** — the allowed-tools pattern is `Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js *)`. Using `cat entry.md | node kb-save.js` won't match and the call will be blocked.
- **Check for `SAVED`/`EDITED`, not just absence of `ERROR:`** — kb-save.js also exits 0 on `NO_CHANGES` (identical content after pull). This is not an error; it commonly means a prior save already succeeded.
- **Pull failure = hard abort** — if `git pull` fails (network/auth/diverged), kb-save.js exits 6 with `ERROR: git pull failed — refusing to write against a stale DB.` The commit never happens. Fix connectivity before retrying.
- **Merge conflict after pull** — prints `ERROR: git pull left a merge conflict.` (code 6). Don't retry blindly — the user must resolve it in the data repo first.
- **Local commit without push** — `push:` line says `committed locally but NOT pushed`. The entry IS saved. Don't re-run kb-save.js (it will find NO_CHANGES and obscure the local-only state). Relay the message and suggest retrying push later.
- **`NO_REMOTE` ≠ push failure** — means no git remote configured. The save fully succeeded: the entry is written and committed locally, and `NO_REMOTE` is the complete, correct terminal state for a repo with no remote (nothing more to do). Only treat it as actionable on the repo's *first* save, where it's the cue to offer [First-time remote setup](#first-time-remote-setup). Never call `--set-remote` unless the push line explicitly said `NO_REMOTE` — if origin already exists it will error.
- **`id: __ID__` must be unquoted** — `id: '__ID__'` causes kb-save.js to exit 2: `ERROR: stdin frontmatter must contain id: __ID__`.
- **Anchor entry before dependent entries** — links validate against entries present at save time. Save the anchor first to get its real kb-NNNN id, then save dependents.
- **kb-build-index.js runs automatically after every save/edit** — don't call it manually. Only run it explicitly after `init` or if the index is suspected corrupt.
- **Five entry types, not four** — the authoritative list is in kb-save.js: `factual_reference`, `decision`, `pattern_convention`, `lesson_learned`, `bookmark`.

---

## add — capture knowledge

Payload: the freeform knowledge to store.

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
   - `created`/`updated` = today, as `YYYY-MM-DD`.
3. **Save immediately** — pipe the entry to the helper via heredoc redirect
   (IMPORTANT: start the command with `node`, not `cat | node`):
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --slug "<slug-from-title>" <<'EOF'`
   It resolves `data_dir`, pulls (if upstream), assigns a collision-free id,
   validates (closed enums, no dangling links), writes the file, bumps
   `kb.json`, commits, and pushes. It prints `SAVED kb-NNNN ...` with a `push:`
   line. If it prints an `ERROR:` line, fix the entry and retry; if the error is
   about `data_dir`, stop and point the user to `/kb init`.

   **Splitting into multiple entries:** the helper assigns each id at save time,
   so you can't reference a sibling's id before it exists. Save the **anchor**
   entry first, read the `SAVED kb-NNNN` it prints, then save the dependent
   entries with `links:` pointing at that real id. One `kb-save.js` call per
   entry.

---

## edit — change an existing entry in place

Payload: a target (id or description) + the change. Use `edit` for **factual
corrections and refinements** to an existing entry. **For a decision that was
replaced** by new thinking, do NOT edit in place — `add` a new entry with a
`supersedes` link to the old one, preserving the history.

1. **Identify the entry.** If the payload names an id (`kb-NNNN`), use it; else
   run the search helper to find it. The search helper returns the full body of
   top hits — **use that content directly; do NOT re-read the entry file.** If
   the entry wasn't in the search results, read it then, but only then.
2. **Draft the full updated entry** using the content from step 1 and the
   type/rel/direction rules from the `add` section above. Keep the real `id:`
   (not `__ID__`), apply the change, bump `updated:` to today, keep `created:`
   as-is.
3. **Save immediately** — pipe the full updated entry via heredoc redirect
   (IMPORTANT: start the command with `node`, not `cat | node`):
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --edit <id> [--slug "<new-slug>"] <<'EOF'`
   (include `--slug` only if the title changed enough to warrant a rename — the
   helper does a `git mv`). It validates, overwrites in place (no new id, no
   `next_id` bump), commits `edit kb-NNNN: ...`, and pushes. It prints
   `EDITED kb-NNNN` + a `push:` line. On an `ERROR:` line, fix and retry.

---

## First-time remote setup

When the `push:` line from `kb-save.js` says `NO_REMOTE`, the data repo has no
git remote yet. **Ask the user for the kb-data remote URL** (the URL must come
from them — for sensitive data, use an internal git host). On their confirmation:
`node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --set-remote "<url>"`
This adds `origin`, pushes all commits, and sets upstream. Never invent a URL.
