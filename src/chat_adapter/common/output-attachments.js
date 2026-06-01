export const GROUP_MESSAGE_TAG_OPEN = "<group_message";
export const GROUP_MESSAGE_TAG_CLOSE = "</group_message>";
export const LEGACY_ATTACHMENTS_BLOCK_OPEN = "<attachments>";
export const LEGACY_ATTACHMENTS_BLOCK_CLOSE = "</attachments>";
export const GROUP_REPLY_MARKER = "REPLY";
export const GROUP_NO_REPLY_MARKER = "NO_REPLY";
export const GROUP_ATTACHMENT_DIRECTIVE = "ATTACH";

export const SUPPORTED_OUTBOUND_ATTACHMENT_KINDS = [
  "photo",
  "document",
  "video",
  "audio",
  "voice",
  "animation"
];

const ATTACHMENT_TAG_PATTERN = /^<attachment\b([^<>]*?)\/>/;
const GROUP_MESSAGE_OPEN_PATTERN = /^<group_message\b([^<>]*)>/;
const ATTRIBUTE_PATTERN = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function decodeXmlAttribute(text) {
  const named = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"]
  ]);

  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body) => {
    const key = String(body ?? "").toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      } catch {
        return entity;
      }
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      } catch {
        return entity;
      }
    }
    return named.get(key) ?? entity;
  });
}

function parseXmlAttributes(rawAttributes) {
  const attributes = {};
  const raw = String(rawAttributes ?? "");
  let cursor = 0;

  while (cursor < raw.length) {
    if (!raw.slice(cursor).trim()) {
      return attributes;
    }

    ATTRIBUTE_PATTERN.lastIndex = cursor;
    const match = ATTRIBUTE_PATTERN.exec(raw);
    if (!match) {
      return null;
    }

    attributes[match[1]] = decodeXmlAttribute(match[2] ?? match[3] ?? "");
    cursor = ATTRIBUTE_PATTERN.lastIndex;
  }

  return attributes;
}

function normalizeAttachmentKind(rawKind) {
  if (!rawKind) {
    return null;
  }

  const normalizedKind = rawKind.toLowerCase();
  return SUPPORTED_OUTBOUND_ATTACHMENT_KINDS.includes(normalizedKind) ? normalizedKind : null;
}

function inferAttachmentKindFromPath(filePath) {
  const extension = String(filePath ?? "")
    .split(/[?#]/, 1)[0]
    .match(/\.([A-Za-z0-9]+)$/)?.[1]
    ?.toLowerCase();

  if (["jpg", "jpeg", "png", "webp", "bmp", "heic", "heif"].includes(extension)) {
    return "photo";
  }
  if (["gif"].includes(extension)) {
    return "animation";
  }
  if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(extension)) {
    return "video";
  }
  if (["mp3", "m4a", "wav", "flac", "aac", "oga"].includes(extension)) {
    return "audio";
  }
  if (["ogg", "opus"].includes(extension)) {
    return "voice";
  }

  return "document";
}

function normalizePathOnlyOutboundEntry(filePath) {
  const normalizedPath = normalizeOptionalString(normalizeAttachmentDirectivePath(filePath));
  if (!normalizedPath) {
    return {
      path: null,
      kind: null,
      rawKind: null,
      error: "path is required"
    };
  }

  return {
    path: normalizedPath,
    kind: inferAttachmentKindFromPath(normalizedPath),
    rawKind: null,
    error: null
  };
}

function normalizeAttachmentDirectivePath(filePath) {
  let normalizedPath = String(filePath ?? "").trim();
  const quote = normalizedPath[0];
  if (
    (quote === '"' || quote === "'") &&
    normalizedPath.endsWith(quote) &&
    normalizedPath.length >= 2
  ) {
    normalizedPath = normalizedPath.slice(1, -1);
  }

  return normalizedPath.replace(/\\([\\\s"'()])/g, "$1");
}

function normalizeOutboundEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      path: null,
      kind: null,
      rawKind: null,
      fileName: null,
      error: "entry must be an object"
    };
  }

  const filePath = normalizeOptionalString(entry.path);
  const rawKind = normalizeOptionalString(entry.kind);
  const normalizedKind = normalizeAttachmentKind(rawKind);

  if (!filePath) {
    return {
      path: null,
      kind: normalizedKind,
      rawKind,
      error: "path is required"
    };
  }

  if (!rawKind) {
    return {
      path: filePath,
      kind: null,
      rawKind,
      error: "kind is required"
    };
  }

  if (rawKind && !normalizedKind) {
    return {
      path: filePath,
      kind: null,
      rawKind,
      error: `unsupported kind "${rawKind}"`
    };
  }

  return {
    path: filePath,
    kind: normalizedKind,
    rawKind,
    error: null
  };
}

function parseAttachmentTag(rawText, startIndex) {
  const match = ATTACHMENT_TAG_PATTERN.exec(rawText.slice(startIndex));
  if (!match) {
    return null;
  }

  const attributes = parseXmlAttributes(match[1]);
  if (!attributes) {
    return null;
  }

  return {
    segment: {
      kind: "attachment",
      rawText: match[0],
      entries: [normalizeOutboundEntry(attributes)]
    },
    endIndex: startIndex + match[0].length
  };
}

function stripSingleOuterNewline(text) {
  return String(text ?? "").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function decodeXmlText(text) {
  return decodeXmlAttribute(text);
}

function parseGroupMessage(rawText, startIndex) {
  const openMatch = GROUP_MESSAGE_OPEN_PATTERN.exec(rawText.slice(startIndex));
  if (!openMatch || openMatch[1].trim()) {
    return null;
  }

  const bodyStart = startIndex + openMatch[0].length;
  const closeStart = rawText.indexOf(GROUP_MESSAGE_TAG_CLOSE, bodyStart);
  if (closeStart < 0) {
    return null;
  }

  const body = rawText.slice(bodyStart, closeStart);
  const trimmedBody = body.trim();
  let messageText;
  if (trimmedBody.startsWith("<![CDATA[") && trimmedBody.endsWith("]]>")) {
    messageText = stripSingleOuterNewline(trimmedBody.slice("<![CDATA[".length, -"]]>".length));
  } else {
    messageText = stripSingleOuterNewline(decodeXmlText(body));
  }

  return {
    segment: {
      kind: "group_message",
      rawText: rawText.slice(startIndex, closeStart + GROUP_MESSAGE_TAG_CLOSE.length),
      text: messageText
    },
    endIndex: closeStart + GROUP_MESSAGE_TAG_CLOSE.length
  };
}

function isBlankLine(line) {
  return !String(line ?? "").trim();
}

function trimOuterBlankLines(lines) {
  const normalized = Array.isArray(lines) ? [...lines] : [];

  while (normalized.length > 0 && isBlankLine(normalized[0])) {
    normalized.shift();
  }
  while (normalized.length > 0 && isBlankLine(normalized[normalized.length - 1])) {
    normalized.pop();
  }

  return normalized;
}

function parseAttachmentDirectiveLine(line) {
  const normalized = String(line ?? "").trim();
  if (normalized !== GROUP_ATTACHMENT_DIRECTIVE && !normalized.startsWith(`${GROUP_ATTACHMENT_DIRECTIVE} `)) {
    return null;
  }

  const remainder = normalized.slice(GROUP_ATTACHMENT_DIRECTIVE.length).trim();
  return {
    kind: "attachment",
    rawText: normalized,
    entries: [normalizePathOnlyOutboundEntry(remainder)]
  };
}

function textWithMention(text, mention) {
  const rawText = String(text ?? "");
  const normalizedMention = normalizeOptionalString(mention);
  if (!normalizedMention) {
    return rawText;
  }

  const trimmedStart = rawText.trimStart();
  if (
    trimmedStart.startsWith(`${normalizedMention} `) ||
    trimmedStart.startsWith(`${normalizedMention}\n`)
  ) {
    return rawText;
  }

  return `${normalizedMention} ${rawText}`;
}

function parseGroupReplyHeader(line) {
  const normalized = String(line ?? "").trim();
  if (!normalized) {
    return null;
  }

  if (normalized === GROUP_NO_REPLY_MARKER) {
    return { kind: "no_reply" };
  }

  if (normalized === GROUP_REPLY_MARKER) {
    return { kind: "reply", mention: null };
  }

  if (!normalized.startsWith(`${GROUP_REPLY_MARKER} `)) {
    return null;
  }

  const rest = normalized.slice(GROUP_REPLY_MARKER.length).trim();
  if (!rest.startsWith("@")) {
    return null;
  }

  const mention = rest.split(/\s+/, 1)[0];
  return {
    kind: "reply",
    mention
  };
}

function parseGroupReplySegments(rawText) {
  const lines = String(rawText ?? "").split(/\r?\n/);
  const segments = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const header = parseGroupReplyHeader(lines[cursor]);
    if (!header) {
      cursor += 1;
      continue;
    }

    if (header.kind === "no_reply") {
      return [];
    }

    cursor += 1;
    const bodyLines = [];
    while (cursor < lines.length) {
      if (parseGroupReplyHeader(lines[cursor])) {
        break;
      }

      bodyLines.push(lines[cursor]);
      cursor += 1;
    }

    const trimmedBodyLines = trimOuterBlankLines(bodyLines);
    if (trimmedBodyLines.length === 0) {
      continue;
    }

    let textLines = [];
    let attachmentsStarted = false;
    const flushTextLines = () => {
      textLines = trimOuterBlankLines(textLines);
      if (textLines.length === 0) {
        return;
      }

      const text = textLines.join("\n");
      segments.push({
        kind: "group_message",
        text: textWithMention(text, header.mention),
        mention: header.mention
      });
      textLines = [];
    };

    for (const line of trimmedBodyLines) {
      const attachmentDirective = parseAttachmentDirectiveLine(line);
      if (attachmentDirective) {
        flushTextLines();
        segments.push(attachmentDirective);
        attachmentsStarted = true;
        continue;
      }

      if (attachmentsStarted) {
        continue;
      }

      textLines.push(line);
    }

    flushTextLines();
  }

  return segments;
}

function hasLegacyGroupControls(rawText) {
  return /<group_message\b|<attachment\b|<attachments>/i.test(String(rawText ?? ""));
}

function pushTextSegment(segments, text) {
  if (!text) {
    return;
  }

  const parts = String(text).split(/(\r?\n)/);
  let textBuffer = "";

  const flushTextBuffer = () => {
    if (!textBuffer) {
      return;
    }
    segments.push({
      kind: "text",
      text: textBuffer
    });
    textBuffer = "";
  };

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const newline = parts[index + 1] ?? "";
    const attachmentDirective = parseAttachmentDirectiveLine(line);
    if (attachmentDirective) {
      flushTextBuffer();
      segments.push(attachmentDirective);
      continue;
    }
    textBuffer += `${line}${newline}`;
  }

  flushTextBuffer();
}

function findNextControlStart(rawText, cursor) {
  const attachmentStart = rawText.slice(cursor).search(/<attachment\b/);
  const groupMessageStart = rawText.indexOf(GROUP_MESSAGE_TAG_OPEN, cursor);
  const legacyStart = rawText.indexOf(LEGACY_ATTACHMENTS_BLOCK_OPEN, cursor);
  const candidates = [];

  if (attachmentStart >= 0) {
    candidates.push({ index: cursor + attachmentStart, kind: "attachment" });
  }
  if (groupMessageStart >= 0) {
    candidates.push({ index: groupMessageStart, kind: "group_message" });
  }
  if (legacyStart >= 0) {
    candidates.push({ index: legacyStart, kind: "legacy_attachments" });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => a.index - b.index);
  return candidates[0];
}

export function parseOutputSegments(text) {
  const rawText = String(text ?? "");
  const segments = [];
  let cursor = 0;

  while (cursor < rawText.length) {
    const nextControl = findNextControlStart(rawText, cursor);
    if (!nextControl) {
      pushTextSegment(segments, rawText.slice(cursor));
      break;
    }

    pushTextSegment(segments, rawText.slice(cursor, nextControl.index));

    if (nextControl.kind === "legacy_attachments") {
      const blockClose = rawText.indexOf(
        LEGACY_ATTACHMENTS_BLOCK_CLOSE,
        nextControl.index + LEGACY_ATTACHMENTS_BLOCK_OPEN.length
      );
      if (blockClose < 0) {
        pushTextSegment(segments, rawText.slice(nextControl.index));
        break;
      }
      const blockEnd = blockClose + LEGACY_ATTACHMENTS_BLOCK_CLOSE.length;
      pushTextSegment(segments, rawText.slice(nextControl.index, blockEnd));
      cursor = blockEnd;
      continue;
    }

    const parsed =
      nextControl.kind === "attachment"
        ? parseAttachmentTag(rawText, nextControl.index)
        : parseGroupMessage(rawText, nextControl.index);

    if (parsed) {
      segments.push(parsed.segment);
      cursor = parsed.endIndex;
    } else {
      pushTextSegment(segments, rawText.slice(nextControl.index, nextControl.index + 1));
      cursor = nextControl.index + 1;
    }
  }

  return segments;
}

export function parseGroupOutputSegments(text) {
  const rawText = String(text ?? "");
  if (hasLegacyGroupControls(rawText)) {
    return parseOutputSegments(text);
  }

  return parseGroupReplySegments(rawText);
}

export function parseGroupMessageBodySegments(text) {
  return parseOutputSegments(text).map((segment) => {
    if (segment.kind === "group_message") {
      return {
        kind: "text",
        text: segment.rawText
      };
    }
    return segment;
  });
}

export function parseOutput(text) {
  const segments = parseOutputSegments(text);

  return {
    text: segments
      .filter((segment) => segment.kind === "text")
      .map((segment) => segment.text)
      .join(""),
    attachments: segments
      .filter((segment) => segment.kind === "attachment")
      .flatMap((segment) =>
        segment.entries.filter((entry) => !entry.error).map((entry) => ({
          path: entry.path,
          kind: entry.kind
        }))
      ),
    groupMessages: segments
      .filter((segment) => segment.kind === "group_message")
      .map((segment) => segment.text)
  };
}
