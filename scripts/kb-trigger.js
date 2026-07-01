#!/usr/bin/env node
// kb-trigger.js — UserPromptSubmit hook that checks if the user's prompt
// matches KB keywords and injects relevant entries as context.
//
// Reads prompt from stdin (JSON with tool_input.user_message or similar),
// tokenizes, checks against kb-index.json, runs kb-search.js if threshold met.
//
// Exit 0 with no stdout = no context injected (passthrough).
// Exit 0 with JSON stdout = additionalContext injected.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfigPath } from "./shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THRESHOLD = 2; // minimum distinct keyword hits to trigger
const MAX_CONTEXT_ENTRIES = 5;

const STOP = new Set([
  "the", "a", "an", "of", "for", "to", "and", "or", "in", "on",
  "is", "it", "with", "how", "my", "this", "that", "was", "are",
  "be", "has", "had", "do", "does", "did", "but", "not", "from",
  "they", "we", "you", "your", "our", "its", "his", "her", "all",
  "can", "will", "just", "about", "also", "been", "have", "when",
  "what", "which", "would", "there", "their", "if", "so", "no",
  "up", "out", "them", "then", "each", "any", "these", "some",
  "file", "code", "run", "fix", "add", "make", "use", "get", "set",
  "new", "try", "see", "let", "now", "way", "need", "want", "look",
]);

// Negative patterns — skip mechanical/code prompts
const SKIP_PATTERNS = [
  /^\//, // slash commands
  /^(commit|push|pull|merge|rebase|checkout|branch)\b/i,
  /^(fix|run|build|test|lint|format)\s+(the\s+)?(lint|test|build|type)/i,
  /^git\s/i,
  /^\s*$/,
];

function readPrompt() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed.prompt
      ?? parsed.tool_input?.user_message
      ?? parsed.user_message
      ?? parsed.input
      ?? parsed.message
      ?? null;
  } catch {
    return raw.trim();
  }
}

function shouldSkip(prompt) {
  if (prompt.length < 15) return true; // very short prompts
  if (SKIP_PATTERNS.some((p) => p.test(prompt))) return true;
  return false;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function loadIndex() {
  const configPath = getConfigPath();
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
    const indexPath = join(dataDir, "kb-index.json");
    if (!existsSync(indexPath)) return null;
    return JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    return null;
  }
}

function runSearch(terms) {
  const searchScript = join(__dirname, "kb-search.js");
  try {
    const result = execFileSync("node", [searchScript, ...terms], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!result || result.includes("NO_MATCHES")) return null;
    // Truncate to avoid blowing up context
    const lines = result.split("\n");
    const truncated = [];
    let entryCount = 0;
    for (const line of lines) {
      if (line.startsWith("### ")) entryCount++;
      if (entryCount > MAX_CONTEXT_ENTRIES) break;
      truncated.push(line);
    }
    return truncated.join("\n").trim();
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const prompt = readPrompt();
if (!prompt) process.exit(0);
if (shouldSkip(prompt)) process.exit(0);

const index = loadIndex();
if (!index) process.exit(0);

const words = tokenize(prompt);
const hitKeywords = new Set();
const hitIds = new Set();

for (const w of words) {
  if (index[w]) {
    hitKeywords.add(w);
    for (const id of index[w]) hitIds.add(id);
  }
}

if (hitKeywords.size < THRESHOLD) process.exit(0);

// Run search with the matching keywords
const searchTerms = [...hitKeywords].slice(0, 6);
const searchResult = runSearch(searchTerms);
if (!searchResult) process.exit(0);

const output = {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `[KB auto-lookup matched: ${[...hitKeywords].join(", ")}]\n\n${searchResult}`,
  },
};

process.stdout.write(JSON.stringify(output));
