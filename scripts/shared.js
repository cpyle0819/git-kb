// shared.js — utilities shared across kb-*.js scripts

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";

export function getConfigPath() {
  if (process.env.CLAUDE_PLUGIN_DATA) {
    const p = join(process.env.CLAUDE_PLUGIN_DATA, "kb-config.json");
    if (existsSync(p)) return p;
  }
  return join(homedir(), ".claude", "kb-config.json");
}

// Expand a leading ~ (home dir) in a config path. Kept here so callers don't
// each need to import node:os.
export function expandHome(p) {
  return (p ?? "").replace(/^~(?=$|\/)/, homedir());
}

// Parse one entry's markdown (frontmatter + body) into a structured object.
// Returns null if the frontmatter fence is missing/malformed.
export function parseEntry(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;
  const get = (k) => {
    const r = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
    return r ? r[1].trim() : "";
  };
  const tagsRaw = get("tags");
  const tags = tagsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const links = [...fm.matchAll(/to:[ \t]*(kb-\d+)/g)].map((x) => x[1]);
  const url = get("url") || null;
  // Cross-cutting retrieval fields (see spec/entry-format.md). `kernel` injects
  // the entry's full BODY on every prompt, exempt from per-session dedup — the
  // small always-resident house-style block. `applies_to` injects it as a title
  // pointer when the prompt's activity matches (subject to per-session dedup).
  const kernel = /^(true|yes)$/i.test(get("kernel"));
  const appliesTo = get("applies_to")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    id: get("id"),
    title: get("title"),
    type: get("type"),
    url,
    tags,
    kernel,
    appliesTo,
    links,
    created: get("created"),
    updated: get("updated"),
    body: body.trim(),
  };
}

// ─── Activity classification ───────────────────────────────────────────────────
// Cross-cutting entries (e.g. writing-style rules) are relevant based on the
// KIND of work a prompt asks for, not the nouns it names. "reply to this thread"
// needs the writing guidance but shares no keyword with it. We classify the
// prompt's activity from a static lexicon of trigger words — deterministic and
// cheap (a set lookup over already-tokenized words), no LLM, no embeddings.
//
// This is a tuning knob, like SKIP_PATTERNS: add trigger words as false
// negatives surface. Keys are activity names an entry can list in `applies_to`.
export const ACTIVITY_LEXICON = {
  writing: [
    "write", "writing", "wrote", "writes", "draft", "drafting", "drafted",
    "drafts", "author", "authoring", "authored", "compose", "composing",
    "composed", "rewrite", "rewriting", "rewrote", "reword", "rewording",
    "reworded", "rephrase", "rephrasing", "rephrased", "edit", "editing",
    "edited", "edits", "revise", "revising", "revised", "proofread",
    "summarize", "summarizing", "summarized", "summary", "summarise",
    "summarising", "summarised", "prose", "wording", "phrasing", "tone",
    "tighten", "tightening", "tightened", "shorten", "shortening", "shortened",
    "polish", "polishing", "polished", "clarify", "clarifying", "clarified",
    "condense", "condensing", "condensed", "trim", "trimming", "trimmed",
    "reply", "respond", "response", "message", "email", "comment", "note",
    "thread", "post", "announcement", "blurb", "copy", "readme", "doc", "docs",
    "documentation", "changelog", "ticket", "commit", "description", "update",
  ],
  reviewing: [
    "review", "reviewing", "critique", "criticize", "feedback", "audit",
    "assess", "evaluate", "appraise", "inspect",
  ],
  planning: [
    "plan", "planning", "design", "designing", "roadmap", "strategy",
    "approach", "proposal", "propose", "architect", "architecture", "scope",
  ],
  coding: [
    "code", "coding", "implement", "implementation", "refactor", "debug",
    "fix", "build", "compile", "test", "function", "class", "bug", "patch",
  ],
};

// Given the prompt's already-tokenized words (a Set or array of lowercase
// tokens), return the set of active activity names. An activity is active if any
// of its trigger words appears among the tokens.
export function classifyActivities(tokens) {
  const set = tokens instanceof Set ? tokens : new Set(tokens);
  const active = new Set();
  for (const [activity, triggers] of Object.entries(ACTIVITY_LEXICON)) {
    for (const t of triggers) {
      if (set.has(t)) {
        active.add(activity);
        break;
      }
    }
  }
  return active;
}

// Resolve the kb-data repo's entries/ dir from the config file. Returns
// {dataDir, entriesDir} on success, or {error, code} for the caller to print
// and exit with.
export function resolveDataDir() {
  const configPath = getConfigPath();
  let dataDir;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    dataDir = expandHome(cfg.data_dir);
  } catch {
    return {
      error: `ERROR: cannot read ${configPath} (run /git-kb init to set up the data repo)`,
      code: 3,
    };
  }
  const entriesDir = join(dataDir, "entries");
  if (!dataDir || !existsSync(entriesDir)) {
    return {
      error: `ERROR: data_dir invalid or has no entries/: '${dataDir}' (run /git-kb init)`,
      code: 4,
    };
  }
  return { dataDir, entriesDir };
}

// Load and parse every .md entry in entriesDir. Returns {entries, titleById}.
export function loadEntries(entriesDir) {
  const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
  const entries = [];
  const titleById = {};
  for (const f of files) {
    const e = parseEntry(readFileSync(join(entriesDir, f), "utf8"));
    if (!e) continue;
    e.file = f;
    entries.push(e);
    if (e.id) titleById[e.id] = e.title;
  }
  return { entries, titleById };
}
