---
name: kb
description: Manage a git-backed personal knowledge base (add / search / sync). Invoke for "/kb add <knowledge>", "/kb search <query>", "/kb sync".
argument-hint: <verb> <content>   # verb = add|search|sync
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js *), Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js *)
---

# /kb — git-backed knowledge base

You are operating the user's personal knowledge base. It is a **git repo of
markdown entries** (the `kb-data` repo). There is no database and no server —
git is the persistence layer and the markdown files are the source of truth.

## Dispatch first — do only what the verb needs

The first token of `$ARGUMENTS` is the verb: `add`, `search`, or `sync`; the
payload is what remains. If the verb is none of these, tell the user the three
valid verbs and stop (no natural-language fallback in v1).

**Do NOT do any setup up front.** Each verb does exactly the setup it needs:
- `search` — needs nothing first. The helper script resolves `data_dir` and
  validates it itself. Just run it (below).
- `add` — needs `data_dir` (for git) and the spec (to write a valid entry).
- `sync` — needs `data_dir` only.

`data_dir` is the local clone of the **kb-data** repo (holds `entries/` and
`kb.json`), read only from **`~/.claude/kb-config.json`** (key `data_dir`;
resolve `~`). When `add`/`sync` need it, resolve/bootstrap per
[Resolve & bootstrap data_dir](#resolve--bootstrap-data_dir) below.

---

### add — capture knowledge

Payload: the freeform knowledge to store. You draft + review; the bundled
`kb-save.js` helper does ALL the mechanical work (pull, id assignment, write,
manifest bump, commit, push, spec validation) in one allowlisted call.

1. Read the spec at `${CLAUDE_SKILL_DIR}/spec/entry-format.md` — you need it to
   write valid frontmatter. (No need to read `kb.json` or pull — the helper
   handles ids and syncing.)
2. **Find candidate link targets.** To propose `links`, you need the ids of
   related existing entries: run the search helper with terms from the new
   knowledge (`node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js "<term>" ...`) and
   note the `kb-NNNN` ids of genuine matches. Only link to ids it returns.
3. **Draft the entry** (use `id: __ID__` as a placeholder — the helper assigns
   the real id):
   - **`type`** — `decision` if the input states a choice + rationale;
     `lesson_learned` for a debugging insight/gotcha; `pattern_convention` for a
     reusable rule; otherwise `factual_reference`.
   - `title` + a concise markdown body.
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
     for when no directional rel fits *either way* (peer ties, person↔team
     leadership). Torn between two rels in the SAME direction → prefer the weaker.
   - `created`/`updated` = today.
4. **Show the user the drafted entry and proposed links; get confirmation**
   (this is the review step — the whole point of plaintext).
5. On confirmation, pipe the entry to the helper on stdin:
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-save.js --slug "<slug-from-title>"`
   It resolves `data_dir`, pulls (if upstream), assigns a collision-free id,
   validates against the spec (closed enums, no dangling links), writes the
   file, bumps `kb.json`, commits, and pushes. It prints `SAVED kb-NNNN ...`
   with a `push:` line (a failed push keeps the local commit — relay that and
   suggest `/kb sync`). If it prints an `ERROR:` line, fix the entry and retry;
   if the error is about `data_dir`, resolve/bootstrap it (see bottom) first.

### search — recall knowledge

Payload: the query. **Do no setup** — no config read, no `data_dir` check, no
pull, no spec, no file reads. The helper does all of that. Two steps only:

1. **Expand the query** into a handful of synonyms / related terms yourself —
   this is how we recover semantic recall without embeddings (e.g. a query about
   "shipping" should also try "deploy", "release", "pipeline"). Then run the
   helper in the SAME step, passing each term as a separate argument:
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js "<term1>" "<term2>" ...`
   The helper resolves `data_dir` from the config, parses entry frontmatter (no
   grep), scores matches (title > tag > body), and prints ranked results. The
   top hits include their **full body**, and `links:` are resolved to target
   titles — so you have everything to answer AND to offer related entries in one
   call. Special outputs: `NO_MATCHES` (nothing matched) or a line starting
   `ERROR:` — only THEN resolve/bootstrap `data_dir` (see bottom) and retry.
2. Answer the user's question directly from the returned content (the top hits'
   full bodies are already present — do NOT read files again). Then, if useful,
   mention the resolved `links:` as related entries to explore. Only read a full
   file or walk a link further if the user asks.

### sync — reconcile

No payload.

0. Resolve/bootstrap `data_dir` (see bottom).
1. `git -C <data_dir> pull` then `git -C <data_dir> push`.
2. Report: pulled changes, pushed pending commits, or "already up to date".
   Surface merge conflicts to the user rather than auto-resolving.

---

## Resolve & bootstrap data_dir

(Only `add` and `sync` need this; `search`'s helper does its own resolution.)

Read `data_dir` from `~/.claude/kb-config.json` (resolve `~`). Then:

1. **Path exists and IS a git repo** → use it.
2. **Config/key missing** → ask the user for the path. Then apply 3/4 below, and
   write `{"data_dir": "<path>"}` to `~/.claude/kb-config.json`.
3. **Path does NOT exist** → offer to create+init: `mkdir -p <path>`, `git init`,
   create `entries/` and `kb.json` (`{"schema_version": 1, "next_id": 1}`).
4. **Path exists but is NOT a git repo** → offer to `git init` in place and
   create `entries/` + `kb.json` if absent.

Always confirm before creating/initializing. No remote is set — that's the
user's to add later for `sync`. Once valid, save the path to the config so
future calls read it directly.

## Rules

- **Never invent `type` or `rel` values** outside the closed enums in the spec.
- **Never write the inverse of a link** on the target entry (edges are directed,
  stored once).
- **Never commit secrets/credentials** — git history is permanent.
- Keep one entry per file; one logical fact per entry.
- All git operations use `-C <data_dir>` so they run against the data repo
  regardless of the session's current directory.
