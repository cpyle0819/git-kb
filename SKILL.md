---
name: kb
description: Manage a git-backed personal knowledge base (add / search / sync). Invoke for "/kb add <knowledge>", "/kb search <query>", "/kb sync".
argument-hint: <verb> <content>   # verb = add|search|sync
---

# /kb — git-backed knowledge base

You are operating the user's personal knowledge base. It is a **git repo of
markdown entries** (the `kb-data` repo). There is no database and no server —
git is the persistence layer and the markdown files are the source of truth.

## The entry-format spec (bundled with this skill)

The authoritative entry contract lives **next to this file** at
`${CLAUDE_SKILL_DIR}/spec/entry-format.md` (file naming, frontmatter fields, the
closed `type` and `rel` enums, edge rules, `kb.json`). **For `add` and `search`,
read it first.** `sync` neither writes nor parses entries, so it can skip it.

## Resolve the data directory (`data_dir`)

`data_dir` is the local clone of the **kb-data** repo (holds `entries/` and
`kb.json`). It is machine-specific and comes only from
**`~/.claude/kb-config.json`** (key `data_dir`). Resolve `~` in the value.

**If the config file is missing, or has no `data_dir`:** ask the user for the
path, then bootstrap it (see below). Do not improvise a location.

**Validate / bootstrap the resolved path** before doing any verb work:

1. **Path exists and IS a git repo** → use it. (If it came from a fresh prompt,
   first write `{"data_dir": "<path>"}` to `~/.claude/kb-config.json`.)
2. **Path does NOT exist** → offer to create and initialize it: `mkdir -p
   <path>`, `git init`, create `entries/` and `kb.json`
   (`{"schema_version": 1, "next_id": 1}`). On confirmation, do it, then write
   the config. (No remote is set — that's the user's to add later for sync.)
3. **Path exists but is NOT a git repo** → offer to initialize it in place:
   `git init` and create `entries/` + `kb.json` if absent. On confirmation, do
   it, then write the config.

Always confirm with the user before creating/initializing anything. Once
`data_dir` is valid and saved, future calls read it straight from the config.

## Dispatch

After `data_dir` is resolved and valid, the first token of `$ARGUMENTS` is the
verb: `add`, `search`, or `sync`. The payload is what remains. If the verb is
none of these, tell the user the three valid verbs and stop (no natural-language
fallback in v1).

---

### add — capture knowledge

Payload: the freeform knowledge to store.

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

Payload: the query.

1. `git -C <data_dir> pull --quiet` (best-effort; continue if offline).
2. **Expand the query** into a handful of synonyms / related terms yourself —
   this is how we recover semantic recall without embeddings. (e.g. a query
   about "shipping" should also try "deploy", "release", "pipeline".)
3. Search with `git grep` over the entries (fall back to `grep -r` if `git grep`
   is unavailable), case-insensitive. `git grep` already scans the whole file,
   so frontmatter tags and body are covered in one pass:
   `git -C <data_dir> grep -i -l -E '<term1|term2|term3>' -- 'entries/*.md'`
4. Rank hits (title/tag match > body match; more distinct terms matched > fewer).
   For the top hits, read the files and **walk `links:` one hop** to surface
   directly-connected entries the keyword search missed.
5. Present compact results: `kb-NNNN — <title>` + a one-line snippet + why it
   matched (keyword vs. link). Offer to show any entry in full.

### sync — reconcile

No payload.

1. `git -C <data_dir> pull` then `git -C <data_dir> push`.
2. Report: pulled changes, pushed pending commits, or "already up to date".
   Surface merge conflicts to the user rather than auto-resolving.

---

## Rules

- **Never invent `type` or `rel` values** outside the closed enums in the spec.
- **Never write the inverse of a link** on the target entry (edges are directed,
  stored once).
- **Never commit secrets/credentials** — git history is permanent.
- Keep one entry per file; one logical fact per entry.
- All git operations use `-C <data_dir>` so they run against the data repo
  regardless of the session's current directory.
