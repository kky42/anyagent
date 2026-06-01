import { routeCommandOrTurn, routeKnownCommand } from "../common/command-router.js";

function normalizeMattermostUsername(username) {
  return String(username || "").trim().replace(/^@+/, "").toLowerCase();
}

function stripLeadingBotMention(text, botUsername) {
  const trimmed = String(text || "").trim();
  const normalizedBotUsername = normalizeMattermostUsername(botUsername);
  if (!normalizedBotUsername || !trimmed.startsWith("@")) {
    return trimmed;
  }

  const [token] = trimmed.split(/\s+/, 1);
  if (normalizeMattermostUsername(token) !== normalizedBotUsername) {
    return trimmed;
  }
  return trimmed.slice(token.length).trim();
}

export function parseCommand(text, botUsername) {
  const trimmed = stripLeadingBotMention(text, botUsername);
  if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) {
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
  const bot = normalizeMattermostUsername(botUsername);
  const args = rawArgs
    .split(/\s+/)
    .filter((arg) => normalizeMattermostUsername(arg) !== bot)
    .join(" ")
    .trim();
  const hasSelfTarget =
    Boolean(mention) ||
    normalizeMattermostUsername(String(text || "").trim().split(/\s+/, 1)[0]) === bot ||
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
  const normalizedText = stripLeadingBotMention(text, botUsername);
  const parsedCommand = parseCommand(normalizedText, botUsername);
  if (parsedCommand?.ignored) {
    return;
  }

  await routeCommandOrTurn({
    command: parsedCommand?.command,
    args: parsedCommand?.args,
    text: parsedCommand ? normalizedText : text,
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
