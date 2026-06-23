#!/usr/bin/env node
// kb-sync.js — reconcile the kb-data repo with its remote, for the /kb skill's `sync`.
//
// Usage:
//   node kb-sync.js                  pull + push; report state
//   node kb-sync.js --set-remote URL one-time: add `origin` URL + push -u (set upstream)
//
// The URL always comes from the user (the skill asks + confirms before calling
// --set-remote). This script never invents a remote. Node + git only.
//
// Output is plain text for the model to relay. Special first-line signals:
//   NO_REMOTE   — no git remote configured; skill should offer to set one
//   CONFLICT    — pull hit a merge conflict; user must resolve
//   ERROR: ...  — anything else fatal

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function die(msg, code = 1) {
  console.log(msg);
  process.exit(code);
}
function git(dir, args, quiet = false) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", quiet ? "ignore" : "pipe"],
  }).trim();
}
function gitTry(dir, args) {
  try {
    return { ok: true, out: git(dir, args, true) };
  } catch (e) {
    return { ok: false, out: ((e.stdout || "") + (e.stderr || "")).trim() };
  }
}

// --- args ---
let setRemote = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--set-remote") setRemote = process.argv[++i] || "";
}

// --- resolve data_dir ---
const configPath = path.join(os.homedir(), ".claude", "kb-config.json");
let dataDir;
try {
  dataDir = (
    JSON.parse(fs.readFileSync(configPath, "utf8")).data_dir || ""
  ).replace(/^~(?=$|\/)/, os.homedir());
} catch {
  die(`ERROR: cannot read ${configPath} (run /kb once to set data_dir)`, 3);
}
if (!fs.existsSync(path.join(dataDir, ".git")))
  die(`ERROR: data_dir is not a git repo: '${dataDir}'`, 4);

const branch = git(dataDir, ["rev-parse", "--abbrev-ref", "HEAD"], true);
const remotes = gitTry(dataDir, ["remote"]).out.split("\n").filter(Boolean);
const hasOrigin = remotes.includes("origin");

// --- --set-remote mode (one-time wiring) ---
if (setRemote !== null) {
  if (!setRemote) die("ERROR: --set-remote needs a URL", 2);
  if (hasOrigin) {
    const cur = gitTry(dataDir, ["remote", "get-url", "origin"]).out;
    die(
      `ERROR: remote 'origin' already exists (${cur}). Change it yourself with 'git -C ${dataDir} remote set-url origin <url>' if needed.`,
      5,
    );
  }
  const add = gitTry(dataDir, ["remote", "add", "origin", setRemote]);
  if (!add.ok) die(`ERROR: git remote add failed: ${add.out}`, 5);
  const push = gitTry(dataDir, ["push", "-u", "origin", branch]);
  if (!push.ok)
    die(
      `ERROR: remote added but push failed: ${push.out}\nThe remote is set; fix access/URL and run /kb sync.`,
      5,
    );
  console.log(`REMOTE_SET origin -> ${setRemote}`);
  console.log(`pushed branch '${branch}' and set upstream.`);
  process.exit(0);
}

// --- default sync: pull then push ---
if (!hasOrigin) {
  console.log("NO_REMOTE");
  console.log(`No git remote configured for ${dataDir}.`);
  console.log("To enable sync, set one (URL must come from you):");
  console.log(`  node <skill>/scripts/kb-sync.js --set-remote <url>`);
  process.exit(0);
}

const pull = gitTry(dataDir, ["pull"]);
if (!pull.ok) {
  if (/conflict/i.test(pull.out)) {
    console.log("CONFLICT");
    console.log(pull.out);
    console.log(
      "Resolve the conflict in the data repo, commit, then run /kb sync again.",
    );
    process.exit(0);
  }
  die(`ERROR: pull failed: ${pull.out}`, 6);
}

// count commits ahead of upstream BEFORE pushing (reliable; push's "up-to-date"
// goes to stderr and is awkward to parse).
const ahead =
  parseInt(
    gitTry(dataDir, ["rev-list", "--count", "@{u}..HEAD"]).out || "0",
    10,
  ) || 0;
const push = gitTry(dataDir, ["push"]);
if (!push.ok) die(`ERROR: pull ok, push failed: ${push.out}`, 6);

// --- report ---
console.log("SYNCED");
console.log(
  `pull: ${/up to date/i.test(pull.out) ? "already up to date" : pull.out.split("\n").slice(-1)[0] || "updated"}`,
);
console.log(
  `push: ${ahead === 0 ? "nothing to push" : `pushed ${ahead} commit${ahead === 1 ? "" : "s"}`}`,
);
