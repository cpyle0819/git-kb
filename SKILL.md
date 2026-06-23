---
name: kb
description: Manage a git-backed personal knowledge base (add / search / edit). Invoke for "/kb add <knowledge>", "/kb search <query>", "/kb edit <id> <change>".
argument-hint: <verb> <content> # verb = add|search|edit
model: sonnet
effort: low
allowed-tools: Read, Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js *), Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js *)
---

# /kb — git-backed knowledge base

You are operating the user's personal knowledge base. It is a **git repo of
markdown entries** (the `kb-data` repo). There is no database and no server —
git is the persistence layer and the markdown files are the source of truth.

## Dispatch first — do only what the verb needs

The first token of `$ARGUMENTS` is the verb: `add`, `search`, or `edit`;
the payload is what remains. If the verb is none of these, tell the user the
valid verbs and stop (no natural-language fallback in v1).

**Do NOT do any setup up front.** Each verb does exactly the setup it needs:

- `search` — needs nothing first. The helper script resolves `data_dir` and
  validates it itself. Just run it (below).
- `add` — needs the spec (to write a valid entry); helper handles `data_dir`/git.
- `edit` — like `add`, for changing an EXISTING entry in place (facts/refinements).

`data_dir` is the local clone of the **kb-data** repo (holds `entries/` and
`kb.json`), read only from **`~/.claude/kb-config.json`** (key `data_dir`;
resolve `~`). When `add`/`edit` need it, resolve/bootstrap per
[Resolve & bootstrap data_dir](#resolve--bootstrap-data_dir) below.

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
   if the error is about `data_dir`, resolve/bootstrap it (see bottom) first.

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
   `ERROR:` — only THEN resolve/bootstrap `data_dir` (see bottom) and retry.
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

## Resolve & bootstrap data_dir

(All helpers resolve `data_dir` from the config themselves. You only need this
section when a helper exits with a `data_dir` `ERROR:` — i.e. the config is
missing or the path isn't a valid repo yet — to bootstrap it, then retry.)

Read `data_dir` from `~/.claude/kb-config.json` (resolve `~`). Then:

1. **Path exists and IS a git repo** → use it.
2. **Config/key missing** → ask the user for the path. Then apply 3/4 below, and
   write `{"data_dir": "<path>"}` to `~/.claude/kb-config.json`.
3. **Path does NOT exist** → offer to create+init: `mkdir -p <path>`, `git init`,
   create `entries/` and `kb.json` (`{"schema_version": 1, "next_id": 1}`).
4. **Path exists but is NOT a git repo** → offer to `git init` in place and
   create `entries/` + `kb.json` if absent.

Always confirm before creating/initializing. No remote is set — that's the
user's to add later (the skill prompts on first `NO_REMOTE`). Once valid, save the path to the config so
future calls read it directly.

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
