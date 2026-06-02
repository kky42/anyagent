import { formatAuto } from "../../auto-mode.js";
import { formatLocalTimestamp } from "../../utils.js";
import { summarizeTurn } from "./attachments.js";
import { nextCronOccurrence, parseCronExpression } from "./cron.js";

export const CHAT_COMMANDS = [
  { command: "status", description: "Show current agent status" },
  { command: "cli", description: "Show or change the agent CLI for this chat" },
  { command: "workdir", description: "Show or change the bot workdir" },
  { command: "auto", description: "Set agent automation level for this chat" },
  { command: "model", description: "Set model for future runs" },
  { command: "reasoning", description: "Set reasoning effort for future runs" },
  { command: "clear_cache", description: "Clear cached attachments for this chat" },
  { command: "abort", description: "Abort current run and clear queued messages" },
  { command: "new", description: "Start a fresh session and clear context" },
  { command: "schedule", description: "List or manage scheduled runs for this chat" },
  { command: "reset", description: "Reload config defaults for this chat" }
];

export function summarizeQueue(queue) {
  if (queue.length === 0) {
    return "empty";
  }

  return queue.map((turn, index) => `${index + 1}. ${summarizeTurn(turn)}`).join("\n");
}

export function renderStatusMessage({
  isRunning,
  cli,
  workdir,
  auto,
  model,
  reasoningEffort,
  usage,
  queue,
  schedules = []
}) {
  const enabledSchedules = schedules.filter((schedule) => schedule.enabled !== false);
  const disabledSchedules = schedules.filter((schedule) => schedule.enabled === false);
  let nextScheduleLine = "n/a";
  if (enabledSchedules.length > 0) {
    const nextSchedule = enabledSchedules
      .map((schedule) => {
        try {
          return {
            ...schedule,
            next: nextCronOccurrence(parseCronExpression(schedule.cron))
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.next.getTime() - right.next.getTime())[0];
    if (nextSchedule) {
      nextScheduleLine = `${nextSchedule.mode} ${nextSchedule.name} at ${formatLocalTimestamp(
        Math.floor(nextSchedule.next.getTime() / 1000)
      )}`;
    }
  }

  const lines = [
    `running: ${isRunning ? "yes" : "no"}`,
    `cli: ${cli}`,
    `workdir: ${workdir}`,
    `auto: ${formatAuto(auto)}`,
    `model: ${model}`,
    `reasoning_effort: ${reasoningEffort}`,
    `context_length: ${usage.contextLength}`,
    `schedules: ${enabledSchedules.length} enabled, ${disabledSchedules.length} disabled`,
    `next_schedule: ${nextScheduleLine}`,
    "queue:",
    summarizeQueue(queue)
  ];

  return lines.join("\n");
}
