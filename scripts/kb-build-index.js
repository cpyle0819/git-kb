#!/usr/bin/env node
// kb-build-index.js — rebuild kb-index.json from entry frontmatter.
//
// Usage:  node kb-build-index.js
//   Reads all entries, extracts tags + title words, writes kb-index.json
//   to the data repo root. Designed to run after every add/edit.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigPath } from "./shared.js";

const STOP = new Set([
  "the", "a", "an", "of", "for", "to", "and", "or", "in", "on",
  "is", "it", "with", "how", "my", "this", "that", "was", "are",
  "be", "has", "had", "do", "does", "did", "but", "not", "from",
  "they", "we", "you", "your", "our", "its", "his", "her", "all",
  "can", "will", "just", "about", "also", "been", "have", "when",
  "what", "which", "would", "there", "their", "if", "so", "no",
  "up", "out", "them", "then", "each", "any", "these", "some",
]);

function resolveDataDir() {
  const configPath = getConfigPath();
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
    const entriesDir = join(dataDir, "entries");
    if (!dataDir || !existsSync(entriesDir)) {
      console.error(`ERROR: data_dir invalid or has no entries/: '${dataDir}'`);
      process.exit(4);
    }
    return { dataDir, entriesDir };
  } catch {
    console.error(`ERROR: cannot read ${configPath} (run /kb init)`);
    process.exit(3);
  }
}

function parseEntry(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const get = (k) => {
    const r = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
    return r ? r[1].trim() : "";
  };
  const tagsRaw = get("tags");
  const tags = tagsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    id: get("id"),
    title: get("title"),
    type: get("type"),
    tags,
  };
}

function tokenizeTitle(title) {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

const { dataDir, entriesDir } = resolveDataDir();
const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));

// Build keyword → [ids] map
const index = {};

function addKeyword(keyword, id) {
  if (!index[keyword]) index[keyword] = [];
  if (!index[keyword].includes(id)) index[keyword].push(id);
}

for (const f of files) {
  const e = parseEntry(readFileSync(join(entriesDir, f), "utf8"));
  if (!e) continue;

  for (const tag of e.tags) {
    // Tags can be multi-word (hyphenated) — index both full tag and parts
    addKeyword(tag, e.id);
    for (const part of tag.split("-").filter((p) => p.length > 2)) {
      addKeyword(part, e.id);
    }
  }

  for (const word of tokenizeTitle(e.title)) {
    addKeyword(word, e.id);
  }

  // Index the type itself as a keyword
  if (e.type) addKeyword(e.type, e.id);
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
const entryCount = files.length;
console.log(`INDEX_BUILT ${keyCount} keywords from ${entryCount} entries → ${outputPath}`);
