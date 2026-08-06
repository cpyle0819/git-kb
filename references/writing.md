# Writing to the KB — `add` and `edit`

You author the entry with your normal file tools — `Write` a new entry, `Edit` an
existing one in place — then hand it to `kb-save.js`, which does the mechanical git
work (pull, id assignment, manifest bump, validation, commit, push, index rebuild)
in one allowlisted call. **`add` uses `Write`; `edit` uses `Edit`.** You author +
review the file; the helper does the git plumbing.

The helper takes the entry content from one of three sources, in this precedence:

1. **`--file <path>`** — the file you just `Write`/`Edit`-ed. This is the primary
   path: `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --file entries/<name>.md ...`.
2. **Edit-in-place** (edit mode only) — with **no `--file` and empty stdin**, the
   helper commits the entry file you already edited on disk. Since `search`/`get`
   print the entry's absolute `file:` path (`<data_dir>/entries/kb-NNNN-*.md`), you
   can `Edit` that path directly and call `--edit kb-NNNN` with nothing piped.
3. **stdin (heredoc)** — the fallback, for piping a program's output straight in
   (e.g. `some-extractor | node kb-save.js --slug ...`). Empty stdin (a TTY or
   `< /dev/null`) does NOT count as stdin content.

## Gotchas (read before saving)

- **Command must start with `node`** — the allowed-tools pattern is `Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js *)`. Using `cat entry.md | node kb-save.js` won't match and the call will be blocked; pass `--file` (or a bare heredoc that begins with `node`) instead.
- **`add` = `Write`, `edit` = `Edit`.** For a new entry, `Write` the draft file then `--file` it. For a change, `Edit` the existing entry file surgically then `--edit kb-NNNN` (no need to reproduce the whole entry). Don't hand-build the full entry text just to pipe it — use the file tools.
- **Check for `SAVED`/`EDITED`, not just absence of `ERROR:`** — kb-save.js also exits 0 on `NO_CHANGES` (identical content after pull). This is not an error; it commonly means a prior save already succeeded.
- **Pull failure = hard abort** — if `git pull` fails (network/auth/diverged), kb-save.js exits 6 with `ERROR: git pull failed — refusing to write against a stale DB.` The commit never happens. Fix connectivity before retrying.
- **Merge conflict after pull** — prints `ERROR: git pull left a merge conflict.` (code 6). Don't retry blindly — the user must resolve it in the data repo first.
- **Local commit without push** — `push:` line says `committed locally but NOT pushed`. The entry IS saved. Don't re-run kb-save.js (it will find NO_CHANGES and obscure the local-only state). Relay the message and suggest retrying push later.
- **`NO_REMOTE` ≠ push failure** — means no git remote configured. The save fully succeeded: the entry is written and committed locally, and `NO_REMOTE` is the complete, correct terminal state for a repo with no remote (nothing more to do). Only treat it as actionable on the repo's *first* save, where it's the cue to offer [First-time remote setup](#first-time-remote-setup). Never call `--set-remote` unless the push line explicitly said `NO_REMOTE` — if origin already exists it will error.
- **`id: __ID__` must be unquoted** — `id: '__ID__'` causes kb-save.js to exit 2: `ERROR: --file frontmatter must contain id: __ID__`.
- **Write the new-entry draft into `entries/`** — for `add` via `--file`, `Write` the draft to `entries/<slug>.md` with `id: __ID__`. The helper assigns the real id, renames the file to `entries/kb-NNNN-<slug>.md`, and removes the un-id'd draft, so only the final entry is committed.
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
   - `title` + a concise markdown body. For bookmarks the body is optional:
     use whatever the user gives about the link (a why-saved rationale OR a
     plain description like "our on-call runbook") as the body; omit it only if
     they gave nothing but the URL.
   - `tags` (free-form; YAML flow list, e.g. `[api, rate-limit]`).
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
   - **`applies_to` / `kernel`** (retrieval beyond keywords — usually OMIT both).
     The auto-lookup hook normally surfaces an entry only when the prompt shares
     keywords with its tags/title. These two optional fields let an entry surface
     on prompts that never name its subject. Most entries want neither — a fact,
     a decision, a bookmark is relevant when its topic comes up, which keywords
     already handle. Add one ONLY when the entry is genuinely cross-cutting:
     - **`applies_to: [<activity>, …]`** — for guidance that applies to a *kind of
       work* rather than a topic (e.g. writing-style rules relevant whenever the
       assistant authors output, no matter the subject). The entry's **title
       pointer** then injects whenever the prompt's activity matches; the model
       fetches the body if relevant. Valid activities are a closed set keyed to
       the classifier: **`writing`** (drafting/editing any prose — a ticket, CR,
       comment, reply, summary, doc), **`reviewing`** (critique, feedback, audit),
       **`planning`** (design, roadmap, approach), **`coding`** (implement,
       refactor, debug, test). Use `writing` for style/prose rules, `reviewing`
       for review checklists, and so on. Value is a YAML flow list of these names,
       lowercase. Subject to per-session dedup — listed at most once per session.
     - **`kernel: true`** — for a tiny set of **invariant** rules that must govern
       *every* turn. Injects the entry's full **body** verbatim on every prompt,
       **exempt from dedup** (re-injected each turn). Reserve it for short,
       always-true guidance (the house-style kernel); a long body re-injected each
       turn wastes context, and deduped-once was the old failure that left later
       turns ungoverned. Prefer the narrower `applies_to` pointer whenever an
       entry is merely *relevant to* a kind of work rather than a standing
       invariant that must always be present as text.
   - `created`/`updated` = today, as `YYYY-MM-DD`.

   **Canonical entry shape** (frontmatter is a YAML block between `---` fences;
   everything after the closing fence is the markdown body):

   ```markdown
   ---
   id: __ID__
   title: Adopt PostgreSQL for the analytics pipeline
   type: decision
   url:                       # required for bookmark, omit otherwise
   tags: [database, analytics, postgres]
   applies_to:                # optional; activity-pointer entries only (see above)
   kernel:                    # optional; always-resident invariant entries only (see above)
   links:
     - rel: relates_to
       to: kb-0002
   created: 2026-07-01
   updated: 2026-07-01
   ---

   We chose PostgreSQL over a separate OLAP store: window functions and JSONB
   cover our analytics needs without a second system to operate.
   ```

   **`Write` the draft** to `entries/<slug>.md` in the data repo (slug format:
   lowercase, words hyphen-separated, no punctuation — e.g. title "API rate limit"
   → `api-rate-limit`). Keep `id: __ID__` in the frontmatter — the helper assigns
   the real id and renames the file.

3. **Save immediately** — hand the draft file to the helper with `--file`:
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --slug "<slug-from-title>" --file entries/<slug>.md`
   (the `--slug` sets the final filename; the helper prefixes the `kb-NNNN` id.)
   It resolves `data_dir`, pulls (if upstream), assigns a collision-free id,
   validates (closed enums, no dangling links), renames the draft to
   `entries/kb-NNNN-<slug>.md`, bumps `kb.json`, commits, and pushes. It prints
   `SAVED kb-NNNN ...` with a `push:` line. If it prints an `ERROR:` line, fix the
   entry and retry; if the error is about `data_dir`, stop and point the user to
   `/git-kb init`. (Piping a program's output? Use the stdin heredoc fallback
   instead of `--file` — the command must still start with `node`.)

   **Splitting into multiple entries:** the helper assigns each id at save time,
   so you can't reference a sibling's id before it exists. Save the **anchor**
   entry first, read the `SAVED kb-NNNN` it prints, then `Write` + save the
   dependent entries with `links:` pointing at that real id. One `kb-save.js` call
   per entry.

---

## edit — change an existing entry in place

Payload: a target (id or description) + the change. Use `edit` for **factual
corrections and refinements** to an existing entry. **For a decision that was
replaced** by new thinking, do NOT edit in place — `add` a new entry with a
`supersedes` link to the old one, preserving the history.

1. **Identify the entry and its file.** If the payload names an id (`kb-NNNN`),
   use it; else run the search helper to find it. Both `search` and `get` print
   the entry's absolute `file:` path (`<data_dir>/entries/kb-NNNN-*.md`) along with
   its full body — that path is ready to hand to `Edit` as-is, no `data_dir`
   lookup needed.
2. **`Edit` the entry file in place.** Make the surgical change with the `Edit`
   tool on that absolute path — you no longer reproduce the whole entry.
   Bump `updated:` to today; keep `created:` and the real `id:` as-is. Follow the
   type/rel/direction rules from the `add` section (including the
   `applies_to`/`kernel` fields — preserve any already set, and add one if the
   edit turns the entry into cross-cutting guidance). If the entry
   wasn't in the search results, `Read` it first so the `Edit` matches.
3. **Save immediately** — commit the edited file:
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --edit <id> [--slug "<new-slug>"]`
   With no `--file` and nothing piped, the helper commits the file you just
   edited on disk. Include `--slug` only if the title changed enough to warrant a
   rename (the helper does a `git mv`). It validates, commits `edit kb-NNNN: ...`
   (no new id, no `next_id` bump), and pushes. It prints `EDITED kb-NNNN` + a
   `push:` line. On an `ERROR:` line, fix and retry. (To edit from a program's
   output instead, pipe it via the stdin heredoc, or pass `--file <path>`.)

---

## First-time remote setup

When the `push:` line from `kb-save.js` says `NO_REMOTE`, the data repo has no
git remote yet. **Ask the user for the kb-data remote URL** (the URL must come
from them — for sensitive data, use an internal git host). On their confirmation:
`node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --set-remote "<url>"`
This adds `origin`, pushes all commits, and sets upstream. Never invent a URL.
