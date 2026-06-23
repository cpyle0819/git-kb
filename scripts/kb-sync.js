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
import { parseArgs } from "node:util";

// ─── Core ────────────────────────────────────────────────────────────────────

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

function resolveDataDir() {
  const configPath = join(homedir(), ".claude", "kb-config.json");
  let dataDir;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    dataDir = (cfg.data_dir ?? "").replace(/^~(?=$|\/)/, homedir());
  } catch {
    return {
      error: `ERROR: cannot read ${configPath} (run /kb once to set data_dir)`,
      code: 3,
    };
  }
  if (!existsSync(join(dataDir, ".git"))) {
    return {
      error: `ERROR: data_dir is not a git repo: '${dataDir}'`,
      code: 4,
    };
  }
  return { dataDir };
}

function setRemote(dataDir, url) {
  const branch = git(dataDir, ["rev-parse", "--abbrev-ref", "HEAD"], true);
  const remotes = gitTry(dataDir, ["remote"]).out.split("\n").filter(Boolean);
  if (remotes.includes("origin")) {
    const cur = gitTry(dataDir, ["remote", "get-url", "origin"]).out;
    return {
      error: `ERROR: remote 'origin' already exists (${cur}). Change it yourself with 'git -C ${dataDir} remote set-url origin <url>' if needed.`,
      code: 5,
    };
  }
  const add = gitTry(dataDir, ["remote", "add", "origin", url]);
  if (!add.ok)
    return { error: `ERROR: git remote add failed: ${add.out}`, code: 5 };
  const push = gitTry(dataDir, ["push", "-u", "origin", branch]);
  if (!push.ok) {
    return {
      error: `ERROR: remote added but push failed: ${push.out}\nThe remote is set; fix access/URL and run /kb sync.`,
      code: 5,
    };
  }
  return { status: "remote_set", url, branch };
}

function sync(dataDir) {
  const remotes = gitTry(dataDir, ["remote"]).out.split("\n").filter(Boolean);
  if (!remotes.includes("origin")) {
    return { status: "no_remote", dataDir };
  }

  const pullResult = gitTry(dataDir, ["pull"]);
  if (!pullResult.ok) {
    if (/conflict/i.test(pullResult.out)) {
      return { status: "conflict", detail: pullResult.out };
    }
    return { error: `ERROR: pull failed: ${pullResult.out}`, code: 6 };
  }

  const ahead =
    parseInt(
      gitTry(dataDir, ["rev-list", "--count", "@{u}..HEAD"]).out ?? "0",
      10,
    ) || 0;
  const pushResult = gitTry(dataDir, ["push"]);
  if (!pushResult.ok) {
    return { error: `ERROR: pull ok, push failed: ${pushResult.out}`, code: 6 };
  }

  const pullSummary = /up to date/i.test(pullResult.out)
    ? "already up to date"
    : (pullResult.out.split("\n").at(-1) ?? "updated");
  const pushSummary =
    ahead === 0
      ? "nothing to push"
      : `pushed ${ahead} commit${ahead === 1 ? "" : "s"}`;

  return { status: "synced", pull: pullSummary, push: pushSummary };
}

// ─── Presentation ────────────────────────────────────────────────────────────

function formatResult(result) {
  const lines = [];
  switch (result.status) {
    case "remote_set":
      lines.push(`REMOTE_SET origin -> ${result.url}`);
      lines.push(`pushed branch '${result.branch}' and set upstream.`);
      break;
    case "no_remote":
      lines.push("NO_REMOTE");
      lines.push(`No git remote configured for ${result.dataDir}.`);
      lines.push("To enable sync, set one (URL must come from you):");
      lines.push(`  node <skill>/scripts/kb-sync.js --set-remote <url>`);
      break;
    case "conflict":
      lines.push("CONFLICT");
      lines.push(result.detail);
      lines.push(
        "Resolve the conflict in the data repo, commit, then run /kb sync again.",
      );
      break;
    case "synced":
      lines.push("SYNCED");
      lines.push(`pull: ${result.pull}`);
      lines.push(`push: ${result.push}`);
      break;
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
  options: { "set-remote": { type: "string" } },
  strict: false,
});
const setRemoteUrl = values["set-remote"] ?? null;

const resolved = resolveDataDir();
if (resolved.error) die(resolved.error, resolved.code);

let result;
if (setRemoteUrl !== null) {
  if (!setRemoteUrl) die("ERROR: --set-remote needs a URL", 2);
  result = setRemote(resolved.dataDir, setRemoteUrl);
} else {
  result = sync(resolved.dataDir);
}

if (result.error) die(result.error, result.code);
console.log(formatResult(result));
