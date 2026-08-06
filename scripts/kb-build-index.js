#!/usr/bin/env node
// kb-build-index.js — rebuild kb-index.json from entry frontmatter.
//
// Usage:  node kb-build-index.js
//   Reads all entries, extracts tags + title words, writes kb-index.json
//   to the data repo root. Designed to run after every add/edit.
//
// The index is a flat map of key → [entry ids]. Most keys are prompt keywords
// (tags, title words, type). Two reserved keys carry the cross-cutting signals
// the hook uses when the prompt shares no keyword with an entry:
//   __kernel__            → ids of entries with `kernel: true` (body injected
//                           every prompt, dedup-exempt)
//   __activity:<name>__   → ids of entries whose `applies_to` lists <name>
// The `__…__` shape can't collide with a prompt token (tokens are [a-z0-9]).

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir, loadEntries } from "./shared.js";

const STOP = new Set([
  "the", "a", "an", "of", "for", "to", "and", "or", "in", "on",
  "is", "it", "with", "how", "my", "this", "that", "was", "are",
  "be", "has", "had", "do", "does", "did", "but", "not", "from",
  "they", "we", "you", "your", "our", "its", "his", "her", "all",
  "can", "will", "just", "about", "also", "been", "have", "when",
  "what", "which", "would", "there", "their", "if", "so", "no",
  "up", "out", "them", "then", "each", "any", "these", "some",
]);

function tokenizeTitle(title) {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

const resolved = resolveDataDir();
if (resolved.error) {
  console.error(resolved.error);
  process.exit(resolved.code);
}
const { dataDir, entriesDir } = resolved;
const { entries } = loadEntries(entriesDir);

// Build key → [ids] map
const index = {};

function addKeyword(keyword, id) {
  if (!index[keyword]) index[keyword] = [];
  if (!index[keyword].includes(id)) index[keyword].push(id);
}

for (const e of entries) {
  if (!e.id) continue;

  for (const tag of e.tags) {
    // Tags can be multi-word (hyphenated) — index both full tag and parts
    const t = tag.toLowerCase();
    addKeyword(t, e.id);
    for (const part of t.split("-").filter((p) => p.length > 2)) {
      addKeyword(part, e.id);
    }
  }

  for (const word of tokenizeTitle(e.title)) {
    addKeyword(word, e.id);
  }

  // Index the type itself as a keyword
  if (e.type) addKeyword(e.type.toLowerCase(), e.id);

  // Cross-cutting signals — reserved keys, unreachable by prompt tokens.
  if (e.kernel) addKeyword("__kernel__", e.id);
  for (const activity of e.appliesTo) {
    addKeyword(`__activity:${activity}__`, e.id);
  }
}

// Ensure kb-index.json is gitignored in the data repo
const gitignorePath = join(dataDir, ".gitignore");
try {
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  if (!existing.split("\n").some((l) => l.trim() === "kb-index.json")) {
    writeFileSync(
      gitignorePath,
      existing.trimEnd() + "\nkb-index.json\n",
    );
  }
} catch {
  // Non-fatal — index works without gitignore
}

const outputPath = join(dataDir, "kb-index.json");
writeFileSync(outputPath, JSON.stringify(index, null, 2) + "\n");

const keyCount = Object.keys(index).length;
const entryCount = entries.length;
console.log(`INDEX_BUILT ${keyCount} keywords from ${entryCount} entries → ${outputPath}`);
