import fs from "node:fs/promises";
import path from "node:path";

import {
  OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES,
  outboundAttachmentLimitText
} from "../common/attachments.js";
import { splitPlainText, toErrorMessage } from "../../utils.js";
import {
  parseGroupMessageBodySegments,
  parseGroupOutputSegments,
  parseOutputSegments
} from "../common/output-attachments.js";
import { renderMarkdownToTelegramHtml } from "./markdown-renderer.js";
import { escapeTelegramMarkdown } from "./render.js";
import { TelegramApiError } from "./telegram-api.js";

const TELEGRAM_RENDER_CHUNK_SIZE = 3500;
const TELEGRAM_RICH_RENDER_CHUNK_SIZE = 32000;
const TELEGRAM_MAX_DRAFT_ID = 2_147_483_647;

function escapeHtmlText(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isParseError(error) {
  return (
    error instanceof TelegramApiError &&
    error.errorCode === 400 &&
    /parse entities/i.test(error.message)
  );
}

function isUnsupportedRichMessageError(error) {
  return (
    error instanceof TelegramApiError &&
    (error.errorCode === 404 || /not found|unsupported|unknown method/i.test(error.message))
  );
}

function isRecoverableRichMessageError(error) {
  return error instanceof TelegramApiError && (error.errorCode === 400 || isUnsupportedRichMessageError(error));
}

function getTelegramMessageId(result) {
  const rawMessageId = result?.message_id ?? result?.messageId;
  const messageId = Number(rawMessageId);
  return Number.isFinite(messageId) ? messageId : null;
}

function formatProgressText(text) {
  return `🟢 ${text}`;
}

function resolveAttachmentPath(filePath, workdir) {
  const normalizedPath = String(filePath ?? "").trim();
  if (!normalizedPath) {
    return "";
  }

  if (path.isAbsolute(normalizedPath)) {
    return normalizedPath;
  }

  return path.resolve(workdir || process.cwd(), normalizedPath);
}

function attachmentLabel(attachment) {
  return attachment.fileName || path.basename(String(attachment.path ?? "")) || attachment.kind;
}

function attachmentKindLabel(entry) {
  return entry.rawKind || entry.kind || null;
}

function formatAttachmentFailure(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  if (error instanceof TelegramApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    if (error.message === "path is not a file") {
      return error.message;
    }

    if (error && "code" in error) {
      if (error.code === "ENOENT") {
        return "file not found";
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        return "permission denied";
      }
    }

    return error.message;
  }

  return String(error);
}

function formatAttachmentErrorText(entry, reason) {
  const parts = [`Attachment error: path=${entry.path || "(missing)"}`];
  const kind = attachmentKindLabel(entry);
  if (kind) {
    parts.push(`kind=${kind}`);
  }
  parts.push(`reason=${reason}`);
  return parts.join("; ");
}

function hasVisibleText(text) {
  return Boolean(String(text ?? "").trim());
}

function richMarkdownCandidate(rawText) {
  const text = String(rawText ?? "");
  if (!text.trim() || text.length > TELEGRAM_RICH_RENDER_CHUNK_SIZE) {
    return null;
  }
  return text;
}

function buildRenderAttempts(rawChunk) {
  return [
    { text: rawChunk, parseMode: "HTML" },
    { text: escapeTelegramMarkdown(rawChunk), parseMode: "MarkdownV2" },
    { text: rawChunk, parseMode: null }
  ];
}

function outboundMessageTarget(replyTarget) {
  if (!replyTarget) {
    return {};
  }
  const target = {};
  if (replyTarget.directMessagesTopicId !== null && replyTarget.directMessagesTopicId !== undefined) {
    target.directMessagesTopicId = replyTarget.directMessagesTopicId;
    return target;
  }
  if (replyTarget.messageThreadId !== null && replyTarget.messageThreadId !== undefined) {
    target.messageThreadId = replyTarget.messageThreadId;
  }
  return target;
}

function isDirectMessagesTopicTarget(replyTarget) {
  return replyTarget?.directMessagesTopicId !== null && replyTarget?.directMessagesTopicId !== undefined;
}

export class MessageRenderer {
  constructor({ botApi, chatId, logger = () => {} }) {
    this.botApi = botApi;
    this.chatId = chatId;
    this.logger = logger;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    this.progressRenderedAsDraft = false;
    this.typingTimer = null;
    this.richMessagesUnavailable = false;
    this.richDraftsUnavailable = false;
    this.richDraftId = null;
  }

  resetTransientState() {
    this.markProgressSuperseded();
  }

  markProgressSuperseded() {
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    this.progressRenderedAsDraft = false;
    this.richDraftId = null;
  }

  async clearProgressMessage() {
    const messageId = this.progressMessageId;
    this.markProgressSuperseded();

    if (!messageId) {
      return;
    }

    try {
      await this.botApi.deleteMessage({
        chatId: this.chatId,
        messageId
      });
    } catch {
      // Keep attachment delivery moving even if Telegram refuses to delete the transient status.
    }
  }

  async refreshProgressDraft(options = {}) {
    const displayText = this.lastRenderedProgressText;
    if (!this.progressRenderedAsDraft || !displayText) {
      return;
    }

    const refreshed = await this.tryRenderProgressDraft(displayText, options);
    if (refreshed) {
      return;
    }

    if (
      !this.progressRenderedAsDraft ||
      this.lastRenderedProgressText !== displayText ||
      this.progressMessageId
    ) {
      return;
    }

    this.progressRenderedAsDraft = false;
    this.progressMessageId = await this.sendSplitText(displayText, options);
  }

  async renderWithFallback(renderAttempt) {
    let previousParseError = null;

    for (const attempt of buildRenderAttempts(renderAttempt.rawChunk)) {
      try {
        return await renderAttempt.send(attempt);
      } catch (error) {
        if (!isParseError(error) || attempt.parseMode === null) {
          throw error;
        }
        previousParseError = error;
      }
    }

    throw previousParseError ?? new Error("Telegram render fallback exhausted unexpectedly.");
  }

  async trySendRichMarkdown(rawText, options = {}) {
    if (this.richMessagesUnavailable || typeof this.botApi.sendRichMessage !== "function") {
      return null;
    }

    const markdown = richMarkdownCandidate(rawText);
    if (markdown === null) {
      return null;
    }

    try {
      return await this.botApi.sendRichMessage({
        chatId: this.chatId,
        richMessage: { markdown },
        ...outboundMessageTarget(options.replyTarget)
      });
    } catch (error) {
      if (!isRecoverableRichMessageError(error)) {
        throw error;
      }
      if (isUnsupportedRichMessageError(error)) {
        this.richMessagesUnavailable = true;
      } else {
        this.logger(`rich message fallback: ${toErrorMessage(error)}`);
      }
      return null;
    }
  }

  async sendRichText(markdown, options = {}) {
    const rawMarkdown = String(markdown ?? "");
    if (!rawMarkdown) {
      return;
    }

    const result = await this.trySendRichMarkdown(rawMarkdown, options);
    if (result) {
      return result;
    }

    return this.sendText(options.fallbackText ?? rawMarkdown, {
      ...options,
      allowRich: false
    });
  }

  nextRichDraftId() {
    if (!this.richDraftId) {
      this.richDraftId = Math.floor(Date.now() % TELEGRAM_MAX_DRAFT_ID) || 1;
    }
    return this.richDraftId;
  }

  draftMessageThreadId(replyTarget) {
    if (replyTarget?.messageThreadId !== null && replyTarget?.messageThreadId !== undefined) {
      return replyTarget.messageThreadId;
    }
    return null;
  }

  canSendRichDraft() {
    return (
      !this.richDraftsUnavailable &&
      Number(this.chatId) > 0 &&
      typeof this.botApi.sendRichMessageDraft === "function"
    );
  }

  async tryRenderProgressDraft(displayText, options = {}) {
    if (!this.canSendRichDraft() || isDirectMessagesTopicTarget(options.replyTarget)) {
      return false;
    }

    try {
      await this.botApi.sendRichMessageDraft({
        chatId: this.chatId,
        draftId: this.nextRichDraftId(),
        richMessage: {
          html: `<tg-thinking>${escapeHtmlText(displayText)}</tg-thinking>`
        },
        messageThreadId: this.draftMessageThreadId(options.replyTarget)
      });
      return true;
    } catch (error) {
      if (!isRecoverableRichMessageError(error)) {
        throw error;
      }
      this.richDraftsUnavailable = true;
      if (!isUnsupportedRichMessageError(error)) {
        this.logger(`rich draft fallback: ${toErrorMessage(error)}`);
      }
      return false;
    }
  }

  async sendMessageChunk(rawChunk, options = {}) {
    const renderChunk = options.renderMarkdown
      ? renderMarkdownToTelegramHtml(rawChunk)
      : rawChunk;
    return this.renderWithFallback({
      rawChunk: renderChunk,
      send: ({ text, parseMode }) =>
        this.botApi.sendMessage({
          chatId: this.chatId,
          text,
          parseMode,
          ...outboundMessageTarget(options.replyTarget)
        })
    });
  }

  async editMessageChunk(messageId, rawChunk, options = {}) {
    const renderChunk = options.renderMarkdown
      ? renderMarkdownToTelegramHtml(rawChunk)
      : rawChunk;
    return this.renderWithFallback({
      rawChunk: renderChunk,
      send: ({ text, parseMode }) =>
        this.botApi.editMessageText({
          chatId: this.chatId,
          messageId,
          text,
          parseMode
        })
    });
  }

  async sendSplitText(rawText, options = {}) {
    let firstMessageId = null;

    for (const rawChunk of splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE)) {
      const result = await this.sendMessageChunk(rawChunk, options);
      firstMessageId ??= getTelegramMessageId(result);
    }

    return firstMessageId;
  }

  async renderProgressText(text, options = {}) {
    const rawText = String(text ?? "").trim();
    if (!rawText) {
      return;
    }

    const displayText = formatProgressText(rawText);
    if (this.lastRenderedProgressText === displayText) {
      return;
    }

    if (await this.tryRenderProgressDraft(displayText, options)) {
      this.lastRenderedProgressText = displayText;
      this.progressRenderedAsDraft = true;
      return;
    }

    if (this.progressMessageId) {
      try {
        await this.editMessageChunk(this.progressMessageId, displayText);
      } catch (error) {
        this.logger(`progress edit failed; sending a replacement: ${toErrorMessage(error)}`);
        this.progressMessageId = await this.sendSplitText(displayText, options);
      }
    } else {
      this.progressMessageId = await this.sendSplitText(displayText, options);
    }

    this.lastRenderedProgressText = displayText;
    this.progressRenderedAsDraft = false;
  }

  async tryRenderRichTerminalText(rawText, options = {}) {
    if (!options.richMarkdown) {
      return false;
    }

    const result = await this.trySendRichMarkdown(rawText, options);
    if (!result) {
      return false;
    }

    if (this.progressMessageId) {
      await this.clearProgressMessage();
    } else {
      this.markProgressSuperseded();
    }
    return true;
  }

  async renderTerminalText(rawText, options = {}) {
    if (!rawText) {
      return;
    }

    if (await this.tryRenderRichTerminalText(rawText, options)) {
      return;
    }

    const rawChunks = splitPlainText(rawText, TELEGRAM_RENDER_CHUNK_SIZE);
    const [firstChunk, ...remainingChunks] = rawChunks;

    if (this.progressMessageId) {
      if (firstChunk !== this.lastRenderedProgressText) {
        try {
          await this.editMessageChunk(this.progressMessageId, firstChunk, options);
        } catch (error) {
          this.logger(`final edit failed; sending a replacement: ${toErrorMessage(error)}`);
          await this.sendMessageChunk(firstChunk, options);
        }
      }
      this.markProgressSuperseded();

      for (const rawChunk of remainingChunks) {
        await this.sendMessageChunk(rawChunk, options);
      }
      return;
    }

    await this.sendSplitText(rawText, options);
    this.markProgressSuperseded();
  }

  async sendAttachment(attachment, options = {}) {
    const filePath = options.filePath ?? resolveAttachmentPath(attachment.path, options.workdir);
    return this.botApi.sendLocalAttachment({
      chatId: this.chatId,
      kind: attachment.kind,
      filePath,
      fileName: attachment.fileName || path.basename(filePath),
      ...outboundMessageTarget(options.replyTarget)
    });
  }

  async validateAttachmentEntry(entry, options = {}) {
    if (entry.error) {
      return { ok: false, reason: entry.error };
    }

    const filePath = resolveAttachmentPath(entry.path, options.workdir);
    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      return {
        ok: false,
        reason: formatAttachmentFailure(error)
      };
    }

    if (!stats.isFile()) {
      return { ok: false, reason: "path is not a file" };
    }

    if (stats.size > OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES) {
      return {
        ok: false,
        reason: `file exceeds the ${outboundAttachmentLimitText()} limit`
      };
    }

    return {
      ok: true,
      filePath
    };
  }

  async deliverAttachmentEntry(entry, options = {}) {
    const validation = await this.validateAttachmentEntry(entry, options);
    if (!validation.ok) {
      return {
        kind: "text",
        text: formatAttachmentErrorText(entry, validation.reason)
      };
    }

    try {
      await this.sendAttachment(entry, {
        ...options,
        filePath: validation.filePath
      });
    } catch (error) {
      return {
        kind: "text",
        text: formatAttachmentErrorText(entry, formatAttachmentFailure(error))
      };
    }

    return { kind: "attachment" };
  }

  async renderOutputSegments(segments, options = {}) {
    const deliverText = options.deliverText ?? ((text) => this.sendText(text, options));
    const suppressRawText = Boolean(options.suppressRawText);
    const deliverGroupMessages = Boolean(options.deliverGroupMessages);
    let hasVisibleOutput = false;

    const renderVisibleText = async (text) => {
      if (!hasVisibleText(text)) {
        return;
      }
      await deliverText(text);
      hasVisibleOutput = true;
    };

    const renderAttachmentSegment = async (segment) => {
      for (const entry of segment.entries) {
        const result = await this.deliverAttachmentEntry(entry, options);
        if (result.kind === "text") {
          await renderVisibleText(result.text);
          continue;
        }

        if (!hasVisibleOutput && options.clearProgressAfterFirstAttachment) {
          await this.clearProgressMessage();
        }
        hasVisibleOutput = true;
      }
    };

    for (const segment of segments) {
      if (segment.kind === "text") {
        if (suppressRawText) {
          continue;
        }
        await renderVisibleText(segment.text);
        continue;
      }

      if (segment.kind === "group_message") {
        const text = deliverGroupMessages ? segment.text : segment.rawText;
        if (suppressRawText && !deliverGroupMessages) {
          continue;
        }

        if (!deliverGroupMessages) {
          await renderVisibleText(text);
          continue;
        }

        const bodySegments = parseGroupMessageBodySegments(text);
        for (const bodySegment of bodySegments) {
          if (bodySegment.kind === "attachment") {
            await renderAttachmentSegment(bodySegment);
            continue;
          }
          await renderVisibleText(bodySegment.text);
        }
        continue;
      }

      await renderAttachmentSegment(segment);
    }
  }

  async sendCodexOutput(text, options = {}) {
    const segments = parseOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, {
      ...options,
      deliverText: (rawText) =>
        this.sendText(rawText, {
          ...options,
          renderMarkdown: true
        })
    });
  }

  async renderFinalMessage(text, options = {}) {
    const segments = parseOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, {
      ...options,
      clearProgressAfterFirstAttachment: true,
      deliverText: (rawText) =>
        this.renderTerminalText(rawText, {
          ...options,
          richMarkdown: true,
          renderMarkdown: true
        })
    });
  }

  async renderGroupFinalMessage(text, options = {}) {
    const segments = parseGroupOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, {
      ...options,
      suppressRawText: true,
      deliverGroupMessages: true,
      deliverText: (rawText) =>
        this.renderTerminalText(rawText, {
          ...options,
          richMarkdown: true,
          renderMarkdown: true
        })
    });
  }

  async renderErrorText(text, options = {}) {
    await this.renderTerminalText(String(text ?? "").trim(), options);
  }

  async sendText(text, options = {}) {
    const rawText = String(text ?? "");
    if (!rawText) {
      return;
    }

    if (options.allowRich !== false) {
      const result = await this.trySendRichMarkdown(rawText, options);
      if (result) {
        return result;
      }
    }

    return this.sendSplitText(rawText, options);
  }

  startTyping(replyTarget = null) {
    if (this.typingTimer) {
      return;
    }

    const tick = async () => {
      if (!isDirectMessagesTopicTarget(replyTarget)) {
        try {
          await this.botApi.sendChatAction({
            chatId: this.chatId,
            action: "typing",
            ...outboundMessageTarget(replyTarget)
          });
        } catch (error) {
          this.logger(`typing indicator failed: ${toErrorMessage(error)}`);
        }
      }

      try {
        await this.refreshProgressDraft({ replyTarget });
      } catch (error) {
        this.logger(`progress draft refresh failed: ${toErrorMessage(error)}`);
      }
    };

    void tick();
    this.typingTimer = setInterval(() => {
      void tick();
    }, 4000);
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}
