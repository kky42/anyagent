import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { cliAdapterFor } from "../src/cli_adapter/index.js";
import { buildGroupInputMessage } from "../src/chat_adapter/common/group-turn.js";
import {
  buildGroupOutputDeveloperInstructions,
  PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
} from "../src/chat_adapter/common/output-instructions.js";
import {
  parseGroupOutputSegments,
  parseOutput
} from "../src/chat_adapter/common/output-attachments.js";

const AGENTS = ["codex", "claude", "pi"];
const DEFAULT_TIMEOUT_MS = 180_000;

function boolEnv(name, legacyName, defaultValue = false) {
  const value = process.env[name] ?? process.env[legacyName];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function envValue(name, legacyName, defaultValue = "") {
  const value = process.env[name] ?? process.env[legacyName];
  return value === undefined || value === "" ? defaultValue : value;
}

function parseTargets(raw) {
  const value = String(raw || "codex").trim().toLowerCase();
  if (value === "all") {
    return AGENTS;
  }
  if (value === "none" || value === "skip") {
    return [];
  }

  const targets = value.split(/[,\s]+/).filter(Boolean);
  for (const target of targets) {
    if (!AGENTS.includes(target)) {
      throw new Error(`Unknown agent behavior E2E target: ${target}`);
    }
  }
  return [...new Set(targets)];
}

function tail(text, maxLength = 5000) {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

async function waitForRun(run, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      run.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([run.done, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runTurn({
  agent,
  adapter,
  workdir,
  label,
  message,
  developerInstructions,
  timeoutMs,
  autoMode,
  model,
  reasoningEffort
}) {
  const state = {
    messages: [],
    errors: [],
    stderr: ""
  };

  const run = adapter.startRun({
    workdir,
    sessionId: null,
    message,
    autoMode,
    model,
    reasoningEffort,
    developerInstructions,
    forceKillDelayMs: 1000,
    onStdErr: (chunk) => {
      state.stderr += chunk;
    },
    onEvent: async (event) => {
      for (const action of adapter.eventToActions(event)) {
        if (action.kind === "message") {
          state.messages.push(action.text);
        } else if (action.kind === "error") {
          state.errors.push(action.text);
        }
      }
    }
  });

  let result;
  try {
    result = await waitForRun(run, timeoutMs, `${agent} ${label}`);
  } catch (error) {
    throw new Error(`${error.message}\nstderr:\n${tail(state.stderr)}`);
  }

  if (!result.sawTerminalEvent) {
    throw new Error(`${agent} ${label} did not emit a terminal event.\nstderr:\n${tail(state.stderr)}`);
  }
  if (state.errors.length > 0) {
    throw new Error(
      `${agent} ${label} emitted error actions:\n${state.errors.join("\n")}\nstderr:\n${tail(state.stderr)}`
    );
  }

  return state.messages.join("\n");
}

function assertPrivateAttachments(text, expectedAttachments) {
  const parsed = parseOutput(text);
  for (const expected of expectedAttachments) {
    const attachment = parsed.attachments.find(
      (entry) => entry.path === expected.path && entry.kind === expected.kind
    );
    if (!attachment) {
      throw new Error(
        `Expected private ${expected.kind} attachment ${expected.path}; got output:\n${tail(text)}`
      );
    }
  }
}

function assertNoMalformedAbsolutePath(text, absolutePath) {
  const malformedPath = `.${absolutePath}`;
  if (String(text ?? "").includes(malformedPath)) {
    throw new Error(
      `Expected absolute path ${absolutePath}, but output used malformed relative path ${malformedPath}:\n${tail(text)}`
    );
  }
}

function assertNoReplyContract(text) {
  const segments = parseGroupOutputSegments(text);
  if (segments.length > 0) {
    throw new Error(
      `Expected no group-visible output for unrelated content; got output:\n${tail(text)}`
    );
  }
  if (!/^\s*NO_REPLY\s*$/m.test(String(text ?? ""))) {
    throw new Error(`Expected explicit NO_REPLY contract output; got:\n${tail(text)}`);
  }
}

function groupMessagesFromReplyBlocks(text) {
  if (!/^\s*REPLY(?:\s|$)/m.test(String(text ?? ""))) {
    throw new Error(`Expected the agent to use REPLY blocks; got:\n${tail(text)}`);
  }

  return parseGroupOutputSegments(text)
    .filter((segment) => segment.kind === "group_message")
    .map((segment) => segment.text);
}

function assertReplyBlocks(text, expectedSnippets, { minReplies = expectedSnippets.length } = {}) {
  const messages = groupMessagesFromReplyBlocks(text);
  if (messages.length < minReplies) {
    throw new Error(
      `Expected at least ${minReplies} REPLY blocks; got ${messages.length} in output:\n${tail(text)}`
    );
  }

  for (const expectedText of expectedSnippets) {
    if (!messages.some((message) => message.includes(expectedText))) {
      throw new Error(
        `Expected a REPLY block containing ${JSON.stringify(expectedText)}; got output:\n${tail(text)}`
      );
    }
  }
}

function assertReplyBlocksDoNotMention(text, forbiddenSnippets) {
  const messages = groupMessagesFromReplyBlocks(text);
  for (const forbiddenText of forbiddenSnippets) {
    if (messages.some((message) => message.includes(forbiddenText))) {
      throw new Error(
        `Expected no REPLY block to mention ${JSON.stringify(forbiddenText)}; got output:\n${tail(text)}`
      );
    }
  }
}

function assertGroupAttachment(text, expectedPath, expectedKind) {
  const messages = groupMessagesFromReplyBlocks(text);
  const attachments = parseGroupOutputSegments(text)
    .filter((segment) => segment.kind === "attachment")
    .flatMap((segment) => segment.entries);
  const attachment = attachments.find(
    (entry) => entry.path === expectedPath && entry.kind === expectedKind
  );
  if (!attachment) {
    throw new Error(
      `Expected group ${expectedKind} attachment ${expectedPath}; got output:\n${tail(text)}`
    );
  }
  if (messages.length === 0) {
    throw new Error(`Expected group attachment to be inside a REPLY flow; got output:\n${tail(text)}`);
  }
}

function groupInstructions() {
  return buildGroupOutputDeveloperInstructions({
    botName: "Relay Bot",
    botHandle: "@relaybot"
  });
}

async function runAgentBehaviorE2E(agent, rootDir) {
  const adapter = cliAdapterFor(agent);
  const workdir = path.join(rootDir, agent, "workspace");
  const artifactDir = path.join(workdir, "artifacts");
  const fakeDesktopDir = path.join(rootDir, agent, "Desktop");
  const timeoutMs = Number(envValue("AGENT_BEHAVIOR_TIMEOUT_MS", "CONTRACT_PROMPT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
  const autoMode = envValue("AGENT_BEHAVIOR_AUTO", "CONTRACT_PROMPT_AUTO", "low");
  const model = envValue("AGENT_BEHAVIOR_MODEL", "CONTRACT_PROMPT_MODEL", "default");
  const reasoningEffort = envValue("AGENT_BEHAVIOR_REASONING", "CONTRACT_PROMPT_REASONING", "default");
  const screenshotPath = path.join(fakeDesktopDir, "Screenshot 2026-05-30 at 01.33.06.png");
  const groupRolloutPath = path.join(fakeDesktopDir, "group-rollout.png");

  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(fakeDesktopDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "private-report.txt"), "private report", "utf8");
  await fs.writeFile(screenshotPath, "fake desktop screenshot", "utf8");
  await fs.writeFile(groupRolloutPath, "fake group png", "utf8");

  console.log(`[${agent}] private attachment behavior`);
  const privateAttachments = await runTurn({
    agent,
    adapter,
    workdir,
    label: "private attachment behavior",
    message: [
      "Private chat scenario:",
      `The user asks: send me the existing local screenshot ${screenshotPath} and the existing local report ./artifacts/private-report.txt.`,
      "Use the relay output contract for attachments. The actual prose does not matter."
    ].join("\n"),
    developerInstructions: PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS,
    timeoutMs,
    autoMode,
    model,
    reasoningEffort
  });
  assertPrivateAttachments(privateAttachments, [
    { path: screenshotPath, kind: "photo" },
    { path: "./artifacts/private-report.txt", kind: "document" }
  ]);
  assertNoMalformedAbsolutePath(privateAttachments, screenshotPath);

  console.log(`[${agent}] unrelated group no-reply behavior`);
  const unrelatedGroup = await runTurn({
    agent,
    adapter,
    workdir,
    label: "unrelated group no-reply behavior",
    message: buildGroupInputMessage({
      messages: [
        "[2026-05-31 10:00:00] Alice (@alice):\nDoes anyone want lunch later?",
        "[2026-05-31 10:00:08] Bob (@bob):\nI can go after standup."
      ]
    }),
    developerInstructions: groupInstructions(),
    timeoutMs,
    autoMode,
    model,
    reasoningEffort
  });
  assertNoReplyContract(unrelatedGroup);

  console.log(`[${agent}] mixed group reply and attachment behavior`);
  const mixedGroup = await runTurn({
    agent,
    adapter,
    workdir,
    label: "mixed group reply and attachment behavior",
    message: buildGroupInputMessage({
      messages: [
        "[2026-05-31 10:02:00] Alice (@alice):\n@relaybot for the migration check, reply with MIGRATION_RISK_OK.",
        "[2026-05-31 10:02:07] Bob (@bob):\nI will update the changelog separately. This does not need a bot reply.",
        `[2026-05-31 10:02:15] Carol (@carol):\n@relaybot for the rollback note, reply with ROLLBACK_PLAN_OK and attach the existing rollout image ${groupRolloutPath}.`
      ]
    }),
    developerInstructions: groupInstructions(),
    timeoutMs,
    autoMode,
    model,
    reasoningEffort
  });
  assertReplyBlocks(mixedGroup, ["MIGRATION_RISK_OK", "ROLLBACK_PLAN_OK"], { minReplies: 2 });
  assertReplyBlocksDoNotMention(mixedGroup, ["changelog separately"]);
  assertGroupAttachment(mixedGroup, groupRolloutPath, "photo");
  assertNoMalformedAbsolutePath(mixedGroup, groupRolloutPath);

  console.log(`[${agent}] agent behavior e2e ok`);
}

async function main() {
  const targets = parseTargets(envValue("AGENT_BEHAVIOR_TARGETS", "CONTRACT_PROMPT_TARGETS", "codex"));
  if (targets.length === 0) {
    console.log("No agent behavior E2E targets selected.");
    return;
  }

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-agent-behavior-e2e-"));
  try {
    for (const agent of targets) {
      await runAgentBehaviorE2E(agent, rootDir);
    }
  } finally {
    if (!boolEnv("AGENT_BEHAVIOR_KEEP_TEMP", "CONTRACT_PROMPT_KEEP_TEMP", false)) {
      await fs.rm(rootDir, { recursive: true, force: true });
    } else {
      console.log(`Keeping agent behavior E2E temp directory: ${rootDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
