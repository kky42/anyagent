import test from "node:test";
import assert from "node:assert/strict";

import { renderMarkdownToTelegramHtml } from "../src/chat_adapter/telegram/markdown-renderer.js";

test("renderMarkdownToTelegramHtml renders common markdown to Telegram-safe HTML", () => {
  assert.equal(
    renderMarkdownToTelegramHtml(
      [
        "# Title",
        "",
        "Use **bold**, _italic_, and `code`.",
        "",
        "- one",
        "- two",
        "",
        "[OpenAI](https://openai.com)"
      ].join("\n")
    ),
    [
      "<b>Title</b>",
      "",
      "Use <b>bold</b>, <i>italic</i>, and <code>code</code>.",
      "",
      "• one",
      "• two",
      "",
      '<a href="https://openai.com">OpenAI</a>'
    ].join("\n")
  );
});

test("renderMarkdownToTelegramHtml renders code fences as pre blocks", () => {
  assert.equal(
    renderMarkdownToTelegramHtml(
      [
        "```js",
        "const x = 1 < 2;",
        "```"
      ].join("\n")
    ),
    "<pre><code>const x = 1 &lt; 2;\n</code></pre>"
  );
});

test("renderMarkdownToTelegramHtml renders tables as monospaced text", () => {
  assert.equal(
    renderMarkdownToTelegramHtml(
      [
        "| Name | Value |",
        "| --- | ---: |",
        "| a | 1 |",
        "| bb | 20 |"
      ].join("\n")
    ),
    [
      "<pre>Name | Value",
      "---- | -----",
      "a    |     1",
      "bb   |    20</pre>"
    ].join("\n")
  );
});
