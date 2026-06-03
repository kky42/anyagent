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
  const tokens = header.split(/\s+/).filter(Boolean);
  const [subcommand, mode, rawName, ...headerRest] = tokens;

  if (subcommand !== "add") {
    throw new Error("Use \"schedule add <heartbeat|background> <name>\".");
  }
  if (!SCHEDULE_MODES.has(mode)) {
    throw new Error("Schedule mode must be \"heartbeat\" or \"background\".");
  }
  const name = validateScheduleName(rawName);

  let cron;
  let prompt;

  if (headerRest.length >= 5) {
    // Single-line format: the next 5 tokens form the cron expression,
    // and everything after is the prompt.
    cron = headerRest.slice(0, 5).join(" ");
    prompt = headerRest.slice(5).join(" ").trim();
    if (lines.length > 0) {
      const extraPrompt = lines.join("\n").trim();
      if (extraPrompt) {
        prompt = prompt ? `${prompt}\n${extraPrompt}` : extraPrompt;
      }
    }
  } else if (headerRest.length === 0) {
    // Multi-line format: cron on the next line, prompt on remaining lines.
    cron = String(lines.shift() ?? "").trim();
    if (!cron) {
      throw new Error("Schedule cron is required on the second line.");
    }
    prompt = lines.join("\n").trim();
  } else {
    throw new Error(
      "Schedule name cannot contain spaces. " +
      "Put the cron expression on the next line, or provide all 5 cron fields after the name on the same line followed by the prompt."
    );
  }

  parseCronExpression(cron);
  if (!prompt) {
    throw new Error("Schedule prompt is required after the cron expression.");
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
    "List:",
    `  ${commandName} list`,
    "",
    "Add heartbeat:",
    `  ${commandName} add heartbeat <name>`,
    "  <cron>",
    "  <prompt>",
    "",
    "Add background:",
    `  ${commandName} add background <name>`,
    "  <cron>",
    "  <prompt>",
    "",
    "Single-line add:",
    `  ${commandName} add background <name> <5 cron fields> <prompt>`,
    "",
    "Manage:",
    `  ${commandName} remove <name>`,
    `  ${commandName} enable <name>`,
    `  ${commandName} disable <name>`
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
