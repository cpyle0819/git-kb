# kb-system

The shareable system for a git-backed personal knowledge base, driven by a
`/kb` Claude Code command. Pairs with a separate, private `kb-data` repo that
holds the actual entries — so you can share this idea without sharing your data.

## Layout
- `commands/kb.md` — the `/kb` slash command (add / search / sync)
- `spec/entry-format.md` — the entry file-format contract

## Install
1. Symlink the command so Claude Code sees it:
   `ln -sf "$PWD/commands/kb.md" ~/.claude/commands/kb.md`
2. Create your private `kb-data` repo (on an internal/private host if the
   content is sensitive) and clone it locally.
3. Write `~/.claude/kb-config.json`:
   ```json
   { "system_dir": "/path/to/kb-system", "data_dir": "/path/to/kb-data" }
   ```
4. Use it: `/kb add <knowledge>`, `/kb search <query>`, `/kb sync`.

## Design
No database, no server, no embeddings. Retrieval is lexical (`git grep`) +
graph traversal over curated `links:` in entry frontmatter. Git is the
persistence layer; history comes free from `git log`.
