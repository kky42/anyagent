import fs from "node:fs/promises";
import path from "node:path";

import {
  OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES,
  outboundAttachmentLimitText
} from "../common/attachments.js";
import { sleep, splitPlainText, toErrorMessage } from "../../utils.js";
import {
  parseGroupMessageBodySegments,
  parseGroupOutputSegments,
  parseOutputSegments
} from "../common/output-attachments.js";
import { MattermostApiError } from "./mattermost-api.js";

const MATTERMOST_RENDER_CHUNK_SIZE = 15000;
const MATTERMOST_FILE_IDS_PER_POST = 5;
const TYPING_INTERVAL_MS = 5000;
const DELIVERY_RETRY_DELAYS_MS = [250, 1000];

function getMattermostPostId(result) {
  const id = String(result?.id ?? "").trim();
  return id || null;
}

function formatProgressText(text) {
  return `:hourglass_flowing_sand: **Running:** ${text}`;
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

function attachmentKindLabel(entry) {
  return entry.rawKind || entry.kind || null;
}

function formatAttachmentFailure(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  if (error instanceof MattermostApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    if (error.message === "path is not a file") {
      return error.message;
    }
    if ("code" in error) {
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

function rootIdFromReplyTarget(replyTarget) {
  const rootId = String(replyTarget?.rootId ?? "").trim();
  return rootId || null;
}

function retryableNetworkError(error) {
  const message = toErrorMessage(error);
  if (/fetch failed/i.test(message)) {
    return true;
  }

  const code = error?.code ?? error?.cause?.code;
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(String(code ?? ""));
}

async function retryDelivery(label, operation, logger) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = DELIVERY_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !retryableNetworkError(error)) {
        throw error;
      }

      attempt += 1;
      logger(
        `${label} failed: ${toErrorMessage(error)}; retrying (${attempt}/${DELIVERY_RETRY_DELAYS_MS.length})`
      );
      await sleep(delayMs);
    }
  }
}

export class MessageRenderer {
  constructor({ botApi, channelId, websocket = null, logger = () => {} }) {
    this.botApi = botApi;
    this.channelId = channelId;
    this.websocket = websocket;
    this.logger = logger;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    this.typingTimer = null;
    this.typingReplyTarget = null;
  }

  setWebSocket(websocket) {
    this.websocket = websocket;
  }

  resetTransientState() {
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
  }

  async clearProgressMessage() {
    const postId = this.progressMessageId;
    this.progressMessageId = null;
    this.lastRenderedProgressText = null;
    if (!postId) {
      return;
    }

    try {
      await this.botApi.deletePost({ postId });
    } catch {
      // Keep attachment delivery moving even if Mattermost refuses to delete the transient status.
    }
  }

  async sendMessageChunk(rawChunk, options = {}) {
    return retryDelivery(
      "post create",
      () => this.botApi.createPost({
        channelId: this.channelId,
        message: rawChunk,
        rootId: rootIdFromReplyTarget(options.replyTarget)
      }),
      this.logger
    );
  }

  async editMessageChunk(postId, rawChunk) {
    return retryDelivery(
      "post update",
      () => this.botApi.updatePost({
        postId,
        message: rawChunk
      }),
      this.logger
    );
  }

  async sendSplitText(rawText, options = {}) {
    let firstPostId = null;
    for (const rawChunk of splitPlainText(rawText, MATTERMOST_RENDER_CHUNK_SIZE)) {
      const result = await this.sendMessageChunk(rawChunk, options);
      firstPostId ??= getMattermostPostId(result);
    }
    return firstPostId;
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

    if (this.progressMessageId) {
      try {
        await this.editMessageChunk(this.progressMessageId, displayText);
      } catch (error) {
        this.logger(`progress edit failed: ${toErrorMessage(error)}`);
        this.progressMessageId = await this.sendSplitText(displayText, options);
      }
    } else {
      this.progressMessageId = await this.sendSplitText(displayText, options);
    }

    this.lastRenderedProgressText = displayText;
  }

  async renderTerminalText(rawText, options = {}) {
    if (!rawText) {
      return;
    }

    const rawChunks = splitPlainText(rawText, MATTERMOST_RENDER_CHUNK_SIZE);
    const [firstChunk, ...remainingChunks] = rawChunks;

    if (this.progressMessageId) {
      try {
        if (firstChunk !== this.lastRenderedProgressText) {
          await this.editMessageChunk(this.progressMessageId, firstChunk);
        }
        this.progressMessageId = null;
        this.lastRenderedProgressText = null;
      } catch (error) {
        this.logger(`terminal edit failed: ${toErrorMessage(error)}`);
        this.progressMessageId = null;
        this.lastRenderedProgressText = null;
        await this.sendMessageChunk(firstChunk, options);
      }

      for (const rawChunk of remainingChunks) {
        await this.sendMessageChunk(rawChunk, options);
      }
      return;
    }

    await this.sendSplitText(rawText, options);
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

  async uploadAttachmentEntry(entry, options = {}) {
    const validation = await this.validateAttachmentEntry(entry, options);
    if (!validation.ok) {
      return {
        kind: "text",
        text: formatAttachmentErrorText(entry, validation.reason)
      };
    }

    try {
      const result = await this.botApi.uploadFile({
        channelId: this.channelId,
        filePath: validation.filePath,
        fileName: entry.fileName || path.basename(validation.filePath)
      });
      const fileInfos = Array.isArray(result?.file_infos) ? result.file_infos : [];
      const fileId = fileInfos[0]?.id;
      if (!fileId) {
        return {
          kind: "text",
          text: formatAttachmentErrorText(entry, "Mattermost did not return a file id")
        };
      }
      return { kind: "attachment", fileId };
    } catch (error) {
      return {
        kind: "text",
        text: formatAttachmentErrorText(entry, formatAttachmentFailure(error))
      };
    }
  }

  async renderOutputSegments(segments, options = {}) {
    const deliverText = options.deliverText ?? ((text) => this.sendText(text, options));
    const suppressRawText = Boolean(options.suppressRawText);
    const deliverGroupMessages = Boolean(options.deliverGroupMessages);
    let hasVisibleOutput = false;
    let pendingFileIds = [];

    const flushFiles = async () => {
      if (pendingFileIds.length === 0) {
        return;
      }
      const fileIds = pendingFileIds;
      pendingFileIds = [];
      await this.botApi.createPost({
        channelId: this.channelId,
        message: "",
        rootId: rootIdFromReplyTarget(options.replyTarget),
        fileIds
      });
      if (!hasVisibleOutput && options.clearProgressAfterFirstAttachment) {
        await this.clearProgressMessage();
      }
      hasVisibleOutput = true;
    };

    const renderVisibleText = async (text) => {
      await flushFiles();
      if (!hasVisibleText(text)) {
        return;
      }
      await deliverText(text);
      hasVisibleOutput = true;
    };

    const renderAttachmentSegment = async (segment) => {
      for (const entry of segment.entries) {
        const result = await this.uploadAttachmentEntry(entry, options);
        if (result.kind === "text") {
          await renderVisibleText(result.text);
          continue;
        }

        pendingFileIds.push(result.fileId);
        if (pendingFileIds.length >= MATTERMOST_FILE_IDS_PER_POST) {
          await flushFiles();
        }
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

    await flushFiles();
  }

  async sendCodexOutput(text, options = {}) {
    const segments = parseOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, options);
  }

  async renderFinalMessage(text, options = {}) {
    const segments = parseOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, {
      ...options,
      clearProgressAfterFirstAttachment: true,
      deliverText: (rawText) => this.renderTerminalText(rawText, options)
    });
  }

  async renderGroupFinalMessage(text, options = {}) {
    const segments = parseGroupOutputSegments(String(text ?? ""));
    await this.renderOutputSegments(segments, {
      ...options,
      suppressRawText: true,
      deliverGroupMessages: true,
      deliverText: (rawText) => this.renderTerminalText(rawText, options)
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
    await this.sendSplitText(rawText, options);
  }

  startTyping(replyTarget = null) {
    if (this.typingTimer) {
      return;
    }
    this.typingReplyTarget = replyTarget;

    const tick = () => {
      try {
        this.websocket?.sendTyping?.({
          channelId: this.channelId,
          rootId: rootIdFromReplyTarget(this.typingReplyTarget)
        });
      } catch (error) {
        this.logger(`typing indicator failed: ${toErrorMessage(error)}`);
      }
    };

    tick();
    this.typingTimer = setInterval(tick, TYPING_INTERVAL_MS);
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
      this.typingReplyTarget = null;
    }
  }
}
