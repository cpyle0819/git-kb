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

// ─── Core ────────────────────────────────────────────────────────────────────

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

function git(dir, args, quiet = false) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"],
  }).trim();
}

function gitTry(dir, args) {
  try {
    return { ok: true, out: git(dir, args, true) };
  } catch (e) {
    return { ok: false, out: ((e.stdout ?? "") + (e.stderr ?? "")).trim() };
  }
}

function resolveDataDir() {
  const configPath = join(homedir(), ".claude", "kb-config.json");
  let dataDir;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
  } catch {
    return { error: `ERROR: cannot read ${configPath}`, code: 3 };
  }
  const entriesDir = join(dataDir, "entries");
  const manifest = join(dataDir, "kb.json");
  if (!existsSync(join(dataDir, ".git"))) {
    return {
      error: `ERROR: data_dir is not a git repo: '${dataDir}' (run git init there, or let /kb bootstrap it)`,
      code: 4,
    };
  }
  if (!existsSync(entriesDir) || !existsSync(manifest)) {
    return {
      error: `ERROR: data_dir invalid (no entries/ or kb.json): '${dataDir}'`,
      code: 4,
    };
  }
  return { dataDir, entriesDir, manifest };
}

function pull(dataDir) {
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
  const mergeHead = join(dataDir, ".git", "MERGE_HEAD");
  if (existsSync(mergeHead)) {
    return {
      error:
        "ERROR: git pull left a merge conflict. Resolve it in the data repo, then retry.",
      code: 6,
    };
  }
  return { pullNote };
}

function mapExistingEntries(entriesDir) {
  const fileById = {};
  for (const f of readdirSync(entriesDir).filter((f) => f.endsWith(".md"))) {
    const m = f.match(/^(kb-\d+)/);
    if (m) fileById[m[1]] = f;
  }
  return fileById;
}

function assignId(existing, kb) {
  let n = kb.next_id ?? 1;
  let id = `kb-${String(n).padStart(4, "0")}`;
  while (existing.has(id)) {
    n++;
    id = `kb-${String(n).padStart(4, "0")}`;
  }
  kb.next_id = n + 1;
  return id;
}

function validate(fm, id, existing) {
  const get = (k) => {
    const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
    if (!m) return "";
    return m[1].trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
  };
  const title = get("title");
  const errors = [];
  for (const k of ["title", "type", "created", "updated"]) {
    if (!get(k)) errors.push(`missing required field '${k}'`);
  }
  if (get("type") && !TYPE.has(get("type")))
    errors.push(`type '${get("type")}' not in closed enum`);
  if (get("type") === "bookmark" && !get("url"))
    errors.push("type 'bookmark' requires a `url:` field");
  for (const r of [...fm.matchAll(/rel:[ \t]*(\S+)/g)]) {
    if (!REL.has(r[1])) errors.push(`rel '${r[1]}' not in closed enum`);
  }
  for (const t of [...fm.matchAll(/to:[ \t]*(kb-\d+)/g)]) {
    if (t[1] === id) continue;
    if (!existing.has(t[1]))
      errors.push(`link target ${t[1]} does not exist (dangling)`);
  }
  return { title, errors };
}

function setRemote(dataDir, url) {
  const branch = git(dataDir, ["rev-parse", "--abbrev-ref", "HEAD"], true);
  const remotes = gitTry(dataDir, ["remote"]).out.split("\n").filter(Boolean);
  if (remotes.includes("origin")) {
    const cur = gitTry(dataDir, ["remote", "get-url", "origin"]).out;
    return {
      error: `ERROR: remote 'origin' already exists (${cur}).`,
      code: 5,
    };
  }
  const add = gitTry(dataDir, ["remote", "add", "origin", url]);
  if (!add.ok)
    return { error: `ERROR: git remote add failed: ${add.out}`, code: 5 };
  const push = gitTry(dataDir, ["push", "-u", "origin", branch]);
  if (!push.ok) {
    return {
      error: `ERROR: remote added but push failed: ${push.out}\nFix access/URL and try again.`,
      code: 5,
    };
  }
  return { status: "remote_set", url, branch };
}

function save(content, { slug, editId, dataDir, entriesDir, manifest }) {
  const editMode = editId !== null;
  const fileById = mapExistingEntries(entriesDir);
  const existing = new Set(Object.keys(fileById));

  let kb;
  try {
    kb = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return {
      error: `ERROR: kb.json is malformed (invalid JSON) at '${manifest}'`,
      code: 4,
    };
  }

  // Determine id
  let id;
  let final;
  if (editMode) {
    if (!existing.has(editId))
      return {
        error: `ERROR: ${editId} does not exist — nothing to edit`,
        code: 5,
      };
    id = editId;
    final = content;
  } else {
    id = assignId(existing, kb);
    final = content.replace(/^id:\s*__ID__\s*$/m, `id: ${id}`);
  }

  // Validate
  const fm = (final.match(/^---\n([\s\S]*?)\n---/) ?? [, ""])[1];
  const { title, errors } = validate(fm, id, existing);
  if (errors.length > 0) return { error: `ERROR: ${errors[0]}`, code: 5 };

  // Write
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

  // Commit
  git(dataDir, ["add", ...toAdd]);
  const status = execFileSync("git", ["-C", dataDir, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim();
  if (!status) return { status: "no_changes", id };

  git(dataDir, [
    "commit",
    "-m",
    `${editMode ? "edit" : "add"} ${id}: ${title}`,
  ]);

  // Push
  const remotes = gitTry(dataDir, ["remote"]).out.split("\n").filter(Boolean);
  let pushNote;
  if (!remotes.includes("origin")) {
    pushNote = "NO_REMOTE";
  } else {
    const pushResult = gitTry(dataDir, ["push"]);
    pushNote = pushResult.ok
      ? "pushed"
      : "committed locally but NOT pushed (offline/auth/diverged)";
  }

  return { status: editMode ? "edited" : "saved", id, file, title, pushNote };
}

// ─── Presentation ────────────────────────────────────────────────────────────

function formatResult(result, pullNote) {
  const lines = [];
  if (result.status === "remote_set") {
    lines.push(`REMOTE_SET origin -> ${result.url}`);
    lines.push(`pushed branch '${result.branch}' and set upstream.`);
  } else if (result.status === "no_changes") {
    lines.push(`NO_CHANGES ${result.id}`);
    lines.push("The entry content is identical — nothing to commit.");
  } else {
    lines.push(
      `${result.status === "edited" ? "EDITED" : "SAVED"} ${result.id}`,
    );
    lines.push(`file: entries/${result.file}`);
    lines.push(`title: ${result.title}`);
    if (pullNote) lines.push(`pull: ${pullNote}`);
    lines.push(`push: ${result.pushNote}`);
  }
  return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  console.error(msg);
  process.exitCode = code;
  process.exit();
}

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    edit: { type: "string" },
    "set-remote": { type: "string" },
  },
  strict: false,
});

const resolved = resolveDataDir();
if (resolved.error) die(resolved.error, resolved.code);

// --- set-remote mode (one-time remote wiring) ---
const setRemoteUrl = values["set-remote"] ?? null;
if (setRemoteUrl !== null) {
  if (!setRemoteUrl) die("ERROR: --set-remote needs a URL", 2);
  const result = setRemote(resolved.dataDir, setRemoteUrl);
  if (result.error) die(result.error, result.code);
  console.log(formatResult(result));
  process.exit(0);
}

// --- add/edit mode ---
const editId = values.edit ?? null;
const editMode = editId !== null;
if (editMode && !/^kb-\d+$/.test(editId))
  die("ERROR: --edit needs an id like kb-0014", 2);

let slug = (values.slug ?? "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");
if (!editMode && !slug) die("ERROR: missing --slug", 2);

const content = readFileSync(0, "utf8");
if (editMode) {
  if (!new RegExp(`^id:\\s*${editId}\\s*$`, "m").test(content)) {
    die(`ERROR: stdin frontmatter id must be '${editId}' in edit mode`, 2);
  }
} else if (!/^id:\s*__ID__\s*$/m.test(content)) {
  die("ERROR: stdin frontmatter must contain `id: __ID__`", 2);
}

const pullResult = pull(resolved.dataDir);
if (pullResult.error) die(pullResult.error, pullResult.code);

const result = save(content, {
  slug,
  editId,
  dataDir: resolved.dataDir,
  entriesDir: resolved.entriesDir,
  manifest: resolved.manifest,
});
if (result.error) die(result.error, result.code);

console.log(formatResult(result, pullResult.pullNote));
