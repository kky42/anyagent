import {
  AUTO_DEFAULT,
  AUTO_LEVEL_LOW,
  AUTO_LEVEL_MEDIUM,
  normalizeAutoMode
} from "../../auto-mode.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../../runtime-settings.js";

const CLAUDE_WEB_TOOL_ARGS = ["--allowedTools", "WebFetch,WebSearch"];

/**
 * @typedef {object} ClaudeRunRequest
 * @property {string | null | undefined} [sessionId]
 * @property {string} message
 * @property {string} [autoMode]
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string | null | undefined} [developerInstructions]
 */

/**
 * @param {ClaudeRunRequest} request
 */
export function buildClaudeArgs({
  sessionId,
  message,
  autoMode = AUTO_DEFAULT,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  developerInstructions = null
}) {
  const normalizedAutoMode = normalizeAutoMode(autoMode, "autoMode");
  const modeArgs =
    normalizedAutoMode === AUTO_LEVEL_LOW
      ? ["--permission-mode", "dontAsk"]
      : normalizedAutoMode === AUTO_LEVEL_MEDIUM
        ? ["--permission-mode", "acceptEdits"]
        : ["--dangerously-skip-permissions"];
  const modelArgs = model === DEFAULT_MODEL ? [] : ["--model", model];
  const reasoningArgs =
    reasoningEffort === DEFAULT_REASONING_EFFORT ? [] : ["--effort", reasoningEffort];
  const developerInstructionArgs = developerInstructions
    ? ["--append-system-prompt", developerInstructions]
    : [];
  const resumeArgs = sessionId ? ["--resume", sessionId] : [];

  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...CLAUDE_WEB_TOOL_ARGS,
    ...modeArgs,
    ...modelArgs,
    ...reasoningArgs,
    ...developerInstructionArgs,
    ...resumeArgs,
    message
  ];
}
