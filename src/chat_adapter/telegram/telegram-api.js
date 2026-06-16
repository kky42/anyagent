import fs from "node:fs/promises";
import path from "node:path";

export class TelegramApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TelegramApiError";
    this.errorCode = options.errorCode ?? null;
    this.parameters = options.parameters ?? null;
  }
}

export class TelegramBotApi {
  constructor(token, fetchImpl = globalThis.fetch) {
    if (!fetchImpl) {
      throw new Error("Global fetch is not available. Node.js 20+ is required.");
    }

    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fileBaseUrl = `https://api.telegram.org/file/bot${token}`;
  }

  async call(method, payload = {}, options = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal
    });

    return this.parseResponse(method, response);
  }

  async callMultipart(method, formData, options = {}) {
    const response = await this.fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      body: formData,
      signal: options.signal
    });

    return this.parseResponse(method, response);
  }

  isThreadNotFoundError(error) {
    return (
      error instanceof TelegramApiError &&
      error.errorCode === 400 &&
      /message thread not found/i.test(error.message)
    );
  }

  hasThreadRoutingField(payload) {
    if (!payload) {
      return false;
    }

    if (typeof payload.has === "function") {
      return payload.has("message_thread_id") || payload.has("direct_messages_topic_id");
    }

    return (
      (payload.message_thread_id !== null && payload.message_thread_id !== undefined) ||
      (payload.direct_messages_topic_id !== null &&
        payload.direct_messages_topic_id !== undefined)
    );
  }

  cloneThreadRoutingPayload(payload) {
    if (typeof payload?.has === "function") {
      const clone = new FormData();
      for (const [key, value] of payload.entries()) {
        clone.append(key, value);
      }
      return clone;
    }

    return { ...payload };
  }

  swapThreadRoutingPayload(payload) {
    if (typeof payload?.has === "function") {
      if (payload.has("message_thread_id")) {
        const threadId = payload.get("message_thread_id");
        payload.delete("message_thread_id");
        payload.set("direct_messages_topic_id", String(threadId));
      } else if (payload.has("direct_messages_topic_id")) {
        const directMessagesTopicId = payload.get("direct_messages_topic_id");
        payload.delete("direct_messages_topic_id");
        payload.set("message_thread_id", String(directMessagesTopicId));
      }
      return payload;
    }

    if (payload.message_thread_id !== null && payload.message_thread_id !== undefined) {
      payload.direct_messages_topic_id = payload.message_thread_id;
      delete payload.message_thread_id;
    } else if (
      payload.direct_messages_topic_id !== null &&
      payload.direct_messages_topic_id !== undefined
    ) {
      payload.message_thread_id = payload.direct_messages_topic_id;
      delete payload.direct_messages_topic_id;
    }

    return payload;
  }

  async callWithThreadFallback(method, payload, options = {}) {
    const invoke =
      typeof payload?.has === "function"
        ? (requestPayload) => this.callMultipart(method, requestPayload, options)
        : (requestPayload) => this.call(method, requestPayload, options);

    try {
      return await invoke(payload);
    } catch (error) {
      if (
        !this.isThreadNotFoundError(error) ||
        !this.hasThreadRoutingField(payload)
      ) {
        throw error;
      }

      const fallbackPayload = this.cloneThreadRoutingPayload(payload);
      this.swapThreadRoutingPayload(fallbackPayload);

      return invoke(fallbackPayload);
    }
  }

  async parseResponse(method, response) {
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new TelegramApiError(`Telegram ${method} returned invalid JSON`);
    }

    if (!response.ok || !body.ok) {
      throw new TelegramApiError(body.description || `${method} failed`, {
        errorCode: body.error_code ?? response.status,
        parameters: body.parameters ?? null
      });
    }

    return body.result;
  }

  getMe(options = {}) {
    return this.call("getMe", {}, options);
  }

  setMyCommands(commands, options = {}) {
    return this.call("setMyCommands", { commands }, options);
  }

  getFile(fileId, options = {}) {
    return this.call("getFile", { file_id: fileId }, options);
  }

  getUpdates({ offset, limit, timeout = 50 } = {}, options = {}) {
    const payload = {
      timeout,
      allowed_updates: ["message"]
    };

    if (offset !== undefined) {
      payload.offset = offset;
    }
    if (limit !== undefined) {
      payload.limit = limit;
    }

    return this.call("getUpdates", payload, options);
  }

  sendMessage({
    chatId,
    text,
    parseMode = null,
    messageThreadId = null,
    directMessagesTopicId = null
  }, options = {}) {
    const payload = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    }
    if (messageThreadId !== null && messageThreadId !== undefined) {
      payload.message_thread_id = messageThreadId;
    } else if (directMessagesTopicId !== null && directMessagesTopicId !== undefined) {
      payload.direct_messages_topic_id = directMessagesTopicId;
    }

    return this.callWithThreadFallback("sendMessage", payload, options);
  }

  sendRichMessage({
    chatId,
    richMessage = null,
    markdown = null,
    html = null,
    isRtl = null,
    skipEntityDetection = null,
    messageThreadId = null,
    directMessagesTopicId = null
  }, options = {}) {
    const payload = {
      chat_id: chatId,
      rich_message: richMessage ?? {}
    };

    if (markdown !== null && markdown !== undefined) {
      payload.rich_message.markdown = markdown;
    }
    if (html !== null && html !== undefined) {
      payload.rich_message.html = html;
    }
    if (isRtl !== null && isRtl !== undefined) {
      payload.rich_message.is_rtl = Boolean(isRtl);
    }
    if (skipEntityDetection !== null && skipEntityDetection !== undefined) {
      payload.rich_message.skip_entity_detection = Boolean(skipEntityDetection);
    }
    if (messageThreadId !== null && messageThreadId !== undefined) {
      payload.message_thread_id = messageThreadId;
    } else if (directMessagesTopicId !== null && directMessagesTopicId !== undefined) {
      payload.direct_messages_topic_id = directMessagesTopicId;
    }

    return this.callWithThreadFallback("sendRichMessage", payload, options);
  }

  sendRichMessageDraft({
    chatId,
    draftId,
    richMessage = null,
    markdown = null,
    html = null,
    messageThreadId = null
  }, options = {}) {
    const payload = {
      chat_id: chatId,
      draft_id: draftId,
      rich_message: richMessage ?? {}
    };

    if (markdown !== null && markdown !== undefined) {
      payload.rich_message.markdown = markdown;
    }
    if (html !== null && html !== undefined) {
      payload.rich_message.html = html;
    }
    if (messageThreadId !== null && messageThreadId !== undefined) {
      payload.message_thread_id = messageThreadId;
    }

    return this.call("sendRichMessageDraft", payload, options);
  }

  editMessageText({ chatId, messageId, text, parseMode = null }, options = {}) {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    return this.call("editMessageText", payload, options);
  }

  deleteMessage({ chatId, messageId }, options = {}) {
    return this.call(
      "deleteMessage",
      {
        chat_id: chatId,
        message_id: messageId
      },
      options
    );
  }

  async sendLocalAttachment(
    {
      chatId,
      kind,
      filePath,
      fileName = null,
      caption = null,
      parseMode = null,
      messageThreadId = null,
      directMessagesTopicId = null
    },
    options = {}
  ) {
    const target = OUTBOUND_ATTACHMENT_TARGETS[kind];
    if (!target) {
      throw new Error(`Unsupported outbound attachment kind: ${kind}`);
    }

    const body = await fs.readFile(filePath);
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append(
      target.field,
      new Blob([body]),
      fileName || path.basename(String(filePath ?? "")) || "attachment"
    );

    if (caption) {
      formData.append("caption", caption);
    }

    if (parseMode) {
      formData.append("parse_mode", parseMode);
    }
    if (messageThreadId !== null && messageThreadId !== undefined) {
      formData.append("message_thread_id", String(messageThreadId));
    } else if (directMessagesTopicId !== null && directMessagesTopicId !== undefined) {
      formData.append("direct_messages_topic_id", String(directMessagesTopicId));
    }

    return this.callWithThreadFallback(target.method, formData, options);
  }

  sendChatAction({
    chatId,
    action = "typing",
    messageThreadId = null,
    directMessagesTopicId = null
  }, options = {}) {
    const payload = {
      chat_id: chatId,
      action
    };
    if (messageThreadId !== null && messageThreadId !== undefined) {
      payload.message_thread_id = messageThreadId;
    }

    return this.callWithThreadFallback("sendChatAction", payload, options);
  }

  async downloadFile(filePath, options = {}) {
    const response = await this.fetch(`${this.fileBaseUrl}/${filePath}`, {
      method: "GET",
      signal: options.signal
    });

    if (!response.ok) {
      throw new TelegramApiError(`Telegram file download failed with status ${response.status}`, {
        errorCode: response.status
      });
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (Number.isFinite(options.maxBytes) && buffer.length > options.maxBytes) {
        throw new TelegramApiError(`Telegram file exceeds ${options.maxBytes} bytes`, {
          errorCode: 413
        });
      }
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (Number.isFinite(options.maxBytes) && totalBytes > options.maxBytes) {
        throw new TelegramApiError(`Telegram file exceeds ${options.maxBytes} bytes`, {
          errorCode: 413
        });
      }
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }
}

const OUTBOUND_ATTACHMENT_TARGETS = {
  photo: { method: "sendPhoto", field: "photo" },
  document: { method: "sendDocument", field: "document" },
  video: { method: "sendVideo", field: "video" },
  audio: { method: "sendAudio", field: "audio" },
  voice: { method: "sendVoice", field: "voice" },
  animation: { method: "sendAnimation", field: "animation" }
};
