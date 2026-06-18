import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { TelegramBotApi, TelegramApiError } from "../src/chat_adapter/telegram/telegram-api.js";

test("editMessageText sends the Telegram edit payload", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 7 }
        };
      }
    };
  });

  const result = await api.editMessageText({
    chatId: 1001,
    messageId: 7,
    text: "hello",
    parseMode: "MarkdownV2"
  });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/editMessageText",
      payload: {
        chat_id: 1001,
        message_id: 7,
        text: "hello",
        disable_web_page_preview: true,
        parse_mode: "MarkdownV2"
      }
    }
  ]);
  assert.deepEqual(result, { message_id: 7 });
});

test("sendMessage prefers direct-message topic routing when both targets are available", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 7 }
        };
      }
    };
  });

  await api.sendMessage({
    chatId: 1001,
    text: "hello",
    parseMode: "HTML",
    messageThreadId: 11,
    directMessagesTopicId: 22
  });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/sendMessage",
      payload: {
        chat_id: 1001,
        text: "hello",
        disable_web_page_preview: true,
        parse_mode: "HTML",
        direct_messages_topic_id: 22
      }
    }
  ]);
});

test("sendMessage falls back to direct-message topic routing when no thread id is available", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 7 }
        };
      }
    };
  });

  await api.sendMessage({
    chatId: 1001,
    text: "hello",
    directMessagesTopicId: 22
  });

  assert.equal(calls[0].payload.direct_messages_topic_id, 22);
  assert.equal("message_thread_id" in calls[0].payload, false);
});

test("sendMessage retries with direct-message topic routing when Telegram rejects message_thread_id", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({
      url,
      payload
    });

    if (calls.length === 1) {
      return {
        ok: false,
        async json() {
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found"
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 7 }
        };
      }
    };
  });

  await api.sendMessage({
    chatId: 1001,
    text: "hello",
    messageThreadId: 11
  });

  assert.deepEqual(
    calls.map((call) => call.payload),
    [
      {
        chat_id: 1001,
        text: "hello",
        disable_web_page_preview: true,
        message_thread_id: 11
      },
      {
        chat_id: 1001,
        text: "hello",
        disable_web_page_preview: true,
        direct_messages_topic_id: 11
      }
    ]
  );
});

test("sendRichMessage sends rich markdown payloads", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 8 }
        };
      }
    };
  });

  const result = await api.sendRichMessage({
    chatId: 1001,
    markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |",
    skipEntityDetection: true,
    messageThreadId: 11,
    directMessagesTopicId: 22
  });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/sendRichMessage",
      payload: {
        chat_id: 1001,
        rich_message: {
          markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |",
          skip_entity_detection: true
        },
        direct_messages_topic_id: 22
      }
    }
  ]);
  assert.deepEqual(result, { message_id: 8 });
});

test("sendRichMessage retries with direct-message topic routing", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);

    if (calls.length === 1) {
      return {
        ok: false,
        async json() {
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found"
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 8 }
        };
      }
    };
  });

  await api.sendRichMessage({
    chatId: 1001,
    markdown: "hello",
    messageThreadId: 11
  });

  assert.deepEqual(calls, [
    {
      chat_id: 1001,
      rich_message: { markdown: "hello" },
      message_thread_id: 11
    },
    {
      chat_id: 1001,
      rich_message: { markdown: "hello" },
      direct_messages_topic_id: 11
    }
  ]);
});

test("sendRichMessageDraft sends ephemeral rich draft payloads", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: true
        };
      }
    };
  });

  const result = await api.sendRichMessageDraft({
    chatId: 1001,
    draftId: 123,
    html: "<tg-thinking>Working</tg-thinking>",
    messageThreadId: 11
  });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/sendRichMessageDraft",
      payload: {
        chat_id: 1001,
        draft_id: 123,
        rich_message: {
          html: "<tg-thinking>Working</tg-thinking>"
        },
        message_thread_id: 11
      }
    }
  ]);
  assert.equal(result, true);
});

test("getFile sends the Telegram getFile payload", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { file_id: "file-1", file_path: "documents/test.pdf" }
        };
      }
    };
  });

  const result = await api.getFile("file-1");

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/getFile",
      payload: {
        file_id: "file-1"
      }
    }
  ]);
  assert.deepEqual(result, { file_id: "file-1", file_path: "documents/test.pdf" });
});

test("getUpdates sends offset and limit when provided", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: []
        };
      }
    };
  });

  await api.getUpdates({ offset: -1, limit: 1, timeout: 0 });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/getUpdates",
      payload: {
        offset: -1,
        limit: 1,
        timeout: 0,
        allowed_updates: ["message"]
      }
    }
  ]);
});

test("downloadFile streams binary responses", async () => {
  const api = new TelegramBotApi("token", async (url) => {
    assert.equal(url, "https://api.telegram.org/file/bottoken/documents/test.pdf");

    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from("hello ")));
          controller.enqueue(new Uint8Array(Buffer.from("world")));
          controller.close();
        }
      })
    };
  });

  const buffer = await api.downloadFile("documents/test.pdf");

  assert.equal(buffer.toString("utf8"), "hello world");
});

test("downloadFile rejects files that exceed the configured byte limit", async () => {
  const api = new TelegramBotApi("token", async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from("toolarge")));
        controller.close();
      }
    })
  }));

  await assert.rejects(
    () => api.downloadFile("documents/test.pdf", { maxBytes: 4 }),
    (error) => error instanceof TelegramApiError && error.errorCode === 413
  );
});

test("deleteMessage sends the Telegram delete payload", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: true
        };
      }
    };
  });

  const result = await api.deleteMessage({
    chatId: 1001,
    messageId: 7
  });

  assert.deepEqual(calls, [
    {
      url: "https://api.telegram.org/bottoken/deleteMessage",
      payload: {
        chat_id: 1001,
        message_id: 7
      }
    }
  ]);
  assert.equal(result, true);
});

test("sendChatAction skips channel direct-message topics", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: true
        };
      }
    };
  });

  const result = await api.sendChatAction({
    chatId: 1001,
    action: "typing",
    messageThreadId: 11,
    directMessagesTopicId: 22
  });

  assert.equal(result, true);
  assert.deepEqual(calls, []);
});

test("sendChatAction includes Telegram thread routing when no direct topic is available", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      payload: JSON.parse(options.body)
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: true
        };
      }
    };
  });

  await api.sendChatAction({
    chatId: 1001,
    action: "typing",
    messageThreadId: 11
  });

  assert.deepEqual(calls[0].payload, {
    chat_id: 1001,
    action: "typing",
    message_thread_id: 11
  });
});

test("sendChatAction does not retry with unsupported direct-message topic routing", async () => {
  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({
      url,
      payload
    });

    if (calls.length === 1) {
      return {
        ok: false,
        async json() {
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found"
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: true
        };
      }
    };
  });

  await assert.rejects(
    () => api.sendChatAction({
      chatId: 1001,
      action: "typing",
      messageThreadId: 11
    }),
    (error) => error instanceof TelegramApiError && /message thread not found/i.test(error.message)
  );

  assert.deepEqual(
    calls.map((call) => call.payload),
    [
      {
        chat_id: 1001,
        action: "typing",
        message_thread_id: 11
      }
    ]
  );
});

test("sendLocalAttachment uploads a multipart Telegram payload", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-telegram-api-"));
  const filePath = path.join(workdir, "report.pdf");
  await fs.writeFile(filePath, "pdf", "utf8");

  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      body: options.body
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 9 }
        };
      }
    };
  });

  const result = await api.sendLocalAttachment({
    chatId: 1001,
    kind: "document",
    filePath,
    fileName: "daily-report.pdf"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bottoken/sendDocument");
  assert.equal(calls[0].body.get("chat_id"), "1001");
  const uploaded = calls[0].body.get("document");
  assert.equal(uploaded.name, "daily-report.pdf");
  assert.equal(Buffer.from(await uploaded.arrayBuffer()).toString("utf8"), "pdf");
  assert.deepEqual(result, { message_id: 9 });
});

test("sendLocalAttachment prefers direct-message topic routing when both targets are available", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-telegram-api-"));
  const filePath = path.join(workdir, "report.pdf");
  await fs.writeFile(filePath, "pdf", "utf8");

  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      body: options.body
    });

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 9 }
        };
      }
    };
  });

  await api.sendLocalAttachment({
    chatId: 1001,
    kind: "document",
    filePath,
    messageThreadId: 11,
    directMessagesTopicId: 22
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bottoken/sendDocument");
  assert.equal(calls[0].body.get("direct_messages_topic_id"), "22");
  assert.equal(calls[0].body.has("message_thread_id"), false);
  assert.equal(calls[0].body.has("reply_parameters"), false);
});

test("sendLocalAttachment retries multipart uploads with direct-message topic routing", async () => {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-telegram-api-"));
  const filePath = path.join(workdir, "report.pdf");
  await fs.writeFile(filePath, "pdf", "utf8");

  const calls = [];
  const api = new TelegramBotApi("token", async (url, options) => {
    calls.push({
      url,
      body: options.body
    });

    if (calls.length === 1) {
      return {
        ok: false,
        async json() {
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found"
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: { message_id: 9 }
        };
      }
    };
  });

  await api.sendLocalAttachment({
    chatId: 1001,
    kind: "document",
    filePath,
    fileName: "report.pdf",
    messageThreadId: 11
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.get("message_thread_id"), "11");
  assert.equal(calls[0].body.has("direct_messages_topic_id"), false);
  assert.equal(calls[1].body.has("message_thread_id"), false);
  assert.equal(calls[1].body.get("direct_messages_topic_id"), "11");
  assert.equal(calls[1].body.get("document").name, "report.pdf");
});
