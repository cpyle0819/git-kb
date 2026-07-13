#!/usr/bin/env node
// kb-search.js — lexical search over the kb-data repo, for the /git-kb skill.
//
// Usage:  node kb-search.js [--type <type>] "term1" "term2" ...
//   Pass "*" as the sole term to list all (useful with --type).

import { parseArgs } from "node:util";
import { resolveDataDir, loadEntries } from "./shared.js";

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

// Render one result to the human-readable text block. Single source of truth so
// the skill's search output and the hook's injected context never diverge.
function formatEntry(r, titleById) {
  const lines = [];
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
  return lines.join("\n");
}

function formatResults(results, titleById) {
  return results.map((r) => formatEntry(r, titleById)).join("\n\n") + "\n";
}

// One JSON object per line: {id, score, render}. Consumers (the hook) parse
// line-by-line, filter by id, and reuse `render` verbatim.
function formatResultsJsonl(results, titleById) {
  return results
    .map((r) =>
      JSON.stringify({
        id: r.id,
        score: r.score,
        render: formatEntry(r, titleById),
      }),
    )
    .join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  options: {
    type: { type: "string", short: "t" },
    jsonl: { type: "boolean" },
  },
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

process.stdout.write(
  values.jsonl
    ? formatResultsJsonl(result.results, titleById)
    : formatResults(result.results, titleById),
);
