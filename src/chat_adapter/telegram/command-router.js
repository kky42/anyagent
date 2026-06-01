import { normalizeTelegramUsername } from "../../utils.js";
import { routeCommandOrTurn, routeKnownCommand } from "../common/command-router.js";

function commandTargetFromArgs(args, botUsername) {
  const bot = normalizeTelegramUsername(botUsername);
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  let otherUsername = null;
  for (const token of tokens) {
    if (!token.startsWith("@")) {
      continue;
    }
    const username = normalizeTelegramUsername(token);
    if (!username) {
      continue;
    }
    if (username === bot) {
      return {
        target: "self",
        username
      };
    }
    otherUsername ??= username;
  }
  if (otherUsername) {
    return {
      target: "other",
      username: otherUsername
    };
  }
  return {
    target: "none",
    username: null
  };
}

function stripTargetFromArgs(args, targetUsername) {
  if (!targetUsername) {
    return String(args ?? "").trim();
  }
  return String(args ?? "")
    .trim()
    .split(/\s+/)
    .filter((token) => normalizeTelegramUsername(token) !== targetUsername)
    .join(" ")
    .trim();
}

export function parseCommand(text, botUsername, options = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [token] = trimmed.split(/\s+/, 1);
  const [commandName, mention] = token.slice(1).split("@");
  if (mention && normalizeTelegramUsername(mention) !== normalizeTelegramUsername(botUsername)) {
    return {
      command: commandName.toLowerCase(),
      args: trimmed.slice(token.length).trim(),
      commandLike: true,
      target: "other",
      ignored: true
    };
  }

  const rawArgs = trimmed.slice(token.length).trim();
  const argTarget = commandTargetFromArgs(rawArgs, botUsername);
  const target = mention ? "self" : argTarget.target;
  const targetUsername = mention ? normalizeTelegramUsername(mention) : argTarget.username;
  const args = options.stripTarget === false
    ? rawArgs
    : stripTargetFromArgs(rawArgs, targetUsername);

  return {
    command: commandName.toLowerCase(),
    args,
    commandLike: true,
    target,
    ignored: target === "other"
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
