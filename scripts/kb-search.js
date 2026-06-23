#!/usr/bin/env node
// kb-search.js — lexical search over the kb-data repo, for the /kb skill.
//
// Usage:  node kb-search.js "term1" "term2" ...
//   The skill passes the user's query already expanded into terms (synonyms /
//   related words). Each arg is one term; matching is case-insensitive and
//   substring-based, scored per field.
//
// Reads data_dir from ~/.claude/kb-config.json, parses each entry's YAML
// frontmatter directly (no grep — the data is structured), scores field
// matches (title/tags > body), and prints ranked compact results plus link
// targets so the caller needs no follow-up file reads. Node only; no git, no
// grep/sed/awk. Output is plain text designed to be read by the model.

const fs = require("fs");
const os = require("os");
const path = require("path");

function die(msg, code) { console.log(msg); process.exit(code); }

const rawTerms = process.argv.slice(2).map(t => t.toLowerCase().trim()).filter(Boolean);
if (rawTerms.length === 0) die("ERROR: no search terms given", 2);

// Tokenize into individual words so a multi-word term like "software development"
// still matches an entry containing only "software" (per-word scoring), instead of
// requiring the whole phrase verbatim. Keep the original phrases too, for an
// exact-phrase bonus. Drop 1-char tokens.
const STOP = new Set(["the","a","an","of","for","to","and","or","in","on","is","it","with","how"]);
const words = new Set();
for (const t of rawTerms) for (const w of t.split(/[^a-z0-9]+/)) if (w.length > 1 && !STOP.has(w)) words.add(w);
const phrases = rawTerms.filter(t => /[^a-z0-9]/.test(t.trim()));  // multi-word phrases only

const configPath = path.join(os.homedir(), ".claude", "kb-config.json");
let dataDir;
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  dataDir = (cfg.data_dir || "").replace(/^~(?=$|\/)/, os.homedir());
} catch {
  die(`ERROR: cannot read ${configPath} (run /kb once to set data_dir)`, 3);
}
const entriesDir = path.join(dataDir, "entries");
if (!dataDir || !fs.existsSync(entriesDir)) {
  die(`ERROR: data_dir invalid or has no entries/: '${dataDir}'`, 4);
}

// Minimal frontmatter parse: split on the first two `---` fences, pull the
// scalar/list fields we care about. Avoids a YAML dependency for our flat schema.
function parseEntry(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;
  const get = (k) => {
    const r = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
    return r ? r[1].trim() : "";
  };
  const tagsRaw = get("tags"); // e.g. "[a, b-c, d]"
  const tags = tagsRaw.replace(/^\[|\]$/g, "").split(",").map(s => s.trim()).filter(Boolean);
  const links = [...fm.matchAll(/to:[ \t]*(kb-\d+)/g)].map(x => x[1]);
  const url = get("url") || null;
  return { id: get("id"), title: get("title"), type: get("type"), url, tags, links,
    created: get("created"), updated: get("updated"), body: body.trim() };
}

// Parse every entry once. Keep an id->title map so we can resolve link targets
// to human titles (graph context) without a second lookup.
const files = fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"));
const all = [];
const titleById = {};
for (const f of files) {
  const e = parseEntry(fs.readFileSync(path.join(entriesDir, f), "utf8"));
  if (!e) continue;
  e.file = f;
  all.push(e);
  if (e.id) titleById[e.id] = e.title;
}

// Score each entry against the terms (title > tag > body).
const results = [];
for (const e of all) {
  const titleL = e.title.toLowerCase();
  const tagsL = e.tags.join(" ").toLowerCase();
  const urlL = (e.url || "").toLowerCase();
  const bodyL = e.body.toLowerCase();
  let score = 0;
  const why = new Set();
  // per-word scoring (title > tag > url > body)
  for (const w of words) {
    if (titleL.includes(w)) { score += 5; why.add("title"); }
    if (tagsL.includes(w))  { score += 3; why.add("tag"); }
    if (urlL.includes(w))   { score += 3; why.add("url"); }
    if (bodyL.includes(w))  { score += 1; why.add("body"); }
  }
  // exact-phrase bonus so verbatim multi-word matches still rank highest
  for (const p of phrases) {
    if (titleL.includes(p) || tagsL.includes(p) || bodyL.includes(p)) { score += 4; why.add("phrase"); }
  }
  if (score > 0) results.push({ ...e, score, why: [...why].join("+") });
}

if (results.length === 0) die("NO_MATCHES", 0);
results.sort((a, b) => b.score - a.score);

// Top hits get full body (entries are small + single-fact, so this lets the
// caller answer in ONE call — no follow-up read). Rest get a one-line snippet.
const FULL_BODY_TOP = 3;
results.forEach((r, i) => {
  console.log(`### ${r.id} — ${r.title}`);
  console.log(`type: ${r.type}   tags: [${r.tags.join(", ")}]   created: ${r.created}   updated: ${r.updated}   match: ${r.why} (score ${r.score})`);
  if (r.url) console.log(`url: ${r.url}`);
  console.log(`file: entries/${r.file}`);
  if (r.links.length) {
    const linkStr = r.links.map(id => titleById[id] ? `${id} (${titleById[id]})` : id).join(", ");
    console.log(`links: ${linkStr}`);
  }
  if (i < FULL_BODY_TOP) {
    console.log("---");
    console.log(r.body);
    console.log("---");
  } else {
    console.log(`snippet: ${r.body.split("\n").find(l => l.trim()) || ""}`);
  }
  console.log("");
});
