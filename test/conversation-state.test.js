import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ConversationState,
  ConversationStateStore
} from "../src/chat_adapter/common/conversation-state.js";

function buildBindingConfig(overrides = {}) {
  return {
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

test("ConversationState persists delivery anchor, overrides, schedules, and session metadata", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-conversation-state-"));
  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const bindingConfig = buildBindingConfig();

  const state = await ConversationState.load({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    deliveryAnchor: {
      chatId: 1001,
      replyTarget: {
        messageThreadId: 11
      }
    },
    stateStore
  });

  await state.applyRuntimeSettings({
    cli: "pi",
    model: "gpt-5.4-mini"
  });
  await state.replaceSchedules([
    {
      name: "pulse",
      mode: "heartbeat",
      cron: "*/5 * * * *",
      prompt: "check the queue",
      enabled: true
    }
  ]);
  await state.updateSessionId("session-1", {
    additionalSystemPromptSnapshot: "frozen prompt"
  });
  await state.updateContextLength(1234);

  const reloaded = ConversationState.loadSync({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });

  assert.equal(reloaded.deliveryAnchor.chatId, 1001);
  assert.deepEqual(reloaded.deliveryAnchor.replyTarget, { messageThreadId: 11 });
  assert.equal(reloaded.cli, "pi");
  assert.equal(reloaded.model, "gpt-5.4-mini");
  assert.equal(reloaded.workdir, "/tmp/project");
  assert.equal(reloaded.sessionId, "session-1");
  assert.equal(reloaded.contextLength, 1234);
  assert.equal(reloaded.additionalSystemPromptSnapshot, "frozen prompt");
  assert.deepEqual(reloaded.schedules, [
    {
      name: "pulse",
      mode: "heartbeat",
      cron: "*/5 * * * *",
      prompt: "check the queue",
      enabled: true
    }
  ]);
});

test("ConversationState.loadSync clears stale session metadata when basis changes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-conversation-state-"));
  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const bindingConfig = buildBindingConfig();

  const state = await ConversationState.load({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });
  await state.updateSessionId("session-1", {
    additionalSystemPromptSnapshot: "frozen prompt"
  });
  await state.updateContextLength(4321);

  const changedBindingConfig = buildBindingConfig({
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: "/tmp/other-project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    }
  });

  const reloaded = ConversationState.loadSync({
    bindingConfig: changedBindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });

  assert.equal(reloaded.sessionId, null);
  assert.equal(reloaded.contextLength, null);
});

test("ConversationState.loadSync clears legacy session metadata without a prompt snapshot", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-conversation-state-"));
  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const bindingConfig = buildBindingConfig();
  const state = await ConversationState.load({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });

  await state.updateSessionId("session-1", {
    additionalSystemPromptSnapshot: "frozen prompt"
  });

  const scope = stateStore.scopeFor({
    agentId: bindingConfig.agent.id,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001"
  });
  const recordPath = stateStore.stateJsonPath(scope);
  const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
  delete record.session.basis.additionalSystemPromptSnapshot;
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const reloaded = ConversationState.loadSync({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });

  assert.equal(reloaded.sessionId, null);
  assert.equal(reloaded.additionalSystemPromptSnapshot, null);
});

test("ConversationState.updateSessionId preserves missing prompt snapshots as null", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-conversation-state-"));
  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const bindingConfig = buildBindingConfig();
  const state = await ConversationState.load({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });

  await state.updateSessionId("session-1");

  const scope = stateStore.scopeFor({
    agentId: bindingConfig.agent.id,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001"
  });
  const record = JSON.parse(await fs.readFile(stateStore.stateJsonPath(scope), "utf8"));

  assert.equal(state.additionalSystemPromptSnapshot, null);
  assert.equal(record.session.basis.additionalSystemPromptSnapshot, null);
});

test("ConversationState.loadSync clears legacy session metadata with an empty prompt snapshot", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-conversation-state-"));
  const stateStore = new ConversationStateStore({
    rootDir: path.join(tempDir, "state")
  });
  const bindingConfig = buildBindingConfig();
  const state = await ConversationState.load({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });

  await state.updateSessionId("session-1", {
    additionalSystemPromptSnapshot: ""
  });

  const scope = stateStore.scopeFor({
    agentId: bindingConfig.agent.id,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001"
  });
  const record = JSON.parse(await fs.readFile(stateStore.stateJsonPath(scope), "utf8"));

  assert.equal(state.additionalSystemPromptSnapshot, null);
  assert.equal(record.session.basis.additionalSystemPromptSnapshot, null);

  const reloaded = ConversationState.loadSync({
    bindingConfig,
    platform: "telegram",
    bindingId: "relaybot",
    conversationId: "1001",
    stateStore
  });

  assert.equal(reloaded.sessionId, null);
  assert.equal(reloaded.additionalSystemPromptSnapshot, null);
});
