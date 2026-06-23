#!/usr/bin/env node
// kb-save.js — write + commit + push one KB entry, for the /kb skill's `add`.
//
// Usage:  node kb-save.js --slug "<slug>" < entry.md
//   The drafted entry markdown is piped on stdin. Its frontmatter must contain
//   `id: __ID__` as a placeholder — this script assigns the real, collision-free
//   id and substitutes it. Claude authors the content + reviews with the user;
//   this script does ALL the mechanical/side-effecting work in one call so the
//   skill needs no separate git/Write steps (and one allowlist entry covers it).
//
// Flow: resolve data_dir from config -> pull (if upstream) -> assign free id ->
//       validate against the spec -> write entries/<id>-<slug>.md -> bump kb.json
//       -> commit both -> push (graceful) -> print a summary.
// Node + git only. Exits non-zero with an `ERROR:` line on any problem; on a
// failed PUSH it still keeps the commit and exits 0 (committed-but-not-pushed).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REL = new Set(["relates_to", "part_of", "depends_on", "supersedes", "mentions"]);
const TYPE = new Set(["factual_reference", "decision", "pattern_convention", "lesson_learned"]);

function die(msg, code = 1) { console.log(msg); process.exit(code); }
function git(dir, args, quiet = false) {
  // quiet: suppress git's stderr (for probes we expect to fail, e.g. @{u})
  return execFileSync("git", ["-C", dir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"] }).trim();
}

// --- args ---
let slug = "";
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--slug") slug = process.argv[++i] || "";
}
slug = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
if (!slug) die("ERROR: missing --slug", 2);

const content = fs.readFileSync(0, "utf8");      // stdin
if (!/^id:\s*__ID__\s*$/m.test(content)) die("ERROR: stdin frontmatter must contain `id: __ID__`", 2);

// --- resolve data_dir ---
const configPath = path.join(os.homedir(), ".claude", "kb-config.json");
let dataDir;
try {
  dataDir = (JSON.parse(fs.readFileSync(configPath, "utf8")).data_dir || "").replace(/^~(?=$|\/)/, os.homedir());
} catch { die(`ERROR: cannot read ${configPath}`, 3); }
const entriesDir = path.join(dataDir, "entries");
const manifest = path.join(dataDir, "kb.json");
if (!fs.existsSync(entriesDir) || !fs.existsSync(manifest)) die(`ERROR: data_dir invalid (no entries/ or kb.json): '${dataDir}'`, 4);

// --- pull if an upstream is configured (best-effort) ---
let pullNote = "";
try { git(dataDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true); git(dataDir, ["pull", "--quiet"], true); }
catch { pullNote = "no upstream — local only"; }

// --- assign a collision-free id ---
const existing = new Set(fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"))
  .map(f => (f.match(/^(kb-\d+)/) || [])[1]).filter(Boolean));
const kb = JSON.parse(fs.readFileSync(manifest, "utf8"));
let n = kb.next_id || 1;
let id = `kb-${String(n).padStart(4, "0")}`;
while (existing.has(id)) { n++; id = `kb-${String(n).padStart(4, "0")}`; }

// --- substitute id, then validate against the spec ---
const final = content.replace(/^id:\s*__ID__\s*$/m, `id: ${id}`);
const fm = (final.match(/^---\n([\s\S]*?)\n---/) || [, ""])[1];
const get = k => {
  const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
  if (!m) return "";
  // strip a single pair of surrounding quotes (YAML-quoted scalars, e.g. titles
  // containing ':' or ','), so the commit msg / display value is clean.
  return m[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
};
const title = get("title");
for (const k of ["title", "type", "created", "updated"]) if (!get(k)) die(`ERROR: missing required field '${k}'`, 5);
if (!TYPE.has(get("type"))) die(`ERROR: type '${get("type")}' not in closed enum`, 5);
for (const r of [...fm.matchAll(/rel:[ \t]*(\S+)/g)]) if (!REL.has(r[1])) die(`ERROR: rel '${r[1]}' not in closed enum`, 5);
for (const t of [...fm.matchAll(/to:[ \t]*(kb-\d+)/g)]) {
  if (t[1] === id) continue;
  if (!existing.has(t[1])) die(`ERROR: link target ${t[1]} does not exist (dangling)`, 5);
}

// --- write, bump manifest ---
const file = `${id}-${slug}.md`;
fs.writeFileSync(path.join(entriesDir, file), final.endsWith("\n") ? final : final + "\n");
kb.next_id = n + 1;
fs.writeFileSync(manifest, JSON.stringify(kb, null, 2) + "\n");

// --- commit (both files together), then push (graceful) ---
git(dataDir, ["add", `entries/${file}`, "kb.json"]);
git(dataDir, ["commit", "-m", `add ${id}: ${title}`]);
let pushNote;
try { git(dataDir, ["push"], true); pushNote = "pushed"; }
catch { pushNote = "committed locally but NOT pushed (offline/auth/diverged) — run /kb sync later"; }

console.log(`SAVED ${id}`);
console.log(`file: entries/${file}`);
console.log(`title: ${title}`);
if (pullNote) console.log(`pull: ${pullNote}`);
console.log(`push: ${pushNote}`);
