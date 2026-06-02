import { formatLocalTimestamp } from "../../utils.js";
import { delayUntilCronOccurrence, nextCronOccurrence, parseCronExpression } from "./cron.js";

export const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SCHEDULE_MODES = new Set(["heartbeat", "background"]);

export function validateScheduleName(name) {
  const normalized = String(name ?? "").trim();
  if (!normalized || !SCHEDULE_NAME_PATTERN.test(normalized)) {
    throw new Error("Schedule name must contain only letters, numbers, \"_\", or \"-\".");
  }
  return normalized;
}

export function parseScheduleAddArgs(args) {
  const text = String(args ?? "").trim();
  const lines = text.split(/\r?\n/);
  const header = String(lines.shift() ?? "").trim();
  const [subcommand, mode, rawName, ...rest] = header.split(/\s+/).filter(Boolean);

  if (subcommand !== "add") {
    throw new Error("Use \"schedule add <heartbeat|background> <name>\".");
  }
  if (!SCHEDULE_MODES.has(mode)) {
    throw new Error("Schedule mode must be \"heartbeat\" or \"background\".");
  }
  const name = validateScheduleName(rawName);
  const cron = String(lines.shift() ?? "").trim();
  if (!cron) {
    throw new Error("Schedule cron is required on the second line.");
  }
  parseCronExpression(cron);
  const prompt = lines.join("\n").trim();
  if (!prompt) {
    throw new Error("Schedule prompt is required after the cron line.");
  }

  if (rest.length > 0) {
    throw new Error("Schedule name cannot contain spaces.");
  }

  return {
    mode,
    name,
    cron,
    prompt
  };
}

export function parseScheduleMutationArgs(args, action) {
  const text = String(args ?? "").trim();
  const [subcommand, rawName, ...rest] = text.split(/\s+/).filter(Boolean);
  if (subcommand !== action) {
    throw new Error(`Use "schedule ${action} <name>".`);
  }
  if (rest.length > 0) {
    throw new Error(`Schedule ${action} takes exactly one schedule name.`);
  }
  return validateScheduleName(rawName);
}

export function scheduleCommandHelp(commandName = "schedule") {
  return [
    "Schedule commands:",
    `- ${commandName} list`,
    `- ${commandName} add heartbeat <name>`,
    "  <cron>",
    "  <prompt>",
    `- ${commandName} add background <name>`,
    "  <cron>",
    "  <prompt>",
    `- ${commandName} remove <name>`,
    `- ${commandName} enable <name>`,
    `- ${commandName} disable <name>`
  ].join("\n");
}

export function buildScheduleListText(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    return "No schedules.";
  }

  const sorted = [...schedules].sort((left, right) => left.name.localeCompare(right.name));
  return sorted
    .map((schedule) => {
      const status = schedule.enabled === false ? "disabled" : "enabled";
      let next = "disabled";
      if (schedule.enabled !== false) {
        try {
          const nextDate = nextCronOccurrence(parseCronExpression(schedule.cron));
          next = formatLocalTimestamp(Math.floor(nextDate.getTime() / 1000));
        } catch {
          next = "invalid cron";
        }
      }
      return [
        `${status}  ${schedule.mode}  ${schedule.name}`,
        `cron: ${schedule.cron}`,
        `next: ${next}`
      ].join("\n");
    })
    .join("\n\n");
}

export function buildScheduleConfirmation(action, schedule) {
  const lines = [`${action} schedule "${schedule.name}".`];
  if (schedule.mode) {
    lines.push(`mode: ${schedule.mode}`);
  }
  if (schedule.cron) {
    lines.push(`cron: ${schedule.cron}`);
  }
  return lines.join("\n");
}

export function buildHeartbeatPrivatePrompt(scheduleName, prompt) {
  return `Heartbeat scheduled turn: ${scheduleName}\n\n${String(prompt ?? "").trim()}`.trim();
}

export function buildHeartbeatGroupTranscriptMessage(scheduleName, prompt, now = new Date()) {
  return [
    `[${formatLocalTimestamp(Math.floor(now.getTime() / 1000))}] Scheduler (no handle):`,
    `Heartbeat scheduled turn: ${scheduleName}`,
    "",
    String(prompt ?? "").trim()
  ].join("\n");
}

export function buildBackgroundNotificationText({
  scheduleName,
  triggeredAt,
  failed = false,
  body
}) {
  const header = failed
    ? `Background scheduled run failed: ${scheduleName}`
    : `Background scheduled run: ${scheduleName}`;
  const normalizedBody = String(body ?? "").trim() || "(no final response)";
  return [header, `Triggered: ${triggeredAt}`, "", normalizedBody].join("\n");
}

export function describeNextSchedule(schedule, now = new Date()) {
  const { next } = delayUntilCronOccurrence(parseCronExpression(schedule.cron), now);
  return next;
}
