# kb

A Claude Code plugin for maintaining a personal knowledge base in plain markdown
and git. Entries live in a separate private `kb-data` repo; this repo is the
system — skill definition, scripts, hook, and spec.

No database, no server, no embeddings. Git is the persistence layer. Search is
lexical with LLM query expansion at invocation. A `links:` block in frontmatter
models a lightweight knowledge graph (5-rel closed vocab, directed edges,
traversed at search time).

## Two layers of access

**Automatic (hook).** A `UserPromptSubmit` hook tokenizes every prompt against a
keyword index built from entry tags and titles. When 2+ keywords match, the top
results inject as context before Claude responds. <10ms on non-matching prompts;
~50–100ms when it fires. Never fires on short or mechanical prompts (commits,
slash commands, lint fixes). The index rebuilds after every add/edit.

**Intentional (skill).** `/kb search <query>` with full LLM query expansion for
semantic recall. `/kb add`, `/kb edit` for writes.

## Install

```
ln -s "$PWD" ~/.claude/skills/kb
```

Then `/kb init` — it asks for the `kb-data` repo (clone URL, existing local
clone, or new), builds the keyword index, and you're done. The plugin manifest
(`.claude-plugin/plugin.json`) makes Claude Code discover the hook on next
session start without any settings.json edits.

## Layout

```
.claude-plugin/plugin.json   plugin manifest (hook auto-discovery)
hooks/hooks.json             UserPromptSubmit → kb-trigger.js
SKILL.md                     /kb skill (init / add / search / edit)
spec/entry-format.md         entry schema (types, rels, frontmatter)
scripts/
  kb-trigger.js              hook: tokenize prompt, check index, inject context
  kb-build-index.js          rebuild keyword→id map from entry frontmatter
  kb-search.js               lexical search, ranked by field weight
  kb-save.js                 validate + write + commit + push + rebuild index
```

## Usage

| Command | Effect |
|---|---|
| `/kb init` | One-time setup: wire data repo, build index |
| `/kb add <knowledge>` | Draft + save + commit + push an entry |
| `/kb search <query>` | Ranked search with query expansion |
| `/kb edit <id or desc> <change>` | Modify an entry in place |

## Tuning the auto-trigger

In `scripts/kb-trigger.js`:

- `THRESHOLD` (default 2) — distinct keyword hits required to fire
- `MAX_CONTEXT_ENTRIES` (default 5) — entries injected per match
- `SKIP_PATTERNS` — regex array of prompts that never trigger

## Trade-offs

- vs. **vector/embedding RAG**: no model dependency, no reindex on model change,
  no binary artifacts. Recall depends on tags + LLM expansion rather than learned
  similarity. At personal scale (<5000 entries) brute lexical search is faster
  than an embedding lookup.
- vs. **DB-backed MCP servers**: no daemon, no binary store, no schema
  migrations. Data is fully portable markdown. Gives up hybrid BM25+vector
  scoring and multi-hop retrieval loops.
- vs. **graph databases**: no infra, no query language. Edges are explicit and
  reviewable in diffs. Traversal is shallow (1-hop at search).
