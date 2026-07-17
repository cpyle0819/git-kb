#!/usr/bin/env node
// kb-save.js — commit + push a KB entry, for the /git-kb skill.
//
// The entry content comes from a file on disk (--file, the primary path — you
// Write/Edit the file with your normal tools, then hand its path here) or from
// stdin (the fallback, for piping a program's output straight in).
//
// Add mode:   node kb-save.js --slug "<slug>" --file entries/<draft>.md
//             node kb-save.js --slug "<slug>" < entry.md          (stdin fallback)
//   content must contain `id: __ID__`; assigns a collision-free id, bumps
//   kb.json, and (for --file) renames the draft to entries/kb-NNNN-<slug>.md.
//
// Edit mode:  node kb-save.js --edit kb-NNNN [--slug "<new-slug>"] [--file <path>]
//             node kb-save.js --edit kb-NNNN [--slug "<new-slug>"] < entry.md
//   content must contain the real `id: kb-NNNN`. With no --file and no stdin,
//   commits the entry file already edited in place on disk. Overwrites, no new id.

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { getConfigPath, expandHome } from "./shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// Cross-cutting `applies_to` activities — must match ACTIVITY_LEXICON keys in
// shared.js (kept as a literal here to avoid importing the lexicon just to
// validate against its key set).
const ACTIVITY = new Set(["writing", "reviewing", "planning", "coding"]);

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
  const manifest = join(dataDir, "kb.json");
  if (!existsSync(join(dataDir, ".git"))) {
    return {
      error: `ERROR: data_dir is not a git repo: '${dataDir}' (run /git-kb init)`,
      code: 4,
    };
  }
  if (!existsSync(entriesDir) || !existsSync(manifest)) {
    return {
      error: `ERROR: data_dir invalid (no entries/ or kb.json): '${dataDir}' (run /git-kb init)`,
      code: 4,
    };
  }
  return { dataDir, entriesDir, manifest };
}

function pull(dataDir) {
  // Distinguish "no upstream configured" (fine — local-only repo) from a real
  // pull failure (network/auth/diverged). A genuine failure must ABORT the save:
  // writing against a stale DB is exactly what the pull is meant to prevent.
  const hasUpstream = gitTry(dataDir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]).ok;
  if (!hasUpstream) {
    return { pullNote: "no upstream — local only" };
  }
  const pulled = gitTry(dataDir, ["pull", "--quiet"]);
  const mergeHead = join(dataDir, ".git", "MERGE_HEAD");
  if (existsSync(mergeHead)) {
    return {
      error:
        "ERROR: git pull left a merge conflict. Resolve it in the data repo, then retry.",
      code: 6,
    };
  }
  if (!pulled.ok) {
    return {
      error:
        `ERROR: git pull failed — refusing to write against a stale DB.\n${pulled.out}\n` +
        "Fix connectivity/auth (or resolve the divergence) in the data repo, then retry.",
      code: 6,
    };
  }
  return { pullNote: "pulled" };
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
  const always = get("always");
  if (always && !/^(true|false|yes|no)$/i.test(always))
    errors.push(`always '${always}' must be true/false (or omitted)`);
  const appliesTo = get("applies_to")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const a of appliesTo) {
    if (!ACTIVITY.has(a))
      errors.push(`applies_to '${a}' not in closed enum (writing, reviewing, planning, coding)`);
  }
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

function save(
  content,
  { slug, editId, sourcePath, dataDir, entriesDir, manifest },
) {
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

  // Write. The target filename is the id + slug; the source content may have
  // arrived from a differently-named draft file (add via --file), the existing
  // entry file (edit in place), or stdin (no source file).
  const oldFile = fileById[id];
  const file = slug ? `${id}-${slug}.md` : (oldFile ?? `${id}.md`);
  const targetAbs = join(entriesDir, file);
  // Rename the tracked entry file when an edit changes its slug.
  if (editMode && oldFile && oldFile !== file) {
    git(dataDir, ["mv", `entries/${oldFile}`, `entries/${file}`]);
  }
  writeFileSync(targetAbs, final.endsWith("\n") ? final : final + "\n");
  // A draft written under a non-target name (add via --file) leaves a stray
  // file once its content lands at the id-based path — remove it so the add
  // doesn't commit both the draft and the final entry.
  if (sourcePath && resolve(sourcePath) !== resolve(targetAbs)) {
    const srcAbs = resolve(sourcePath);
    if (srcAbs.startsWith(resolve(entriesDir) + "/") && existsSync(srcAbs)) {
      unlinkSync(srcAbs);
      // Stage the removal only if the draft was tracked; a freshly-written
      // untracked draft needs no git action (and `git add` would error on it).
      gitTry(dataDir, ["add", "-A", "--", `entries/${basename(srcAbs)}`]);
    }
  }
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
    file: { type: "string" },
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

// Resolve the entry content and its source file, if any. Precedence:
//   1. --file <path>       — read the named file (primary path).
//   2. stdin (piped)       — read stdin (fallback, for piping program output).
//   3. edit-in-place       — no --file, no stdin: commit the entry file already
//                            edited on disk (edit mode only).
const fileArg = values.file ?? null;
// Empty stdin (a TTY, or a redirect like `< /dev/null`) reads as "" — treat that
// as no stdin so edit-in-place fires regardless of how stdin is wired.
let stdinContent = "";
if (!fileArg) {
  try {
    stdinContent = readFileSync(0, "utf8");
  } catch {
    stdinContent = "";
  }
}
const hasStdin = stdinContent.trim().length > 0;
let content;
let sourcePath = null;
if (fileArg) {
  const p = resolve(fileArg);
  if (!existsSync(p)) die(`ERROR: --file not found: '${fileArg}'`, 2);
  content = readFileSync(p, "utf8");
  sourcePath = p;
} else if (hasStdin) {
  content = stdinContent;
} else if (editMode) {
  // Edit-in-place: locate the existing entry file on disk and commit it as-is.
  const fileById = mapExistingEntries(resolved.entriesDir);
  const existingFile = fileById[editId];
  if (!existingFile)
    die(`ERROR: ${editId} does not exist — nothing to edit`, 5);
  sourcePath = join(resolved.entriesDir, existingFile);
  content = readFileSync(sourcePath, "utf8");
} else {
  die("ERROR: add mode needs entry content via --file <path> or stdin", 2);
}

const idPattern = editMode ? `id:\\s*${editId}\\s*$` : "id:\\s*__ID__\\s*$";
const idLabel = editMode ? `id: ${editId}` : "id: __ID__";
if (!new RegExp(`^${idPattern}`, "m").test(content)) {
  const src = fileArg ? `--file` : sourcePath ? `entry file` : "stdin";
  die(`ERROR: ${src} frontmatter must contain \`${idLabel}\``, 2);
}

const pullResult = pull(resolved.dataDir);
if (pullResult.error) die(pullResult.error, pullResult.code);

const result = save(content, {
  slug,
  editId,
  sourcePath,
  dataDir: resolved.dataDir,
  entriesDir: resolved.entriesDir,
  manifest: resolved.manifest,
});
if (result.error) die(result.error, result.code);

console.log(formatResult(result, pullResult.pullNote));

// Rebuild the keyword index after successful save/edit
if (result.status === "saved" || result.status === "edited") {
  try {
    execFileSync("node", [join(__dirname, "kb-build-index.js")], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Non-fatal — index rebuild failure shouldn't block the save
  }
}
