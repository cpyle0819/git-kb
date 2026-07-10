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
keyword index built from entry tags and titles. When 2+ keywords match (or a
cross-cutting signal fires), it injects the matching entries' **ids and titles**
— not their bodies — with an instruction to fetch the ones the task needs via
`kb-get`. Claude reads the list and pulls the full text of what's relevant. This
IDs-only design is deliberate: see [Gotcha: the 10K hook-output
cap](#gotcha-the-10k-hook-output-cap). <10ms on non-matching prompts; ~50–100ms
when it fires. Never fires on short or mechanical prompts (commits, slash
commands, lint fixes). The index rebuilds after every add/edit.

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
SKILL.md                     /kb skill: dispatch + inline search + rules
references/
  writing.md                 add + edit detail (loaded on those verbs)
  init.md                     setup detail (loaded on init)
spec/entry-format.md         entry schema (types, rels, frontmatter)
scripts/
  kb-trigger.js              hook: tokenize prompt, check index, inject context
  kb-build-index.js          rebuild keyword→id map from entry frontmatter
  kb-search.js               lexical search, ranked by field weight
  kb-get.js                  fetch entries by ID, printed verbatim
  kb-save.js                 validate + write + commit + push + rebuild index
  shared.js                  config resolution + entry parse/load helpers
workflows/
  test-skill.js              /kb:test-skill — fresh-eyes test harness (see below)
```

## Usage

| Command | Effect |
|---|---|
| `/kb init` | One-time setup: wire data repo, build index |
| `/kb add <knowledge>` | Draft + save + commit + push an entry |
| `/kb search <query>` | Ranked search with query expansion |
| `kb-get.js <id>…` | Fetch known entries by ID verbatim (follow `[[kb-XXXXX]]` links) |
| `/kb edit <id or desc> <change>` | Modify an entry in place |
| `/kb:test-skill` | Fresh-eyes test of the skill (see below) |

**Automatic retrieval has no command.** Once `/kb init` has run, the
`UserPromptSubmit` hook fires on every prompt with no action from you — see
[Two layers of access](#two-layers-of-access). The `/kb` verbs are the only
part you invoke explicitly; the hook is always-on background context injection.

**Per-session dedup.** When the hook surfaces an entry id, it records that id in
a per-session ledger under the temp dir, so a later prompt that matches the same
entry does not list it again — each id appears in a session at most once. Paired
with the IDs-only design, that bounds the cost of the extra fetch: Claude pulls a
given entry's body at most once per session, not on every matching prompt. Any
add/edit rebuilds the index, which resets the ledger, so new or changed entries
resurface. A fresh session starts with an empty ledger.

## Testing the skill

`/kb:test-skill` runs an isolated, self-verifying test of the whole skill. It:

1. **Setup** — creates a throwaway scratch kb-data repo in a temp dir (via
   `mktemp`) with a temp `CLAUDE_PLUGIN_DATA` config and three seeded entries.
   Your real KB and its remote are never touched; the scratch repo has no
   remote, so pushes resolve harmlessly to `NO_REMOTE`.
2. **Exercise** — two fresh agents that learn the skill only from its docs (read
   once, reused across tasks). A **writer** does the three mutating tasks in
   order (add a decision, add a bookmark, edit an entry — serial, since they
   share one git repo); a **reader** runs concurrently doing the five read-only
   tasks (search by keyword, search with `--type`, firing the auto-trigger hook
   with a matching and a non-matching prompt, and verifying per-session
   injection caching dedups repeats and re-fires after a KB change).
3. **Verify** — one adversarial agent inspects the final scratch-repo state
   (git log, entry files, re-run search/trigger) to confirm every outcome,
   rather than trusting the test agents' self-reports.
4. **Teardown** — removes the scratch dirs (runs even if a test throws).

Five agents total (setup + writer + reader + verify + teardown), keeping
per-test pass/fail granularity while avoiding redundant doc-reads.

The report gives pass/fail per test plus **doc-followability friction** — every
point where a fresh agent found the docs ambiguous or had to guess. That
friction is the signal for improving SKILL.md and the reference files.

## Tuning the auto-trigger

In `scripts/kb-trigger.js`:

- `THRESHOLD` (default 2) — distinct keyword hits required to fire the keyword path
- `MAX_CONTEXT_ENTRIES` (default 5) — cap on **keyword-ranked** ids listed per
  prompt. Cross-cutting ids (always-on + activity-matched) are listed uncapped —
  the output is ids only, so it can't approach the hook-output cap regardless.
- `SKIP_PATTERNS` — regex array of prompts that never trigger

In `scripts/shared.js`:

- `ACTIVITY_LEXICON` — activity → trigger-word map used to classify a prompt's
  *kind of work*. Extend a list when a cross-cutting entry should have fired but
  didn't (a false negative).

### Cross-cutting retrieval (beyond keywords)

Keyword overlap misses entries relevant to a *kind of work* the prompt never
names (writing-style rules on "reply to this thread"). Two optional frontmatter
fields close that gap, both honored by the hook and gated by the same
per-session dedup ledger as keyword matches (so an entry injects at most once
per session):

- `applies_to: [writing|reviewing|planning|coding, …]` — inject when the prompt's
  classified activity matches, at zero keyword overlap.
- `always: true` — inject on every non-skipped prompt.

Cross-cutting entries are listed ahead of keyword matches and are not subject to
`MAX_CONTEXT_ENTRIES`, so keyword noise can't starve them. See
[`spec/entry-format.md`](spec/entry-format.md) for the field contract and when to
use each.

## Gotcha: the 10K hook-output cap

Claude Code hard-caps a `UserPromptSubmit` hook's `additionalContext` at **10,000
characters**. Output over the cap is written to a file in the session directory
and replaced in-context with a blind ~2KB preview — the harness cuts at a byte
offset, so whole entries past the cut vanish mid-stream and Claude never sees
them. The cap is **not configurable**: there is no settings.json key and no
environment variable for it (`BASH_MAX_OUTPUT_LENGTH` governs Bash tool output,
not hooks). Confirmed against Claude Code docs, *Hooks → Output size limit and
truncation*.

**Why this bites the obvious design.** Injecting entry bodies is the tempting
approach, but a handful of full entries easily exceeds 10K (the writing suite
alone ran ~26KB). The overflow then truncates to a 2KB preview whose cut point is
arbitrary — so the entries the classifier ranked *first* can be exactly the ones
dropped, and silently. The careful cross-cutting-first ordering buys nothing once
the harness truncates.

**How this hook avoids it.** It injects **ids and titles only**, never bodies,
and instructs Claude to fetch the entries it needs with `kb-get`. A list of ids
is a few hundred to ~1–2K chars even with dozens of entries, so it always lands
intact under the cap. The bodies arrive on demand, in full, un-truncated. Paired
with per-session dedup, an entry's id is listed at most once per session, so the
fetch is paid once, not per prompt.

**If you change the hook to emit anything sized with content** (bodies,
summaries, long headers), keep the assembled `additionalContext` under ~9,000
chars yourself and degrade the remainder to ids — do not let the harness be the
thing that truncates, because its cut is blind and silent.

### Observability

Set `KB_HOOK_DEBUG=1` to append a per-prompt JSONL record to
`<tmpdir>/kb-hook-cache/debug.jsonl`: keyword hits, detected activities, surfaced
ids (with which signal surfaced each), and near-misses — keyword hits below
`THRESHOLD`, and the reason nothing surfaced (`no_signal` / `all_deduped`). This
makes a non-surfaced entry observable instead of silent, so retrieval quality can
be measured. Off by default; the non-match path stays a pure in-memory index lookup.

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
