#!/usr/bin/env node
// kb-sync.js — reconcile the kb-data repo with its remote, for the /kb skill.
//
// Usage:
//   node kb-sync.js                  pull + push; report state
//   node kb-sync.js --set-remote URL one-time: add origin + push -u

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function die(msg, code = 1) {
  console.error(msg);
  process.exitCode = code;
  process.exit();
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
    return { ok: false, out: ((e.stdout ?? "") + (e.stderr ?? "")).trim() };
  }
}

// --- args ---
let setRemote = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--set-remote") setRemote = args[++i] ?? "";
}

// --- resolve data_dir ---
const configPath = join(homedir(), ".claude", "kb-config.json");
let dataDir;
try {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
} catch {
  die(`ERROR: cannot read ${configPath} (run /kb once to set data_dir)`, 3);
}
if (!existsSync(join(dataDir, ".git"))) {
  die(`ERROR: data_dir is not a git repo: '${dataDir}'`, 4);
}

const branch = git(dataDir, ["rev-parse", "--abbrev-ref", "HEAD"], true);
const remotes = gitTry(dataDir, ["remote"]).out.split("\n").filter(Boolean);
const hasOrigin = remotes.includes("origin");

// --- --set-remote mode ---
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
  if (!push.ok) {
    die(
      `ERROR: remote added but push failed: ${push.out}\nThe remote is set; fix access/URL and run /kb sync.`,
      5,
    );
  }
  console.log(`REMOTE_SET origin -> ${setRemote}`);
  console.log(`pushed branch '${branch}' and set upstream.`);
  process.exit(0);
}

// --- default sync ---
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
    console.log("Resolve the conflict in the data repo, commit, then run /kb sync again.");
    process.exit(0);
  }
  die(`ERROR: pull failed: ${pull.out}`, 6);
}

const ahead =
  parseInt(gitTry(dataDir, ["rev-list", "--count", "@{u}..HEAD"]).out ?? "0", 10) || 0;
const push = gitTry(dataDir, ["push"]);
if (!push.ok) die(`ERROR: pull ok, push failed: ${push.out}`, 6);

// --- report ---
console.log("SYNCED");
console.log(
  `pull: ${/up to date/i.test(pull.out) ? "already up to date" : (pull.out.split("\n").at(-1) ?? "updated")}`,
);
console.log(
  `push: ${ahead === 0 ? "nothing to push" : `pushed ${ahead} commit${ahead === 1 ? "" : "s"}`}`,
);
