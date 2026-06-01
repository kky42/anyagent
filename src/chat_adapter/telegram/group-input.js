import { formatInputAttachment } from "../../cli_adapter/turn-input.js";
import { formatLocalTimestamp, normalizeTelegramUsername } from "../../utils.js";

function parseFiniteNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function messageTimestamp(message) {
  return parseFiniteNumber(message?.date) ?? Math.floor(Date.now() / 1000);
}

function messageText(message) {
  if (typeof message?.text === "string") {
    return message.text;
  }
  if (typeof message?.caption === "string") {
    return message.caption;
  }
  return "";
}

function userDisplayName(user) {
  const name = [user?.first_name, user?.last_name]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .trim();
  if (name) {
    return name;
  }

  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return username;
  }

  return "unknown";
}

function userHandle(user) {
  const username = normalizeTelegramUsername(user?.username);
  return username ? `@${username}` : "no handle";
}

function transcriptUserLabel(user) {
  return `${userDisplayName(user)} (${userHandle(user)})`;
}

export function renderGroupInputMessage(message, attachments = []) {
  const lines = [`[${formatLocalTimestamp(messageTimestamp(message))}] ${transcriptUserLabel(message?.from)}:`];
  const text = messageText(message).trim();
  if (text) {
    lines.push(text);
  } else if (attachments.length === 0) {
    lines.push("(no text)");
  }

  for (const attachment of attachments) {
    lines.push("");
    lines.push(formatInputAttachment(attachment));
  }

  return lines.join("\n");
}
