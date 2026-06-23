#!/usr/bin/env node
// kb-save.js — write/update + commit + push one KB entry, for the /kb skill.
//
// Add mode:   node kb-save.js --slug "<slug>" < entry.md
//   stdin must contain `id: __ID__`; assigns a collision-free id, bumps kb.json.
//
// Edit mode:  node kb-save.js --edit kb-NNNN [--slug "<new-slug>"] < entry.md
//   stdin must contain the real `id: kb-NNNN`. Overwrites in place (no new id).

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const REL = new Set([
  "relates_to",
  "part_of",
  "depends_on",
  "supersedes",
  "mentions",
]);
const TYPE = new Set([
  "factual_reference",
  "decision",
  "pattern_convention",
  "lesson_learned",
  "bookmark",
]);

function die(msg, code = 1) {
  console.error(msg);
  process.exitCode = code;
  process.exit();
}

function git(dir, args, quiet = false) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  }).trim();
}

// --- args ---
const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    edit: { type: "string" },
  },
  strict: false,
});
const editId = values.edit ?? null;
const editMode = editId !== null;
if (editMode && !/^kb-\d+$/.test(editId)) {
  die("ERROR: --edit needs an id like kb-0014", 2);
}
let slug = (values.slug ?? "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
if (!editMode && !slug) die("ERROR: missing --slug", 2);

// --- stdin ---
const content = readFileSync(0, "utf8");
if (editMode) {
  if (!new RegExp(`^id:\\s*${editId}\\s*$`, "m").test(content)) {
    die(`ERROR: stdin frontmatter id must be '${editId}' in edit mode`, 2);
  }
} else if (!/^id:\s*__ID__\s*$/m.test(content)) {
  die("ERROR: stdin frontmatter must contain `id: __ID__`", 2);
}

// --- resolve data_dir ---
const configPath = join(homedir(), ".claude", "kb-config.json");
let dataDir;
try {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
} catch {
  die(`ERROR: cannot read ${configPath}`, 3);
}
const entriesDir = join(dataDir, "entries");
const manifest = join(dataDir, "kb.json");
if (!existsSync(join(dataDir, ".git"))) {
  die(
    `ERROR: data_dir is not a git repo: '${dataDir}' (run /kb sync to bootstrap)`,
    4,
  );
}
if (!existsSync(entriesDir) || !existsSync(manifest)) {
  die(`ERROR: data_dir invalid (no entries/ or kb.json): '${dataDir}'`, 4);
}

// --- pull (best-effort) ---
let pullNote = "";
try {
  git(
    dataDir,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    true,
  );
  git(dataDir, ["pull", "--quiet"], true);
} catch {
  pullNote = "no upstream — local only";
}
// Abort if pull left a merge conflict.
const mergeHead = join(dataDir, ".git", "MERGE_HEAD");
if (existsSync(mergeHead)) {
  die(
    "ERROR: git pull left a merge conflict. Resolve it in the data repo, then retry.",
    6,
  );
}

// --- map existing entries ---
const fileById = {};
for (const f of readdirSync(entriesDir).filter((f) => f.endsWith(".md"))) {
  const m = f.match(/^(kb-\d+)/);
  if (m) fileById[m[1]] = f;
}
const existing = new Set(Object.keys(fileById));
let kb;
try {
  kb = JSON.parse(readFileSync(manifest, "utf8"));
} catch {
  die(`ERROR: kb.json is malformed (invalid JSON) at '${manifest}'`, 4);
}

// --- determine id ---
let id;
let final;
if (editMode) {
  if (!existing.has(editId))
    die(`ERROR: ${editId} does not exist — nothing to edit`, 5);
  id = editId;
  final = content;
} else {
  let n = kb.next_id ?? 1;
  id = `kb-${String(n).padStart(4, "0")}`;
  while (existing.has(id)) {
    n++;
    id = `kb-${String(n).padStart(4, "0")}`;
  }
  kb.next_id = n + 1;
  final = content.replace(/^id:\s*__ID__\s*$/m, `id: ${id}`);
}

// --- validate ---
const fm = (final.match(/^---\n([\s\S]*?)\n---/) ?? [, ""])[1];
const get = (k) => {
  const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
};
const title = get("title");
for (const k of ["title", "type", "created", "updated"]) {
  if (!get(k)) die(`ERROR: missing required field '${k}'`, 5);
}
if (!TYPE.has(get("type")))
  die(`ERROR: type '${get("type")}' not in closed enum`, 5);
if (get("type") === "bookmark" && !get("url"))
  die("ERROR: type 'bookmark' requires a `url:` field", 5);
for (const r of [...fm.matchAll(/rel:[ \t]*(\S+)/g)]) {
  if (!REL.has(r[1])) die(`ERROR: rel '${r[1]}' not in closed enum`, 5);
}
for (const t of [...fm.matchAll(/to:[ \t]*(kb-\d+)/g)]) {
  if (t[1] === id) continue;
  if (!existing.has(t[1]))
    die(`ERROR: link target ${t[1]} does not exist (dangling)`, 5);
}

// --- write ---
const oldFile = fileById[id];
const file = slug ? `${id}-${slug}.md` : (oldFile ?? `${id}.md`);
if (editMode && oldFile && oldFile !== file) {
  git(dataDir, ["mv", `entries/${oldFile}`, `entries/${file}`]);
}
writeFileSync(
  join(entriesDir, file),
  final.endsWith("\n") ? final : final + "\n",
);
const toAdd = [`entries/${file}`];
if (!editMode) {
  writeFileSync(manifest, JSON.stringify(kb, null, 2) + "\n");
  toAdd.push("kb.json");
}

// --- commit + push ---
git(dataDir, ["add", ...toAdd]);
const status = execFileSync("git", ["-C", dataDir, "status", "--porcelain"], {
  encoding: "utf8",
}).trim();
if (!status) {
  console.log(`NO_CHANGES ${id}`);
  console.log("The entry content is identical — nothing to commit.");
  process.exit(0);
}
git(dataDir, ["commit", "-m", `${editMode ? "edit" : "add"} ${id}: ${title}`]);
let pushNote;
try {
  git(dataDir, ["push"], true);
  pushNote = "pushed";
} catch {
  pushNote =
    "committed locally but NOT pushed (offline/auth/diverged) — run /kb sync later";
}

// --- report ---
console.log(`${editMode ? "EDITED" : "SAVED"} ${id}`);
console.log(`file: entries/${file}`);
console.log(`title: ${title}`);
if (pullNote) console.log(`pull: ${pullNote}`);
console.log(`push: ${pushNote}`);
