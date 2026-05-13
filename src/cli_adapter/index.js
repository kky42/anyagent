import { buildClaudeArgs } from "./claude/args.js";
import { eventToActions as claudeEventToActions } from "./claude/events.js";
import { startClaudeRun } from "./claude/runner.js";
import { buildCodexArgs } from "./codex/args.js";
import { readContextLengthForSession } from "./codex/context-length.js";
import { eventToActions as codexEventToActions } from "./codex/events.js";
import { startCodexRun } from "./codex/runner.js";

export const SUPPORTED_AGENT_CLIS = ["codex", "claude"];

const CLI_ADAPTERS = {
  codex: {
    id: "codex",
    displayName: "Codex",
    buildArgs: buildCodexArgs,
    eventToActions: codexEventToActions,
    startRun: startCodexRun,
    resolveContextLength: readContextLengthForSession,
    supportsNativeImages: true
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    buildArgs: buildClaudeArgs,
    eventToActions: claudeEventToActions,
    startRun: startClaudeRun,
    resolveContextLength: async () => null,
    supportsNativeImages: false
  }
};

export function cliAdapterFor(cli) {
  const adapter = CLI_ADAPTERS[String(cli ?? "").trim().toLowerCase()];
  if (!adapter) {
    throw new Error(`Unsupported agent CLI: ${cli}`);
  }
  return adapter;
}
