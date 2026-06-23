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
2. Run `/kb add <knowledge>` (or any verb). On first use it asks where your
   `kb-data` repo lives and saves the answer to `~/.claude/kb-config.json`.
   It will create + `git init` the repo for you if the path doesn't exist (or
   isn't yet a repo) — confirming first.

`data_dir` comes only from `~/.claude/kb-config.json` (key `data_dir`). You can
pre-write it yourself: `{ "data_dir": "/path/to/kb-data" }`. If the content is
sensitive, host the `kb-data` remote on a private/internal git server and add
it with `git remote add origin <url>`; the skill never sets a remote for you.

## Design
No database, no server, no embeddings. Retrieval is lexical (`git grep`) +
graph traversal over curated `links:` in entry frontmatter. Git is the
persistence layer; history comes free from `git log`.
