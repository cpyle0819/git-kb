#!/usr/bin/env node
// kb-prose-judge-codex.js — Codex PreToolUse hook that judges prose in a
// pending publish/edit action against the KB kernel rules and denies the tool
// call on violation.
//
// Contract:
//   stdin  : Codex PreToolUse payload
//   stdout : {} or a permissionDecision JSON (see deny()).
//   Fail-OPEN on every error/timeout — a judge that can't run must never block a
//   publish. Kill switch: KB_PROSE_LINT=0.

import { tmpdir } from "node:os";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath, resolveDataDir, loadEntries } from "./shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const KILL = /^(0|false|no|off)$/i.test(process.env.KB_PROSE_LINT ?? "");
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.KB_PROSE_LINT_DEBUG ?? "");
const DEBUG_LOG = process.env.KB_PROSE_LINT_DEBUG_LOG || join(tmpdir(), "kb-prose-judge-codex.debug.jsonl");
const JUDGE_TIMEOUT_MS = Number(process.env.KB_PROSE_LINT_TIMEOUT_MS || 45000);
const CODEX_BIN = process.env.KB_PROSE_LINT_CODEX || "codex";
const JUDGE_MODEL = process.env.KB_PROSE_LINT_MODEL || "";
const MIN_PROSE_CHARS = 60;

const EXCLUDE_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "TodoWrite", "WebFetch", "WebSearch",
  "Task", "Agent",
]);

function readPayload() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function debug(...args) {
  if (!DEBUG) return;
  console.error("[kb-prose-judge-codex]", ...args);
  try {
    appendFileSync(
      DEBUG_LOG,
      JSON.stringify({ ts: new Date().toISOString(), args }) + "\n",
    );
  } catch {
    // Best-effort debug logging only.
  }
}

function normalizeToolName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isArtifactTool(name) {
  if (!name) return false;
  if (EXCLUDE_TOOLS.has(name)) return false;
  const normalized = normalizeToolName(name);
  if (normalized === "bash" || normalized.endsWith("bash")) return false;
  if (normalized === "applypatch") return false;
  return true;
}

function collectProse(obj, path = "") {
  const out = [];
  if (obj == null) return out;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (s.length >= MIN_PROSE_CHARS && /\s/.test(s) && !/^https?:\/\/\S+$/.test(s)) {
      out.push({ field: path || "(value)", text: s });
    }
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...collectProse(v, `${path}[${i}]`)));
    return out;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      out.push(...collectProse(v, path ? `${path}.${k}` : k));
    }
  }
  return out;
}

function stripCommentPrefix(line) {
  return line
    .replace(/^\s*(?:\/\/+|#+|\/\*+|\*+|<!--|-->|;+)\s?/, "")
    .trim();
}

function collectApplyPatchProse(command) {
  if (!command) return [];
  const blocks = [];
  let currentFile = "(unknown file)";
  let currentLines = [];

  function flush() {
    const text = currentLines.join("\n").trim();
    if (text.length >= MIN_PROSE_CHARS && /\s/.test(text)) {
      blocks.push({ field: currentFile, text });
    }
    currentLines = [];
  }

  for (const rawLine of command.split("\n")) {
    if (rawLine.startsWith("*** Update File: ") || rawLine.startsWith("*** Add File: ")) {
      flush();
      currentFile = rawLine.replace(/^\*\*\* (?:Update|Add) File: /, "").trim();
      continue;
    }
    if (
      rawLine.startsWith("*** ") ||
      rawLine.startsWith("@@") ||
      rawLine.startsWith("---") ||
      rawLine.startsWith("+++")
    ) {
      flush();
      continue;
    }
    if (!rawLine.startsWith("+")) {
      flush();
      continue;
    }
    const stripped = stripCommentPrefix(rawLine.slice(1));
    if (!stripped || !/\s/.test(stripped)) {
      flush();
      continue;
    }
    currentLines.push(stripped);
  }
  flush();
  return blocks;
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function readApplyPatchCommand(toolInput) {
  if (typeof toolInput === "string") return toolInput;
  if (!toolInput || typeof toolInput !== "object") return "";
  return firstString([
    toolInput.command,
    toolInput.patch,
    toolInput.input,
    toolInput.text,
    toolInput.value,
  ]);
}

function shellTokens(command) {
  const tokens = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  for (const match of command.matchAll(re)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(token.replace(/\\(["'\\ ])/g, "$1"));
  }
  return tokens;
}

function isProseLike(text) {
  const s = (text || "").trim();
  return s.length >= MIN_PROSE_CHARS && /\s/.test(s) && !/^https?:\/\/\S+$/.test(s);
}

function readMaybeRelative(path, cwd) {
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    if (!existsSync(resolved)) return null;
    return readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

function collectBashArtifacts(command, cwd) {
  if (!command) return [];
  const tokens = shellTokens(command);
  const fields = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-m" && tokens[i + 1]) {
      const text = tokens[i + 1].trim();
      if (isProseLike(text)) {
        fields.push({ field: "command.-m", text });
      }
      i++;
      continue;
    }
    if (
      ["-F", "--body-file", "--description", "--message-file"].includes(token) &&
      tokens[i + 1]
    ) {
      const file = tokens[i + 1];
      const text = readMaybeRelative(file, cwd);
      if (text && isProseLike(text)) {
        fields.push({ field: `${token} ${basename(file)}`, text: text.trim() });
      }
      i++;
    }
  }

  if (fields.length > 0) return fields;

  const writesFile =
    tokens.some((t) => [">", ">>", "1>", "1>>"].includes(t)) ||
    tokens.includes("tee");
  if (writesFile) {
    let target = "command.write";
    for (let i = 0; i < tokens.length - 1; i++) {
      if ([">", ">>", "1>", "1>>"].includes(tokens[i])) {
        target = tokens[i + 1];
        break;
      }
      if (tokens[i] === "tee" && tokens[i + 1] && !tokens[i + 1].startsWith("-")) {
        target = tokens[i + 1];
        break;
      }
    }
    const inline = tokens
      .filter((t) => isProseLike(t))
      .map((text) => ({ field: target, text }));
    if (inline.length > 0) return inline;
  }

  const trimmed = command.trim();
  if (isProseLike(trimmed)) {
    return [{ field: "command", text: trimmed }];
  }
  return [];
}

function readBashCommand(toolInput) {
  if (typeof toolInput === "string") return toolInput;
  if (!toolInput || typeof toolInput !== "object") return "";
  return firstString([toolInput.command, toolInput.input, toolInput.text, toolInput.value]);
}

function bashCommandOptedIn(command) {
  if (!command) return false;
  try {
    const cfg = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    const pats = Array.isArray(cfg.bash_judge_patterns) ? cfg.bash_judge_patterns : [];
    return pats.some((p) => {
      try {
        return new RegExp(p).test(command);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function loadKernelRules() {
  try {
    const resolved = resolveDataDir();
    if (resolved.error) return "";
    const index = JSON.parse(readFileSync(join(resolved.dataDir, "kb-index.json"), "utf8"));
    const ids = index["__kernel__"] ?? [];
    if (ids.length === 0) return "";
    const { entries } = loadEntries(resolved.entriesDir);
    const byId = new Map(entries.map((e) => [e.id, e]));
    return ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((entry) => `### ${entry.id} — ${entry.title}\n---\n${entry.body}\n---`)
      .join("\n\n")
      .trim();
  } catch {
    return "";
  }
}

function codexJudge(rules, artifact, cwd) {
  const prompt =
    "You are a strict prose linter enforcing a house writing style on an artifact " +
    "about to be published. Judge ONLY against the rules below. Do not invent rules. " +
    "Ignore correctness of the underlying facts and judge the writing only. " +
    "Flag a violation only when it clearly breaks a rule; when in doubt, pass.\n\n" +
    "Return JSON that matches the required schema.\n\n" +
    "=== HOUSE STYLE RULES ===\n" +
    rules +
    "\n\n=== ARTIFACT TO JUDGE ===\n" +
    artifact;

  const schema = {
    type: "object",
    properties: {
      pass: { type: "boolean" },
      violations: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["pass", "violations"],
    additionalProperties: false,
  };

  const tempDir = mkdtempSync(join(tmpdir(), "kb-prose-judge-"));
  const schemaPath = join(tempDir, "schema.json");

  try {
    writeFileSync(schemaPath, JSON.stringify(schema));
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-c",
      'approval_policy="never"',
      "-c",
      "features.hooks=false",
      "--output-schema",
      schemaPath,
      prompt,
    ];
    if (JUDGE_MODEL) {
      args.splice(1, 0, "-m", JUDGE_MODEL);
    }
    const result = spawnSync(CODEX_BIN, args, {
      cwd,
      encoding: "utf8",
      timeout: JUDGE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        KB_PROSE_LINT: "0",
      },
    });
    if (result.status !== 0) {
      debug("codex judge stderr", result.stderr?.trim() || "");
      debug("codex judge stdout", result.stdout?.trim() || "");
      return null;
    }
    const raw = result.stdout.trim();
    debug("codex raw", raw);
    const verdict = JSON.parse(raw);
    if (typeof verdict.pass !== "boolean" || !Array.isArray(verdict.violations)) {
      return null;
    }
    return verdict;
  } catch (error) {
    debug("codex judge failed", error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

if (KILL) allow();

const payload = readPayload();
debug("payload", payload);
if (!payload) allow();

const toolName = payload.tool_name ?? payload.toolName ?? payload.tool ?? "";
const toolKey = normalizeToolName(toolName);
const toolInput = payload.tool_input ?? payload.toolInput ?? {};
const cwd = payload.cwd ?? process.cwd();

let proseFields = [];
if (toolKey === "applypatch") {
  proseFields = collectApplyPatchProse(readApplyPatchCommand(toolInput));
} else if (toolKey === "bash" || toolKey.endsWith("bash")) {
  const command = readBashCommand(toolInput);
  if (bashCommandOptedIn(command) || /(^|[^\S\r\n])(tee|printf|echo|cat)([^\S\r\n]|$)/.test(command)) {
    proseFields = collectBashArtifacts(command, cwd);
  }
} else if (isArtifactTool(toolName)) {
  proseFields = collectProse(toolInput);
}
debug("tool", toolName, "fields", proseFields.length);

if (proseFields.length === 0) allow();

const rules = loadKernelRules();
debug("rules length", rules.length);
if (!rules) allow();

const artifact = proseFields.map((p) => `## ${p.field}\n${p.text}`).join("\n\n");
const verdict = codexJudge(rules, artifact, cwd);
debug("verdict", verdict);
if (!verdict || verdict.pass) allow();

const list = verdict.violations.length
  ? verdict.violations.map((v) => `  • ${v}`).join("\n")
  : "  • (house-style violation flagged; no specifics returned)";

deny(
  "House-style prose check blocked this artifact before publishing. The tool call " +
    "did NOT run: nothing was written and the file is unchanged. Build the retry " +
    "against the file's current on-disk text. Revise the wording and retry; do " +
    "not bypass.\n\nViolations:\n" +
    list +
    "\n\n(This gate enforces the KB prose kernel. Kill switch if it misfires: set " +
    "KB_PROSE_LINT=0.)",
);
