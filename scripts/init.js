#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, exit } from "node:process";
import { fileURLToPath } from "node:url";
import {
  getClaudeFallbackConfigPath,
  getCodexFallbackConfigPath,
} from "./shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CODEX_MARKETPLACE_NAME = "git-kb-local";
const CODEX_MARKETPLACE_ROOT = join(homedir(), ".codex", "git-kb-marketplace");
const CODEX_MARKETPLACE_FILE = join(
  CODEX_MARKETPLACE_ROOT,
  ".agents",
  "plugins",
  "marketplace.json",
);
const CODEX_PLUGIN_LINK = join(CODEX_MARKETPLACE_ROOT, "plugins", "git-kb");
const CLAUDE_SKILL_LINK = join(homedir(), ".claude", "skills", "git-kb");

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    "data-mode": { type: "string" },
    "data-path": { type: "string" },
    "data-url": { type: "string" },
    refresh: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    "dry-run": { type: "boolean" },
  },
  allowPositionals: false,
});

const rl = values.yes
  ? null
  : createInterface({
      input,
      output,
    });

function say(line = "") {
  output.write(line + "\n");
}

function fail(message, code = 1) {
  console.error(message);
  rl?.close();
  exit(code);
}

function expandHome(raw) {
  return (raw ?? "").replace(/^~(?=$|\/)/, homedir());
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(path) {
  if (values["dry-run"]) {
    say(`[dry-run] mkdir -p ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

function writeJson(path, payload) {
  ensureDir(dirname(path));
  if (values["dry-run"]) {
    say(`[dry-run] write ${path}`);
    say(JSON.stringify(payload, null, 2));
    return;
  }
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
}

function run(command, args, extraEnv = {}) {
  const rendered = [command, ...args].join(" ");
  if (values["dry-run"]) {
    say(`[dry-run] ${rendered}`);
    return { stdout: "", stderr: "" };
  }
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `command failed: ${rendered}`).trim());
  }
  return result;
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    env: process.env,
  });
  return result.status === 0;
}

function sameTarget(path, target) {
  try {
    return realpathSync(path) === realpathSync(target);
  } catch {
    return false;
  }
}

function ensureSymlink(linkPath, target) {
  ensureDir(dirname(linkPath));
  let entry = null;
  try {
    entry = lstatSync(linkPath);
  } catch {
    entry = null;
  }
  if (entry) {
    if (sameTarget(linkPath, target)) return;
    const kind = entry.isSymbolicLink() ? "symlink" : "path";
    throw new Error(
      `${linkPath} already exists as a different ${kind}. Remove it or move it aside, then rerun init.`,
    );
  }
  if (values["dry-run"]) {
    say(`[dry-run] ln -s ${target} ${linkPath}`);
    return;
  }
  symlinkSync(target, linkPath, "dir");
}

function validateDataRepo(dataDir) {
  const expanded = resolve(expandHome(dataDir));
  const gitCheck = spawnSync("git", ["-C", expanded, "rev-parse", "--show-toplevel"], {
    stdio: "ignore",
    env: process.env,
  });
  if (gitCheck.status !== 0) {
    throw new Error(`${expanded} is not a git repo`);
  }
  if (!existsSync(join(expanded, "entries")) || !existsSync(join(expanded, "kb.json"))) {
    throw new Error(`${expanded} must contain entries/ and kb.json`);
  }
  return expanded;
}

function createNewRepo(dataDir) {
  const expanded = resolve(expandHome(dataDir));
  if (existsSync(expanded)) {
    const entry = lstatSync(expanded);
    if (!entry.isDirectory()) {
      throw new Error(`${expanded} already exists and is not a directory`);
    }
    if (readdirSync(expanded).length > 0) {
      throw new Error(`${expanded} already exists and is not empty`);
    }
  }
  ensureDir(expanded);
  run("git", ["init", expanded]);
  ensureDir(join(expanded, "entries"));
  writeJson(join(expanded, "kb.json"), {
    schema_version: 1,
    next_id: 1,
  });
  return expanded;
}

function cloneRepo(url, dataDir) {
  const expanded = resolve(expandHome(dataDir));
  if (existsSync(expanded)) {
    throw new Error(`${expanded} already exists`);
  }
  run("git", ["clone", url, expanded]);
  return validateDataRepo(expanded);
}

function writeConfig(configPath, dataDir) {
  const current = readJson(configPath);
  const next = current && typeof current === "object" ? current : {};
  next.data_dir = dataDir;
  writeJson(configPath, next);
}

function syncCompanionConfig(primaryPath, companionPath, dataDir) {
  if (primaryPath === companionPath || !existsSync(companionPath)) return false;
  writeConfig(companionPath, dataDir);
  return true;
}

async function ask(prompt, fallback = "") {
  if (!rl) fail(`Missing required value for non-interactive init: ${prompt}`);
  const suffix = fallback ? ` [${fallback}]` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || fallback;
}

async function chooseHost(availableHosts) {
  if (values.host) {
    const normalized = values.host.toLowerCase();
    if (!availableHosts.includes(normalized)) {
      fail(`Host '${values.host}' is not available. Available: ${availableHosts.join(", ")}`);
    }
    return normalized;
  }
  if (availableHosts.length === 1) return availableHosts[0];
  if (!rl) fail(`Multiple hosts are available (${availableHosts.join(", ")}). Re-run with --host.`);
  say("Available hosts:");
  availableHosts.forEach((host, index) => {
    say(`${index + 1}. ${host}`);
  });
  while (true) {
    const answer = await ask("Pick a host by number");
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && availableHosts[index]) return availableHosts[index];
    say("Enter one of the listed numbers.");
  }
}

function currentConfiguredRepo(configPath) {
  const cfg = readJson(configPath);
  if (!cfg || typeof cfg !== "object" || typeof cfg.data_dir !== "string") return null;
  try {
    return validateDataRepo(cfg.data_dir);
  } catch {
    return null;
  }
}

async function chooseDataMode() {
  if (!rl) fail("Re-run with --data-mode existing|clone|new.");
  say("KB data repo setup:");
  say("1. existing");
  say("2. clone");
  say("3. new");
  while (true) {
    const answer = await ask("Pick a data repo mode by number");
    if (answer === "1") return "existing";
    if (answer === "2") return "clone";
    if (answer === "3") return "new";
    say("Enter 1, 2, or 3.");
  }
}

async function chooseDataRepo(configPath) {
  const configured = currentConfiguredRepo(configPath);
  if (configured && !values["data-mode"] && !values["data-path"] && !values["data-url"]) {
    if (values.yes) return configured;
    const keep = (await ask(`Keep using existing kb-data repo at ${configured}? (y/n)`, "y"))
      .toLowerCase();
    if (keep === "y" || keep === "yes") return configured;
  }

  const dataMode = values["data-mode"]
    ? values["data-mode"].toLowerCase()
    : await chooseDataMode();
  if (!["existing", "clone", "new"].includes(dataMode)) {
    fail(`Unsupported data mode '${dataMode}'. Use existing, clone, or new.`);
  }

  if (dataMode === "existing") {
    const dataPath = values["data-path"] || (await ask("Path to existing kb-data repo"));
    return validateDataRepo(dataPath);
  }

  if (dataMode === "clone") {
    const dataUrl = values["data-url"] || (await ask("Git clone URL for kb-data"));
    const dataPath =
      values["data-path"] || (await ask("Where should the clone live?", "~/kb-data"));
    return cloneRepo(dataUrl, dataPath);
  }

  const dataPath =
    values["data-path"] || (await ask("Where should the new kb-data repo live?", "~/kb-data"));
  return createNewRepo(dataPath);
}

function installClaude() {
  ensureSymlink(CLAUDE_SKILL_LINK, REPO_ROOT);
  return {
    configPath: getClaudeFallbackConfigPath(),
    summary: `Claude linked ${CLAUDE_SKILL_LINK} -> ${REPO_ROOT}`,
  };
}

function installCodex() {
  const manifest = join(REPO_ROOT, ".codex-plugin", "plugin.json");
  if (!existsSync(manifest)) {
    throw new Error(`Missing Codex plugin manifest at ${manifest}`);
  }
  ensureSymlink(CODEX_PLUGIN_LINK, REPO_ROOT);
  writeJson(CODEX_MARKETPLACE_FILE, {
    name: CODEX_MARKETPLACE_NAME,
    plugins: [
      {
        name: "git-kb",
        source: {
          source: "local",
          path: "./plugins/git-kb",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ],
  });
  run("codex", ["plugin", "marketplace", "add", CODEX_MARKETPLACE_ROOT, "--json"]);
  run("codex", ["plugin", "add", `git-kb@${CODEX_MARKETPLACE_NAME}`, "--json"]);
  return {
    configPath: getCodexFallbackConfigPath(),
    summary: `Codex installed git-kb from local marketplace ${CODEX_MARKETPLACE_ROOT}`,
  };
}

function rebuildIndex(configPath) {
  run("node", [join(REPO_ROOT, "scripts", "kb-build-index.js")], {
    KB_CONFIG_PATH: configPath,
  });
}

async function main() {
  const availableHosts = [];
  if (commandExists("claude")) availableHosts.push("claude");
  if (commandExists("codex")) availableHosts.push("codex");
  if (availableHosts.length === 0) {
    fail("Neither 'claude' nor 'codex' is available on PATH.");
  }

  const host = await chooseHost(availableHosts);
  const install = host === "claude" ? installClaude() : installCodex();
  if (values.refresh) {
    const configured = currentConfiguredRepo(install.configPath);
    if (!configured) {
      fail(
        `No valid existing KB config found at ${install.configPath}. Run init without --refresh first.`,
      );
    }
    rebuildIndex(install.configPath);
    say("");
    say(install.summary);
    say(`KB data repo: ${configured}`);
    say(`Config reused: ${install.configPath}`);
    if (host === "claude") {
      say("Refresh complete. Start a new Claude Code session to pick up updated skill files.");
    } else {
      say("Refresh complete. Start a new Codex thread to pick up the reinstalled plugin.");
    }
    return;
  }

  const dataDir = await chooseDataRepo(install.configPath);
  writeConfig(install.configPath, dataDir);
  const companionPath =
    host === "claude" ? getCodexFallbackConfigPath() : getClaudeFallbackConfigPath();
  const syncedCompanion = syncCompanionConfig(install.configPath, companionPath, dataDir);
  rebuildIndex(install.configPath);

  say("");
  say(install.summary);
  say(`KB data repo: ${dataDir}`);
  say(`Config written: ${install.configPath}`);
  if (syncedCompanion) {
    say(`Companion config synced: ${companionPath}`);
  }
  if (host === "claude") {
    say("Next step: open a new Claude Code session and run /git-kb search or /git-kb add.");
  } else {
    say("Next step: open a new Codex thread. If Codex asks, trust the git-kb UserPromptSubmit hook.");
  }
}

try {
  await main();
  rl?.close();
} catch (error) {
  rl?.close();
  fail(error instanceof Error ? error.message : String(error));
}
