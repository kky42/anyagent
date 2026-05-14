import { normalizeTelegramUsername } from "../../utils.js";

export function parseCommand(text, botUsername) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [token] = trimmed.split(/\s+/, 1);
  const [commandName, mention] = token.slice(1).split("@");
  if (mention && normalizeTelegramUsername(mention) !== normalizeTelegramUsername(botUsername)) {
    return { ignored: true };
  }

  return {
    command: commandName.toLowerCase(),
    args: trimmed.slice(token.length).trim()
  };
}

export async function routeTextMessage({ text, botUsername, session, runtime, replyTarget = null }) {
  const parsedCommand = parseCommand(text, botUsername);
  if (parsedCommand?.ignored) {
    return;
  }

  switch (parsedCommand?.command) {
    case "status":
      await session.handleStatus({ replyTarget });
      return;
    case "auto":
      await session.handleAuto(parsedCommand.args, { replyTarget });
      return;
    case "workdir":
      await session.handleWorkdir(parsedCommand.args, { replyTarget });
      return;
    case "cli":
      await session.handleCli(parsedCommand.args, { replyTarget });
      return;
    case "model":
      await session.handleModel(parsedCommand.args, { replyTarget });
      return;
    case "reasoning":
      await session.handleReasoningEffort(parsedCommand.args, { replyTarget });
      return;
    case "clear_cache":
      await runtime.handleClearCache(session.chatId, { replyTarget });
      return;
    case "abort":
      await session.handleAbort({ replyTarget });
      return;
    case "new":
      await session.handleNewSession({ replyTarget });
      return;
    case "reset":
      await session.handleReset({ replyTarget });
      return;
    default:
      await session.enqueueMessage(text, { replyTarget });
  }
}
