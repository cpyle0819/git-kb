#!/usr/bin/env node
// kb-trigger.js — UserPromptSubmit hook that checks if the user's prompt
// matches the KB and injects relevant entries as context.
//
// Three retrieval signals run per prompt:
//   1. Kernel — entries flagged `kernel: true` have their full BODY injected on
//      every non-skipped prompt, EXEMPT from per-session dedup. This is the small
//      always-resident house-style block: the invariant rules that must govern
//      every turn, re-injected each turn to survive context growth. Bodies, not
//      pointers — an invariant that must always hold can't depend on a fetch.
//   2. Keyword match — ≥THRESHOLD distinct prompt tokens hit an entry's
//      tags/title/type (the original lexical path). Injected as title POINTERS.
//   3. Activity match — entries whose `applies_to` activity matches the prompt's
//      classified activity inject even at zero keyword overlap, as title
//      pointers. Surfaces guidance for a KIND of work the prompt never names
//      (e.g. writing rules on "reply to this thread").
// Signals 2 and 3 feed the same per-session dedup ledger, so a pointer entry is
// listed at most once per session. The kernel bypasses the ledger entirely.
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
// Kernel bodies inject verbatim every turn, so an oversized kernel would hit the
// blind ~2KB truncation of Claude Code's 10K additionalContext cap (see README
// "Gotcha: the 10K hook-output cap"). Guard it: if the assembled kernel bodies
// exceed this, keep whole entries in order until the next would overflow, and
// degrade the rest to pointers. Well under 10K to leave room for the pointer list.
const KERNEL_BUDGET = 7000;
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

// Kernel: `kernel: true` entries whose BODY is injected every prompt, exempt
// from dedup (the always-resident house-style block). Activity: entries whose
// `applies_to` matches the prompt's classified activity, injected as title
// pointers. Both are reserved index keys — see kb-build-index.js.
const activities = classifyActivities(words);
const kernelIds = index["__kernel__"] ?? [];
const activityIds = [];
for (const a of activities) {
  for (const id of index[`__activity:${a}__`] ?? []) {
    if (!activityIds.includes(id)) activityIds.push(id);
  }
}

const keywordFires = hitKeywords.size >= THRESHOLD;

// Nothing to do if no signal has anything to contribute.
if (!keywordFires && kernelIds.length === 0 && activityIds.length === 0) {
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

// Fetch renders. Kernel entries carry their full body (injected verbatim);
// activity + keyword entries are surfaced as title pointers.
const kernelResults = runGet(kernelIds).map((r) => ({ ...r, via: "kernel" }));
const activityResults = runGet(activityIds).map((r) => ({ ...r, via: "activity" }));
const keywordResults = keywordFires
  ? runSearch([...hitKeywords].slice(0, 6)).map((r) => ({ ...r, via: "keyword" }))
  : [];

// The kernel is always resident; a pointer that duplicates a kernel entry is
// noise, so drop it from the pointer list.
const kernelSeen = new Set(kernelResults.map((r) => r.id));

// ─── Injection: kernel body (every turn) + pointer list (deduped) ───────────
// Two shapes reach the model. The KERNEL is the small always-resident house-style
// block — its full BODY is injected verbatim on every non-skipped prompt, exempt
// from the dedup ledger, so the invariant rules govern each turn even as context
// grows (an invariant that must always hold can't depend on a fetch that may be
// skipped). Everything else is a title POINTER the model fetches with kb-get if
// relevant, deduped per session so a given pointer is listed at most once.
//
// Claude Code hard-caps a hook's additionalContext at 10,000 chars (over-cap
// output is written to a file and replaced with a blind ~2KB preview that
// silently truncates — see README "Gotcha: the 10K hook-output cap"). The kernel
// is deliberately kept small (a handful of entries, a few hundred lines total) so
// body + pointer list stays well under the cap; pointers are tiny regardless.
const ledger = loadLedger(sessionId, stamp);
// Kernel bodies bypass the ledger — re-injected every turn by design. Guard the
// total body size against the 10K cap: keep whole entries in order until the next
// would overflow KERNEL_BUDGET; degrade any overflow to pointers so the model at
// least sees the id. With one short kernel entry this never triggers; it's the
// safety seam for when the kernel grows.
const kernelBodies = [];
const kernelOverflow = [];
{
  let used = 0;
  for (const r of kernelResults) {
    const size = r.render.length;
    if (used + size <= KERNEL_BUDGET) {
      kernelBodies.push(r);
      used += size;
    } else {
      kernelOverflow.push(r);
    }
  }
}
// Pointers: activity + keyword hits, minus anything already in the kernel, minus
// anything already surfaced this session. Keyword hits are capped; activity hits
// are not (cheap, and tied to the kind of work).
const freshActivity = activityResults.filter(
  (r) => !kernelSeen.has(r.id) && !ledger.seen.has(r.id),
);
const freshKeyword = keywordResults
  .filter((r) => !kernelSeen.has(r.id) && !ledger.seen.has(r.id))
  .filter((r) => !freshActivity.some((a) => a.id === r.id))
  .slice(0, MAX_CONTEXT_ENTRIES);
// Kernel entries that overflowed the body budget are surfaced as pointers so the
// model still sees them (marked via `via: "kernel-overflow"` for the debug log).
const overflowPointers = kernelOverflow.map((r) => ({ ...r, via: "kernel-overflow" }));
const pointers = [...overflowPointers, ...freshActivity, ...freshKeyword];

// Nothing fresh to say — no kernel and every pointer already surfaced.
if (kernelBodies.length === 0 && pointers.length === 0) {
  debugLog({
    session: sessionId,
    prompt: prompt.slice(0, 200),
    injected: [],
    reason: "all_deduped",
    keywords: [...hitKeywords],
    activities: [...activities],
    kernel_ids: kernelIds,
  });
  process.exit(0);
}

// Only pointers are marked seen; kernel entries are intentionally never recorded
// so they re-inject every turn.
for (const r of pointers) ledger.seen.add(r.id);
saveLedger(sessionId, ledger.seen, stamp);

debugLog({
  session: sessionId,
  prompt: prompt.slice(0, 200),
  injected: [
    ...kernelBodies.map((r) => ({ id: r.id, via: r.via })),
    ...pointers.map((r) => ({ id: r.id, via: r.via })),
  ],
  keywords: [...hitKeywords],
  activities: [...activities],
  kernel_ids: kernelIds,
});

// Header names the active signals so the reason context surfaced is legible.
const matchBits = [];
if (kernelBodies.length) matchBits.push("house-style kernel");
if (hitKeywords.size) matchBits.push(`keywords: ${[...hitKeywords].join(", ")}`);
if (activities.size) matchBits.push(`activity: ${[...activities].join(", ")}`);

// The kernel body is the `render`'s content between its "---" fences — inject it
// verbatim. Framed as house-style FACTS, not an imperative system command:
// imperative out-of-band instructions can trip Claude's prompt-injection defenses
// (see Anthropic hooks docs), which surfaces the text to the user instead of
// treating it as context.
const bodyOf = (r) => {
  const m = r.render.match(/\n---\n([\s\S]*?)\n---\s*$/);
  return (m ? m[1] : r.render).trim();
};
// First render line is "### <id> — <title>"; strip "### " for the pointer label.
const labelOf = (r) => (r.render.split("\n", 1)[0] || r.id).replace(/^#+\s*/, "");

const sections = [`[KB auto-lookup — ${matchBits.join("; ")}]`];

if (kernelBodies.length) {
  sections.push(
    "\nHouse writing style — these rules govern all prose you produce this turn " +
      "(replies, summaries, comments, CRs, tickets, docs). They are standing " +
      "guidance, already in effect:\n\n" +
      kernelBodies.map((r) => bodyOf(r)).join("\n\n"),
  );
}

if (pointers.length) {
  sections.push(
    "\nRelated KB entries (titles only — the title is not the guidance). Fetch the " +
      "full body of any that bear on this task and work from it before acting. " +
      "Fetch via the Skill tool so it runs pre-approved:\n" +
      '  Skill(skill: "git-kb", args: "get <id> [<id> ...]")\n' +
      "(Batch the ids into one call.) Each is listed at most once per session.\n\n" +
      pointers.map((r) => `- ${labelOf(r)}`).join("\n"),
  );
}

const output = {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: sections.join("\n"),
  },
};

process.stdout.write(JSON.stringify(output));
