import test from "node:test";
import assert from "node:assert/strict";

import { createRuntime } from "./support/builders.js";
import { richMessageToMarkdown } from "../src/chat_adapter/telegram/rich-message.js";

function buildRichMessage(richMessage, username = "AllowedUser", chatId = 1001, overrides = {}) {
  return {
    chat: { id: chatId, type: "private" },
    from: { id: 42, username },
    rich_message: richMessage,
    ...overrides
  };
}

test("richMessageToMarkdown flattens headings, nested lists, tables, details, and formulas", () => {
  const markdown = richMessageToMarkdown({
    blocks: [
      { type: "heading", size: 2, text: "Report" },
      {
        type: "list",
        items: [
          {
            label: "-",
            blocks: [
              { type: "paragraph", text: ["one ", { type: "bold", text: "bold" }] },
              {
                type: "list",
                items: [
                  { has_checkbox: true, is_checked: true, blocks: [{ type: "paragraph", text: "nested" }] }
                ]
              }
            ]
          }
        ]
      },
      {
        type: "table",
        cells: [
          [{ text: "Metric", is_header: true }, { text: "Value", is_header: true }],
          [{ text: "speed" }, { text: { type: "code", text: "42ms" } }]
        ]
      },
      {
        type: "details",
        summary: "More",
        blocks: [{ type: "mathematical_expression", expression: "E = mc^2" }]
      }
    ]
  });

  assert.match(markdown, /^## Report/);
  assert.match(markdown, /- one \*\*bold\*\*/);
  assert.match(markdown, /  - \[x\] nested/);
  assert.match(markdown, /\| Metric \| Value \|/);
  assert.match(markdown, /`42ms`/);
  assert.match(markdown, /<details><summary>More<\/summary>/);
  assert.match(markdown, /\$\$E = mc\^2\$\$/);
});

test("runtime routes inbound Telegram rich_message content to the agent as Markdown", async () => {
  const { runtime, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildRichMessage({
      blocks: [
        { type: "heading", size: 1, text: "Q1" },
        {
          type: "table",
          cells: [
            [{ text: "Metric", is_header: true }, { text: "Value", is_header: true }],
            [{ text: "Speed" }, { text: "42" }]
          ]
        }
      ]
    })
  );

  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /^# Q1/);
  assert.match(runnerFactory.runs[0].params.message, /\| Metric \| Value \|/);
  runnerFactory.runs[0].finish();
  await runtime.stop();
});

test("runtime recognizes inbound Telegram rich_message bot commands", async () => {
  assert.equal(
    richMessageToMarkdown({
      blocks: [{ type: "paragraph", text: { type: "bot_command", value: "status" } }]
    }),
    "/status"
  );

  const { runtime, fakeBotApi, runnerFactory } = await createRuntime();

  await runtime.handleMessage(
    buildRichMessage({
      blocks: [{ type: "paragraph", text: { type: "bot_command", text: "status" } }]
    })
  );

  assert.equal(runnerFactory.runs.length, 0);
  assert.match(fakeBotApi.messages.at(-1).text, /running: no/);
  await runtime.stop();
});

test("Telegram status command sends rich key-value output when rich messages are available", async () => {
  const { runtime, fakeBotApi } = await createRuntime();
  fakeBotApi.supportsRichMessages = true;

  await runtime.handleMessage({
    chat: { id: 1001, type: "private" },
    from: { id: 42, username: "AllowedUser" },
    text: "/status"
  });

  assert.equal(fakeBotApi.richMessages.length, 1);
  const { markdown } = fakeBotApi.richMessages[0].richMessage;
  assert.match(markdown, /^# AnyAgent Status/);
  assert.match(markdown, /\*\*running:\*\* no/);
  assert.doesNotMatch(markdown, /\| Field \| Value \|/);
});
