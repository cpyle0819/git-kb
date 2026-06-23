#!/usr/bin/env node
// kb-search.js — lexical search over the kb-data repo, for the /kb skill.
//
// Usage:  node kb-search.js [--type <type>] "term1" "term2" ...
//   Pass "*" as the sole term to list all (useful with --type).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ─── Core ────────────────────────────────────────────────────────────────────

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

function resolveDataDir() {
  const configPath = join(homedir(), ".claude", "kb-config.json");
  let dataDir;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
  } catch {
    return {
      error: `ERROR: cannot read ${configPath} (run /kb once to set data_dir)`,
      code: 3,
    };
  }
  const entriesDir = join(dataDir, "entries");
  if (!dataDir || !existsSync(entriesDir)) {
    return {
      error: `ERROR: data_dir invalid or has no entries/: '${dataDir}'`,
      code: 4,
    };
  }
  return { dataDir, entriesDir };
}

function loadEntries(entriesDir) {
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

function tokenize(rawTerms) {
  const words = new Set();
  for (const t of rawTerms) {
    for (const w of t.split(/[^a-z0-9]+/)) {
      if (w.length > 1 && !STOP.has(w)) words.add(w);
    }
  }
  const phrases = rawTerms.filter((t) => /[^a-z0-9]/.test(t.trim()));
  return { words, phrases };
}

function search(entries, { rawTerms, typeFilter }) {
  const listAll = rawTerms.length === 1 && rawTerms[0] === "*";
  const pool = typeFilter
    ? entries.filter((e) => e.type === typeFilter)
    : entries;

  if (typeFilter && pool.length === 0) {
    return {
      status: "no_matches",
      message: `no entries with type '${typeFilter}'`,
    };
  }

  const { words, phrases } = tokenize(rawTerms);
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

  if (results.length === 0) return { status: "no_matches" };
  results.sort((a, b) => b.score - a.score);
  return { status: "ok", results };
}

// ─── Presentation ────────────────────────────────────────────────────────────

function formatResults(results, titleById) {
  const lines = [];
  for (const r of results) {
    lines.push(`### ${r.id} — ${r.title}`);
    lines.push(
      `type: ${r.type}   tags: [${r.tags.join(", ")}]   created: ${r.created}   updated: ${r.updated}   match: ${r.why} (score ${r.score})`,
    );
    if (r.url) lines.push(`url: ${r.url}`);
    lines.push(`file: entries/${r.file}`);
    if (r.links.length) {
      const linkStr = r.links
        .map((id) => (titleById[id] ? `${id} (${titleById[id]})` : id))
        .join(", ");
      lines.push(`links: ${linkStr}`);
    }
    lines.push("---", r.body, "---");
    lines.push("");
  }
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  options: { type: { type: "string", short: "t" } },
  allowPositionals: true,
  strict: false,
});
const typeFilter = values.type?.toLowerCase() ?? null;
const rawTerms = positionals.map((t) => t.toLowerCase().trim());

if (rawTerms.length === 0) {
  console.error(
    "ERROR: no search terms given (pass terms, or --type <type> with at least one term or '*')",
  );
  process.exit(2);
}

const resolved = resolveDataDir();
if (resolved.error) {
  console.error(resolved.error);
  process.exit(resolved.code);
}

const { entries, titleById } = loadEntries(resolved.entriesDir);
const result = search(entries, { rawTerms, typeFilter });

if (result.status === "no_matches") {
  console.error(
    result.message ? `NO_MATCHES (${result.message})` : "NO_MATCHES",
  );
  process.exit(0);
}

process.stdout.write(formatResults(result.results, titleById));
