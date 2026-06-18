import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createSession } from "./support/builders.js";
import { flush } from "./support/async.js";
import { FakeBotApi } from "./support/fakes.js";

test("sendText falls back to MarkdownV2 when Telegram HTML parsing fails", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlOnce: true });
  const { session } = await createSession({ fakeBotApi });

  await session.sendText("a_b");

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "a\\_b",
      parseMode: "MarkdownV2"
    }
  ]);
});

test("sendText falls back to plain text when Telegram HTML and Markdown parsing fail", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlOnce: true, failMarkdownOnce: true });
  const { session } = await createSession({ fakeBotApi });

  await session.sendText("a_b");

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "a_b"
    }
  ]);
});

test("sendText uses Telegram rich Markdown when available", async () => {
  const fakeBotApi = new FakeBotApi({ supportsRichMessages: true });
  const { session } = await createSession({ fakeBotApi });

  await session.sendText("| A | B |\n| --- | --- |\n| 1 | 2 |");

  assert.equal(fakeBotApi.richMessages.length, 1);
  assert.deepEqual(fakeBotApi.richMessages[0], {
    chatId: 1001,
    richMessage: {
      markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |"
    },
    text: "| A | B |\n| --- | --- |\n| 1 | 2 |"
  });
});

test("rich final agent_message deletes the transient progress message instead of editing it", async () => {
  const fakeBotApi = new FakeBotApi({ supportsRichMessages: true });
  const { session, runnerFactory } = await createSession({ fakeBotApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "# Done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.equal(fakeBotApi.richMessages.at(-1).richMessage.markdown, "# Done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.deepEqual(fakeBotApi.deletions, [{ chatId: 1001, messageId: 1 }]);
  assert.deepEqual(fakeBotApi.edits, []);
});

test("private progress uses Telegram rich message drafts when available", async () => {
  const fakeBotApi = new FakeBotApi({ supportsRichDrafts: true });
  const { session, runnerFactory } = await createSession({ fakeBotApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });

  assert.equal(fakeBotApi.richDrafts.length, 1);
  assert.equal(fakeBotApi.richDrafts[0].chatId, 1001);
  assert.match(fakeBotApi.richDrafts[0].richMessage.html, /<tg-thinking>🟢 reasoning<\/tg-thinking>/);
  assert.deepEqual(fakeBotApi.messages, []);

  run.finish();
  await flush();
});

test("private rich draft progress refreshes while the run is still active", async () => {
  const fakeBotApi = new FakeBotApi({ supportsRichDrafts: true });
  const { session } = await createSession({ fakeBotApi });

  await session.renderProgressText("reasoning");
  await session.messageRenderer.refreshProgressDraft();

  assert.equal(fakeBotApi.richDrafts.length, 2);
  assert.equal(fakeBotApi.richDrafts[0].draftId, fakeBotApi.richDrafts[1].draftId);
  assert.deepEqual(fakeBotApi.messages, []);
});

test("private rich draft progress falls back to a message if refresh fails", async () => {
  const fakeBotApi = new FakeBotApi({ supportsRichDrafts: true });
  const { session } = await createSession({ fakeBotApi });

  await session.renderProgressText("reasoning");
  fakeBotApi.failRichDraftOnce = true;
  await session.messageRenderer.refreshProgressDraft();

  assert.equal(fakeBotApi.richDrafts.length, 1);
  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    }
  ]);
});

test("rich draft progress is not materialized after a final agent_message", async () => {
  const fakeBotApi = new FakeBotApi({ supportsRichDrafts: true });
  const { session, runnerFactory } = await createSession({ fakeBotApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "done"
    }
  });
  await run.emit({
    type: "turn.completed"
  });
  run.finish();

  await flush();
  await flush();

  assert.equal(fakeBotApi.richDrafts.length, 1);
  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "done",
      parseMode: "HTML"
    }
  ]);
});

test("rich draft progress after a final agent_message is not materialized on completion", async () => {
  const fakeBotApi = new FakeBotApi({ supportsRichDrafts: true });
  const { session, runnerFactory } = await createSession({ fakeBotApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "working"
    }
  });
  await run.emit({
    type: "item.started",
    item: {
      id: "item_3",
      type: "todo_list",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "turn.completed"
  });
  run.finish();

  await flush();
  await flush();

  assert.equal(fakeBotApi.richDrafts.length, 2);
  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "working",
      parseMode: "HTML"
    }
  ]);
});

test("progress items reuse one Telegram message and final agent_message replaces it", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.started",
    item: {
      id: "item_2",
      type: "command_execution",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "command_execution",
      status: "completed"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_3",
      type: "agent_message",
      text: "done"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "🟢 command_execution",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      messageId: 1,
      text: "done",
      parseMode: "HTML"
    }
  ]);
});

test("subsequent agent messages in the same turn are sent as new Telegram messages", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "working"
    }
  });
  await run.emit({
    type: "item.started",
    item: {
      id: "item_3",
      type: "command_execution",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_4",
      type: "agent_message",
      text: "done"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "🟢 command_execution",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "working",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      messageId: 2,
      text: "done",
      parseMode: "HTML"
    }
  ]);
});

test("transient progress after an agent message is cleared when the turn completes", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "working"
    }
  });
  await run.emit({
    type: "item.started",
    item: {
      id: "item_3",
      type: "todo_list",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "turn.completed"
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "🟢 todo_list",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "working",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.deletions, [
    {
      chatId: 1001,
      messageId: 2
    }
  ]);
});

test("long final agent_message edits the progress message and sends remaining chunks", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();
  const longMessage = `${"A".repeat(3500)}${"B".repeat(250)}`;

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: longMessage
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "B".repeat(250),
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "A".repeat(3500),
      parseMode: "HTML"
    }
  ]);
});

test("turn errors replace the in-flight progress message", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "turn.failed",
    error: {
      message: "boom"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "Codex failed: boom",
      parseMode: "HTML"
    }
  ]);
});

test("progress message edits fall back to MarkdownV2 when Telegram HTML parsing fails", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlEditOnce: true });
  const { session, runnerFactory } = await createSession({ fakeBotApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "a_b"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "a\\_b",
      parseMode: "MarkdownV2"
    }
  ]);
});

test("progress message edits fall back to plain text when Telegram HTML and Markdown parsing fail", async () => {
  const fakeBotApi = new FakeBotApi({ failHtmlEditOnce: true, failMarkdownEditOnce: true });
  const { session, runnerFactory } = await createSession({ fakeBotApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "a_b"
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "a_b"
    }
  ]);
});

test("final agent_message can send attachments declared in the XML output block", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-output-"));
  const artifactDir = path.join(tempDir, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "chart.png"), "png", "utf8");

  const { session, fakeBotApi, runnerFactory } = await createSession({
    botConfig: {
      workdir: tempDir
    }
  });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: [
        '<attachment path="./artifacts/chart.png" kind="photo" />',
        "",
        "Here is the chart."
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.edits, []);
  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "Here is the chart.",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "photo",
      filePath: path.join(artifactDir, "chart.png"),
      fileName: "chart.png"
    }
  ]);
  assert.deepEqual(fakeBotApi.deletions, [
    {
      chatId: 1001,
      messageId: 1
    }
  ]);
});

test("final agent_message can send ATTACH paths with quotes and escaped spaces", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-output-"));
  const desktopDir = path.join(tempDir, "Desktop");
  const screenshotPath = path.join(desktopDir, "Screenshot 2026-05-30 at 01.33.06.png");
  const secondPath = path.join(desktopDir, "Screenshot 2026-05-30 at 01.33.07.png");
  await fs.mkdir(desktopDir, { recursive: true });
  await fs.writeFile(screenshotPath, "png", "utf8");
  await fs.writeFile(secondPath, "png", "utf8");

  const { session, fakeBotApi, runnerFactory } = await createSession({
    botConfig: {
      workdir: tempDir
    }
  });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: [
        `ATTACH "${screenshotPath}"`,
        `ATTACH ${secondPath.replaceAll(" ", "\\ ")}`
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, []);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "photo",
      filePath: screenshotPath,
      fileName: "Screenshot 2026-05-30 at 01.33.06.png"
    },
    {
      chatId: 1001,
      kind: "photo",
      filePath: secondPath,
      fileName: "Screenshot 2026-05-30 at 01.33.07.png"
    }
  ]);
});

test("private final agent_message leaves group message blocks literal", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "<group_message><![CDATA[private text]]></group_message>"
    }
  });
  run.finish();
  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "<group_message><![CDATA[private text]]></group_message>",
      parseMode: "HTML"
    }
  ]);
});

test("attachment-only final agent_message deletes the transient progress message", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-output-"));
  const reportPath = path.join(tempDir, "report.pdf");
  await fs.writeFile(reportPath, "pdf", "utf8");

  const { session, fakeBotApi, runnerFactory } = await createSession({
    botConfig: {
      workdir: tempDir
    }
  });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: [
        '<attachment path="./report.pdf" kind="document" />'
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.deletions, [
    {
      chatId: 1001,
      messageId: 1
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "document",
      filePath: reportPath,
      fileName: "report.pdf"
    }
  ]);
});

test("multiple control blocks preserve text, attachment, and error order", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-output-"));
  const chartPath = path.join(tempDir, "chart.png");
  const reportPath = path.join(tempDir, "report.pdf");
  await fs.writeFile(chartPath, "png", "utf8");
  await fs.writeFile(reportPath, "pdf", "utf8");

  const attachmentFailures = new Map([[reportPath, "telegram rejected file"]]);
  const fakeBotApi = new FakeBotApi({ attachmentFailures });
  const { session, runnerFactory } = await createSession({
    fakeBotApi,
    botConfig: {
      workdir: tempDir
    }
  });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: [
        "Before",
        '<attachment path="./chart.png" kind="photo" />',
        "Between",
        '<attachment path="./missing.pdf" kind="document" />',
        '<attachment path="./report.pdf" kind="document" />',
        "After"
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "🟢 reasoning",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "Between",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "Attachment error: path=./missing.pdf; kind=document; reason=file not found",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "Attachment error: path=./report.pdf; kind=document; reason=telegram rejected file",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "After",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "Before",
      parseMode: "HTML"
    }
  ]);
  assert.deepEqual(fakeBotApi.attachments, [
    {
      chatId: 1001,
      kind: "photo",
      filePath: chartPath,
      fileName: "chart.png"
    }
  ]);
  assert.deepEqual(fakeBotApi.deletions, []);
});

test("oversized outbound attachments become inline errors without sending", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-output-"));
  const largePath = path.join(tempDir, "large.bin");
  await fs.writeFile(largePath, "", "utf8");
  await fs.truncate(largePath, 50 * 1024 * 1024 + 1);

  const { session, fakeBotApi, runnerFactory } = await createSession({
    botConfig: {
      workdir: tempDir
    }
  });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: [
        '<attachment path="./large.bin" kind="document" />'
      ].join("\n")
    }
  });
  run.finish();

  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.attachments, []);
  assert.deepEqual(fakeBotApi.edits, [
    {
      chatId: 1001,
      messageId: 1,
      text: "Attachment error: path=./large.bin; kind=document; reason=file exceeds the 50 MB limit",
      parseMode: "HTML"
    }
  ]);
});

test("group turns suppress progress and raw text while rendering group control blocks", async () => {
  const { session, fakeBotApi, runnerFactory } = await createSession();

  await session.enqueueTurn({
    mode: "group",
    groupInput: {
      messages: ["[2026-05-31 15:31:20] Alice (@alice):\nhello"]
    },
    groupIdentity: {
      botName: "Relay Bot",
      botHandle: "@relaybot"
    }
  });
  const run = runnerFactory.runs[0];

  await run.emit({
    type: "item.started",
    item: {
      id: "item_1",
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: [
        "raw text that should not be sent",
        "<group_message><![CDATA[Visible group reply]]></group_message>",
        '<attachment path="./missing.png" kind="photo" />'
      ].join("\n")
    }
  });
  run.finish();
  await flush();
  await flush();

  assert.deepEqual(fakeBotApi.messages, [
    {
      chatId: 1001,
      text: "Visible group reply",
      parseMode: "HTML"
    },
    {
      chatId: 1001,
      text: "Attachment error: path=./missing.png; kind=photo; reason=file not found",
      parseMode: "HTML"
    }
  ]);
});
