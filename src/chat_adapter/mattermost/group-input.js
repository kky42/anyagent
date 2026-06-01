import { formatInputAttachment } from "../../cli_adapter/turn-input.js";
import { formatLocalTimestamp } from "../../utils.js";

function parseFiniteNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function parseMattermostTimestamp(value) {
  const normalized = parseFiniteNumber(value);
  if (!normalized || normalized <= 0) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(normalized / 1000);
}

function postTimestamp(post) {
  return parseMattermostTimestamp(post?.create_at);
}

function postText(post) {
  return String(post?.message ?? "");
}

export function mattermostUserDisplayName(user, fallback = "unknown") {
  const nickname = String(user?.nickname ?? "").trim();
  if (nickname) {
    return nickname;
  }

  const name = [user?.first_name, user?.last_name]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .trim();
  if (name) {
    return name;
  }

  const username = String(user?.username ?? "").trim();
  if (username) {
    return username;
  }

  return fallback;
}

function userDisplayName(post) {
  const name = mattermostUserDisplayName(post?.user, "");
  if (name) {
    return name;
  }

  const webhookName = String(post?.props?.from_webhook ?? "").trim();
  return webhookName || "unknown";
}

function userHandle(post) {
  const username = String(post?.user?.username ?? post?.props?.from_webhook ?? "").trim();
  return username ? `@${username.replace(/^@+/, "")}` : "no handle";
}

function transcriptUserLabel(post) {
  return `${userDisplayName(post)} (${userHandle(post)})`;
}

export function renderGroupInputPost(post, attachments = []) {
  const lines = [`[${formatLocalTimestamp(postTimestamp(post))}] ${transcriptUserLabel(post)}:`];
  const text = postText(post).trim();
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
