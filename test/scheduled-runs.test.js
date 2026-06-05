import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { waitFor } from "./support/async.js";
import { createRuntime } from "./support/builders.js";
import { formatLocalTimestamp } from "../src/utils.js";

function buildTextMessage(text, username = "AllowedUser", chatId = 1001, overrides = {}) {
  return {
    chat: { id: chatId, type: "private" },
    from: { id: 42, username },
    text,
    ...overrides
  };
}

test("allowed non-manager users can manage private schedules", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime({
    botConfig: {
      allowedUsernames: ["alloweduser", "owner"],
      managerUsernames: ["owner"]
    }
  });

  await runtime.handleMessage(buildTextMessage("/schedule list"));
  await runtime.handleMessage(
    buildTextMessage("/schedule add heartbeat pulse\n*/5 * * * *\ncheck the queue")
  );
  await runtime.handleMessage(buildTextMessage("/schedule list"));

  const session = runtime.sessionFor(1001);
  assert.equal(runnerFactory.runs.length, 0);
  assert.deepEqual(session.schedules, [
    {
      name: "pulse",
      mode: "heartbeat",
      cron: "*/5 * * * *",
      prompt: "check the queue",
      enabled: true
    }
  ]);
  assert.equal(fakeBotApi.messages[0].text, "No schedules.");
  assert.equal(fakeBotApi.messages[1].text, 'Added schedule "pulse".\nmode: heartbeat\ncron: */5 * * * *');
  assert.match(fakeBotApi.messages[2].text, /enabled  heartbeat  pulse/);
});

test("background scheduled runs use a fresh agent turn and emit a marked notification", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();
  const session = runtime.sessionFor(1001, {
    deliveryAnchor: {
      chatId: 1001,
      replyTarget: null
    }
  });
  const schedule = {
    name: "news",
    mode: "background",
    cron: "0 * * * *",
    prompt: "latest stock news",
    enabled: true
  };

  const triggeredAt = new Date("2026-06-03T01:02:03Z");
  const backgroundRunPromise = runtime.runBackgroundSchedule(session, schedule, triggeredAt);
  await waitFor(() => runnerFactory.runs.length === 1, 20);

  assert.equal(runnerFactory.runs[0].params.sessionId, null);
  assert.equal(runnerFactory.runs[0].params.developerInstructions, null);
  assert.equal(runnerFactory.runs[0].params.message, "latest stock news");

  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "Here are the headlines."
    }
  });
  runnerFactory.runs[0].finish();
  await backgroundRunPromise;

  assert.equal(
    fakeBotApi.messages.at(-1).text,
    `Background scheduled run: news\nTriggered: ${formatLocalTimestamp(
      Math.floor(triggeredAt.getTime() / 1000)
    )}\n\nHere are the headlines.`
  );
});

test("background scheduled runs load profile instructions for their fresh agent turn", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-schedule-profile-"));
  const profileInstructionsPath = path.join(tempDir, "AGENTS.md");
  await fs.writeFile(profileInstructionsPath, "background profile instructions", "utf8");
  const { runtime, runnerFactory } = await createRuntime({
    agent: {
      profileInstructionsPath
    }
  });
  const session = runtime.sessionFor(1001, {
    deliveryAnchor: {
      chatId: 1001,
      replyTarget: null
    }
  });

  const backgroundRunPromise = runtime.runBackgroundSchedule(session, {
    name: "news",
    mode: "background",
    cron: "0 * * * *",
    prompt: "latest stock news",
    enabled: true
  });
  await waitFor(() => runnerFactory.runs.length === 1, 20);

  assert.equal(runnerFactory.runs[0].params.sessionId, null);
  assert.equal(runnerFactory.runs[0].params.developerInstructions, "background profile instructions");

  runnerFactory.runs[0].finish();
  await backgroundRunPromise;
});

test("same-minute schedules keep sibling timers armed after one schedule fires", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();
  const session = runtime.sessionFor(1001, {
    deliveryAnchor: {
      chatId: 1001,
      replyTarget: null
    }
  });
  await session.replaceSchedules([
    {
      name: "smill",
      mode: "heartbeat",
      cron: "*/5 * * * *",
      prompt: "讲一个中文短笑话",
      enabled: true
    },
    {
      name: "joke",
      mode: "background",
      cron: "*/5 * * * *",
      prompt: "讲一个 3 句话的科幻故事",
      enabled: true
    }
  ]);
  runtime.syncConversationSchedules(session);

  const heartbeatKey = runtime.scheduleKey(session.conversationId, "smill");
  const backgroundKey = runtime.scheduleKey(session.conversationId, "joke");
  const originalHeartbeatTimer = runtime.scheduleTimers.get(heartbeatKey);
  const originalBackgroundTimer = runtime.scheduleTimers.get(backgroundKey);
  assert.ok(originalHeartbeatTimer);
  assert.ok(originalBackgroundTimer);

  await runtime.handleScheduledOccurrence(session.conversationId, "smill");
  assert.equal(runtime.scheduleTimers.get(backgroundKey), originalBackgroundTimer);
  assert.notEqual(runtime.scheduleTimers.get(heartbeatKey), originalHeartbeatTimer);

  const backgroundRunPromise = runtime.handleScheduledOccurrence(session.conversationId, "joke");
  await waitFor(() => runnerFactory.runs.length === 2, 20);
  assert.equal(runnerFactory.runs[1].params.sessionId, null);
  assert.equal(runnerFactory.runs[1].params.message, "讲一个 3 句话的科幻故事");

  await runnerFactory.runs[1].emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "星舰在木星背面醒来。"
    }
  });
  runnerFactory.runs[1].finish();
  await backgroundRunPromise;
  runnerFactory.runs[0].finish();

  assert.match(fakeBotApi.messages.at(-1).text, /^Background scheduled run: joke\nTriggered: /);
  assert.match(fakeBotApi.messages.at(-1).text, /星舰在木星背面醒来。/);
});
