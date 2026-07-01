// shared.js — utilities shared across kb-*.js scripts

import { homedir } from "node:os";
import { join } from "node:path";

export function getConfigPath() {
  return process.env.CLAUDE_PLUGIN_DATA
    ? join(process.env.CLAUDE_PLUGIN_DATA, "kb-config.json")
    : join(homedir(), ".claude", "kb-config.json");
}
