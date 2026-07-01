// shared.js — utilities shared across kb-*.js scripts

import { homedir } from "node:os";
import { join } from "node:path";

export function getConfigPath() {
  return process.env.CLAUDE_PLUGIN_DATA
    ? join(process.env.CLAUDE_PLUGIN_DATA, "kb-config.json")
    : join(homedir(), ".claude", "kb-config.json");
}

// Expand a leading ~ (home dir) in a config path. Kept here so callers don't
// each need to import node:os.
export function expandHome(p) {
  return (p ?? "").replace(/^~(?=$|\/)/, homedir());
}
