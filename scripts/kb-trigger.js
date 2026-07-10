#!/usr/bin/env node
// kb-trigger.js — UserPromptSubmit hook that checks if the user's prompt
// matches the KB and injects relevant entries as context.
//
// Two retrieval signals run per prompt:
//   1. Keyword match — ≥THRESHOLD distinct prompt tokens hit an entry's
//      tags/title/type (the original lexical path).
//   2. Cross-cutting match — entries flagged `always: true`, and entries whose
//      `applies_to` activity matches the prompt's classified activity, inject
//      even at zero keyword overlap. This surfaces guidance that applies to a
//      KIND of work the prompt never names (e.g. writing rules on "reply to
//      this thread"). Cross-cutting entries are ordered FIRST so the context
//      cap can't starve them.
// Both signals feed the same per-session dedup ledger, so any entry injects at
// most once per session regardless of which signal surfaced it.
//
// Observability: set KB_HOOK_DEBUG=1 to append a per-prompt JSONL record
// (keyword hits, detected activities, injected ids, and below-threshold
// near-misses) to <tmp>/kb-hook-cache/debug.jsonl, so retrieval gaps are
// measurable instead of silent. Off by default — the non-match path stays a
// pure in-memory index lookup with no subprocess.
//
// Exit 0 with no stdout = no context injected (passthrough).
// Exit 0 with JSON stdout = additionalContext injected.

import {
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfigPath, expandHome, classifyActivities } from "./shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THRESHOLD = 2; // minimum distinct keyword hits to trigger the keyword path
const MAX_CONTEXT_ENTRIES = 5;
const DEBUG = /^(1|true|yes)$/i.test(process.env.KB_HOOK_DEBUG ?? "");

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

// Parse the --jsonl output (one JSON object per line) of kb-search / kb-get.
// Parsing structured lines (not the presentation format) keeps the hook
// decoupled from how entries render.
function parseJsonl(result) {
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

// Returns ranked results as [{id, score, render}] via kb-search's --jsonl mode.
function runSearch(terms) {
  const searchScript = join(__dirname, "kb-search.js");
  try {
    return parseJsonl(
      execFileSync("node", [searchScript, "--jsonl", ...terms], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return [];
  }
}

// Fetch specific entries by id as [{id, render}] via kb-get's --jsonl mode.
// Used for cross-cutting entries, whose ids the index hands us directly (no
// query to rank). Missing ids are omitted by kb-get.
function runGet(ids) {
  if (ids.length === 0) return [];
  const getScript = join(__dirname, "kb-get.js");
  try {
    return parseJsonl(
      execFileSync("node", [getScript, "--jsonl", ...ids], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return [];
  }
}

// Append one diagnostic record when KB_HOOK_DEBUG is set. Best-effort; a failed
// write never affects the hook's output. This is what makes a non-surfaced
// entry observable rather than silent.
function debugLog(record) {
  if (!DEBUG) return;
  try {
    const p = join(tmpdir(), "kb-hook-cache", "debug.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(record) + "\n");
  } catch {
    // best-effort
  }
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

// Cross-cutting retrieval: entries relevant by KIND of work, not keyword.
// `__always__` fires on every non-skipped prompt; `__activity:<name>__` fires
// when the prompt's classified activity matches. These surface at zero keyword
// overlap. (Reserved index keys — see kb-build-index.js.)
const activities = classifyActivities(words);
const alwaysIds = index["__always__"] ?? [];
const activityIds = [];
for (const a of activities) {
  for (const id of index[`__activity:${a}__`] ?? []) {
    if (!activityIds.includes(id)) activityIds.push(id);
  }
}
// Cross-cutting ids, de-duped, in a stable order (always before activity).
const crossIds = [];
for (const id of [...alwaysIds, ...activityIds]) {
  if (!crossIds.includes(id)) crossIds.push(id);
}

const keywordFires = hitKeywords.size >= THRESHOLD;

// Nothing to do if neither signal has anything to contribute.
if (!keywordFires && crossIds.length === 0) {
  debugLog({
    session: sessionId,
    prompt: prompt.slice(0, 200),
    injected: [],
    reason: "no_signal",
    // Near-miss: keyword hits that existed but fell below THRESHOLD.
    keyword_near_miss: [...hitKeywords],
    activities: [...activities],
  });
  process.exit(0);
}

// Fetch renders. Cross-cutting entries first (by id, unranked), then keyword
// results — so the context cap can never starve the always/activity guidance.
const crossResults = runGet(crossIds).map((r) => ({ ...r, via: "cross" }));
const keywordResults = keywordFires
  ? runSearch([...hitKeywords].slice(0, 6)).map((r) => ({ ...r, via: "keyword" }))
  : [];

// Merge, cross-cutting first, dropping keyword duplicates of a cross entry.
const crossSeen = new Set(crossResults.map((r) => r.id));
const merged = [...crossResults, ...keywordResults.filter((r) => !crossSeen.has(r.id))];

// Drop entries already injected this session (dedup by entry ID), then cap.
const ledger = loadLedger(sessionId, stamp);
const fresh = merged.filter((r) => !ledger.seen.has(r.id));
const selected = fresh.slice(0, MAX_CONTEXT_ENTRIES);
const dropped = fresh.slice(MAX_CONTEXT_ENTRIES); // over the cap this prompt

if (selected.length === 0) {
  debugLog({
    session: sessionId,
    prompt: prompt.slice(0, 200),
    injected: [],
    reason: "all_deduped",
    keywords: [...hitKeywords],
    activities: [...activities],
    cross_ids: crossIds,
  });
  process.exit(0); // all matches already in context this session
}

for (const r of selected) ledger.seen.add(r.id);
saveLedger(sessionId, ledger.seen, stamp);

debugLog({
  session: sessionId,
  prompt: prompt.slice(0, 200),
  injected: selected.map((r) => ({ id: r.id, via: r.via })),
  keywords: [...hitKeywords],
  activities: [...activities],
  cross_ids: crossIds,
  // Near-miss: relevant entries cut by the per-prompt cap.
  dropped_over_cap: dropped.map((r) => ({ id: r.id, via: r.via })),
});

// Header names both signals so the reason an entry surfaced is legible.
const matchBits = [];
if (hitKeywords.size) matchBits.push(`keywords: ${[...hitKeywords].join(", ")}`);
if (activities.size) matchBits.push(`activity: ${[...activities].join(", ")}`);
if (alwaysIds.length) matchBits.push("always-on");

const body = selected.map((r) => r.render).join("\n\n");
const output = {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `[KB auto-lookup — ${matchBits.join("; ")}]\n\n${body}`,
  },
};

process.stdout.write(JSON.stringify(output));
