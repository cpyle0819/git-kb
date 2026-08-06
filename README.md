# git-kb

A Claude Code plugin for maintaining a personal knowledge base in plain markdown
and git. Entries live in a separate private `kb-data` repo; this repo is the
system — skill definition, scripts, hook, and spec.

No database, no server, no embeddings. Git is the persistence layer. Search is
lexical with LLM query expansion at invocation. A `links:` block in frontmatter
models a lightweight knowledge graph (5-rel closed vocab, directed edges,
traversed at search time).

## Three layers of access

**Automatic (retrieval hook).** A `UserPromptSubmit` hook tokenizes every prompt
against a keyword index built from entry tags and titles. It surfaces context in
two shapes. Keyword and activity matches inject **ids and titles** — not their
bodies — with an instruction to fetch the ones the task needs via `kb-get`;
Claude reads the list and pulls the full text of what's relevant. This pointer
design is deliberate: see [Gotcha: the 10K hook-output
cap](#gotcha-the-10k-hook-output-cap). Separately, entries flagged `kernel: true`
have their full **body** injected verbatim on every prompt, exempt from dedup —
the small always-resident house-style block (kept short so it stays under the
cap). <10ms on non-matching prompts; ~50–100ms when it fires. Never fires on
short or mechanical prompts (commits, slash commands, lint fixes). The index
rebuilds after every add/edit.

**Enforcement (prose-judge hook).** A `PreToolUse` hook judges a prose artifact
about to be published — a code-review description, commit message, ticket, or
comment — against the kernel rules, and denies the tool call on violation so bad
prose never reaches the server. Retrieval puts the rules in front of the model;
this gates the output against them. See [The prose judge](#the-prose-judge).

**Intentional (skill).** `/git-kb search <query>` with full LLM query expansion for
semantic recall. `/git-kb add`, `/git-kb edit` for writes.

## Install

```
ln -s "$PWD" ~/.claude/skills/git-kb
```

Then `/git-kb init` — it asks for the `kb-data` repo (clone URL, existing local
clone, or new), builds the keyword index, and you're done. The plugin manifest
(`.claude-plugin/plugin.json`) makes Claude Code discover the hook on next
session start without any settings.json edits.

## Layout

```
.claude-plugin/plugin.json   plugin manifest (hook auto-discovery)
hooks/hooks.json             UserPromptSubmit → kb-trigger.js; PreToolUse → kb-prose-judge.js
SKILL.md                     /git-kb skill: dispatch + inline search + rules
references/
  writing.md                 add + edit detail (loaded on those verbs)
  init.md                     setup detail (loaded on init)
spec/entry-format.md         entry schema (types, rels, frontmatter)
scripts/
  kb-trigger.js              hook: tokenize prompt, check index, inject context
  kb-prose-judge.js          hook: judge a prose artifact against the kernel before publish
  kb-build-index.js          rebuild keyword→id map from entry frontmatter
  kb-search.js               lexical search, ranked by field weight
  kb-get.js                  fetch entries by ID, printed verbatim
  kb-save.js                 validate + write + commit + push + rebuild index
  shared.js                  config resolution + entry parse/load helpers
workflows/
  test-skill.js              /git-kb:test-skill — fresh-eyes test harness (see below)
```

## Usage

| Command | Effect |
|---|---|
| `/git-kb init` | One-time setup: wire data repo, build index |
| `/git-kb add <knowledge>` | Draft + save + commit + push an entry |
| `/git-kb search <query>` | Ranked search with query expansion |
| `kb-get.js <id>…` | Fetch known entries by ID verbatim (follow `[[kb-XXXXX]]` links) |
| `/git-kb edit <id or desc> <change>` | Modify an entry in place |
| `/git-kb:test-skill` | Fresh-eyes test of the skill (see below) |

**Automatic retrieval has no command.** Once `/git-kb init` has run, the
`UserPromptSubmit` hook fires on every prompt with no action from you — see
[Two layers of access](#two-layers-of-access). The `/git-kb` verbs are the only
part you invoke explicitly; the hook is always-on background context injection.

**Per-session dedup.** When the hook surfaces an entry as a **pointer** (keyword
or activity match), it records that id in a per-session ledger under the temp
dir, so a later prompt that matches the same entry does not list it again — each
pointer appears in a session at most once. Paired with the pointer design, that
bounds the cost of the extra fetch: Claude pulls a given entry's body at most
once per session, not on every matching prompt. Any add/edit rebuilds the index,
which resets the ledger, so new or changed entries resurface. A fresh session
starts with an empty ledger. **`kernel: true` entries bypass the ledger entirely**
— their bodies re-inject every turn by design, because an invariant that must
govern every turn can't be spent on turn 1 (that was the old `always`-flag bug).

## Testing the skill

`/git-kb:test-skill` runs an isolated, self-verifying test of the whole skill. It:

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
- `MAX_CONTEXT_ENTRIES` (default 5) — cap on **keyword-ranked** pointers listed
  per prompt. Activity pointers and kernel bodies are not subject to it (activity
  pointers are ids only; the kernel is kept short by design).
- `SKIP_PATTERNS` — regex array of prompts that never trigger

In `scripts/shared.js`:

- `ACTIVITY_LEXICON` — activity → trigger-word map used to classify a prompt's
  *kind of work*. Extend a list when an activity pointer should have fired but
  didn't (a false negative).

### Retrieval beyond keywords

Keyword overlap misses entries relevant to a *kind of work* the prompt never
names (writing-style rules on "reply to this thread"). Two optional frontmatter
fields close that gap, honored by the hook — but they inject different shapes and
differ on dedup:

- `applies_to: [writing|reviewing|planning|coding, …]` — inject a **title
  pointer** when the prompt's classified activity matches, at zero keyword
  overlap. Gated by the per-session dedup ledger (listed at most once per
  session); the model fetches the body with `kb-get`.
- `kernel: true` — inject the entry's full **body** verbatim on every non-skipped
  prompt, **exempt from dedup** (re-injected each turn). The always-resident
  house-style block. Reserve for a tiny set of short invariant entries.

Kernel bodies are listed ahead of pointers so keyword noise can't starve them.
See [`spec/entry-format.md`](spec/entry-format.md) for the field contract and
when to use each.

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

**How this hook avoids it.** Keyword and activity matches inject **ids and titles
only**, never bodies, and instruct Claude to fetch the entries it needs with
`kb-get`. A list of ids is a few hundred to ~1–2K chars even with dozens of
entries. The one content-sized payload is the **kernel body**, injected verbatim
every turn — kept safe by keeping the kernel *small* (one short entry today,
~2–3K chars with the pointer list). The budget rule: **kernel bodies must stay
well under the cap on their own**, since pointers add to them. A handful of full
entries easily exceeds 10K (the writing suite alone ran ~26KB), so only the
distilled invariants belong in the kernel — never the full articles, which stay
pointers fetched on demand.

**If you add more content-sized payload** (more kernel entries, summaries, long
headers), keep the assembled `additionalContext` under ~9,000 chars yourself and
degrade the remainder to pointers — do not let the harness be the thing that
truncates, because its cut is blind and silent. A `KERNEL_BUDGET` guard in
`kb-trigger.js` (see below) is the enforcement seam if the kernel ever grows.

### Observability

Set `KB_HOOK_DEBUG=1` to append a per-prompt JSONL record to
`<tmpdir>/kb-hook-cache/debug.jsonl`: keyword hits, detected activities, surfaced
ids (with which signal surfaced each), and near-misses — keyword hits below
`THRESHOLD`, and the reason nothing surfaced (`no_signal` / `all_deduped`). This
makes a non-surfaced entry observable instead of silent, so retrieval quality can
be measured. Off by default; the non-match path stays a pure in-memory index lookup.

## The prose judge

Retrieval injects the rules; it can't guarantee the model follows them. The
`PreToolUse` hook `kb-prose-judge.js` closes that gap for the highest-stakes
output — prose that gets **published to a server** and can't be quietly fixed
afterward. Before a matched tool call runs, the hook extracts the prose it would
publish, asks a fast model to judge it against the kernel rules (fetched live via
`kb-get`, so there's no second copy of the rules to drift), and **denies the call
with the specific violations** if it fails. The model revises and retries; bad
prose never reaches the server.

**It runs before the write, not after**, because a code-review or ticket write
publishes mid-turn — a turn-end (`Stop`) check could only drive a correction once
the text is already out. Gating the tool call is a true pre-publish gate.

**Fail-open, always.** Every error path — no payload, no kernel rules, judge
timeout, unparseable verdict — resolves to *allow*. A judge that can't run must
never block a publish. Kill switch: `KB_PROSE_LINT=0`.

### What it judges

Tool coverage lives in **one place: the hook's `matcher`** in
[`hooks/hooks.json`](hooks/hooks.json). The shipped matcher is provider-neutral —
`Bash` plus the substrings `Comment`, `Review`, `Revision`, `Issue`, `Ticket`,
`PullRequest` — so it catches common code-review/issue/comment tools by name
without hardcoding any one vendor's tool. The script trusts the matcher: any tool
routed to it is judged, except a built-in exclude-list (`Write`, `Edit`,
`Read`, `TodoWrite`, `Task`, …) that never publishes prose, so a broad matcher
can't make the gate judge a file edit or block code. `Bash` is special-cased —
only a `git commit -m` message is judged, not arbitrary commands. Short strings
(< 60 chars), ids, slugs, enums, and URLs are skipped as non-prose.

### Covering your own toolchain

Add a `PreToolUse` entry in your **local** `settings.json` matching your tools,
pointing at the plugin script — internal tool names stay out of this shared repo:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*YourReviewTool|.*YourTicketTool",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/kb-prose-judge.js",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

That single matcher entry is the whole extension — the script judges whatever the
matcher sends it (minus the exclude-list). No env var, no code change.

### Tuning

- `KB_PROSE_LINT=0` — kill switch (any of `0/false/no/off`).
- `KB_PROSE_LINT_MODEL` — judge model (default `sonnet`; `haiku` is faster/cheaper
  but stricter on borderline cases).
- `KB_PROSE_LINT_TIMEOUT_MS` — judge timeout (default 45000; on timeout, fail open).
- `KB_PROSE_LINT_CLAUDE` — path to the `claude` binary if not on `PATH`.

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
