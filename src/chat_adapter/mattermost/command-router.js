import { routeCommandOrTurn, routeKnownCommand } from "../common/command-router.js";

function normalizeMattermostUsername(username) {
  return String(username || "").trim().replace(/^@+/, "").toLowerCase();
}

function isCommandText(text) {
  return String(text || "").startsWith("/") || String(text || "").startsWith("!");
}

function firstToken(text) {
  const trimmed = String(text || "").trim();
  const [token = ""] = trimmed.split(/\s+/, 1);
  return {
    token,
    rest: trimmed.slice(token.length).trim()
  };
}

function targetForUsername(username, botUsername, botDisplayName = "") {
  const normalizedUsername = normalizeMattermostUsername(username);
  if (!normalizedUsername) {
    return null;
  }
  const normalizedBotUsername = normalizeMattermostUsername(botUsername);
  const normalizedBotDisplayName = normalizeMattermostUsername(botDisplayName);
  const isSelf = Boolean(
    normalizedBotUsername &&
    (normalizedUsername === normalizedBotUsername ||
      (normalizedBotDisplayName && normalizedUsername === normalizedBotDisplayName))
  );
  return {
    target: isSelf ? "self" : "other",
    username: normalizedUsername
  };
}

function leadingMentionTarget(text, botUsername, botDisplayName) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("@")) {
    return null;
  }

  const { token, rest } = firstToken(trimmed);
  const target = targetForUsername(token, botUsername, botDisplayName);
  if (!target) {
    return null;
  }

  return {
    ...target,
    text: rest
  };
}

function firstArgTarget(args, botUsername, botDisplayName) {
  const { token, rest } = firstToken(args);
  if (!token.startsWith("@")) {
    return null;
  }

  const target = targetForUsername(token, botUsername, botDisplayName);
  return target ? { ...target, args: rest } : null;
}

export function parseCommand(text, botUsername, botDisplayName = "") {
  const originalText = String(text || "").trim();
  const leadingTarget = leadingMentionTarget(originalText, botUsername, botDisplayName);
  const trimmed =
    leadingTarget?.target === "self" || isCommandText(leadingTarget?.text)
      ? leadingTarget.text
      : originalText;
  if (!isCommandText(trimmed)) {
    return null;
  }

  const { token, rest: rawArgs } = firstToken(trimmed);
  const [commandName, mention] = token.slice(1).split("@");
  if (mention) {
    const target = targetForUsername(mention, botUsername, botDisplayName);
    return {
      command: commandName.toLowerCase(),
      args: rawArgs,
      commandLike: true,
      target: target?.target ?? "other",
      ignored: target?.target !== "self"
    };
  }

  if (leadingTarget) {
    return {
      command: commandName.toLowerCase(),
      args: rawArgs,
      commandLike: true,
      target: leadingTarget.target,
      ignored: leadingTarget.target !== "self"
    };
  }

  const argTarget = firstArgTarget(rawArgs, botUsername, botDisplayName);
  const target = argTarget?.target ?? "none";
  const args = argTarget ? argTarget.args : rawArgs;

  return {
    command: commandName.toLowerCase(),
    args,
    commandLike: true,
    target,
    ignored: target === "other"
  };
}

export async function routeTextMessage({ text, botUsername, botDisplayName = "", session, runtime, replyTarget = null }) {
  const parsedCommand = parseCommand(text, botUsername, botDisplayName);
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
