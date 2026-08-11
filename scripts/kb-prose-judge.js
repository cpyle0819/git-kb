#!/usr/bin/env node
// kb-prose-judge.js — PreToolUse hook that judges the prose in an artifact-writing
// tool call against the house-style KERNEL rules BEFORE the call runs, and denies
// it on violation so bad prose never reaches the server (a code-review
// description, commit message, ticket, or comment).
//
// Runs pre-publish (PreToolUse): a code-review or ticket write reaches the server
// mid-turn, so gating the tool call is the only point where a violation can stop
// the text from being published rather than merely corrected afterward.
//
// Contract:
//   stdin  : { tool_name, tool_input, ... }  (Claude Code PreToolUse payload)
//   stdout : {} or a permissionDecision JSON (see deny()).
//   Fail-OPEN on every error/timeout — a judge that can't run must never block a
//   publish. Kill switch: KB_PROSE_LINT=0.
//
// The rules are pulled live from the KB kernel (entries flagged kernel: true) via
// kb-get, so this enforces exactly the kernel the user maintains — no duplicated
// ruleset to drift.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath, expandHome } from "./shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const KILL = /^(0|false|no|off)$/i.test(process.env.KB_PROSE_LINT ?? "");
const JUDGE_MODEL = process.env.KB_PROSE_LINT_MODEL || "sonnet";
const JUDGE_TIMEOUT_MS = Number(process.env.KB_PROSE_LINT_TIMEOUT_MS || 45000);
const CLAUDE_BIN = process.env.KB_PROSE_LINT_CLAUDE || "claude";
// Only judge text over this length — a short label (a slug, a branch name, a
// one-line status) isn't prose worth gating and is a false-positive magnet.
const MIN_PROSE_CHARS = 60;

// ─── Which tools publish prose ─────────────────────────────────────────────────
// The hook's `matcher` (in hooks/hooks.json) decides which tools reach this
// script — that is the single place tool coverage is configured. This script
// trusts the matcher: any tool it receives is judged as a prose publish, except
// the exclude-list below. To cover your own toolchain, add a PreToolUse matcher
// entry pointing at this script in your local settings.json (e.g. a matcher of
// `.*YourReviewTool|.*YourTicketTool`) — no code change here, and your internal
// tool names stay out of this shared repo.
//
// Tools that never carry prose worth gating — a read/search returns data, a todo
// is scratch, a subagent launch is a prompt. They're skipped even under a broad
// matcher (e.g. `.*`). File writes (Write/Edit/MultiEdit/NotebookEdit) are in
// scope: a written file is as often a README, a doc, a message, or a chapter as
// it is code, so the prose/non-prose decision belongs to the collector's length
// filter and the judge, per file, rather than to this tool list. Bash is judged
// only when the command matches a local-config pattern (see bashCommandOptedIn);
// the whole command string goes to the judge, with no shape parsing here.
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

// Any tool the matcher routed here is a prose publish, unless it's a known local
// tool (code/scratch/prompt) or Bash (handled separately for git-commit messages).
function isArtifactTool(name) {
  if (!name) return false;
  if (EXCLUDE_TOOLS.has(name)) return false;
  if (name === "Bash" || /(^|_)Bash$/i.test(name)) return false;
  return true;
}

// Pull every prose-like string from an arbitrary tool_input object, labeled by
// its key path. Schema-agnostic: we don't guess field names (they differ across
// code-review / issue / comment tools and change over time). A value counts as prose if it's a
// string with a space and >= MIN_PROSE_CHARS — that filters ids, slugs, enums,
// URLs, and branch names while keeping descriptions/summaries/comments.
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

// Bash commands carry prose in shapes that differ per shell tool (git commit
// `-m`, an internal CR CLI's `--description`, and so on). Encoding those shapes
// here would put tool-specific parsing — and internal tool names — into this
// shared script. Instead the LOCAL config (`kb-config.json`, never this repo)
// lists regex patterns naming which commands publish prose worth judging; a
// matching command is handed to the semantic judge verbatim, and the model finds
// and judges any prose in the command string itself. Prose that lives in a file
// the command only references by path is not inlined — the judge sees the path,
// not the file. With no `bash_judge_patterns` configured, no Bash command is
// judged.
function bashCommandOptedIn(command) {
  if (!command) return false;
  try {
    const cfg = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    const pats = Array.isArray(cfg.bash_judge_patterns) ? cfg.bash_judge_patterns : [];
    return pats.some((p) => {
      try {
        return new RegExp(p).test(command);
      } catch {
        return false; // a malformed config pattern must never break the judge
      }
    });
  } catch {
    return false;
  }
}

// Fetch the kernel rule text from the KB (entries flagged kernel: true). Returns
// "" if anything fails — the caller fails open on empty rules.
function loadKernelRules() {
  try {
    const cfg = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    const dataDir = expandHome(cfg.data_dir);
    const index = JSON.parse(readFileSync(join(dataDir, "kb-index.json"), "utf8"));
    const ids = index["__kernel__"] ?? [];
    if (ids.length === 0) return "";
    const out = execFileSync("node", [join(__dirname, "kb-get.js"), ...ids], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return "";
  }
}

// Ask a fast model whether the artifact violates the kernel. Returns
// {pass:boolean, violations:string[]} or null on any failure (→ fail open).
function judge(rules, artifact) {
  const prompt =
    "You are a strict prose linter enforcing a house writing style on an artifact " +
    "about to be published (a code-review description, commit message, ticket, or " +
    "comment). Judge ONLY against the rules below. Do not invent rules. Ignore " +
    "correctness of the underlying facts — judge the writing only. Flag a violation " +
    "only when it clearly breaks a rule; when in doubt, pass (false positives block " +
    "a real publish, so bias toward passing borderline cases).\n\n" +
    "The artifact may be a shell command that carries the prose to publish in a file " +
    "it references by path (for example a `--description <path>` or `-F <path>` " +
    "argument) rather than inline. When it does, read that file with the Read tool and " +
    "judge its contents as the artifact. Judge the prose being published, never the " +
    "shell syntax around it. If no such file is referenced, judge the text as given.\n\n" +
    "=== HOUSE STYLE RULES ===\n" +
    rules +
    "\n\n=== ARTIFACT TO JUDGE ===\n" +
    artifact +
    "\n\n=== OUTPUT ===\n" +
    "Reply with ONLY a JSON object, no prose around it:\n" +
    '{"pass": true|false, "violations": ["<rule broken> — <the offending phrase, quoted>", ...]}\n' +
    "Empty violations array when it passes. Cite the specific offending phrase in each violation.";
  let raw;
  try {
    raw = execFileSync(
      CLAUDE_BIN,
      ["-p", prompt, "--output-format", "text", "--model", JUDGE_MODEL,
       "--allowedTools", "Read"],
      { encoding: "utf8", timeout: JUDGE_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return null;
  }
  // Extract the JSON object from the reply (model may wrap it in fences/prose).
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (typeof v.pass !== "boolean") return null;
    return { pass: v.pass, violations: Array.isArray(v.violations) ? v.violations : [] };
  } catch {
    return null;
  }
}

function allow() {
  process.exit(0); // no output = allow
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

// ─── Main ──────────────────────────────────────────────────────────────────────

if (KILL) allow();

const payload = readPayload();
if (!payload) allow();

const toolName = payload.tool_name ?? payload.toolName ?? "";
const toolInput = payload.tool_input ?? payload.toolInput ?? {};

// Gather the prose this call would publish.
let proseFields = [];
if (isArtifactTool(toolName)) {
  proseFields = collectProse(toolInput);
} else if (toolName === "Bash" || /(^|_)Bash$/i.test(toolName)) {
  const command = toolInput.command ?? "";
  if (bashCommandOptedIn(command)) {
    proseFields = [{ field: "command", text: command }];
  }
}
if (proseFields.length === 0) allow(); // nothing prose-like to judge

const rules = loadKernelRules();
if (!rules) allow(); // no rules available → fail open

const artifact = proseFields.map((p) => `## ${p.field}\n${p.text}`).join("\n\n");
const verdict = judge(rules, artifact);
if (!verdict || verdict.pass) allow(); // pass or judge failed → allow

const list = verdict.violations.length
  ? verdict.violations.map((v) => `  • ${v}`).join("\n")
  : "  • (house-style violation flagged; no specifics returned)";
deny(
  "House-style prose check blocked this artifact before publishing. The tool call " +
    "did NOT run: nothing was written and the file is unchanged. Build the retry " +
    "against the file's current on-disk text — the prose you just proposed was " +
    "never applied, so an old_string that quotes it will not match. Revise the " +
    "wording and retry; do not bypass.\n\nViolations:\n" +
    list +
    "\n\n(This gate enforces the KB prose kernel. Kill switch if it misfires: set " +
    "KB_PROSE_LINT=0.)",
);
