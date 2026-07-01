#!/usr/bin/env node
// kb-trigger.js — UserPromptSubmit hook that checks if the user's prompt
// matches KB keywords and injects relevant entries as context.
//
// Reads prompt from stdin (JSON with tool_input.user_message or similar),
// tokenizes, checks against kb-index.json, runs kb-search.js if threshold met.
//
// Exit 0 with no stdout = no context injected (passthrough).
// Exit 0 with JSON stdout = additionalContext injected.

import {
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfigPath, expandHome } from "./shared.js";

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

function readPayload() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return { prompt: null, sessionId: null };
  }
  if (!raw.trim()) return { prompt: null, sessionId: null };

  try {
    const parsed = JSON.parse(raw);
    const prompt =
      parsed.prompt ??
      parsed.tool_input?.user_message ??
      parsed.user_message ??
      parsed.input ??
      parsed.message ??
      null;
    return { prompt, sessionId: parsed.session_id ?? null };
  } catch {
    return { prompt: raw.trim(), sessionId: null };
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
    const dataDir = expandHome(cfg.data_dir);
    const indexPath = join(dataDir, "kb-index.json");
    if (!existsSync(indexPath)) return null;
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const stamp = statSync(indexPath).mtimeMs;
    return { index, stamp };
  } catch {
    return null;
  }
}

// ─── Per-session injection ledger ──────────────────────────────────────────────
// Keyed by entry ID so overlapping prompts only inject entries not yet seen this
// session. Lives in a temp dir: auto-clears, and a new session starts empty.
// The index mtime (`stamp`) versions the ledger — any add/edit resets it so new
// or edited entries can resurface.

function ledgerPath(sessionId) {
  const dir = join(tmpdir(), "kb-hook-cache");
  return join(dir, `injected-${sessionId}.json`);
}

function loadLedger(sessionId, stamp) {
  if (!sessionId) return { seen: new Set(), stamp };
  try {
    const l = JSON.parse(readFileSync(ledgerPath(sessionId), "utf8"));
    if (l.stamp !== stamp) return { seen: new Set(), stamp }; // index changed
    return { seen: new Set(l.seen), stamp };
  } catch {
    return { seen: new Set(), stamp };
  }
}

function saveLedger(sessionId, seen, stamp) {
  if (!sessionId) return;
  try {
    const p = ledgerPath(sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ stamp, seen: [...seen] }));
  } catch {
    // best-effort; a failed write just means we may re-inject later
  }
}

// Returns ranked results as [{id, score, render}] via kb-search's --jsonl mode.
// Parsing structured lines (not the presentation format) keeps the hook
// decoupled from how entries render.
function runSearch(terms) {
  const searchScript = join(__dirname, "kb-search.js");
  let result;
  try {
    result = execFileSync("node", [searchScript, "--jsonl", ...terms], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  if (!result) return [];
  const out = [];
  for (const line of result.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip malformed line rather than fail the whole lookup
    }
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const { prompt, sessionId } = readPayload();
if (!prompt) process.exit(0);
if (shouldSkip(prompt)) process.exit(0);

const loaded = loadIndex();
if (!loaded) process.exit(0);
const { index, stamp } = loaded;

const words = tokenize(prompt);
const hitKeywords = new Set();

for (const w of words) {
  if (index[w]) hitKeywords.add(w);
}

if (hitKeywords.size < THRESHOLD) process.exit(0);

const searchTerms = [...hitKeywords].slice(0, 6);
let results = runSearch(searchTerms);
if (results.length === 0) process.exit(0);

// Drop entries already injected this session (dedup by entry ID), then cap.
const ledger = loadLedger(sessionId, stamp);
results = results.filter((r) => !ledger.seen.has(r.id)).slice(0, MAX_CONTEXT_ENTRIES);
if (results.length === 0) process.exit(0); // all matches already in context

for (const r of results) ledger.seen.add(r.id);
saveLedger(sessionId, ledger.seen, stamp);

const body = results.map((r) => r.render).join("\n\n");
const output = {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `[KB auto-lookup matched: ${[...hitKeywords].join(", ")}]\n\n${body}`,
  },
};

process.stdout.write(JSON.stringify(output));
