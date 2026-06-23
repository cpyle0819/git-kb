#!/usr/bin/env node
// kb-save.js — write/update + commit + push one KB entry, for the /kb skill.
//
// Add mode:   node kb-save.js --slug "<slug>" < entry.md
//   stdin frontmatter must contain `id: __ID__`; the script assigns the next
//   collision-free id, bumps kb.json, and commits "add kb-NNNN: <title>".
//
// Edit mode:  node kb-save.js --edit kb-NNNN [--slug "<new-slug>"] < entry.md
//   stdin frontmatter must contain the REAL existing `id: kb-NNNN`. The script
//   overwrites that entry in place (no new id, no next_id bump), renames the
//   file if --slug differs, and commits "edit kb-NNNN: <title>". Use for
//   factual corrections/refinements; for decisions that are REPLACED, prefer
//   `add` with a `supersedes` link (keeps history).
//
// Claude authors the content + reviews with the user; this script does ALL the
// mechanical work in one allowlisted call. Node + git only. Exits non-zero with
// an `ERROR:` line on any problem; a failed PUSH still keeps the commit (exit 0).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REL = new Set(["relates_to", "part_of", "depends_on", "supersedes", "mentions"]);
const TYPE = new Set(["factual_reference", "decision", "pattern_convention", "lesson_learned"]);

function die(msg, code = 1) { console.log(msg); process.exit(code); }
function git(dir, args, quiet = false) {
  return execFileSync("git", ["-C", dir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"] }).trim();
}

// --- args ---
let slug = "", editId = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--slug") slug = process.argv[++i] || "";
  else if (process.argv[i] === "--edit") editId = process.argv[++i] || "";
}
const editMode = editId !== null;
if (editMode && !/^kb-\d+$/.test(editId)) die("ERROR: --edit needs an id like kb-0014", 2);
slug = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
if (!editMode && !slug) die("ERROR: missing --slug", 2);

const content = fs.readFileSync(0, "utf8");      // stdin
if (editMode) {
  if (!new RegExp(`^id:\\s*${editId}\\s*$`, "m").test(content))
    die(`ERROR: stdin frontmatter id must be '${editId}' in edit mode`, 2);
} else if (!/^id:\s*__ID__\s*$/m.test(content)) {
  die("ERROR: stdin frontmatter must contain `id: __ID__`", 2);
}

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

// --- map existing files by id ---
const fileById = {};
for (const f of fs.readdirSync(entriesDir).filter(f => f.endsWith(".md"))) {
  const m = f.match(/^(kb-\d+)/); if (m) fileById[m[1]] = f;
}
const existing = new Set(Object.keys(fileById));
const kb = JSON.parse(fs.readFileSync(manifest, "utf8"));

// --- determine id ---
let id, final;
if (editMode) {
  if (!existing.has(editId)) die(`ERROR: ${editId} does not exist — nothing to edit`, 5);
  id = editId;
  final = content;
} else {
  let n = kb.next_id || 1;
  id = `kb-${String(n).padStart(4, "0")}`;
  while (existing.has(id)) { n++; id = `kb-${String(n).padStart(4, "0")}`; }
  kb.next_id = n + 1;
  final = content.replace(/^id:\s*__ID__\s*$/m, `id: ${id}`);
}

// --- validate against the spec ---
const fm = (final.match(/^---\n([\s\S]*?)\n---/) || [, ""])[1];
const get = k => {
  const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");  // strip surrounding YAML quotes
};
const title = get("title");
for (const k of ["title", "type", "created", "updated"]) if (!get(k)) die(`ERROR: missing required field '${k}'`, 5);
if (!TYPE.has(get("type"))) die(`ERROR: type '${get("type")}' not in closed enum`, 5);
for (const r of [...fm.matchAll(/rel:[ \t]*(\S+)/g)]) if (!REL.has(r[1])) die(`ERROR: rel '${r[1]}' not in closed enum`, 5);
for (const t of [...fm.matchAll(/to:[ \t]*(kb-\d+)/g)]) {
  if (t[1] === id) continue;
  if (!existing.has(t[1])) die(`ERROR: link target ${t[1]} does not exist (dangling)`, 5);
}

// --- write (+ rename on slug change), bump manifest (add only) ---
const oldFile = fileById[id];
const file = slug ? `${id}-${slug}.md` : (oldFile || `${id}.md`);
const toAdd = [];
// git mv stages the rename (both old + new paths) atomically; only the new
// path needs a follow-up `git add` to capture the content change.
if (editMode && oldFile && oldFile !== file) git(dataDir, ["mv", `entries/${oldFile}`, `entries/${file}`]);
fs.writeFileSync(path.join(entriesDir, file), final.endsWith("\n") ? final : final + "\n");
toAdd.push(`entries/${file}`);
if (!editMode) { fs.writeFileSync(manifest, JSON.stringify(kb, null, 2) + "\n"); toAdd.push("kb.json"); }

// --- commit, then push (graceful) ---
git(dataDir, ["add", ...toAdd]);
git(dataDir, ["commit", "-m", `${editMode ? "edit" : "add"} ${id}: ${title}`]);
let pushNote;
try { git(dataDir, ["push"], true); pushNote = "pushed"; }
catch { pushNote = "committed locally but NOT pushed (offline/auth/diverged) — run /kb sync later"; }

console.log(`${editMode ? "EDITED" : "SAVED"} ${id}`);
console.log(`file: entries/${file}`);
console.log(`title: ${title}`);
if (pullNote) console.log(`pull: ${pullNote}`);
console.log(`push: ${pushNote}`);
