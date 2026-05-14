import path from "node:path";

import { truncateText } from "../../utils.js";

export const ATTACHMENT_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_SIZE_LIMIT_MB = 20;
export const OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
export const OUTBOUND_ATTACHMENT_SIZE_LIMIT_MB = 50;
export const ALBUM_QUIET_PERIOD_MS = 1500;
export const SUPPORTED_ATTACHMENT_KINDS = [
  "photo",
  "document",
  "video",
  "audio",
  "voice",
  "animation"
];

const DEFAULT_ATTACHMENT_EXTENSIONS = {
  photo: ".jpg",
  document: "",
  video: ".mp4",
  audio: "",
  voice: ".ogg",
  animation: ".mp4"
};
const MAX_ATTACHMENT_FILE_NAME_LENGTH = 160;

export function attachmentSupportText() {
  return SUPPORTED_ATTACHMENT_KINDS.join(", ");
}

export function unsupportedAttachmentMessage() {
  return `Unsupported message type. Supported attachments: ${attachmentSupportText()}.`;
}

export function attachmentLimitText() {
  return `${ATTACHMENT_SIZE_LIMIT_MB} MB`;
}

export function outboundAttachmentLimitText() {
  return `${OUTBOUND_ATTACHMENT_SIZE_LIMIT_MB} MB`;
}

function parseFiniteNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function preferredPhotoSize(photoSizes) {
  let best = null;
  let bestScore = -1;

  for (const candidate of photoSizes) {
    if (!candidate?.file_id) {
      continue;
    }
    const score =
      parseFiniteNumber(candidate.file_size) ??
      (parseFiniteNumber(candidate.width) ?? 0) * (parseFiniteNumber(candidate.height) ?? 0);

    if (!best || score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

export function attachmentDescriptorFromMessage(message) {
  const bestPhoto = preferredPhotoSize(message?.photo ?? []);
  if (bestPhoto) {
    return {
      kind: "photo",
      telegramFileId: bestPhoto.file_id,
      telegramFileUniqueId: bestPhoto.file_unique_id ?? null,
      fileName: null,
      mimeType: null,
      fileSize: parseFiniteNumber(bestPhoto.file_size),
      sourceMessageId: parseFiniteNumber(message?.message_id),
      mediaGroupId: message?.media_group_id ?? null
    };
  }

  for (const kind of ["document", "video", "audio", "voice", "animation"]) {
    const payload = message?.[kind];
    if (!payload?.file_id) {
      continue;
    }

    return {
      kind,
      telegramFileId: payload.file_id,
      telegramFileUniqueId: payload.file_unique_id ?? null,
      fileName: typeof payload.file_name === "string" ? payload.file_name : null,
      mimeType: typeof payload.mime_type === "string" ? payload.mime_type : null,
      fileSize: parseFiniteNumber(payload.file_size),
      sourceMessageId: parseFiniteNumber(message?.message_id),
      mediaGroupId: message?.media_group_id ?? null
    };
  }

  return null;
}

export function hasSupportedAttachment(message) {
  return Boolean(attachmentDescriptorFromMessage(message));
}

function sanitizeSegment(value, fallback = "attachment") {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : fallback;
}

function sanitizeExtension(value) {
  const extension = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (!extension || extension.length > 16) {
    return "";
  }

  return `.${extension}`;
}

function basenameFromAnyPath(value) {
  return path.posix.basename(String(value ?? "").replace(/\\/g, "/"));
}

function extensionFromName(value) {
  return sanitizeExtension(path.extname(basenameFromAnyPath(value)).replace(/^\./, ""));
}

function stemFromName(value, fallback) {
  const baseName = basenameFromAnyPath(value);
  const extension = path.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  return sanitizeSegment(stem, fallback);
}

function truncateStemForFileName(stem, marker, collisionSuffix, extension) {
  const maxStemLength = Math.max(
    1,
    MAX_ATTACHMENT_FILE_NAME_LENGTH - marker.length - collisionSuffix.length - extension.length
  );
  if (stem.length <= maxStemLength) {
    return stem;
  }

  return stem.slice(0, maxStemLength).replace(/[._-]+$/g, "") || stem.slice(0, maxStemLength);
}

export function buildAttachmentFileName({
  kind,
  fileName,
  filePath,
  sourceMessageId,
  collisionIndex = 1
}) {
  const fallbackStem = sanitizeSegment(kind, "attachment");
  const originalName = typeof fileName === "string" && fileName.trim() ? fileName : "";
  const stem = originalName ? stemFromName(originalName, fallbackStem) : fallbackStem;
  const candidateExtension = extensionFromName(originalName || filePath);
  const defaultExtension = DEFAULT_ATTACHMENT_EXTENSIONS[kind] ?? "";
  const extension = candidateExtension || defaultExtension;
  const messageId = sanitizeSegment(sourceMessageId, "unknown");
  const marker = `--m${messageId}`;
  const normalizedCollisionIndex = Number(collisionIndex);
  const collisionSuffix =
    Number.isSafeInteger(normalizedCollisionIndex) && normalizedCollisionIndex > 1
      ? `-${normalizedCollisionIndex}`
      : "";
  const cappedStem = truncateStemForFileName(stem, marker, collisionSuffix, extension);

  return `${cappedStem}${marker}${collisionSuffix}${extension}`;
}

export function summarizeTurn(turn) {
  if (typeof turn === "string") {
    return truncateText(turn.replace(/\s+/g, " ").trim(), 160);
  }

  const promptPreview = truncateText(String(turn?.promptText ?? "").replace(/\s+/g, " ").trim(), 160);
  const attachments = Array.isArray(turn?.attachments) ? turn.attachments : [];

  if (attachments.length === 0) {
    return promptPreview;
  }

  const prefix = `[${attachments.length} attachment${attachments.length === 1 ? "" : "s"}]`;
  return promptPreview ? `${prefix} ${promptPreview}` : `${prefix} (no caption)`;
}
