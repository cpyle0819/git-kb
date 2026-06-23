# kb-system

A git-backed personal knowledge base, packaged as a Claude Code **skill** (`/kb`).
Pairs with a separate, private `kb-data` repo that holds the actual entries — so
you can share this system without sharing your data.

## Layout (this repo IS the skill directory)
- `SKILL.md` — the `/kb` skill (add / search / sync). `${CLAUDE_SKILL_DIR}`
  resolves to this directory, so the bundled spec is always findable.
- `spec/entry-format.md` — the entry file-format contract (bundled; read by the
  skill via `${CLAUDE_SKILL_DIR}/spec/entry-format.md`).

## Install
1. Symlink (or clone) this repo as a personal skill:
   `ln -s "$PWD" ~/.claude/skills/kb`
2. Create your private `kb-data` repo (on an internal/private host if the
   content is sensitive) and clone it locally.
3. Tell `/kb` where the data lives, either:
   - per call: `/kb <verb> <data_dir> <content>` (path-like first arg), or
   - once: write `~/.claude/kb-config.json` → `{ "data_dir": "/path/to/kb-data" }`
4. Use it: `/kb add <knowledge>`, `/kb search <query>`, `/kb sync`.

`data_dir` resolution order: argument (if path-like) > `~/.claude/kb-config.json`
> prompt. The first form, when given, is persisted to the config.

## Design
No database, no server, no embeddings. Retrieval is lexical (`git grep`) +
graph traversal over curated `links:` in entry frontmatter. Git is the
persistence layer; history comes free from `git log`.
