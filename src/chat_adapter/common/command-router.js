export const PRIVATE_ALLOWED_USER_COMMANDS = new Set(["status", "new", "schedule"]);

export function allowedInPrivateForAllowedUser(command) {
  return PRIVATE_ALLOWED_USER_COMMANDS.has(String(command ?? "").trim().toLowerCase());
}

export async function routeCommandOrTurn({
  command,
  args = "",
  text = "",
  session,
  runtime,
  replyTarget = null
}) {
  switch (command) {
    case "status":
      await session.handleStatus({ replyTarget });
      return;
    case "auto":
      await session.handleAuto(args, { replyTarget });
      return;
    case "workdir":
      await session.handleWorkdir(args, { replyTarget });
      return;
    case "cli":
      await session.handleCli(args, { replyTarget });
      return;
    case "model":
      await session.handleModel(args, { replyTarget });
      return;
    case "reasoning":
      await session.handleReasoningEffort(args, { replyTarget });
      return;
    case "clear_cache":
      await runtime.handleClearCache(session, { replyTarget });
      return;
    case "abort":
      await session.handleAbort({ replyTarget });
      return;
    case "new":
      await session.handleNewSession({ replyTarget });
      return;
    case "schedule":
      await runtime.handleScheduleCommand(session, args, { replyTarget });
      return;
    case "reset":
      await session.handleReset({ replyTarget });
      return;
    default:
      if (command) {
        await session.sendText("Unknown command.", { replyTarget });
        return;
      }
      await session.enqueueMessage(text, { replyTarget });
  }
}

export async function routeKnownCommand({
  command,
  args = "",
  session,
  runtime,
  replyTarget = null
}) {
  switch (command) {
    case "status":
      await session.handleStatus({ replyTarget });
      return true;
    case "auto":
      await session.handleAuto(args, { replyTarget });
      return true;
    case "workdir":
      await session.handleWorkdir(args, { replyTarget });
      return true;
    case "cli":
      await session.handleCli(args, { replyTarget });
      return true;
    case "model":
      await session.handleModel(args, { replyTarget });
      return true;
    case "reasoning":
      await session.handleReasoningEffort(args, { replyTarget });
      return true;
    case "clear_cache":
      await runtime.handleClearCache(session, { replyTarget });
      return true;
    case "abort":
      await session.handleAbort({ replyTarget });
      return true;
    case "new":
      await session.handleNewSession({ replyTarget });
      return true;
    case "schedule":
      await runtime.handleScheduleCommand(session, args, { replyTarget });
      return true;
    case "reset":
      await session.handleReset({ replyTarget });
      return true;
    default:
      return false;
  }
}
