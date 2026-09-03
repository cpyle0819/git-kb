---
name: git-kb
description: Search and maintain a git-backed markdown knowledge base, with a plugin hook that can inject matching entries into prompt context automatically.
---

# git-kb — git-backed knowledge base

You are operating the user's personal knowledge base. It is a **git repo of
markdown entries** (the `kb-data` repo). There is no database and no server —
git is the persistence layer and the markdown files are the source of truth.

## Two ways the KB surfaces

1. **Automatic retrieval (the hook).** `../../scripts/kb-trigger.js` runs on every
   `UserPromptSubmit` (wired via `../../hooks/codex-hooks.json`). It tokenizes the prompt,
   checks it against `kb-index.json`, and — if ≥2 distinct keywords hit
   (`THRESHOLD`, default 2) — injects the matching entries as `additionalContext`.
   **This is automatic; you never invoke it.** Fewer than 2 keyword hits, or a
   prompt matching `SKIP_PATTERNS` (mechanical prompts like `git …` and slash
   commands) → it emits nothing and the prompt passes through untouched. This is
   the mechanism behind "automatic knowledge-base retrieval for every prompt."
   The exact defaults and the full skip-pattern list are in the README's
   **"Tuning the auto-trigger"** section. Beyond keyword overlap, entries can
   opt into **retrieval beyond keywords** — `kernel: true` (inject the entry's
   full body on every prompt, exempt from dedup — the always-resident house-style
   block) or `applies_to: [<activity>]` (inject a title pointer on prompts of a
   matching *kind of work*, e.g. writing rules on any authoring prompt, subject to
   dedup) — so guidance surfaces even when the prompt names none of its keywords.
   Set these when drafting via `add`/`edit` (see `references/writing.md`).
2. **The skill verbs (below).** Explicit `init` / `add` / `search` / `edit` /
   `get`.

When you need one of these operations, invoke this skill directly or run the
bundled scripts under `../../scripts/` via `../../scripts/run-node.sh`. Do not
do speculative setup before dispatching; each verb handles only the work it
needs.

## Dispatch first — do only what the verb needs

The first token of the skill input is the verb: `init`, `add`, `search`, `edit`, or
`get`; the payload is what remains. If the verb is none of these, tell the
user the valid verbs and stop (no natural-language fallback in v1).

**Do NOT do any setup up front.** Each verb does exactly the setup it needs:

- **`search`** — recall knowledge. Needs nothing first; the helper resolves and
  validates `data_dir` itself. Handled inline below.
- **`get`** — fetch one or more already-known entries by id. Needs nothing
  first. Handled inline below.
- **`add`** — capture knowledge. Read [`references/writing.md`](references/writing.md)
  and follow the `add` section.
- **`edit`** — change an existing entry in place (factual corrections /
  refinements). Read [`references/writing.md`](references/writing.md) and follow
  the `edit` section.
- **`init`** — the one explicit setup step: point the KB at its `data_dir`.
  Read [`references/init.md`](references/init.md).

`data_dir` is the local clone of the **kb-data** repo (holds `entries/`, the
`kb.json` manifest, and the generated `kb-index.json` search index), read from
the first available config file in this order:

- `<plugin data>/kb-config.json` when a hook process runs with plugin env vars
- `~/.codex/git-kb/kb-config.json`
- legacy `~/.claude/kb-config.json`

The helpers resolve this path themselves, which is why `search`/`add`/`edit`
need no config read before invoking them. `init` should write the shared Codex
fallback file at `~/.codex/git-kb/kb-config.json`. For direct script runs, you
can pin a specific config file with `KB_CONFIG_PATH=/path/to/kb-config.json`.

**Not configured yet?** `search`/`get`/`add`/`edit` each run a helper that resolves
`data_dir` itself. If a helper exits with a `data_dir` `ERROR:` (config missing,
path absent, or not a valid repo), stop and point the user to `$git-kb init`:

> KB isn't set up yet. Run `$git-kb init` to point it at your kb-data repo
> (clone URL, an existing local clone, or a new repo).

---

## search — recall knowledge

Payload: the query. **Do no setup** — no config read, no `data_dir` check, no
pull, no file reads. The helper does all of that. Two steps only:

1. **Expand the query** into a handful of synonyms / related terms yourself —
   this is how we recover semantic recall without embeddings (e.g. a query about
   "shipping" should also try "deploy", "release", "pipeline"). Then run the
   helper in the SAME step, passing each term as a separate argument:
   `../../scripts/run-node.sh ../../scripts/kb-search.js "<term1>" "<term2>" ...`
   **Optional filter:** add `--type <type>` to restrict results to a single entry
   type (e.g. `--type bookmark "*"` lists all bookmarks; `--type decision "*"`
   lists all decisions). Use `"*"` as the term to list all matching the type
   without further keyword filtering. The `--type` value is case-sensitive
   lowercase — `lesson_learned` works, `LessonLearned` silently returns nothing.
   The helper resolves `data_dir` from the config, parses entry frontmatter (no
   grep), scores matches (title > tag > url > body), and prints ranked results.
   The top hits include their **full body**, and `links:` are resolved to target
   titles — so you have everything to answer AND to offer related entries in one
   call. An entry with no outgoing links has **no `links:` line at all** (the
   field is omitted, not printed empty) — a missing `links:` line means the entry
   genuinely has none, not that the field was dropped. Special outputs: `NO_MATCHES` (nothing matched) or a line starting
   `ERROR:` — a `data_dir` `ERROR:` means setup is incomplete; stop and point
   the user to `$git-kb init`.
2. Answer the user's question directly from the returned content (the top hits'
   full bodies are already present — do NOT read files again). Then, if useful,
   mention the resolved `links:` as related entries to explore. Only read a full
   file or walk a link further if the user asks.
   **For bookmarks:** always show the actual FULL `url:` value from the output —
   that IS the entry's primary content. Never substitute a description for the
   URL, and never truncate URLs (no `…`). Present bookmark lists as a flat
   list (not a table) so URLs have room and are copy-pasteable.

---

## get — fetch known entries by id

Payload: one or more `kb-NNNN` ids. Use this whenever you already know the
id — e.g. following a `links:`/`[[kb-XXXXX]]` reference from an entry already
in context, or a hook-injected list of ids — instead of guessing keywords for
`search`. **Do no setup** — the helper resolves `data_dir` itself.

`../../scripts/run-node.sh ../../scripts/kb-get.js kb-0065 kb-0053 ...`

It prints each entry's full body (frontmatter + body + resolved `links:`), in
the order requested. An unknown ID prints a `NOT FOUND` line and does **not**
fail the run — the entries that exist are still returned. A `data_dir` `ERROR:`
means setup is incomplete; stop and point the user to `$git-kb init`. Prefer this
over `search` whenever you have the exact ID: search can rank the wrong entry
first or miss on keywords, but a get by ID is exact.

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
