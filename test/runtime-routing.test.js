import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCacheScope } from "../src/chat_adapter/common/cache-scope.js";
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

function buildGroupTextMessage(text, overrides = {}) {
  const messageId = overrides.message_id ?? 101;
  const chat = overrides.chat ?? { id: -1001, type: "supergroup", title: "Test Group" };
  return buildTextMessage(text, "AllowedUser", -1001, {
    message_id: messageId,
    date: 1700000000 + messageId,
    chat,
    entities: text.includes("@relaybot")
      ? [
          {
            type: "mention",
            offset: text.indexOf("@relaybot"),
            length: "@relaybot".length
          }
        ]
      : [],
    ...overrides
  });
}

function telegramScope(
  cacheRootDir,
  {
    agentId = "primary-agent",
    botUsername = "relaybot",
    chatId = 1001,
    conversationId = chatId
  } = {}
) {
  return buildCacheScope({
    cacheRootDir,
    agentId,
    platform: "telegram",
    bindingId: botUsername,
    conversationId
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

  assert.match(runnerFactory.runs[0].params.message, /^compare these\n\nAttached file:/);
  assert.equal("imagePaths" in runnerFactory.runs[0].params, false);
  assert.match(runnerFactory.runs[0].params.message, /photo--m101\.jpg/);
  assert.match(runnerFactory.runs[0].params.message, /photo--m102\.jpg/);
  assert.match(runnerFactory.runs[0].params.message, /- kind: photo/);
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

test("runtime clears only the active private topic cache scope", async () => {
  const { runtime, fakeBotApi, cacheRootDir } = await createRuntime();
  const baseScope = telegramScope(cacheRootDir, { chatId: 12345 });
  const topicScope = telegramScope(cacheRootDir, {
    chatId: 12345,
    conversationId: "12345:topic:777"
  });
  const otherTopicScope = telegramScope(cacheRootDir, {
    chatId: 12345,
    conversationId: "12345:topic:888"
  });
  await fs.mkdir(baseScope.scopeDir, { recursive: true });
  await fs.mkdir(topicScope.scopeDir, { recursive: true });
  await fs.mkdir(otherTopicScope.scopeDir, { recursive: true });
  await fs.writeFile(path.join(baseScope.scopeDir, "base.txt"), "base", "utf8");
  await fs.writeFile(path.join(topicScope.scopeDir, "topic.txt"), "topic", "utf8");
  await fs.writeFile(path.join(otherTopicScope.scopeDir, "other-topic.txt"), "other-topic", "utf8");

  await runtime.handleMessage(
    buildTextMessage("/clear_cache@relaybot", "AllowedUser", 12345, {
      message_id: 1,
      date: 1700000001,
      chat: { id: 12345, type: "private", title: "Example Topic" },
      message_thread_id: 777,
      entities: [{ type: "bot_command", offset: 0, length: "/clear_cache@relaybot".length }]
    })
  );

  assert.equal(await fs.readFile(path.join(baseScope.scopeDir, "base.txt"), "utf8"), "base");
  await assert.rejects(() => fs.stat(topicScope.scopeDir));
  assert.equal(await fs.readFile(path.join(otherTopicScope.scopeDir, "other-topic.txt"), "utf8"), "other-topic");
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

test("runtime rejects unknown private slash commands without starting an agent run", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/unknown_command"));

  assert.equal(runnerFactory.runs.length, 0);
  assert.equal(fakeBotApi.messages.at(-1).text, "Unknown command.");
});

test("runtime lets allowed non-manager users send private prompts and basic private commands", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    botConfig: {
      allowedUsernames: ["alloweduser", "owner"],
      managerUsernames: ["owner"]
    }
  });

  await runtime.handleMessage(buildTextMessage("please inspect this stack trace"));
  await runtime.handleMessage(buildTextMessage("/status"));

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "please inspect this stack trace");
  assert.match(fakeBotApi.messages.at(-1).text, /^running: yes|^running: no/);
  runnerFactory.runs[0].finish();
});

test("runtime rejects private commands targeting another Telegram bot", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(buildTextMessage("/status @otherbot"));

  assert.equal(runnerFactory.runs.length, 0);
  assert.equal(fakeBotApi.messages.at(-1).text, "That command targets another bot.");
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

test("runtime appends Telegram private reply context after the new message", async () => {
  const { runtime, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildTextMessage("follow up", "AllowedUser", 1001, {
      message_id: 2,
      reply_to_message: {
        message_id: 1,
        chat: { id: 1001, type: "private" },
        from: { id: 42, username: "AllowedUser" },
        text: "previous question"
      }
    })
  );

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(
    runnerFactory.runs[0].params.message,
    "follow up\n\nReference context:\nprevious question"
  );
  runnerFactory.runs[0].finish();
});

test("runtime sends every group message and silently coalesces pending group turns", async () => {
  const { runtime, runnerFactory } = await createRuntime();

  await runtime.handleMessage(buildGroupTextMessage("background one", { message_id: 1 }));
  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /^Messages since your last turn:/);
  assert.match(runnerFactory.runs[0].params.message, /\[2023-\d\d-\d\d \d\d:\d\d:\d\d\] alloweduser \(@alloweduser\):\nbackground one/);
  assert.doesNotMatch(runnerFactory.runs[0].params.message, /Context:|Message to you:/);

  await runtime.handleMessage(buildGroupTextMessage("background two", { message_id: 2 }));
  await runtime.handleMessage(buildGroupTextMessage("@relaybot summarize", { message_id: 3 }));

  const session = runtime.sessionFor(-1001);
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(session.queue.length, 1);
  assert.match(session.queue[0].promptText, /background two/);
  assert.match(session.queue[0].promptText, /@relaybot summarize/);

  runnerFactory.runs[0].finish();
  await waitFor(() => runnerFactory.runs.length === 2, 20);

  assert.equal(runnerFactory.runs.length, 2);
  assert.match(runnerFactory.runs[1].params.message, /background two/);
  assert.match(runnerFactory.runs[1].params.message, /@relaybot summarize/);
  runnerFactory.runs[1].finish();
  await waitFor(() => session.isRunning === false, 20);
});

test("runtime lets any group participant trigger the agent", async () => {
  const { runtime, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildGroupTextMessage("uploads fail after deploy", {
      message_id: 1,
      from: { id: 99, username: "OtherUser" }
    })
  );

  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /otheruser \(@otheruser\):\nuploads fail after deploy/);
  runnerFactory.runs[0].finish();
});

test("runtime includes Telegram group sender display name and username", async () => {
  const { runtime, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildGroupTextMessage("please check this", {
      message_id: 1,
      from: { id: 99, username: "y_xm", first_name: "Rick" }
    })
  );

  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /Rick \(@y_xm\):\nplease check this/);
  runnerFactory.runs[0].finish();
});

test("runtime renders group attachments as plain path and kind near their message", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();
  fakeBotApi.registerFile("history-doc", {
    filePath: "documents/history.pdf",
    body: Buffer.from("history")
  });
  fakeBotApi.registerFile("trigger-doc", {
    filePath: "documents/trigger.pdf",
    body: Buffer.from("trigger")
  });
  await runtime.handleMessage({
    message_id: 1,
    date: 1700000001,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 42, username: "AllowedUser" },
    caption: "history attachment",
    document: {
      file_id: "history-doc",
      file_unique_id: "history-doc",
      file_name: "history.pdf",
      mime_type: "application/pdf",
      file_size: 7
    }
  });
  assert.deepEqual(fakeBotApi.getFileCalls, ["history-doc"]);
  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /history attachment/);
  assert.match(runnerFactory.runs[0].params.message, /Attached file:\n- path: .*history--m1\.pdf\n- kind: document/);
  runnerFactory.runs[0].finish();
  await waitFor(() => runtime.sessionFor(-1001).isRunning === false, 20);

  await runtime.handleMessage({
    message_id: 2,
    date: 1700000002,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 43, username: "AllowedUser" },
    caption: "inspect",
    document: {
      file_id: "trigger-doc",
      file_unique_id: "trigger-doc",
      file_name: "trigger.pdf",
      mime_type: "application/pdf",
      file_size: 7
    }
  });

  assert.deepEqual(fakeBotApi.getFileCalls, ["history-doc", "trigger-doc"]);
  assert.equal(runnerFactory.runs.length, 2);
  assert.match(runnerFactory.runs[1].params.message, /inspect/);
  assert.match(runnerFactory.runs[1].params.message, /Attached file:\n- path: .*trigger--m2\.pdf\n- kind: document/);
  assert.equal("imagePaths" in runnerFactory.runs[1].params, false);
  runnerFactory.runs[1].finish();
});

test("runtime sends addressed group albums as one turn with all media siblings", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    albumQuietPeriodMs: 5
  });
  fakeBotApi.registerFile("album-photo-1", {
    filePath: "photos/one.jpg",
    body: Buffer.from("one")
  });
  fakeBotApi.registerFile("album-photo-2", {
    filePath: "photos/two.jpg",
    body: Buffer.from("two")
  });
  fakeBotApi.registerFile("album-photo-3", {
    filePath: "photos/three.jpg",
    body: Buffer.from("three")
  });

  await runtime.handleMessage({
    message_id: 10,
    date: 1700000010,
    media_group_id: "group-album-1",
    chat: { id: -1001, type: "supergroup" },
    from: { id: 42, username: "AllowedUser" },
    caption: "@relaybot compare these",
    caption_entities: [{ type: "mention", offset: 0, length: "@relaybot".length }],
    photo: [{ file_id: "album-photo-1", file_unique_id: "album-photo-1", file_size: 3, width: 100, height: 100 }]
  });
  await runtime.handleMessage({
    message_id: 11,
    date: 1700000011,
    media_group_id: "group-album-1",
    chat: { id: -1001, type: "supergroup" },
    from: { id: 42, username: "AllowedUser" },
    photo: [{ file_id: "album-photo-2", file_unique_id: "album-photo-2", file_size: 3, width: 100, height: 100 }]
  });
  await runtime.handleMessage({
    message_id: 12,
    date: 1700000012,
    media_group_id: "group-album-1",
    chat: { id: -1001, type: "supergroup" },
    from: { id: 42, username: "AllowedUser" },
    photo: [{ file_id: "album-photo-3", file_unique_id: "album-photo-3", file_size: 5, width: 100, height: 100 }]
  });

  await waitFor(() => runnerFactory.runs.length === 1, 20);

  assert.deepEqual(fakeBotApi.getFileCalls, ["album-photo-1", "album-photo-2", "album-photo-3"]);
  assert.match(runnerFactory.runs[0].params.message, /@relaybot compare these/);
  assert.match(runnerFactory.runs[0].params.message, /photo--m10\.jpg/);
  assert.match(runnerFactory.runs[0].params.message, /photo--m11\.jpg/);
  assert.match(runnerFactory.runs[0].params.message, /photo--m12\.jpg/);
  assert.equal("imagePaths" in runnerFactory.runs[0].params, false);
  runnerFactory.runs[0].finish();
  await waitFor(() => runtime.sessionFor(-1001).isRunning === false, 20);

  await runtime.handleMessage(buildGroupTextMessage("next", { message_id: 13 }));

  assert.equal(runnerFactory.runs.length, 2);
  assert.doesNotMatch(runnerFactory.runs[1].params.message, /photo--m10\.jpg/);
  assert.match(runnerFactory.runs[1].params.message, /next/);
  runnerFactory.runs[1].finish();
});

test("runtime keeps separate sessions for different group chats", async () => {
  const { runtime, runnerFactory } = await createRuntime();

  await runtime.handleMessage(buildGroupTextMessage("@relaybot first group", { message_id: 1 }));
  await runtime.handleMessage(
    buildGroupTextMessage("@relaybot second group", {
      message_id: 1,
      chat: { id: -2002, type: "supergroup" }
    })
  );

  assert.equal(runtime.sessions.size, 2);
  assert.equal(runnerFactory.runs.length, 2);
  assert.equal(runnerFactory.runs[0].params.sessionId, null);
  assert.equal(runnerFactory.runs[1].params.sessionId, null);
  await runnerFactory.runs[0].emit({
    type: "thread.started",
    thread_id: "group-one-session"
  });
  runnerFactory.runs[0].finish();
  runnerFactory.runs[1].finish();
});

test("runtime routes addressed group commands without starting an agent run", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildGroupTextMessage("/status @relaybot", {
      entities: [{ type: "bot_command", offset: 0, length: "/status".length }]
    })
  );

  assert.equal(runnerFactory.runs.length, 0);
  assert.match(fakeBotApi.messages.at(-1).text, /running: no/);
});

test("runtime rejects group commands without a Telegram bot target", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildGroupTextMessage("/status", {
      entities: [{ type: "bot_command", offset: 0, length: "/status".length }]
    })
  );

  assert.equal(runnerFactory.runs.length, 0);
  assert.match(fakeBotApi.messages.at(-1).text, /Group commands must mention this bot/);
});

test("runtime ignores Telegram group commands addressed to another bot", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildGroupTextMessage("/status@otherbot", {
      entities: [{ type: "bot_command", offset: 0, length: "/status@otherbot".length }]
    })
  );

  assert.equal(runnerFactory.runs.length, 0);
  assert.equal(fakeBotApi.messages.length, 0);
  assert.equal(runtime.sessions.size, 0);
});

test("runtime ignores empty unsupported Telegram group updates", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage({
    message_id: 1,
    date: 1700000001,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 99, username: "OtherUser" },
    sticker: { file_id: "sticker-1" }
  });

  await runtime.handleMessage({
    message_id: 2,
    date: 1700000002,
    chat: { id: -1001, type: "supergroup" },
    from: { id: 99, username: "OtherUser" },
    contact: { phone_number: "5550100", first_name: "Mallory" }
  });

  assert.equal(runnerFactory.runs.length, 0);
  assert.equal(fakeBotApi.messages.length, 0);
  assert.equal(runtime.sessions.size, 0);
});

test("runtime rejects relay commands from unauthorized Telegram group users", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildGroupTextMessage("/auto high @relaybot", {
      from: { id: 99, username: "OtherUser" },
      entities: [{ type: "bot_command", offset: 0, length: "/auto".length }]
    })
  );

  assert.equal(runnerFactory.runs.length, 0);
  assert.equal(fakeBotApi.messages.at(-1).text, "Only manager users can run AnyAgent commands.");
});

test("runtime treats private topic messages as group-like conversations", async () => {
  const { runtime, runnerFactory, fakeBotApi } = await createRuntime();

  await runtime.handleMessage(
    buildTextMessage("hi", "AllowedUser", 12345, {
      message_id: 1,
      date: 1700000001,
      from: { id: 42, username: "AllowedUser" },
      chat: { id: 12345, type: "private", title: "Example Topic" },
      message_thread_id: 777
    })
  );
  await runtime.handleMessage(
    buildTextMessage("/status @relaybot", "AllowedUser", 12345, {
      message_id: 2,
      date: 1700000002,
      from: { id: 42, username: "AllowedUser" },
      chat: { id: 12345, type: "private", title: "Example Topic" },
      message_thread_id: 777,
      entities: [{ type: "bot_command", offset: 0, length: "/status".length }]
    })
  );
  await runtime.handleMessage(
    buildTextMessage("@relaybot can you see history messages?", "AllowedUser", 12345, {
      message_id: 3,
      date: 1700000003,
      from: { id: 42, username: "AllowedUser" },
      chat: { id: 12345, type: "private", title: "Example Topic" },
      message_thread_id: 777,
      entities: [{ type: "mention", offset: 0, length: "@relaybot".length }]
    })
  );

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(fakeBotApi.messages.length, 1);
  assert.match(fakeBotApi.messages[0].text, /running: yes/);
  assert.match(runnerFactory.runs[0].params.message, /^Messages since your last turn:/);
  assert.match(runnerFactory.runs[0].params.message, /alloweduser \(@alloweduser\):\nhi/);
  const session = runtime.sessionFor(12345, { conversationId: "12345:topic:777" });
  assert.equal(session.queue.length, 1);
  assert.match(session.queue[0].promptText, /@relaybot can you see history messages\?/);
  assert.equal(runtime.sessions.has("12345:topic:777"), true);
  runnerFactory.runs[0].finish();
  await waitFor(() => runnerFactory.runs.length === 2, 20);
  runnerFactory.runs[1].finish();
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
    managerUsernames: ["alloweduser"],
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
