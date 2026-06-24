---
name: kb
description: Manage a git-backed personal knowledge base (init / add / search / edit). Invoke for "/kb init", "/kb add <knowledge>", "/kb search <query>", "/kb edit <id> <change>".
argument-hint: <verb> <content> # verb = init|add|search|edit
model: sonnet
effort: low
allowed-tools: Read, Write(~/.claude/kb-config.json), Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js *), Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js *)
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
  write `~/.claude/kb-config.json`. See [init](#init--set-up-the-data-repo).
- `search` — needs nothing first. The helper script resolves `data_dir` and
  validates it itself. Just run it (below).
- `add` — needs the spec (to write a valid entry); helper handles `data_dir`/git.
- `edit` — like `add`, for changing an EXISTING entry in place (facts/refinements).

`data_dir` is the local clone of the **kb-data** repo (holds `entries/` and
`kb.json`), read only from **`~/.claude/kb-config.json`** (key `data_dir`;
resolve `~`). It is set up only by `init`.

**Not configured yet?** `search`/`add`/`edit` each run a helper that resolves
`data_dir` itself. If a helper exits with a `data_dir` `ERROR:` (config missing,
path absent, or not a valid repo), stop and point the user to `/kb init`:

> KB isn't set up yet. Run `/kb init` to point it at your kb-data repo
> (clone URL, an existing local clone, or a new repo).

---

### init — set up the data repo

Payload: optional (a clone URL, a local path, or instructions). This is the
single place `data_dir` gets configured. Goal: end with a valid kb-data repo
(holds `entries/` + `kb.json`) and `~/.claude/kb-config.json` pointing at it.

1. **Read the current config** at `~/.claude/kb-config.json` (resolve `~`).
   - **Already configured** (`data_dir` set to a valid repo): tell the user
     what it points at and ask whether they want to change it. If no, stop —
     setup is already done. If yes, continue as if unset, using their new
     answer.
   - **Not configured** (file/key missing, or path is absent/not a repo): ask
     the user how they want to provide the data repo, unless the payload
     already answers it. The three ways:
     - **Clone an existing repo** — they give a clone URL (and optionally a
       target path). Run the clone (e.g. `git clone <url> <path>`, or whatever
       custom command they specify — some hosts need a non-`git` clone). For a
       sensitive KB the URL should be an internal git host.
     - **Register an existing local clone** — they give a path that is already
       a kb-data repo (they cloned it themselves). Use it as-is.
     - **Start a new repo** — they give a target path with nothing there yet.
       Create it: `mkdir -p <path>`, `git init <path>`, create `entries/` and
       `kb.json` (`{"schema_version": 1, "next_id": 1}`). No remote — the
       skill prompts for one on the first `NO_REMOTE` push.
2. **Confirm before any clone / init / mkdir** — these create or fetch
   directories. State exactly what you'll run and where, then do it.
3. **Validate** the resulting path is a git repo containing `entries/` and
   `kb.json`. If a freshly cloned/registered repo lacks them, tell the user the
   path isn't a kb-data repo and stop — don't silently scaffold over it.
4. **Write the config**: `{"data_dir": "<resolved-absolute-path>"}` to
   `~/.claude/kb-config.json` (this is the only file the skill writes directly).
   Then confirm setup is complete and that `add`/`search`/`edit` now work.

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

1. Read the spec at `${CLAUDE_SKILL_DIR}/spec/entry-format.md` — you need it to
   write valid frontmatter. (No need to read `kb.json` or pull — the helper
   handles ids and syncing.)
2. **Find candidate link targets.** To propose `links`, you need the ids of
   related existing entries: run the search helper with terms from the new
   knowledge (`node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js "<term>" ...`) and
   note the `kb-NNNN` ids of genuine matches. Only link to ids it returns.
3. **Draft the entry** (use `id: __ID__` as a placeholder — the helper assigns
   the real id):
   - **`type`** — `bookmark` if the input is a URL/link to save (requires a
     `url:` frontmatter field); `decision` if it states a choice + rationale;
     `lesson_learned` for a debugging insight/gotcha; `pattern_convention` for a
     reusable rule; otherwise `factual_reference`.
   - `url` (frontmatter field) — required for `bookmark`, optional for others.
   - `title` + a concise markdown body (for bookmarks: body is optional
     notes/context about _why_ you saved it).
   - `tags` (free-form).
   - `links` — closed `rel` set only; `to:` only ids confirmed in step 2.
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
4. **Save immediately** — pipe the entry to the helper via heredoc redirect
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
