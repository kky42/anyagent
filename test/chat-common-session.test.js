import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { ChatSession } from "../src/chat_adapter/common/chat-session.js";
import { routeCommandOrTurn } from "../src/chat_adapter/common/command-router.js";
import {
  ConversationState,
  ConversationStateStore
} from "../src/chat_adapter/common/conversation-state.js";
import { PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/common/output-instructions.js";
import { createControlledRunnerFactory } from "./support/fakes.js";
import { waitFor } from "./support/async.js";

class FakeChatOutput {
  constructor() {
    this.texts = [];
    this.progress = [];
    this.finals = [];
    this.groupFinals = [];
    this.errors = [];
    this.typing = [];
    this.stopTypingCount = 0;
    this.resetCount = 0;
    this.clearProgressCount = 0;
    this.groupFinalFailure = null;
  }

  resetTransientState() {
    this.resetCount += 1;
  }

  async sendText(text, options = {}) {
    this.texts.push({ text, options });
  }

  async sendMessageChunk(rawChunk, options = {}) {
    this.texts.push({ text: rawChunk, options });
    return { id: this.texts.length };
  }

  async editMessageChunk(messageId, rawChunk, options = {}) {
    this.texts.push({ messageId, text: rawChunk, options });
  }

  async sendSplitText(rawText, options = {}) {
    this.texts.push({ text: rawText, options });
    return this.texts.length;
  }

  async renderProgressText(text, options = {}) {
    this.progress.push({ text, options });
  }

  async clearProgressMessage() {
    this.clearProgressCount += 1;
  }

  async renderFinalMessage(text, options = {}) {
    this.finals.push({ text, options });
  }

  async renderGroupFinalMessage(text, options = {}) {
    if (this.groupFinalFailure) {
      throw this.groupFinalFailure;
    }
    this.groupFinals.push({ text, options });
  }

  async renderErrorText(text, options = {}) {
    this.errors.push({ text, options });
  }

  async sendCodexOutput(text, options = {}) {
    this.texts.push({ text, options });
  }

  startTyping(replyTarget = null) {
    this.typing.push(replyTarget);
  }

  stopTyping() {
    this.stopTypingCount += 1;
  }
}

function buildBindingConfig(overrides = {}) {
  return {
    platform: "testchat",
    bindingId: "workspace-main",
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: "/tmp/project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    ...overrides
  };
}

async function createCommonSession(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-common-session-"));
  const output = options.output ?? new FakeChatOutput();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const logs = [];
  const session = new ChatSession({
    bindingConfig: options.bindingConfig ?? buildBindingConfig(),
    output,
    configStore: options.configStore,
    logger: (message) => logs.push(message),
    conversationId: options.conversationId ?? "conversation-1",
    cacheRootDir: path.join(tempDir, "cache"),
    createAgentRun: (params) => runnerFactory.createRun(params),
    resolveContextLength: options.resolveContextLength ?? (async () => 3456),
    resolveHomeDir: options.resolveHomeDir
  });

  return { session, output, runnerFactory, logs, tempDir };
}

async function createSessionWithPersistedCliOverride({
  defaultCli = "claude",
  overrideCli = "pi",
  conversationId = "conversation-1"
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-common-session-"));
  const bindingConfig = buildBindingConfig({
    agent: {
      ...buildBindingConfig().agent,
      cli: defaultCli
    }
  });
  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const state = await ConversationState.load({
    bindingConfig,
    platform: bindingConfig.platform,
    bindingId: bindingConfig.bindingId,
    conversationId,
    stateStore
  });
  await state.applyRuntimeSettings({ cli: overrideCli });

  const output = new FakeChatOutput();
  const runnerFactory = createControlledRunnerFactory();
  const logs = [];
  const session = new ChatSession({
    bindingConfig,
    output,
    logger: (message) => logs.push(message),
    platform: bindingConfig.platform,
    bindingId: bindingConfig.bindingId,
    conversationId,
    cacheRootDir: path.join(tempDir, "cache"),
    stateStore,
    createAgentRun: (params) => runnerFactory.createRun(params),
    resolveContextLength: async () => 3456
  });

  return { session, output, runnerFactory, logs, tempDir };
}

test("common ChatSession owns queueing, run orchestration, and opaque reply targets", async () => {
  const { session, output, runnerFactory, logs } = await createCommonSession();
  const replyTarget = { channelId: "channel-1", rootId: "post-root" };

  await session.enqueueMessage("first", { replyTarget });

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.cli, "codex");
  assert.equal(runnerFactory.runs[0].params.workdir, "/tmp/project");
  assert.equal(runnerFactory.runs[0].params.sessionId, null);
  assert.equal(runnerFactory.runs[0].params.autoMode, "medium");
  assert.deepEqual(output.typing, [replyTarget]);

  await session.enqueueMessage("second", { replyTarget });
  assert.equal(session.queue.length, 1);
  assert.deepEqual(output.texts.at(-1), {
    text: "Queued message 1.",
    options: { replyTarget }
  });

  await runnerFactory.runs[0].emit({
    type: "thread.started",
    thread_id: "session-1"
  });
  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      type: "tool_call"
    }
  });
  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "done"
    }
  });
  await runnerFactory.runs[0].emit({
    type: "turn.completed"
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => runnerFactory.runs.length === 2);

  assert.equal(session.sessionId, "session-1");
  assert.equal(session.contextLength, 3456);
  assert.deepEqual(output.progress, [
    {
      text: "tool_call",
      options: { replyTarget }
    }
  ]);
  assert.deepEqual(output.finals, [
    {
      text: "done",
      options: { replyTarget, workdir: "/tmp/project" }
    }
  ]);
  assert.equal(output.clearProgressCount, 1);
  assert.equal(output.stopTypingCount, 1);
  assert.match(logs[0], /starting codex run/);
  assert.equal(runnerFactory.runs[1].params.sessionId, "session-1");
});

test("common ChatSession restores the CLI adapter from durable CLI overrides", async () => {
  const { session, runnerFactory, logs } = await createSessionWithPersistedCliOverride({
    defaultCli: "claude",
    overrideCli: "pi"
  });

  assert.equal(session.cli, "pi");
  assert.equal(session.cliAdapter.id, "pi");

  await session.enqueueMessage("hello after restart");
  await waitFor(() => runnerFactory.runs.length === 1);

  assert.equal(runnerFactory.runs[0].params.cli, "pi");
  assert.match(logs[0], /starting pi run/);

  runnerFactory.runs[0].finish();
  await waitFor(() => !session.isRunning);
});

test("/cli compares the requested CLI with the restored effective CLI", async () => {
  const { session, output } = await createSessionWithPersistedCliOverride({
    defaultCli: "claude",
    overrideCli: "pi"
  });

  await session.handleCli("claude");

  assert.equal(session.cli, "claude");
  assert.equal(session.cliAdapter.id, "claude");
  assert.equal(
    output.texts.at(-1).text,
    "CLI set to claude. Started a new session. The next message will open a fresh Claude session."
  );
});

test("common ChatSession surfaces group output delivery failures as visible relay errors", async () => {
  const output = new FakeChatOutput();
  output.groupFinalFailure = new TypeError("fetch failed");
  const { session, runnerFactory, logs } = await createCommonSession({ output });

  await session.enqueueTurn({
    mode: "group",
    promptText: "Messages since your last turn:\n\nalice (@alice):\nhello",
    replyTarget: { channelId: "channel-1" },
    groupIdentity: {
      botName: "Relay Bot",
      botHandle: "@relaybot"
    }
  });
  const run = runnerFactory.runs[0];
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "REPLY @alice\nhello"
    }
  });
  await run.emit({
    type: "turn.completed"
  });
  run.finish();

  await waitFor(() => !session.isRunning);

  assert.deepEqual(output.groupFinals, []);
  assert.deepEqual(output.errors, [
    {
      text: "Failed to deliver group output: fetch failed",
      options: { replyTarget: { channelId: "channel-1" } }
    }
  ]);
  assert.equal(logs.some((message) => /process error/.test(message)), false);
});

test("common ChatSession retries once with a fresh session after resume failure", async () => {
  const { session, output, runnerFactory } = await createCommonSession();
  session.sessionId = "stale-session";

  await session.enqueueMessage("retry me");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.sessionId, "stale-session");

  await runnerFactory.runs[0].emit({
    type: "error",
    message: "session not found"
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => runnerFactory.runs.length === 2);

  assert.equal(output.texts.at(-1).text, "Stored session could not be resumed. Started a fresh session for this conversation.");
  assert.equal(session.sessionId, null);
  assert.equal(runnerFactory.runs[1].params.sessionId, null);

  await runnerFactory.runs[1].emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "fresh answer"
    }
  });
  await runnerFactory.runs[1].emit({
    type: "turn.completed"
  });
  runnerFactory.runs[1].finish();

  await waitFor(() => !session.isRunning);
  assert.deepEqual(output.finals.at(-1), {
    text: "fresh answer",
    options: { replyTarget: null, workdir: "/tmp/project" }
  });
});

test("common ChatSession freezes combined additional system prompt for a conversation session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-profile-instructions-"));
  const profileInstructionsPath = path.join(tempDir, "AGENTS.md");
  await fs.writeFile(profileInstructionsPath, "first profile instructions", "utf8");
  const bindingConfig = buildBindingConfig({
    agent: {
      id: "primary-agent",
      cli: "claude",
      workdir: "/tmp/project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default",
      profileInstructionsPath
    }
  });
  const { session, runnerFactory, logs } = await createCommonSession({ bindingConfig });

  await session.enqueueMessage("first");
  await session.enqueueMessage("second");

  const snapshot = runnerFactory.runs[0].params.developerInstructions;
  assert.match(snapshot, /^# Profile Instructions/);
  assert.match(snapshot, /first profile instructions/);
  assert.match(snapshot, /# Relay Output Contract/);
  assert.match(snapshot, /ATTACH/);
  assert.ok(snapshot.endsWith(PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS));
  assert.ok(snapshot.indexOf("first profile instructions") < snapshot.indexOf("ATTACH"));
  assert.doesNotMatch(logs[0], /first profile instructions/);

  await fs.writeFile(profileInstructionsPath, "second profile instructions", "utf8");
  await runnerFactory.runs[0].emit({
    type: "system",
    subtype: "init",
    session_id: "session-1"
  });
  await runnerFactory.runs[0].emit({
    type: "result"
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => runnerFactory.runs.length === 2);

  assert.equal(session.sessionId, "session-1");
  assert.equal(session.additionalSystemPromptSnapshot, snapshot);
  assert.equal(runnerFactory.runs[1].params.sessionId, "session-1");
  assert.equal(runnerFactory.runs[1].params.developerInstructions, snapshot);
  assert.doesNotMatch(runnerFactory.runs[1].params.developerInstructions, /second profile/);
});

test("common ChatSession /new reloads profile instructions for the next fresh session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-profile-new-"));
  const profileInstructionsPath = path.join(tempDir, "AGENTS.md");
  await fs.writeFile(profileInstructionsPath, "first profile instructions", "utf8");
  const bindingConfig = buildBindingConfig({
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: "/tmp/project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default",
      profileInstructionsPath
    }
  });
  const { session, runnerFactory } = await createCommonSession({ bindingConfig });

  await session.enqueueMessage("first");
  const firstSnapshot = runnerFactory.runs[0].params.developerInstructions;
  assert.match(firstSnapshot, /first profile instructions/);

  await runnerFactory.runs[0].emit({
    type: "thread.started",
    thread_id: "session-1"
  });
  await runnerFactory.runs[0].emit({
    type: "turn.completed"
  });
  runnerFactory.runs[0].finish();
  await waitFor(() => !session.isRunning);

  await fs.writeFile(profileInstructionsPath, "second profile instructions", "utf8");
  await session.handleNewSession();
  await session.enqueueMessage("after new");

  assert.equal(session.sessionId, null);
  assert.equal(runnerFactory.runs[1].params.sessionId, null);
  assert.match(runnerFactory.runs[1].params.developerInstructions, /second profile instructions/);
  assert.doesNotMatch(runnerFactory.runs[1].params.developerInstructions, /first profile/);
});

test("common ChatSession cache scopes use generic platform and binding ids", async () => {
  const { session } = await createCommonSession({
    bindingConfig: buildBindingConfig({
      platform: "futurechat",
      bindingId: "workspace-a"
    }),
    conversationId: "channel:abc"
  });

  const scope = session.cacheScope();

  assert.equal(scope.agentId, "primary-agent");
  assert.equal(scope.platform, "futurechat");
  assert.equal(scope.bindingId, "workspace-a");
  assert.equal(scope.conversationId, "channel:abc");
  assert.equal(scope.scopeKey, "primary-agent:futurechat:workspace-a:channel:abc");
});

test("common ChatSession reset reloads through generic chat binding config", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-common-reset-"));
  const calls = [];
  const configStore = {
    async loadChatBindingConfig(args) {
      calls.push(args);
      return buildBindingConfig({
        agent: {
          id: "primary-agent",
          cli: "claude",
          workdir: nextWorkdir,
          auto: "high",
          model: "gpt-5.4-mini",
          reasoningEffort: "high"
        }
      });
    }
  };
  const { session, output } = await createCommonSession({ configStore });
  await session.handleAuto("low");
  await session.handleModel("default");
  await session.updateSessionId("session-old");
  await session.updateContextLength(1200);

  await session.handleReset({ replyTarget: { channelId: "channel-1" } });

  assert.deepEqual(calls, [
    {
      platform: "testchat",
      agentId: "primary-agent",
      bindingId: "workspace-main"
    }
  ]);
  assert.equal(session.cliAdapter.id, "claude");
  assert.equal(session.workdir, nextWorkdir);
  assert.equal(session.auto, "high");
  assert.equal(session.model, "gpt-5.4-mini");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(session.sessionId, null);
  assert.equal(session.contextLength, null);
  assert.match(output.texts.at(-1).text, /Reset current chat to config defaults/);
  assert.deepEqual(output.texts.at(-1).options, { replyTarget: { channelId: "channel-1" } });
});

test("common command router maps shared commands and reports unknown commands", async () => {
  const calls = [];
  const session = {
    async handleStatus(options) {
      calls.push(["status", options]);
    },
    async handleAuto(args, options) {
      calls.push(["auto", args, options]);
    },
    async sendText(text, options) {
      calls.push(["text", text, options]);
    },
    async enqueueMessage(text, options) {
      calls.push(["turn", text, options]);
    }
  };
  const runtime = {
    async handleClearCache(currentSession, options) {
      calls.push(["clear_cache", currentSession === session, options]);
    }
  };
  const replyTarget = { channelId: "channel-1" };

  await routeCommandOrTurn({ command: "status", session, runtime, replyTarget });
  await routeCommandOrTurn({ command: "auto", args: "high", session, runtime, replyTarget });
  await routeCommandOrTurn({ command: "clear_cache", session, runtime, replyTarget });
  const routed = await routeCommandOrTurn({
    command: "unknown",
    text: "/unknown keep as prompt",
    session,
    runtime,
    replyTarget
  });

  assert.deepEqual(calls, [
    ["status", { replyTarget }],
    ["auto", "high", { replyTarget }],
    ["clear_cache", true, { replyTarget }],
    ["text", "Unknown command.", { replyTarget }]
  ]);
  assert.equal(routed, undefined);
});
