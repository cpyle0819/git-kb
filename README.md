# kb-system

A git-backed personal knowledge base, packaged as a Claude Code **skill** (`/kb`).
Pairs with a separate, private `kb-data` repo that holds the actual entries.

## Layout (this repo IS the skill directory)

- `SKILL.md` — the `/kb` skill (add / search / edit / sync). `${CLAUDE_SKILL_DIR}`
  resolves to this directory, so the bundled spec and scripts are always findable.
- `spec/entry-format.md` — the entry file-format contract (closed enums for type
  and rel, frontmatter schema, file-naming rules).
- `scripts/` — Node.js helpers (allowlisted via `allowed-tools`):
  - `kb-search.js` — parses all entries, scores by field, prints ranked results.
  - `kb-save.js` — writes/validates/commits/pushes entries (add + edit modes).
  - `kb-sync.js` — pull + push, or first-time remote setup.

## Install

1. Symlink (or clone) this repo as a personal skill:
   `ln -s "$PWD" ~/.claude/skills/kb`
2. Run `/kb add <knowledge>` (or any verb). On first use it asks where your
   `kb-data` repo lives and saves the answer to `~/.claude/kb-config.json`.
   It will create + `git init` the repo for you if the path doesn't exist (or
   isn't yet a repo) — confirming first.

`data_dir` comes only from `~/.claude/kb-config.json` (key `data_dir`). You can
pre-write it yourself: `{ "data_dir": "/path/to/kb-data" }`.

**Remote / sync:** `kb-data` starts local-only. The first time you run `/kb
sync` with no remote, the skill asks you for a remote URL and wires it up (`git
remote add` + push). The URL always comes from you — for sensitive content, use
a private/internal git host. The skill never invents or guesses a remote.

## Usage

| Command | What it does |
|---|---|
| `/kb add <knowledge>` | Draft an entry from freeform text (or a file/URL), confirm, commit+push. |
| `/kb search <query>` | Lexical search with query expansion; returns ranked results with full bodies. Use `--type bookmark` to filter. |
| `/kb edit <id or description> <change>` | Modify an existing entry in place (factual corrections). For replaced decisions, use `add` with a `supersedes` link instead. |
| `/kb sync` | Pull + push. On first run with no remote, offers to wire one up. |

## Design

No database, no server, no embeddings. Retrieval is lexical (Node.js reads all
entries, parses frontmatter, scores term matches per field) + graph traversal
over curated `links:` in entry frontmatter. Git is the persistence layer;
history comes free from `git log`.
