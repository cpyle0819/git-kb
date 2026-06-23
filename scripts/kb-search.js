#!/usr/bin/env node
// kb-search.js — lexical search over the kb-data repo, for the /kb skill.
//
// Usage:  node kb-search.js [--type <type>] "term1" "term2" ...
//   Pass "*" as the sole term to list all (useful with --type).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function die(msg, code = 1) {
  console.error(msg);
  process.exitCode = code;
  process.exit();
}

// --- args ---
let typeFilter = null;
const rawTerms = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--type") {
    typeFilter = (args[++i] ?? "").toLowerCase();
  } else {
    rawTerms.push(args[i].toLowerCase().trim());
  }
}
if (rawTerms.length === 0) {
  die(
    "ERROR: no search terms given (pass terms, or --type <type> with at least one term or '*')",
    2,
  );
}
const listAll = rawTerms.length === 1 && rawTerms[0] === "*";

// Tokenize multi-word terms into individual words for per-word scoring.
// Keep original phrases too for an exact-phrase bonus.
const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "and",
  "or",
  "in",
  "on",
  "is",
  "it",
  "with",
  "how",
]);
const words = new Set();
for (const t of rawTerms) {
  for (const w of t.split(/[^a-z0-9]+/)) {
    if (w.length > 1 && !STOP.has(w)) words.add(w);
  }
}
const phrases = rawTerms.filter((t) => /[^a-z0-9]/.test(t.trim()));

// --- resolve data_dir ---
const configPath = join(homedir(), ".claude", "kb-config.json");
let dataDir;
try {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
} catch {
  die(`ERROR: cannot read ${configPath} (run /kb once to set data_dir)`, 3);
}
const entriesDir = join(dataDir, "entries");
if (!dataDir || !existsSync(entriesDir)) {
  die(`ERROR: data_dir invalid or has no entries/: '${dataDir}'`, 4);
}

// --- parse entries ---
function parseEntry(text) {
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
  return {
    id: get("id"),
    title: get("title"),
    type: get("type"),
    url,
    tags,
    links,
    created: get("created"),
    updated: get("updated"),
    body: body.trim(),
  };
}

const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
const all = [];
const titleById = {};
for (const f of files) {
  const e = parseEntry(readFileSync(join(entriesDir, f), "utf8"));
  if (!e) continue;
  e.file = f;
  all.push(e);
  if (e.id) titleById[e.id] = e.title;
}

// --- filter + score ---
const pool = typeFilter ? all.filter((e) => e.type === typeFilter) : all;
if (typeFilter && pool.length === 0) {
  die(`NO_MATCHES (no entries with type '${typeFilter}')`, 0);
}

const results = [];
for (const e of pool) {
  if (listAll) {
    results.push({ ...e, score: 1, why: "list-all" });
    continue;
  }
  const titleL = e.title.toLowerCase();
  const tagsL = e.tags.join(" ").toLowerCase();
  const urlL = (e.url ?? "").toLowerCase();
  const bodyL = e.body.toLowerCase();
  let score = 0;
  const why = new Set();
  for (const w of words) {
    if (titleL.includes(w)) {
      score += 5;
      why.add("title");
    }
    if (tagsL.includes(w)) {
      score += 3;
      why.add("tag");
    }
    if (urlL.includes(w)) {
      score += 3;
      why.add("url");
    }
    if (bodyL.includes(w)) {
      score += 1;
      why.add("body");
    }
  }
  for (const p of phrases) {
    if (titleL.includes(p) || tagsL.includes(p) || bodyL.includes(p)) {
      score += 4;
      why.add("phrase");
    }
  }
  if (score > 0) results.push({ ...e, score, why: [...why].join("+") });
}

if (results.length === 0) die("NO_MATCHES", 0);
results.sort((a, b) => b.score - a.score);

// --- output (stdout = data for the model to consume) ---
const FULL_BODY_TOP = 3;
for (const [i, r] of results.entries()) {
  console.log(`### ${r.id} — ${r.title}`);
  console.log(
    `type: ${r.type}   tags: [${r.tags.join(", ")}]   created: ${r.created}   updated: ${r.updated}   match: ${r.why} (score ${r.score})`,
  );
  if (r.url) console.log(`url: ${r.url}`);
  console.log(`file: entries/${r.file}`);
  if (r.links.length) {
    const linkStr = r.links
      .map((id) => (titleById[id] ? `${id} (${titleById[id]})` : id))
      .join(", ");
    console.log(`links: ${linkStr}`);
  }
  if (i < FULL_BODY_TOP) {
    console.log("---");
    console.log(r.body);
    console.log("---");
  } else {
    console.log(`snippet: ${r.body.split("\n").find((l) => l.trim()) ?? ""}`);
  }
  console.log("");
}
