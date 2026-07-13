#!/usr/bin/env node
// kb-get.js — fetch KB entries by ID and print them verbatim, for the /git-kb skill
// and for following [[kb-XXXXX]] links without round-tripping through search.
//
// Usage:  node kb-get.js [--jsonl] kb-0065 kb-0053 ...
//   Prints each entry's frontmatter + body, in the order requested.
//   Unknown IDs print a "not found" line and do not fail the run — a partial
//   miss still returns the entries that were found (exit 0).
//   --jsonl: emit one JSON object per found entry ({id, render}) instead of the
//   human block — mirrors kb-search's --jsonl so the hook can reuse renders.
//   Missing IDs are omitted in --jsonl mode (nothing to render).

import { resolveDataDir, loadEntries } from "./shared.js";

// ─── Presentation ────────────────────────────────────────────────────────────

// Render one entry to a human-readable block. Unlike kb-search's formatter this
// omits match/score — a direct fetch has no query to score against.
function formatEntry(e, titleById) {
  const lines = [];
  lines.push(`### ${e.id} — ${e.title}`);
  lines.push(
    `type: ${e.type}   tags: [${e.tags.join(", ")}]   created: ${e.created}   updated: ${e.updated}`,
  );
  if (e.url) lines.push(`url: ${e.url}`);
  lines.push(`file: entries/${e.file}`);
  if (e.links.length) {
    const linkStr = e.links
      .map((id) => (titleById[id] ? `${id} (${titleById[id]})` : id))
      .join(", ");
    lines.push(`links: ${linkStr}`);
  }
  lines.push("---", e.body, "---");
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);
const jsonl = argv.includes("--jsonl");
const ids = argv.filter((a) => a !== "--jsonl");

if (ids.length === 0) {
  console.error("ERROR: no entry IDs given (usage: node kb-get.js [--jsonl] kb-0065 kb-0053 ...)");
  process.exit(2);
}

const resolved = resolveDataDir();
if (resolved.error) {
  console.error(resolved.error);
  process.exit(resolved.code);
}

const { entries, titleById } = loadEntries(resolved.entriesDir);
const byId = {};
for (const e of entries) if (e.id) byId[e.id] = e;

if (jsonl) {
  // One JSON object per FOUND entry; missing ids are silently omitted (a render
  // consumer has nothing to show for them). Order follows the request.
  const lines = ids
    .filter((id) => byId[id])
    .map((id) => JSON.stringify({ id, render: formatEntry(byId[id], titleById) }));
  process.stdout.write(lines.join("\n") + (lines.length ? "\n" : ""));
} else {
  const blocks = ids.map((id) =>
    byId[id] ? formatEntry(byId[id], titleById) : `### ${id} — NOT FOUND`,
  );
  process.stdout.write(blocks.join("\n\n") + "\n");
}
