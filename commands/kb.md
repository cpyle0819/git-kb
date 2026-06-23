---
description: Manage the git-backed personal knowledge base (add / search / sync)
argument-hint: add <knowledge> | search <query> | sync
---

# /kb — git-backed knowledge base

You are operating the user's personal knowledge base. It is a **git repo of
markdown entries** (the `kb-data` repo). There is no database and no server —
git is the persistence layer and the markdown files are the source of truth.

## Configuration

All paths come from a fixed-location config file: **`~/.claude/kb-config.json`**
(machine-local; never committed). Read it first. It has two keys:

- `system_dir` — the kb-system repo clone (holds `spec/entry-format.md`).
- `data_dir` — the kb-data repo clone (holds `entries/` and `kb.json`).

If the file or either key is missing, ask the user for the path(s) once, write
them to `~/.claude/kb-config.json`, then continue. Resolve `~` in the values.

If `data_dir` does not exist or is not a git repo, stop and tell the user to
clone their `kb-data` repo there — do not improvise a location.

The entry file format is defined in `<system_dir>/spec/entry-format.md`. **For
`add` and `search`, read that spec first** — it is the authoritative contract
(file naming, frontmatter fields, the closed `type` and `rel` enums, edge rules,
`kb.json`). `sync` neither writes nor parses entries, so it does not need the spec.

## Dispatch

`$ARGUMENTS` begins with a verb: `add`, `search`, or `sync`. The rest is the
payload. If the first word is none of these, tell the user the three valid verbs
and stop (no natural-language fallback in v1).

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
