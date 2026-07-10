// shared.js — utilities shared across kb-*.js scripts

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";

export function getConfigPath() {
  if (process.env.CLAUDE_PLUGIN_DATA) {
    const p = join(process.env.CLAUDE_PLUGIN_DATA, "kb-config.json");
    if (existsSync(p)) return p;
  }
  return join(homedir(), ".claude", "kb-config.json");
}

// Expand a leading ~ (home dir) in a config path. Kept here so callers don't
// each need to import node:os.
export function expandHome(p) {
  return (p ?? "").replace(/^~(?=$|\/)/, homedir());
}

// Parse one entry's markdown (frontmatter + body) into a structured object.
// Returns null if the frontmatter fence is missing/malformed.
export function parseEntry(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;
  const get = (k) => {
    const r = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m"));
    return r ? r[1].trim() : "";
  };
  const tagsRaw = get("tags");
  const tags = tagsRaw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const links = [...fm.matchAll(/to:[ \t]*(kb-\d+)/g)].map((x) => x[1]);
  const url = get("url") || null;
  return {
    id: get("id"),
    title: get("title"),
    type: get("type"),
    url,
    tags,
    links,
    created: get("created"),
    updated: get("updated"),
    body: body.trim(),
  };
}

// Resolve the kb-data repo's entries/ dir from the config file. Returns
// {dataDir, entriesDir} on success, or {error, code} for the caller to print
// and exit with.
export function resolveDataDir() {
  const configPath = getConfigPath();
  let dataDir;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    dataDir = expandHome(cfg.data_dir);
  } catch {
    return {
      error: `ERROR: cannot read ${configPath} (run /kb init to set up the data repo)`,
      code: 3,
    };
  }
  const entriesDir = join(dataDir, "entries");
  if (!dataDir || !existsSync(entriesDir)) {
    return {
      error: `ERROR: data_dir invalid or has no entries/: '${dataDir}' (run /kb init)`,
      code: 4,
    };
  }
  return { dataDir, entriesDir };
}

// Load and parse every .md entry in entriesDir. Returns {entries, titleById}.
export function loadEntries(entriesDir) {
  const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
  const entries = [];
  const titleById = {};
  for (const f of files) {
    const e = parseEntry(readFileSync(join(entriesDir, f), "utf8"));
    if (!e) continue;
    e.file = f;
    entries.push(e);
    if (e.id) titleById[e.id] = e.title;
  }
  return { entries, titleById };
}
