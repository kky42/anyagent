import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCacheScope } from "../src/chat_adapter/cache-scope.js";
import { createRuntime } from "./support/builders.js";
import { FakeBotApi } from "./support/fakes.js";
import { waitFor } from "./support/async.js";

function buildTextMessage(text, username = "AllowedUser", chatId = 1001, overrides = {}) {
  return {
    chat: { id: chatId, type: "private" },
    from: { id: 42, username },
    text,
    ...overrides
  };
}

function telegramScope(cacheRootDir, { agentId = "primary-agent", botUsername = "relaybot", chatId = 1001 } = {}) {
  return buildCacheScope({
    cacheRootDir,
    agentId,
    platform: "telegram",
    bindingId: botUsername,
    conversationId: chatId
  });
}

test("unauthorized users are told which Telegram username to allow", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "OtherUser" },
    text: "hello"
  });

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    'You are not authorized to use this bot. Your Telegram username is @otheruser. Add "otheruser" to allowedUsernames in this Telegram binding.'
  );
});

test("runtime discards pending Telegram updates during startup", async () => {
  const fakeBotApi = new FakeBotApi({
    getUpdatesResult: [{ update_id: 77, message: { text: "old" } }]
  });
  const { runtime } = await createRuntime({ fakeBotApi });

  await runtime.initialize();

  assert.deepEqual(fakeBotApi.getUpdatesCalls[0], {
    offset: -1,
    limit: 1,
    timeout: 0
  });
  assert.equal(runtime.offset, 78);
  assert.equal(runtime.sessions.size, 0);
});

test("runtime aggregates media groups into one attachment turn", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    albumQuietPeriodMs: 5
  });
  fakeBotApi.registerFile("photo-1", {
    filePath: "photos/one.jpg",
    body: Buffer.from("one")
  });
  fakeBotApi.registerFile("photo-2", {
    filePath: "photos/two.jpg",
    body: Buffer.from("two")
  });

  await runtime.handleMessage({
    message_id: 101,
    media_group_id: "album-1",
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    caption: "compare these",
    photo: [{ file_id: "photo-1", file_unique_id: "photo-1", file_size: 3, width: 100, height: 100 }]
  });
  await runtime.handleMessage({
    message_id: 102,
    media_group_id: "album-1",
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    photo: [{ file_id: "photo-2", file_unique_id: "photo-2", file_size: 3, width: 100, height: 100 }]
  });

  await waitFor(() => runnerFactory.runs.length === 1, 20);

  assert.match(runnerFactory.runs[0].params.message, /^compare these\n\n<attachments>/);
  assert.equal("imagePaths" in runnerFactory.runs[0].params, false);
  assert.match(runnerFactory.runs[0].params.message, /photo--m101\.jpg" kind="photo"/);
  assert.match(runnerFactory.runs[0].params.message, /photo--m102\.jpg" kind="photo"/);
  runnerFactory.runs[0].finish();
});

test("runtime rejects unsupported non-text messages", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    sticker: { file_id: "sticker-1" }
  });

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    "Unsupported message type. Supported attachments: photo, document, video, audio, voice, animation."
  );
});

test("runtime ignores Telegram topic-created service messages", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage({
    message_id: 101,
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    message_thread_id: 11,
    forum_topic_created: {
      name: "list all message",
      icon_color: 7322096
    }
  });

  assert.equal(fakeBotApi.messages.length, 0);
  assert.equal(runnerFactory.runs.length, 0);
  assert.equal(runtime.sessions.size, 0);
});

test("runtime writes different private chats to different attachment cache scopes", async () => {
  const { runtime, fakeBotApi, cacheRootDir, runnerFactory } = await createRuntime();
  const firstScope = telegramScope(cacheRootDir, { chatId: 1001 });
  const secondScope = telegramScope(cacheRootDir, { chatId: 2002 });
  fakeBotApi.registerFile("photo-1001", {
    filePath: "photos/one.jpg",
    body: Buffer.from("one")
  });
  fakeBotApi.registerFile("photo-2002", {
    filePath: "photos/two.jpg",
    body: Buffer.from("two")
  });

  await runtime.handleMessage({
    message_id: 11,
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    photo: [{ file_id: "photo-1001", file_unique_id: "photo-1001", file_size: 3, width: 100, height: 100 }]
  });
  await runtime.handleMessage({
    message_id: 12,
    chat: { id: 2002, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    photo: [{ file_id: "photo-2002", file_unique_id: "photo-2002", file_size: 3, width: 100, height: 100 }]
  });

  assert.notEqual(firstScope.scopeDir, secondScope.scopeDir);
  assert.equal(await fs.readFile(path.join(firstScope.scopeDir, "photo--m11.jpg"), "utf8"), "one");
  assert.equal(await fs.readFile(path.join(secondScope.scopeDir, "photo--m12.jpg"), "utf8"), "two");
  runnerFactory.runs[0].finish();
  runnerFactory.runs[1].finish();
});

test("runtime clears only the current chat cache scope", async () => {
  const { runtime, fakeBotApi, cacheRootDir } = await createRuntime();
  const currentScope = telegramScope(cacheRootDir, { chatId: 1001 });
  const otherChatScope = telegramScope(cacheRootDir, { chatId: 2002 });
  const otherBotScope = telegramScope(cacheRootDir, { botUsername: "otherbot", chatId: 1001 });
  await fs.mkdir(currentScope.scopeDir, { recursive: true });
  await fs.mkdir(otherChatScope.scopeDir, { recursive: true });
  await fs.mkdir(otherBotScope.scopeDir, { recursive: true });
  await fs.writeFile(path.join(currentScope.scopeDir, "one.txt"), "current", "utf8");
  await fs.writeFile(path.join(otherChatScope.scopeDir, "two.txt"), "other-chat", "utf8");
  await fs.writeFile(path.join(otherBotScope.scopeDir, "three.txt"), "other-bot", "utf8");

  await runtime.handleMessage(buildTextMessage("/clear_cache"));

  await assert.rejects(() => fs.stat(currentScope.scopeDir));
  assert.equal(await fs.readFile(path.join(otherChatScope.scopeDir, "two.txt"), "utf8"), "other-chat");
  assert.equal(await fs.readFile(path.join(otherBotScope.scopeDir, "three.txt"), "utf8"), "other-bot");
  assert.equal(fakeBotApi.messages.at(-1).text, "Cleared cache for this chat.");
});

test("runtime routes /cli, /auto, /model, and /reasoning to the current chat session", async () => {
  const { runtime, fakeBotApi } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/cli pi"));
  await runtime.handleMessage(buildTextMessage("/auto low"));
  await runtime.handleMessage(buildTextMessage("/model gpt-5.4"));
  await runtime.handleMessage(buildTextMessage("/reasoning high"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.cliAdapter.id, "pi");
  assert.equal(session.auto, "low");
  assert.equal(session.model, "gpt-5.4");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(
    fakeBotApi.messages.at(-4).text,
    "CLI set to pi. Started a new session. The next message will open a fresh Pi session."
  );
  assert.equal(fakeBotApi.messages.at(-3).text, "Auto level set to low.");
  assert.equal(fakeBotApi.messages.at(-2).text, "Model set to gpt-5.4.");
  assert.equal(fakeBotApi.messages.at(-1).text, "Reasoning effort set to high.");
});

test("runtime treats unknown slash commands as normal prompts", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/unknown_command"));

  assert.equal(fakeBotApi.messages.length, 0);
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "/unknown_command");
  runnerFactory.runs[0].finish();
});

test("runtime shares one private chat session across Telegram threads but replies to each source thread", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildTextMessage("thread one", "AllowedUser", 1001, {
      message_id: 101,
      message_thread_id: 11
    })
  );
  await runtime.handleMessage(
    buildTextMessage("thread two", "AllowedUser", 1001, {
      message_id: 202,
      message_thread_id: 22
    })
  );

  assert.equal(runtime.sessions.size, 1);
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "thread one");
  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "Queued message 1.",
      parseMode: "HTML",
      directMessagesTopicId: 22,
      messageThreadId: 22
    }
  ]);

  await runnerFactory.runs[0].emit({
    type: "thread.started",
    thread_id: "session-1"
  });
  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "answer one"
    }
  });
  runnerFactory.runs[0].finish();
  await waitFor(() => runnerFactory.runs.length === 2, 20);

  assert.equal(runnerFactory.runs[1].params.sessionId, "session-1");
  assert.equal(runnerFactory.runs[1].params.message, "thread two");

  await runnerFactory.runs[1].emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "answer two"
    }
  });
  runnerFactory.runs[1].finish();
  await waitFor(() => fakeBotApi.messages.some((message) => message.text === "answer two"), 20);

  assert.deepEqual(
    fakeBotApi.messages.filter((message) => message.text?.startsWith("answer ")),
    [
      {
        chatId: 1001,
        text: "answer one",
        parseMode: "HTML",
        directMessagesTopicId: 11,
        messageThreadId: 11
      },
      {
        chatId: 1001,
        text: "answer two",
        parseMode: "HTML",
        directMessagesTopicId: 22,
        messageThreadId: 22
      }
    ]
  );
});

test("runtime routes first private topic message without quoting it", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildTextMessage("first topic message", "AllowedUser", 1001, {
      message_id: 101,
      message_thread_id: 11
    })
  );

  assert.equal(runnerFactory.runs.length, 1);
  assert.deepEqual(fakeBotApi.actions, [
    {
      chatId: 1001,
      action: "typing",
      directMessagesTopicId: 11,
      messageThreadId: 11
    }
  ]);

  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "topic answer"
    }
  });
  runnerFactory.runs[0].finish();
  await waitFor(() => fakeBotApi.messages.some((message) => message.text === "topic answer"), 20);

  assert.deepEqual(fakeBotApi.messages.at(-1), {
    chatId: 1001,
    text: "topic answer",
    parseMode: "HTML",
    directMessagesTopicId: 11,
    messageThreadId: 11
  });
});

test("runtime routes existing private topic messages with Telegram message_thread_id", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildTextMessage("existing topic message", "AllowedUser", 1001, {
      message_id: 101,
      message_thread_id: 33,
      direct_messages_topic: { topic_id: 22 }
    })
  );

  assert.equal(runnerFactory.runs.length, 1);
  assert.deepEqual(fakeBotApi.actions, [
    {
      chatId: 1001,
      action: "typing",
      messageThreadId: 33,
      directMessagesTopicId: 22
    }
  ]);

  await runnerFactory.runs[0].emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning"
    }
  });
  await waitFor(() => fakeBotApi.messages.some((message) => message.text === "🟢 reasoning"), 20);

  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "existing topic answer"
    }
  });
  runnerFactory.runs[0].finish();
  await waitFor(() => fakeBotApi.edits.some((message) => message.text === "existing topic answer"), 20);

  assert.deepEqual(fakeBotApi.messages.at(-1), {
    chatId: 1001,
    text: "🟢 reasoning",
    parseMode: "HTML",
    directMessagesTopicId: 22,
    messageThreadId: 33
  });
  assert.deepEqual(fakeBotApi.edits.at(-1), {
    chatId: 1001,
    messageId: 1,
    text: "existing topic answer",
    parseMode: "HTML"
  });
});

test("runtime keeps separate sessions for different private chats", async () => {
  const { runtime } = await createRuntime({
    botConfig: {
      agent: {
        id: "primary-agent",
        cli: "codex",
        workdir: "/tmp/project",
        auto: "medium",
        model: "deepseek-v4-flash",
        reasoningEffort: "default"
      }
    }
  });

  await runtime.handleMessage(buildTextMessage("/model gpt-5.5", "AllowedUser", 1001));
  await runtime.handleMessage(buildTextMessage("/cli pi", "AllowedUser", 1001));

  const sessionA = runtime.sessionFor(1001);
  const sessionB = runtime.sessionFor(2002);

  assert.equal(sessionA.cliAdapter.id, "pi");
  assert.equal(sessionB.cliAdapter.id, "codex");
  assert.equal(sessionA.model, "gpt-5.5");
  assert.equal(sessionB.model, "deepseek-v4-flash");
  assert.equal(sessionA.workdir, "/tmp/project");
  assert.equal(sessionB.workdir, "/tmp/project");
});

test("runtime uses the current chat CLI for future runs", async () => {
  const { runtime, runnerFactory } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/cli pi"));
  await runtime.handleMessage(buildTextMessage("hello"));

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.cli, "pi");
  runnerFactory.runs[0].finish();
});

test("runtime creates Claude-backed chat sessions from agent profile", async () => {
  const { runtime, runnerFactory } = await createRuntime({
    botConfig: {
      agent: {
        id: "claude-agent",
        cli: "claude",
        workdir: "/tmp/project",
        auto: "medium",
        model: "default",
        reasoningEffort: "default"
      }
    }
  });

  await runtime.handleMessage(buildTextMessage("hello"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.cliAdapter.id, "claude");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "hello");
  runnerFactory.runs[0].finish();
});

test("runtime creates Pi-backed chat sessions from agent profile", async () => {
  const { runtime, runnerFactory } = await createRuntime({
    botConfig: {
      agent: {
        id: "pi-agent",
        cli: "pi",
        workdir: "/tmp/project",
        auto: "medium",
        model: "default",
        reasoningEffort: "default"
      }
    }
  });

  await runtime.handleMessage(buildTextMessage("hello"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.cliAdapter.id, "pi");
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "hello");
  runnerFactory.runs[0].finish();
});

test("runtime routes /reset to the current chat session only", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-"));
  const { runtime, fakeBotApi, configStore } = await createRuntime({
    botConfig: {
      agent: {
        id: "primary-agent",
        cli: "codex",
        workdir: "/tmp/project-old",
        auto: "low",
        model: "gpt-5.4",
        reasoningEffort: "low"
      }
    }
  });

  await runtime.handleMessage(buildTextMessage("/auto high"));
  await runtime.handleMessage(buildTextMessage("/reasoning xhigh"));
  configStore.loadedBotConfig = {
    username: "relaybot",
    allowedUsernames: ["alloweduser"],
    agent: {
      id: "primary-agent",
      cli: "claude",
      workdir: nextWorkdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "high"
    }
  };
  await runtime.handleMessage(buildTextMessage("/reset"));

  const session = runtime.sessionFor(1001);
  assert.equal(session.sessionId, null);
  assert.equal(session.contextLength, null);
  assert.equal(session.cliAdapter.id, "claude");
  assert.equal(session.workdir, nextWorkdir);
  assert.equal(session.auto, "medium");
  assert.equal(session.model, "default");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(
    fakeBotApi.messages.at(-1).text,
    `Reset current chat to config defaults. Started a new session with CLI claude, workdir ${nextWorkdir}, auto medium, model default, reasoning effort high.`
  );
});
