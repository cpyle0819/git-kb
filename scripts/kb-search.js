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

const terms = process.argv.slice(2).map(t => t.toLowerCase()).filter(Boolean);
if (terms.length === 0) die("ERROR: no search terms given", 2);

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
  return { id: get("id"), title: get("title"), type: get("type"), tags, links, body: body.trim() };
}

const files = fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"));
const results = [];
for (const f of files) {
  const full = path.join(entriesDir, f);
  const e = parseEntry(fs.readFileSync(full, "utf8"));
  if (!e) continue;
  const titleL = e.title.toLowerCase();
  const tagsL = e.tags.join(" ").toLowerCase();
  const bodyL = e.body.toLowerCase();
  let score = 0;
  const why = new Set();
  for (const t of terms) {
    if (titleL.includes(t)) { score += 5; why.add("title"); }
    if (tagsL.includes(t))  { score += 3; why.add("tag"); }
    if (bodyL.includes(t))  { score += 1; why.add("body"); }
  }
  if (score > 0) {
    const snippet = e.body.split("\n").find(l => l.trim()) || "";
    results.push({ ...e, file: f, score, why: [...why].join("+"), snippet });
  }
}

if (results.length === 0) die("NO_MATCHES", 0);
results.sort((a, b) => b.score - a.score);

for (const r of results) {
  console.log(`### ${r.id} — ${r.title}`);
  console.log(`type: ${r.type}   tags: [${r.tags.join(", ")}]   match: ${r.why} (score ${r.score})`);
  console.log(`file: entries/${r.file}`);
  console.log(`snippet: ${r.snippet}`);
  if (r.links.length) console.log(`links: ${r.links.join(" ")}`);
  console.log("");
}
