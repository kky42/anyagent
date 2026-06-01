import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/common/output-instructions.js";
import { waitFor } from "./support/async.js";
import { createRuntime } from "./support/builders.js";

function privateMessage(text, overrides = {}) {
  return {
    message_id: overrides.message_id ?? 1,
    date: overrides.date ?? 1700000001,
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text,
    ...overrides
  };
}

function groupMessage(text, overrides = {}) {
  return privateMessage(text, {
    message_id: overrides.message_id ?? 101,
    date: overrides.date ?? 1700000101,
    chat: { id: -1001, type: "supergroup", title: "Test Group" },
    from: { id: 42, username: "AllowedUser" },
    ...overrides
  });
}

async function finishRunWithAgentMessage(runtime, run, text) {
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text
    }
  });
  run.finish();
  await waitFor(() => {
    for (const session of runtime.sessions.values()) {
      if (session.isRunning) {
        return false;
      }
    }
    return true;
  });
}

async function finishRunAndKeepDraining(run, text) {
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text
    }
  });
  run.finish();
}

async function waitForRunCount(runnerFactory, count) {
  await waitFor(() => runnerFactory.runs.length === count, 20);
}

async function createContractRuntime() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-tg-contract-"));
  const workdir = path.join(tempDir, "workdir");
  await fs.mkdir(workdir, { recursive: true });
  return {
    ...(await createRuntime({
      botConfig: {
        agent: {
          workdir
        }
      }
    })),
    workdir
  };
}

test("Telegram private E2E injects the private output contract and delivers ATTACH images and files", async () => {
  const { runtime, fakeBotApi, runnerFactory, workdir } = await createContractRuntime();

  await runtime.handleMessage(privateMessage("please confirm before preparing artifacts"));
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "please confirm before preparing artifacts");
  assert.equal(
    runnerFactory.runs[0].params.developerInstructions,
    PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
  );
  await finishRunWithAgentMessage(runtime, runnerFactory.runs[0], "Short note.");

  const artifactDir = path.join(workdir, "artifacts");
  const reportPath = path.join(artifactDir, "report.txt");
  const screenshotPath = path.join(artifactDir, "screenshot.png");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(reportPath, "telegram report", "utf8");
  await fs.writeFile(screenshotPath, "fake png", "utf8");

  await runtime.handleMessage(privateMessage("send me the screenshot and report", { message_id: 2 }));
  assert.equal(runnerFactory.runs.length, 2);
  assert.equal(runnerFactory.runs[1].params.message, "send me the screenshot and report");
  assert.equal(
    runnerFactory.runs[1].params.developerInstructions,
    PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
  );
  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[1],
    "Artifacts attached.\nATTACH ./artifacts/screenshot.png\nATTACH ./artifacts/report.txt"
  );

  assert.equal(fakeBotApi.messages.length, 2);
  assert.equal(fakeBotApi.messages[0].chatId, 1001);
  assert.equal(fakeBotApi.messages[1].chatId, 1001);
  assert.doesNotMatch(fakeBotApi.messages[1].text, /ATTACH/);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "photo",
      filePath: screenshotPath,
      fileName: "screenshot.png"
    },
    {
      chatId: 1001,
      kind: "document",
      filePath: reportPath,
      fileName: "report.txt"
    }
  ]);
});

test("Telegram group E2E suppresses unrelated output with NO_REPLY", async () => {
  const { runtime, fakeBotApi, runnerFactory } = await createContractRuntime();

  await runtime.handleMessage(groupMessage("general team chatter", { message_id: 1 }));

  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /^Messages since your last turn:/);
  assert.match(runnerFactory.runs[0].params.message, /alloweduser \(@alloweduser\):\ngeneral team chatter/);
  assert.match(
    runnerFactory.runs[0].params.developerInstructions,
    /You are AnyAgent \(@relaybot\) in a group chat\./
  );
  assert.match(
    runnerFactory.runs[0].params.developerInstructions,
    /NO_REPLY/
  );

  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[0],
    "NO_REPLY"
  );

  assert.deepEqual(fakeBotApi.messages, []);
  assert.deepEqual(fakeBotApi.attachments, []);
});

test("Telegram group E2E sends related REPLY blocks and ATTACH files", async () => {
  const { runtime, fakeBotApi, runnerFactory, workdir } = await createContractRuntime();
  const artifactDir = path.join(workdir, "artifacts");
  const planPath = path.join(artifactDir, "plan.txt");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(planPath, "telegram group plan", "utf8");

  await runtime.handleMessage(groupMessage("@relaybot please answer and attach the plan", { message_id: 1 }));

  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /@relaybot please answer and attach the plan/);
  assert.match(
    runnerFactory.runs[0].params.developerInstructions,
    /REPLY/
  );
  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[0],
    [
      "private scratch text",
      "REPLY",
      "Here is the Telegram group plan.",
      "ATTACH ./artifacts/plan.txt"
    ].join("\n")
  );

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: -1001,
      text: "Here is the Telegram group plan.",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: -1001,
      kind: "document",
      filePath: planPath,
      fileName: "plan.txt"
    }
  ]);
});

test("Telegram group E2E batches busy group messages and replies only through REPLY blocks", async () => {
  const { runtime, fakeBotApi, runnerFactory, workdir } = await createContractRuntime();
  const artifactDir = path.join(workdir, "artifacts");
  const photoPath = path.join(artifactDir, "rollout.png");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(photoPath, "fake png", "utf8");

  await runtime.handleMessage(groupMessage("release thread is starting", {
    message_id: 1,
    from: { id: 42, username: "alice" }
  }));
  await runtime.handleMessage(groupMessage("@relaybot check the migration risk", {
    message_id: 2,
    from: { id: 43, username: "alice" }
  }));
  await runtime.handleMessage(groupMessage("I will update the changelog separately", {
    message_id: 3,
    from: { id: 44, username: "bob" }
  }));
  await runtime.handleMessage(groupMessage("@relaybot also attach the rollout image", {
    message_id: 4,
    from: { id: 45, username: "carol" }
  }));

  assert.equal(runnerFactory.runs.length, 1);
  await finishRunAndKeepDraining(
    runnerFactory.runs[0],
    "NO_REPLY"
  );
  await waitForRunCount(runnerFactory, 2);

  const queuedGroupPrompt = runnerFactory.runs[1].params.message;
  assert.match(queuedGroupPrompt, /^Messages since your last turn:/);
  assert.match(queuedGroupPrompt, /alice \(@alice\):\n@relaybot check the migration risk/);
  assert.match(queuedGroupPrompt, /bob \(@bob\):\nI will update the changelog separately/);
  assert.match(queuedGroupPrompt, /carol \(@carol\):\n@relaybot also attach the rollout image/);
  assert(
    queuedGroupPrompt.indexOf("@relaybot check the migration risk") <
      queuedGroupPrompt.indexOf("I will update the changelog separately")
  );
  assert(
    queuedGroupPrompt.indexOf("I will update the changelog separately") <
      queuedGroupPrompt.indexOf("@relaybot also attach the rollout image")
  );

  await finishRunWithAgentMessage(
    runtime,
    runnerFactory.runs[1],
    [
      "private scratch text that must stay hidden",
      "REPLY @alice",
      "Migration risk is captured.",
      "REPLY @carol",
      "Rollout image attached.",
      "ATTACH ./artifacts/rollout.png",
      "scratch after the attachment must also stay hidden"
    ].join("\n")
  );

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: -1001,
      text: "@alice Migration risk is captured.",
      parseMode: "HTML"
    },
    {
      chatId: -1001,
      text: "@carol Rollout image attached.",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: -1001,
      kind: "photo",
      filePath: photoPath,
      fileName: "rollout.png"
    }
  ]);
});
