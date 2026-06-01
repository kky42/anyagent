import { routeCommandOrTurn, routeKnownCommand } from "../common/command-router.js";

function normalizeMattermostUsername(username) {
  return String(username || "").trim().replace(/^@+/, "").toLowerCase();
}

function isCommandText(text) {
  return String(text || "").startsWith("/") || String(text || "").startsWith("!");
}

function leadingMentionTarget(text, botUsername) {
  const trimmed = String(text || "").trim();
  const normalizedBotUsername = normalizeMattermostUsername(botUsername);
  if (!trimmed.startsWith("@")) {
    return null;
  }

  const [token] = trimmed.split(/\s+/, 1);
  const username = normalizeMattermostUsername(token);
  if (!username) {
    return null;
  }

  return {
    target: normalizedBotUsername && username === normalizedBotUsername ? "self" : "other",
    username,
    text: trimmed.slice(token.length).trim()
  };
}

export function parseCommand(text, botUsername) {
  const originalText = String(text || "").trim();
  const leadingTarget = leadingMentionTarget(originalText, botUsername);
  const trimmed =
    leadingTarget?.target === "self" || isCommandText(leadingTarget?.text)
      ? leadingTarget.text
      : originalText;
  if (!isCommandText(trimmed)) {
    return null;
  }

  const [token] = trimmed.split(/\s+/, 1);
  const [commandName, mention] = token.slice(1).split("@");
  if (mention && normalizeMattermostUsername(mention) !== normalizeMattermostUsername(botUsername)) {
    return {
      command: commandName.toLowerCase(),
      args: trimmed.slice(token.length).trim(),
      commandLike: true,
      target: "other",
      ignored: true
    };
  }

  const rawArgs = trimmed.slice(token.length).trim();
  if (leadingTarget?.target === "other") {
    return {
      command: commandName.toLowerCase(),
      args: rawArgs,
      commandLike: true,
      target: "other",
      ignored: true
    };
  }

  const bot = normalizeMattermostUsername(botUsername);
  const args = rawArgs
    .split(/\s+/)
    .filter((arg) => normalizeMattermostUsername(arg) !== bot)
    .join(" ")
    .trim();
  const hasSelfTarget =
    Boolean(mention) ||
    leadingTarget?.target === "self" ||
    rawArgs.split(/\s+/).some((arg) => normalizeMattermostUsername(arg) === bot);
  const hasOtherTarget =
    !hasSelfTarget &&
    rawArgs.split(/\s+/).some((arg) => {
      const username = normalizeMattermostUsername(arg);
      return username && arg.startsWith("@") && username !== bot;
    });

  return {
    command: commandName.toLowerCase(),
    args,
    commandLike: true,
    target: hasSelfTarget ? "self" : hasOtherTarget ? "other" : "none",
    ignored: hasOtherTarget
  };
}

export async function routeTextMessage({ text, botUsername, session, runtime, replyTarget = null }) {
  const parsedCommand = parseCommand(text, botUsername);
  if (parsedCommand?.ignored) {
    return;
  }

  await routeCommandOrTurn({
    command: parsedCommand?.command,
    args: parsedCommand?.args,
    text,
    session,
    runtime,
    replyTarget
  });
}

export async function routeKnownTextCommand({
  parsedCommand,
  session,
  runtime,
  replyTarget = null
}) {
  if (!parsedCommand?.command || parsedCommand.ignored) {
    return false;
  }

  return routeKnownCommand({
    command: parsedCommand.command,
    args: parsedCommand.args,
    session,
    runtime,
    replyTarget
  });
}
