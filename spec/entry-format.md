# KB Entry Format Spec (v1)

The contract every entry file obeys. Both `/git-kb add` (writes it) and `/git-kb search`
(reads it) depend on this. Designed to be parseable by plain tools (`git grep`,
`grep`, any YAML reader) and by eye — no custom format, no binary.

> This spec lives in the shareable `kb-system` repo. It contains **no real
> knowledge-base content** — all examples are generic placeholders. Real entries
> (which may be sensitive) live only in the separate, private `kb-data` repo.

## Data repo layout

The **data repo** (private; lives on any git server — an internal host when the
content is sensitive) contains only entries and a tiny manifest:

```
<kb-data repo>/
├── entries/
│   ├── kb-0001-example-topic.md
│   ├── kb-0002-another-topic.md
│   └── ...
└── kb.json            # repo-level manifest (schema version, id counter)
```

No code, no index, no embeddings. The `kb-system` repo (this one) holds the
`/git-kb` command, this spec, and any helper scripts — and points at a data repo via
a configurable remote (see SKILL). Sharing the system never shares the data.

## File naming

```
entries/kb-NNNN-<slug>.md
```

- `kb-NNNN` — zero-padded 4-digit id, monotonically assigned (see `kb.json`).
  The id is the stable identity; the slug is for humans and may drift.
- `<slug>` — lowercase, hyphenated, derived from the title. Cosmetic only;
  nothing keys off it. Renaming the slug = a `git mv` (history follows).
- One entry per file. The id appears in both the filename and the frontmatter
  (`id:`) so a grep hit on either resolves the entry.

## Frontmatter schema

YAML frontmatter delimited by `---`, followed by a free-form markdown body.

```markdown
---
id: kb-0001
title: Example Topic
type: factual_reference
tags: [alpha, beta-category, example-area]
links:
  - rel: relates_to
    to: kb-0002
  - rel: depends_on
    to: kb-0003
created: 2026-06-22
updated: 2026-06-22
---

A short, self-contained description of the topic goes here in plain markdown.
The body has no required structure.
```

### Fields

| Field     | Required | Type         | Notes                                                                                                                         |
| --------- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`      | yes      | `kb-NNNN`    | Matches filename. Stable identity.                                                                                            |
| `title`   | yes      | string       | Human title; drives the slug.                                                                                                 |
| `type`    | yes      | enum         | Closed set — see below.                                                                                                       |
| `url`     | no       | string       | A full URL (`https://...`). Required for `type: bookmark`; optional for others (e.g. a factual_reference with a source link). |
| `tags`    | no       | list[string] | **Free-form.** Lowercase, hyphenated. Primary lexical-search and filter signal; matched as wildcards. `[]` if none.           |
| `applies_to` | no    | list[enum]   | **Cross-cutting retrieval.** Activities this entry applies to, so its **title pointer** surfaces on prompts of that *kind* even with no keyword overlap. Closed set: `writing`, `reviewing`, `planning`, `coding`. Omit for topic-scoped entries.        |
| `kernel`  | no       | bool         | **Always-resident guidance.** `true` = inject this entry's full **body** verbatim on every prompt, **exempt from per-session dedup** (re-injected each turn). Reserve for a tiny set of invariant rules that must govern every turn; keep each kernel entry short. Everything else is a title pointer.                                                    |
| `links`   | no       | list[edge]   | Curated graph edges; `rel` is a closed set. `[]` if none.                                                                     |
| `created` | yes      | `YYYY-MM-DD` | Set once at add.                                                                                                              |
| `updated` | yes      | `YYYY-MM-DD` | Bumped on edit. (For real history, use `git log --follow`.)                                                                   |

### `type` — closed enum (v1)

Exactly these five values are valid. Anything else is a lint error. Extend the
set only by editing this spec.

| `type`               | Meaning                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `factual_reference`  | A fact, definition, or description of a thing.                                                                           |
| `decision`           | A choice made and its rationale ("chose X over Y because ...").                                                          |
| `pattern_convention` | A reusable pattern or convention.                                                                                        |
| `lesson_learned`     | A debugging insight or non-obvious gotcha.                                                                               |
| `bookmark`           | A pointer to an external resource (URL). Body is optional notes/context about _why_ you saved it. Requires `url:` field. |

### `tags` — free-form (open)

No controlled vocabulary. Any lowercase, hyphenated token is valid. Tags are the
main lexical/filter signal and are matched as wildcards (e.g. a search for
`deploy` matches the tag `deployment`). Use as many as are genuinely useful.

### `applies_to` / `kernel` — retrieval beyond keywords

Keyword matching surfaces an entry when the prompt names its subject. That
structurally misses guidance relevant to a *kind of work* the prompt never names
— writing-style rules apply to "reply to this thread" though it shares no style
keyword. These two optional fields close that gap; the auto-lookup hook
(`kb-trigger.js`) honors them. They differ in **what** they inject and **whether
they dedup**:

- **`applies_to`** lists **activities** (closed set: `writing`, `reviewing`,
  `planning`, `coding`) and injects a **title pointer**. The hook classifies each
  prompt's activity from a static trigger-word lexicon (`ACTIVITY_LEXICON` in
  `shared.js`) and lists the entry whenever the prompt's activity intersects its
  `applies_to` — at zero keyword overlap. Gated by the per-session dedup ledger,
  so the pointer is listed **at most once per session**. The model fetches the
  body with `kb-get` if the entry bears on the task. The lexicon is a tuning
  knob: extend it as false negatives surface.
- **`kernel: true`** injects the entry's full **body** verbatim on every
  non-skipped prompt, **exempt from dedup** — re-injected each turn. This is the
  always-resident house-style block: an invariant that must govern every turn
  can't depend on a fetch that may be skipped, and re-injecting each turn keeps
  it salient as context grows (adherence to early-context instructions decays).

**Why the split.** A pointer that dedups is right for situational guidance —
listed once, fetched when relevant, cheap to miss. An invariant that must *always
hold* is the opposite: it must be present as text every turn. Deduping it (the
old `always` behavior) burned it on turn 1 and left later turns ungoverned.
Reserve `kernel` for a tiny set of short entries; everything else is a pointer.
Kernel bodies are ordered ahead of pointers so the context cap
(`MAX_CONTEXT_ENTRIES`, which bounds keyword pointers only) never starves them.

### `links` — the graph

Each edge is an explicit, reviewable object: a `rel` (relationship type) and a
`to` (target entry id).

```yaml
links:
  - rel: relates_to
    to: kb-0002
```

#### `rel` — closed enum (v1)

Exactly these five values are valid. This is deliberate — the old KB sprawled to
60+ one-off relationship types, which made edge-typed traversal unreliable.
Extend the set only by editing this spec.

| `rel`        | Direction / meaning                                           |
| ------------ | ------------------------------------------------------------- |
| `relates_to` | Generic association. Symmetric in meaning; still stored once. |
| `part_of`    | Source is a component/subset of target.                       |
| `depends_on` | Source requires or builds on target.                          |
| `supersedes` | Source replaces target (how decisions evolve over time).      |
| `mentions`   | Source references target in passing.                          |

#### Edge rules

- **Directed, stored once.** Write the edge on the **source** entry only. Do
  **not** also write the inverse on the target (the old KB's
  bidirectional-duplicate bug). Traversal reads edges in both directions.
- **`to` must be an existing `kb-NNNN`.** A dangling link is a lint error, not a
  silent edge.
- `supersedes` carries the intent of a decision change; `git log --follow`
  carries the timestamps.

## `kb.json` manifest

```json
{
  "schema_version": 1,
  "next_id": 4
}
```

- `schema_version` — bump when this spec changes incompatibly.
- `next_id` — the counter `/git-kb add` reads, uses, and increments (in the same
  commit as the new entry) so ids never collide.

## Invariants (what `search`/lint can assume)

1. Every file in `entries/` has valid frontmatter with `id`, `title`, `type`,
   `created`, `updated`.
2. `id` in frontmatter == `kb-NNNN` in filename.
3. `type` is one of the four closed enum values.
4. Every `links[].rel` is one of the five closed enum values, and every
   `links[].to` resolves to an existing entry.
5. Body is plain markdown; no required structure.
6. No secrets/credentials in any file (git history is permanent).
