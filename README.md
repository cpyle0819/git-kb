# kb-system

A git-backed personal knowledge base, packaged as a Claude Code **skill** (`/kb`).
Pairs with a separate, private `kb-data` repo that holds the actual entries.

No database, no server, no embeddings. Entries are plain markdown files with YAML
frontmatter; git is the persistence layer (commit = durable, `git log` = free
history). Search is lexical: a Node.js helper reads all entries, parses
frontmatter, and scores term matches per field — with LLM query expansion at
invocation to recover semantic recall. A curated `links:` block in frontmatter
models a lightweight knowledge graph (typed edges from a closed 5-rel vocab)
traversed at search time for related-entry discovery.

**Trade-offs vs. alternatives:**

- vs. **graph databases** (Neo4j, Neptune): no infra, no query language, no ops —
  but traversal is shallow (1-hop at search, manual for deeper). Graph edges are
  explicit and reviewable in diffs; a graph DB auto-extracts richer structure but
  needs a running service and its edges are opaque.
- vs. **vector/embedding RAG**: no model dependency, no reindexing on model
  change, no binary artifacts — but recall depends on good tags + LLM expansion
  rather than learned similarity. At personal scale (~50–5000 entries), brute
  lexical search in <100ms is faster than an embedding lookup anyway.
- vs. **DB-backed MCP/tool servers** (e.g. SQLite + vector store behind an API):
  no daemon, no binary DB, no write-path code, no schema migrations — but gives
  up hybrid BM25+vector scoring and agentic multi-hop retrieval loops. Data is
  fully portable (any tool that reads markdown can use it); a DB-backed approach
  locks data inside a binary store that only its server can query.

## Layout (this repo IS the skill directory)

- `SKILL.md` — the `/kb` skill (add / search / edit). `${CLAUDE_SKILL_DIR}`
  resolves to this directory, so the bundled spec and scripts are always findable.
- `spec/entry-format.md` — the entry file-format contract (closed enums for type
  and rel, frontmatter schema, file-naming rules).
- `scripts/` — Node.js helpers (allowlisted via `allowed-tools`):
  - `kb-search.js` — parses all entries, scores by field, prints ranked results.
  - `kb-save.js` — writes/validates/commits/pushes entries (add + edit + first-time remote setup).

## Install

1. Symlink (or clone) this repo as a personal skill:
   `ln -s "$PWD" ~/.claude/skills/kb`
2. Run `/kb init` once. It points the KB at its `kb-data` repo — clone an
   existing one from a URL, register a local clone you already have, or start a
   fresh repo — and saves the resolved path to `~/.claude/kb-config.json`. It
   confirms before any clone/init.

`data_dir` comes only from `~/.claude/kb-config.json` (key `data_dir`). You can
pre-write it yourself instead of running init: `{ "data_dir": "/path/to/kb-data" }`.
The other verbs never set it up — if it's missing, they stop and point you at
`/kb init`.

## Usage

| Command                                 | What it does                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/kb init`                              | One-time setup: point the KB at its `kb-data` repo (clone URL, existing local clone, or new repo) and write the config.       |
| `/kb add <knowledge>`                   | Draft an entry from freeform text (or a file/URL), save + commit + push.                                                     |
| `/kb search <query>`                    | Lexical search with query expansion; returns ranked results with full bodies. Use `--type bookmark` to filter.               |
| `/kb edit <id or description> <change>` | Modify an existing entry in place (factual corrections). For replaced decisions, use `add` with a `supersedes` link instead. |
