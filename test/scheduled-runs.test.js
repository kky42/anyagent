import test from "node:test";
import assert from "node:assert/strict";

import { waitFor } from "./support/async.js";
import { createRuntime } from "./support/builders.js";

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

  const backgroundRunPromise = runtime.runBackgroundSchedule(
    session,
    schedule,
    new Date("2026-06-03T01:02:03Z")
  );
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
    "Background scheduled run: news\nTriggered: 2026-06-03 09:02:03\n\nHere are the headlines."
  );
});
