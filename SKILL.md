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

## Two ways the KB surfaces

1. **Automatic retrieval (the hook).** `scripts/kb-trigger.js` runs on every
   `UserPromptSubmit` (wired via `hooks/hooks.json`). It tokenizes the prompt,
   checks it against `kb-index.json`, and — if ≥2 distinct keywords hit — injects
   the matching entries as `additionalContext`. **This is automatic; you never
   invoke it.** No match (or a skip-pattern prompt like `git …`) → it emits
   nothing and the prompt passes through untouched. This is the mechanism behind
   "automatic knowledge-base retrieval for every prompt." Tuning notes live in
   the README.
2. **The `/kb` verbs (below).** Explicit `init` / `add` / `search` / `edit`.

## Dispatch first — do only what the verb needs

The first token of `$ARGUMENTS` is the verb: `init`, `add`, `search`, or
`edit`; the payload is what remains. If the verb is none of these, tell the
user the valid verbs and stop (no natural-language fallback in v1).

**Do NOT do any setup up front.** Each verb does exactly the setup it needs:

- **`search`** — recall knowledge. Needs nothing first; the helper resolves and
  validates `data_dir` itself. Handled inline below.
- **`add`** — capture knowledge. Read [`references/writing.md`](references/writing.md)
  and follow the `add` section.
- **`edit`** — change an existing entry in place (factual corrections /
  refinements). Read [`references/writing.md`](references/writing.md) and follow
  the `edit` section.
- **`init`** — the one explicit setup step: point the KB at its `data_dir` and
  write `${CLAUDE_PLUGIN_DATA}/kb-config.json`. Read
  [`references/init.md`](references/init.md).

`data_dir` is the local clone of the **kb-data** repo (holds `entries/` and
`kb.json`), read from **`${CLAUDE_PLUGIN_DATA}/kb-config.json`** (key `data_dir`;
resolve `~`). It is set up only by `init`.

**Not configured yet?** `search`/`add`/`edit` each run a helper that resolves
`data_dir` itself. If a helper exits with a `data_dir` `ERROR:` (config missing,
path absent, or not a valid repo), stop and point the user to `/kb init`:

> KB isn't set up yet. Run `/kb init` to point it at your kb-data repo
> (clone URL, an existing local clone, or a new repo).

---

## search — recall knowledge

Payload: the query. **Do no setup** — no config read, no `data_dir` check, no
pull, no file reads. The helper does all of that. Two steps only:

1. **Expand the query** into a handful of synonyms / related terms yourself —
   this is how we recover semantic recall without embeddings (e.g. a query about
   "shipping" should also try "deploy", "release", "pipeline"). Then run the
   helper in the SAME step, passing each term as a separate argument:
   `node ${CLAUDE_SKILL_DIR}/scripts/kb-search.js "<term1>" "<term2>" ...`
   **Optional filter:** add `--type <type>` to restrict results to a single entry
   type (e.g. `--type bookmark "*"` lists all bookmarks; `--type decision "*"`
   lists all decisions). Use `"*"` as the term to list all matching the type
   without further keyword filtering. The `--type` value is case-sensitive
   lowercase — `lesson_learned` works, `LessonLearned` silently returns nothing.
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

## Rules

- **Never invent `type` or `rel` values** outside the closed enums in the spec.
- **Never write the inverse of a link** on the target entry (edges are directed,
  stored once).
- **Never commit secrets/credentials** — git history is permanent.
- Keep one entry per file; one logical fact per entry.
- **State what a thing IS, not what it isn't.** Write positively. If someone is
  _not_ a manager, don't say "not a manager" — say their actual role.
- **Minimize tool calls.** The search helper already returns full bodies + link
  titles. Do not re-read files the helper already returned.
- All git operations use `-C <data_dir>` so they run against the data repo
  regardless of the session's current directory.
