---
name: kb
description: Manage a git-backed personal knowledge base (add / search / sync). Invoke for "/kb add <knowledge>", "/kb search <query>", "/kb sync".
argument-hint: <verb> <content>   # verb = add|search|sync
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js *)
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

Payload: the freeform knowledge to store.

0. Resolve/bootstrap `data_dir` (see bottom). Read the spec at
   `${CLAUDE_SKILL_DIR}/spec/entry-format.md` — you need it to write a valid entry.
1. **Pull first** so ids and links are current: `git -C <data_dir> pull --quiet`
   (if it fails — offline — note it and continue; do not abort capture).
2. Read `kb.json` for `next_id` → candidate id `kb-NNNN` (zero-padded, 4 digits).
   **Verify no entry with that id already exists** (`ls entries/` or grep the
   id); if it does, advance to the next free id. This guards against duplicate
   ids when the repo was edited on another machine.
3. Draft the entry per the spec:
   - **`type`** — pick the closed value that fits: `decision` if the input states
     a choice + rationale; `lesson_learned` for a debugging insight/gotcha;
     `pattern_convention` for a reusable rule; otherwise `factual_reference`.
   - Write `title` + a concise markdown body from the user's input.
   - Propose `tags` (free-form).
   - Propose `links` to existing entries — only the closed `rel` set, only `to:`
     ids you have confirmed exist (grep entries first). **`rel` guidance:**
     use `supersedes` ONLY when `to:` is the specific entry being replaced
     (don't use it for "this changes a thing some factual entry describes" — if
     the replaced thing has no entry of its own, use `relates_to`); `part_of`
     for component-of; `depends_on` for requires/builds-on; `mentions` for a
     passing reference; `relates_to` as the generic fallback when none fit
     cleanly. When in doubt between two, prefer the weaker (`relates_to`).
   - Set `created`/`updated` to today.
4. **Show the user the drafted file and proposed links. Get confirmation**
   before writing (this is the review step — the whole point of plaintext).
5. Write `entries/kb-NNNN-<slug>.md`. Set `next_id` in `kb.json` to the id you
   used + 1.
6. Commit BOTH files together:
   `git -C <data_dir> add entries/kb-NNNN-<slug>.md kb.json`
   `git -C <data_dir> commit -m "add kb-NNNN: <title>"`
7. Push: `git -C <data_dir> push`. **If push fails (offline/auth/diverged), keep
   the local commit and tell the user it's committed-but-not-pushed; suggest
   `/kb sync` later.** Capture must never fail just because the remote is down.

### search — recall knowledge

Payload: the query. **Do no setup** — no config read, no `data_dir` check, no
pull, no spec, no file reads. The helper does all of that. Two steps only:

1. **Expand the query** into a handful of synonyms / related terms yourself —
   this is how we recover semantic recall without embeddings (e.g. a query about
   "shipping" should also try "deploy", "release", "pipeline"). Then run the
   helper in the SAME step, passing each term as a separate argument:
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js "<term1>" "<term2>" ...`
   The helper resolves `data_dir` from the config, parses entry frontmatter (no
   grep), scores matches (title > tag > body), and prints ranked results with
   `id / title / type / tags / snippet / links`. Special outputs: `NO_MATCHES`
   (nothing matched) or a line starting `ERROR:` — only THEN resolve/bootstrap
   `data_dir` (see bottom) and retry.
2. Present the results as-is (already ranked and compact). The snippet and
   `links:` targets are included, so **only read a full entry or walk a link if
   the user asks** — do not pre-read files.

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
