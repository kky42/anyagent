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
  await state.updateSessionId("session-1");
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
  await state.updateSessionId("session-1");
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
