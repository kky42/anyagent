import path from "node:path";

import { buildTurnInputMessage } from "../../cli_adapter/turn-input.js";
import {
  DEFAULT_CACHE_PATH,
  formatLocalTimestamp,
  normalizeTelegramUsername,
  sleep,
  toErrorMessage
} from "../../utils.js";
import { ALBUM_QUIET_PERIOD_MS, hasSupportedAttachment, unsupportedAttachmentMessage } from "./attachments.js";
import { ChatSession, replyTargetFromTelegramMessage } from "./chat-session.js";
import { parseCommand, routeKnownTextCommand } from "./command-router.js";
import { renderGroupInputMessage } from "./group-input.js";
import { MediaGroupBuffer } from "./media-group-buffer.js";
import { telegramMessageText } from "./rich-message.js";
import {
  allowedInPrivateForAllowedUser
} from "../common/command-router.js";
import { ConversationStateStore } from "../common/conversation-state.js";
import { appendReferenceContext } from "../common/reference-context.js";
import {
  buildBackgroundNotificationText,
  buildHeartbeatGroupTranscriptMessage,
  buildHeartbeatPrivatePrompt,
  buildScheduleConfirmation,
  buildScheduleListText,
  describeNextSchedule,
  parseScheduleAddArgs,
  parseScheduleMutationArgs,
  scheduleCommandHelp
} from "../common/schedules.js";
import { NOOP_CONFIG_STORE } from "../common/session-persistence.js";
import { TelegramApiError, TelegramBotApi } from "./telegram-api.js";
import { CHAT_COMMANDS } from "../common/render.js";
import { resetSession } from "../common/session-reset.js";

export const TELEGRAM_COMMANDS = CHAT_COMMANDS;

function unauthorizedMessage(user) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return `You are not authorized to use this bot. Your Telegram username is @${username}. Add "${username}" to allowedUsernames in this Telegram binding.`;
  }

  return "You are not authorized to use this bot. Your Telegram account has no username set. Add one in Telegram Settings, then add it to allowedUsernames in this Telegram binding.";
}

const COMMAND_REJECTION_UNAUTHORIZED = "Only manager users can run AnyAgent commands.";
const COMMAND_REJECTION_OTHER_BOT = "That command targets another bot.";
const UNKNOWN_COMMAND_MESSAGE = "Unknown command.";

function missingTargetMessage(botUsername) {
  const suffix = botUsername ? `@${botUsername}` : "@this_bot";
  return `Group commands must mention this bot, for example /status ${suffix}.`;
}

function inlineValue(value) {
  return String(value ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
}

function markdownKeyValues(rows) {
  return rows.map(([key, value]) => `- **${key}:** ${inlineValue(value)}`).join("\n");
}

function buildTelegramScheduleHelpMarkdown(commandName = "/schedule") {
  return [
    "# Schedule Commands",
    "",
    "- List schedules:",
    `  - \`${commandName} list\``,
    "- Add heartbeat:",
    `  - \`${commandName} add heartbeat <name>\``,
    "  - next line: `<cron>`",
    "  - remaining lines: `<prompt>`",
    "- Add background:",
    `  - \`${commandName} add background <name>\``,
    "  - next line: `<cron>`",
    "  - remaining lines: `<prompt>`",
    "- Single-line add:",
    `  - \`${commandName} add background <name> <5 cron fields> <prompt>\``,
    "- Manage:",
    `  - \`${commandName} remove <name>\``,
    `  - \`${commandName} enable <name>\``,
    `  - \`${commandName} disable <name>\``
  ].join("\n");
}

function buildTelegramScheduleListMarkdown(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    return "No schedules.";
  }

  const blocks = [...schedules]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((schedule) => {
      const status = schedule.enabled === false ? "disabled" : "enabled";
      let next = "disabled";
      if (schedule.enabled !== false) {
        try {
          next = formatLocalTimestamp(Math.floor(describeNextSchedule(schedule).getTime() / 1000));
        } catch {
          next = "invalid cron";
        }
      }
      return [
        `- **${inlineValue(schedule.name)}** (${inlineValue(schedule.mode)}, ${status})`,
        `  - cron: \`${inlineValue(schedule.cron)}\``,
        `  - next: ${inlineValue(next)}`
      ].join("\n");
    });

  return ["# Schedules", "", blocks.join("\n")].join("\n");
}

function buildTelegramScheduleConfirmationMarkdown(action, schedule) {
  const rows = [];
  if (schedule.mode) {
    rows.push(["mode", schedule.mode]);
  }
  if (schedule.cron) {
    rows.push(["cron", schedule.cron]);
  }
  return [
    `**${action} schedule \"${schedule.name}\".**`,
    rows.length ? "" : null,
    rows.length ? markdownKeyValues(rows) : null
  ].filter(Boolean).join("\n");
}

async function sendRichOrText(session, markdown, fallbackText, options = {}) {
  if (typeof session.sendRichText === "function") {
    await session.sendRichText(markdown, { ...options, fallbackText });
    return;
  }
  await session.sendText(fallbackText, options);
}

const IGNORED_SERVICE_MESSAGE_FIELDS = [
  "forum_topic_created",
  "forum_topic_closed",
  "forum_topic_reopened",
  "forum_topic_edited",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden"
];

function isIgnoredServiceMessage(message) {
  return IGNORED_SERVICE_MESSAGE_FIELDS.some((field) => message?.[field]);
}

// Telegram auto-sends a `/start` message when a user first opens a private chat
// with the bot (clicks the "Start" button). It is a Telegram-only convention and
// is not one of our commands, so ignore it silently instead of replying "Unknown command.".
function isTelegramStartCommand(message) {
  return messageText(message).trim().toLowerCase() === "/start";
}

function messageText(message) {
  return telegramMessageText(message);
}

function privateConversationId(message) {
  const chatId = message?.chat?.id;
  const directTopicId = message?.direct_messages_topic?.topic_id;
  if (chatId !== null && chatId !== undefined && directTopicId !== null && directTopicId !== undefined) {
    return `${chatId}:direct:${directTopicId}`;
  }
  return chatId;
}

function groupLikeConversationId(message) {
  const chatType = message?.chat?.type;
  if (chatType === "group" || chatType === "supergroup") {
    const topicId = message?.message_thread_id;
    return topicId === null || topicId === undefined
      ? String(message.chat.id)
      : `${message.chat.id}:topic:${topicId}`;
  }

  if (chatType === "private") {
    const title = typeof message?.chat?.title === "string" ? message.chat.title.trim() : "";
    if (title) {
      const topicId =
        message?.direct_messages_topic?.topic_id ??
        message?.message_thread_id;
      return topicId === null || topicId === undefined
        ? String(message.chat.id)
        : `${message.chat.id}:topic:${topicId}`;
    }
  }

  return null;
}

function deliveryAnchorFromTelegramMessage(message) {
  const chatId = message?.chat?.id;
  if (chatId === null || chatId === undefined) {
    return null;
  }
  return {
    chatId,
    replyTarget: replyTargetFromTelegramMessage(message)
  };
}

export class BotRuntime {
  constructor({
    botConfig,
    configStore = NOOP_CONFIG_STORE,
    fetchImpl = globalThis.fetch,
    botApi = null,
    createAgentRun = null,
    createCodexRun = null,
    cacheRootDir = DEFAULT_CACHE_PATH,
    stateRootDir = null,
    albumQuietPeriodMs = ALBUM_QUIET_PERIOD_MS,
    operationLocks = null
  }) {
    this.botConfig = botConfig;
    this.configStore = configStore;
    this.botApi = botApi ?? new TelegramBotApi(botConfig.token, fetchImpl);
    this.createAgentRun = createAgentRun ?? createCodexRun;
    this.cacheRootDir = cacheRootDir;
    this.stateStore = new ConversationStateStore({
      rootDir: stateRootDir || path.join(path.dirname(cacheRootDir), "state")
    });
    this.albumQuietPeriodMs = albumQuietPeriodMs;
    this.botUsername = null;
    this.offset = undefined;
    this.polling = false;
    this.retiring = false;
    this.pollPromise = null;
    this.pollAbortController = null;
    this.sessions = new Map();
    this.mediaGroupBuffer = new MediaGroupBuffer({ quietPeriodMs: albumQuietPeriodMs });
    this.scheduleTimers = new Map();
    this.activeBackgroundRuns = new Set();
    this.botDisplayName = "AnyAgent";
    this.operationLocks = operationLocks;
  }

  log(message) {
    process.stderr.write(`[telegram:@${this.botConfig.username}] ${message}\n`);
  }

  sessionFor(chatId, options = {}) {
    const conversationId = options.conversationId ?? chatId;
    const key = String(conversationId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new ChatSession({
        botConfig: this.botConfig,
        botApi: this.botApi,
        configStore: this.configStore,
        logger: (message) => this.log(`${key}: ${message}`),
        chatId,
        conversationId,
        cacheRootDir: this.cacheRootDir,
        stateStore: this.stateStore,
        deliveryAnchor: options.deliveryAnchor ?? null,
        createAgentRun: this.createAgentRun
      });
      this.sessions.set(key, session);
    } else if (options.deliveryAnchor) {
      void session.updateDeliveryAnchor(options.deliveryAnchor).catch((error) => {
        this.log(`${key}: failed to persist delivery anchor: ${toErrorMessage(error)}`);
      });
    }
    return session;
  }

  scheduleKey(conversationId, scheduleName) {
    return `${conversationId}::${scheduleName}`;
  }

  clearConversationScheduleTimers(conversationId) {
    const prefix = `${conversationId}::`;
    for (const [key, timer] of this.scheduleTimers.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      clearTimeout(timer);
      this.scheduleTimers.delete(key);
    }
  }

  syncScheduleTimer(session, schedule) {
    const key = this.scheduleKey(session.conversationId, schedule.name);
    const existingTimer = this.scheduleTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.scheduleTimers.delete(key);
    }

    if (schedule.enabled === false) {
      return;
    }

    try {
      const next = describeNextSchedule(schedule);
      const delayMs = Math.max(0, next.getTime() - Date.now());
      const timer = setTimeout(() => {
        void this.handleScheduledOccurrence(session.conversationId, schedule.name, timer);
      }, delayMs);
      timer.unref?.();
      this.scheduleTimers.set(key, timer);
    } catch (error) {
      this.log(
        `invalid scheduled cron for ${session.conversationId}/${schedule.name}: ${toErrorMessage(error)}`
      );
    }
  }

  syncConversationSchedules(session) {
    this.clearConversationScheduleTimers(session.conversationId);

    for (const schedule of session.schedules) {
      this.syncScheduleTimer(session, schedule);
    }
  }

  async restoreScheduledConversations() {
    const records = await this.stateStore.loadBindingRecords(
      {
        agentId: this.botConfig.agent.id,
        platform: "telegram",
        bindingId: this.botConfig.username
      },
      {
        onError: (error, details) => {
          this.log(`failed to load conversation state from ${details.stateJsonPath}: ${toErrorMessage(error)}`);
        }
      }
    );

    for (const { scope, record } of records) {
      if (!Array.isArray(record.schedules) || record.schedules.length === 0) {
        continue;
      }

      const chatId = record.deliveryAnchor?.chatId;
      if (chatId === null || chatId === undefined) {
        this.log(`skipping scheduled restore for ${scope.conversationId}: missing delivery anchor`);
        continue;
      }

      const session = this.sessionFor(chatId, {
        conversationId: scope.conversationId,
        deliveryAnchor: record.deliveryAnchor
      });
      this.syncConversationSchedules(session);
    }
  }

  async buildPrivateReferenceText(session, message) {
    const referenceMessage = message?.reply_to_message;
    if (!referenceMessage || typeof referenceMessage !== "object") {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromMessage(referenceMessage);
    return buildTurnInputMessage({
      promptText: messageText(referenceMessage).trim(),
      attachments
    }).trim();
  }

  async buildGroupReferenceText(session, message) {
    const referenceMessage = message?.reply_to_message;
    if (!referenceMessage || typeof referenceMessage !== "object") {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromMessage(referenceMessage);
    return renderGroupInputMessage(referenceMessage, attachments);
  }

  async runHeartbeatSchedule(session, schedule, now = new Date()) {
    const deliveryAnchor = session.deliveryAnchor ?? { chatId: session.chatId, replyTarget: null };
    const isGroupConversation = Number(deliveryAnchor?.chatId) < 0;

    if (isGroupConversation) {
      await session.enqueueTurn({
        mode: "group",
        groupInput: {
          messages: [buildHeartbeatGroupTranscriptMessage(schedule.name, schedule.prompt, now)]
        },
        groupIdentity: this.groupIdentity(),
        replyTarget: deliveryAnchor?.replyTarget ?? null,
        scheduleName: schedule.name,
        suppressQueueNotice: true
      });
      return;
    }

    await session.enqueueTurn({
      promptText: buildHeartbeatPrivatePrompt(schedule.name, schedule.prompt),
      replyTarget: deliveryAnchor?.replyTarget ?? null,
      scheduleName: schedule.name,
      suppressQueueNotice: true
    });
  }

  async runBackgroundSchedule(session, schedule, now = new Date()) {
    const deliveryAnchor = session.deliveryAnchor ?? { chatId: session.chatId, replyTarget: null };
    const cliAdapter = session.cliAdapter;
    const triggeredAt = formatLocalTimestamp(Math.floor(now.getTime() / 1000));
    const messageParts = [];
    let failureText = null;

    this.log(`background run starting: ${schedule.name} in ${session.conversationId}`);

    const run = session.createAgentRun({
      cli: session.cli,
      workdir: session.workdir,
      sessionId: null,
      message: schedule.prompt,
      autoMode: session.auto,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      developerInstructions: await session.buildFreshAdditionalSystemPrompt(null),
      onEvent: async (event) => {
        const actions = cliAdapter.eventToActions(event);
        for (const action of actions) {
          if (action.kind === "message") {
            if (String(action.text ?? "").trim()) {
              messageParts.push(String(action.text));
            }
            continue;
          }
          if (action.kind === "error" && !failureText) {
            failureText = action.text;
          }
        }
      },
      onStdErr: (chunk) => {
        const stderrText = String(chunk ?? "").trim();
        if (stderrText) {
          session.logger(`${cliAdapter.id} background stderr: ${stderrText}`);
        }
      }
    });
    this.activeBackgroundRuns.add(run);
    let resolveBackgroundDone;
    run.backgroundDone = new Promise((resolve) => {
      resolveBackgroundDone = resolve;
    });

    try {
      const result = await run.done;
      if (result.aborted) {
        failureText = `Background run was aborted before completion.`;
        this.log(`background run aborted: ${schedule.name} in ${session.conversationId}`);
      } else if (!failureText && !result.sawTerminalEvent) {
        failureText = `${cliAdapter.displayName} exited without a terminal JSON event.`;
      }
    } catch (error) {
      failureText = `${cliAdapter.displayName} process error: ${toErrorMessage(error)}`;
      this.log(`background run error: ${schedule.name} in ${session.conversationId}: ${failureText}`);
    }

    try {
      if (run.suppressBackgroundNotification) {
        this.log(`background run notification suppressed: ${schedule.name} in ${session.conversationId}`);
        return;
      }

      await session.sendText(
        buildBackgroundNotificationText({
          scheduleName: schedule.name,
          triggeredAt,
          failed: Boolean(failureText),
          body: failureText ?? messageParts.join("\n\n")
        }),
        {
          replyTarget: deliveryAnchor?.replyTarget ?? null
        }
      );

      this.log(`background run finished: ${schedule.name} in ${session.conversationId} (failed=${Boolean(failureText)})`);
    } finally {
      this.activeBackgroundRuns.delete(run);
      resolveBackgroundDone();
    }
  }

  async handleScheduledOccurrence(conversationId, scheduleName, expectedTimer = null) {
    await this.waitForAgentOperation();
    if (!this.isActive()) {
      this.log(`schedule skipped (runtime stopped): ${scheduleName} in ${conversationId}`);
      return;
    }
    const scheduleTimerKey = this.scheduleKey(conversationId, scheduleName);
    if (expectedTimer && this.scheduleTimers.get(scheduleTimerKey) !== expectedTimer) {
      this.log(`schedule skipped (timer superseded): ${scheduleName} in ${conversationId}`);
      return;
    }
    this.log(`schedule triggered: ${scheduleName} in ${conversationId}`);

    const session = this.sessions.get(String(conversationId));
    if (!session) {
      this.log(`schedule skipped (no session): ${scheduleName} in ${conversationId}`);
      return;
    }

    this.scheduleTimers.delete(scheduleTimerKey);
    const schedule = session.schedules.find((candidate) => candidate.name === scheduleName);
    if (!schedule) {
      this.log(`schedule skipped (not found): ${scheduleName} in ${conversationId}`);
      return;
    }
    if (schedule.enabled === false) {
      this.log(`schedule skipped (disabled): ${scheduleName} in ${conversationId}`);
      return;
    }

    try {
      if (schedule.mode === "background") {
        await this.runBackgroundSchedule(session, schedule);
      } else {
        await this.runHeartbeatSchedule(session, schedule);
      }
    } catch (error) {
      this.log(`scheduled run "${scheduleName}" failed in ${conversationId}: ${toErrorMessage(error)}`);
    } finally {
      const nextSchedule = session.schedules.find((candidate) => candidate.name === scheduleName);
      if (nextSchedule) {
        this.syncScheduleTimer(session, nextSchedule);
      }
    }
  }

  async handleScheduleCommand(session, args, options = {}) {
    const trimmedArgs = String(args ?? "").trim();
    if (!trimmedArgs) {
      await sendRichOrText(
        session,
        buildTelegramScheduleHelpMarkdown("/schedule"),
        scheduleCommandHelp("/schedule"),
        options
      );
      return;
    }

    const action = trimmedArgs.split(/\s+/, 1)[0]?.toLowerCase();
    const schedules = session.schedules;

    try {
      if (action === "list") {
        await sendRichOrText(
          session,
          buildTelegramScheduleListMarkdown(schedules),
          buildScheduleListText(schedules),
          options
        );
        return;
      }

      if (action === "add") {
        const schedule = parseScheduleAddArgs(trimmedArgs);
        if (schedules.some((candidate) => candidate.name === schedule.name)) {
          throw new Error(`Schedule "${schedule.name}" already exists.`);
        }
        await session.replaceSchedules([...schedules, { ...schedule, enabled: true }]);
        this.syncConversationSchedules(session);
        await sendRichOrText(
          session,
          buildTelegramScheduleConfirmationMarkdown("Added", schedule),
          buildScheduleConfirmation("Added", schedule),
          options
        );
        return;
      }

      if (action === "remove") {
        const name = parseScheduleMutationArgs(trimmedArgs, "remove");
        const schedule = schedules.find((candidate) => candidate.name === name);
        if (!schedule) {
          throw new Error(`Schedule "${name}" does not exist.`);
        }
        await session.replaceSchedules(schedules.filter((candidate) => candidate.name !== name));
        session.removeQueuedScheduledTurns(name);
        this.syncConversationSchedules(session);
        await sendRichOrText(
          session,
          buildTelegramScheduleConfirmationMarkdown("Removed", schedule),
          buildScheduleConfirmation("Removed", schedule),
          options
        );
        return;
      }

      if (action === "enable" || action === "disable") {
        const name = parseScheduleMutationArgs(trimmedArgs, action);
        const schedule = schedules.find((candidate) => candidate.name === name);
        if (!schedule) {
          throw new Error(`Schedule "${name}" does not exist.`);
        }
        const enabled = action === "enable";
        const nextSchedules = schedules.map((candidate) =>
          candidate.name === name ? { ...candidate, enabled } : candidate
        );
        await session.replaceSchedules(nextSchedules);
        if (!enabled) {
          session.removeQueuedScheduledTurns(name);
        }
        this.syncConversationSchedules(session);
        await sendRichOrText(
          session,
          buildTelegramScheduleConfirmationMarkdown(enabled ? "Enabled" : "Disabled", {
            ...schedule,
            enabled
          }),
          buildScheduleConfirmation(enabled ? "Enabled" : "Disabled", {
            ...schedule,
            enabled
          }),
          options
        );
        return;
      }

      await sendRichOrText(
        session,
        buildTelegramScheduleHelpMarkdown("/schedule"),
        scheduleCommandHelp("/schedule"),
        options
      );
    } catch (error) {
      await session.sendText(toErrorMessage(error), options);
    }
  }

  hasPendingBotWork() {
    if (this.mediaGroupBuffer.hasPending()) {
      return true;
    }

    if (this.activeBackgroundRuns.size > 0) {
      return true;
    }

    for (const session of this.sessions.values()) {
      if (session.isRunning || session.queue.length > 0) {
        return true;
      }
    }

    return false;
  }

  isAuthorized(user) {
    const username = normalizeTelegramUsername(user?.username);
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : [];
    return Boolean(
      username &&
      (this.botConfig.allowedUsernames.includes(username) || managerUsernames.includes(username))
    );
  }

  isManager(user) {
    const username = normalizeTelegramUsername(user?.username);
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : this.botConfig.allowedUsernames;
    return Boolean(username && managerUsernames.includes(username));
  }

  async initialize({ restoreScheduledConversations = true } = {}) {
    const me = await this.botApi.getMe();
    this.botUsername = normalizeTelegramUsername(me.username);
    this.botDisplayName = String(me.first_name ?? me.username ?? "AnyAgent").trim() || "AnyAgent";
    if (this.botUsername !== this.botConfig.username) {
      throw new Error(
        `Configured Telegram bot username @${this.botConfig.username} does not match token owner @${this.botUsername || "unknown"}.`
      );
    }
    await this.discardPendingUpdates();
    await this.botApi.setMyCommands(TELEGRAM_COMMANDS);
    if (restoreScheduledConversations) {
      await this.restoreScheduledConversations();
    }
    this.log(
      `ready as @${this.botUsername} for agent ${this.botConfig.agent.id} with workdir ${this.botConfig.agent.workdir}`
    );
  }

  groupIdentity() {
    const botUsername = this.botUsername || this.botConfig.username;
    return {
      botName: this.botDisplayName,
      botHandle: botUsername ? `@${botUsername}` : "@unknown"
    };
  }

  async waitForAgentOperation() {
    await this.operationLocks?.wait(this.botConfig.agent.id);
  }

  isActive() {
    return !this.retiring;
  }

  requestStop() {
    this.retiring = true;
    if (this.polling) {
      this.polling = false;
      this.pollAbortController?.abort();
    }
    this.mediaGroupBuffer.clear();
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
  }

  async abortBackgroundRuns({ suppressNotification = false } = {}) {
    const backgroundRuns = [...this.activeBackgroundRuns];
    for (const run of backgroundRuns) {
      if (suppressNotification) {
        run.suppressBackgroundNotification = true;
      }
      run.abort?.();
    }
    await Promise.allSettled(
      backgroundRuns.map((run) => (run.backgroundDone ?? run.done).catch(() => null))
    );
    return backgroundRuns.length;
  }

  async resetSessions() {
    this.mediaGroupBuffer.clear();
    await Promise.all([...this.sessions.values()].map((session) =>
      resetSession(session, { clearSessionState: true })
    ));
  }

  async handleConversationReset(session, options = {}) {
    const reset = async () => {
      const result = await session.handleReset(options);
      if (result?.ok) {
        this.syncConversationSchedules(session);
      }
      return result;
    };
    if (this.operationLocks) {
      return this.operationLocks.runExclusive(this.botConfig.agent.id, reset);
    }
    return reset();
  }

  async discardPendingUpdates() {
    const updates = await this.botApi.getUpdates({
      offset: -1,
      limit: 1,
      timeout: 0
    });
    const lastUpdate = updates.at(-1);
    if (typeof lastUpdate?.update_id === "number") {
      this.offset = lastUpdate.update_id + 1;
    }
  }

  async sendDirectMessage(chatId, text) {
    const session = this.sessionFor(chatId, {
      deliveryAnchor: {
        chatId,
        replyTarget: null
      }
    });
    await session.sendText(text);
  }

  async handleClearCache(sessionOrChatId, options = {}) {
    const session =
      sessionOrChatId instanceof ChatSession
        ? sessionOrChatId
        : this.sessionFor(sessionOrChatId);
    if (this.hasPendingBotWork()) {
      await session.sendText(
        "Cannot clear cache while runs, queued turns, or media albums are pending.",
        options
      );
      return;
    }

    try {
      await session.clearCache();
    } catch (error) {
      await session.sendText(`Failed to clear cache: ${toErrorMessage(error)}`, options);
      return;
    }

    await session.sendText("Cleared cache for this chat.", options);
  }

  async handleMessage(message) {
    await this.waitForAgentOperation();
    if (!this.isActive()) {
      return;
    }
    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    if (message.chat?.type === "private") {
      await this.handlePrivateMessage(message);
      return;
    }

    const groupConversationId = groupLikeConversationId(message);
    if (groupConversationId !== null) {
      await this.handleGroupMessage(message, { conversationId: groupConversationId });
      return;
    }
  }

  async handlePrivateMessage(message) {
    const chatId = message.chat?.id;
    const replyTarget = replyTargetFromTelegramMessage(message);

    if (!this.isAuthorized(message.from)) {
      const session = this.sessionFor(chatId, {
        conversationId: privateConversationId(message),
        deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
      });
      await session.sendText(unauthorizedMessage(message.from), { replyTarget });
      return;
    }

    if (isIgnoredServiceMessage(message)) {
      return;
    }

    if (isTelegramStartCommand(message)) {
      return;
    }

    const groupConversationId = groupLikeConversationId(message);
    if (groupConversationId !== null) {
      await this.handleGroupMessage(message, { conversationId: groupConversationId });
      return;
    }

    const session = this.sessionFor(chatId, {
      conversationId: privateConversationId(message),
      deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
    });
    const text = messageText(message);
    if (text.trim()) {
      const parsedCommand = parseCommand(text, this.botUsername);
      if (parsedCommand?.ignored) {
        await session.sendText(COMMAND_REJECTION_OTHER_BOT, { replyTarget });
        return;
      }
      if (parsedCommand?.commandLike) {
        if (
          !this.isManager(message.from) &&
          !allowedInPrivateForAllowedUser(parsedCommand.command)
        ) {
          await session.sendText(COMMAND_REJECTION_UNAUTHORIZED, { replyTarget });
          return;
        }
        const routed = await routeKnownTextCommand({
          parsedCommand,
          session,
          runtime: this,
          replyTarget
        });
        if (!routed) {
          await session.sendText(UNKNOWN_COMMAND_MESSAGE, { replyTarget });
        }
        return;
      }
    }

    const supportedAttachment = hasSupportedAttachment(message);
    if (supportedAttachment) {
      await this.mediaGroupBuffer.queue(session, message, async (messages) => {
        const primaryMessage = messages.find((candidate) => messageText(candidate).trim()) ?? messages[0];
        const referenceText = await this.buildPrivateReferenceText(session, primaryMessage);
        await session.handleAttachmentMessages(messages, { referenceText });
      });
      return;
    }

    if (text.trim()) {
      await session.enqueueMessage(
        appendReferenceContext(text, await this.buildPrivateReferenceText(session, message)),
        { replyTarget }
      );
      return;
    }

    await session.sendText(unsupportedAttachmentMessage(), { replyTarget });
  }

  async handleGroupMessage(message, { conversationId = message.chat?.id } = {}) {
    const chatId = message.chat?.id;
    if (isIgnoredServiceMessage(message)) {
      return;
    }

    const text = messageText(message);
    const parsedCommand = parseCommand(text, this.botUsername ?? this.botConfig.username);
    if (parsedCommand?.ignored) {
      return;
    }
    const isCommandLike = Boolean(parsedCommand?.commandLike);
    const replyTarget = replyTargetFromTelegramMessage(message);
    if (isCommandLike && parsedCommand.target === "none") {
      const session = this.sessionFor(chatId, {
        conversationId,
        deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
      });
      await session.sendText(missingTargetMessage(this.botUsername ?? this.botConfig.username), {
        replyTarget
      });
      return;
    }

    const supportedAttachment = hasSupportedAttachment(message);
    if (!text.trim() && !supportedAttachment) {
      return;
    }

    const session = this.sessionFor(chatId, {
      conversationId,
      deliveryAnchor: deliveryAnchorFromTelegramMessage(message)
    });
    if (isCommandLike) {
      if (!this.isManager(message.from)) {
        await session.sendText(COMMAND_REJECTION_UNAUTHORIZED, { replyTarget });
        return;
      }
      const routed = await routeKnownTextCommand({
        parsedCommand,
        session,
        runtime: this,
        replyTarget
      });
      if (!routed) {
        await session.sendText(UNKNOWN_COMMAND_MESSAGE, { replyTarget });
      }
      return;
    }

    if (supportedAttachment) {
      await this.mediaGroupBuffer.queue(session, message, (messages) =>
        this.handleGroupTriggerMessages({ session, messages, triggerMessage: message })
      );
      return;
    }

    await this.handleGroupTriggerMessages({
      session,
      triggerMessage: message,
      messages: [message]
    });
  }

  async handleGroupTriggerMessages({ session, messages, triggerMessage = null }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    const primaryMessage = messages.find((message) => messageText(message).trim()) ?? triggerMessage ?? messages[0];
    const renderedMessages = [];

    const mediaGroupId = messages[0]?.media_group_id;
    const isSingleMediaGroup =
      messages.length > 1 &&
      mediaGroupId &&
      messages.every((message) => message?.media_group_id === mediaGroupId);

    if (isSingleMediaGroup) {
      const attachments = [];
      for (const message of messages) {
        attachments.push(...await session.stageInputAttachmentsFromMessage(message));
      }
      renderedMessages.push(renderGroupInputMessage(primaryMessage, attachments));
    } else {
      for (const message of messages) {
        const attachments = await session.stageInputAttachmentsFromMessage(message);
        renderedMessages.push(renderGroupInputMessage(message, attachments));
      }
    }

    const referenceText = await this.buildGroupReferenceText(session, primaryMessage);
    if (referenceText && renderedMessages.length > 0) {
      renderedMessages[renderedMessages.length - 1] = appendReferenceContext(
        renderedMessages[renderedMessages.length - 1],
        referenceText
      );
    }

    await session.enqueueTurn({
      mode: "group",
      groupInput: {
        messages: renderedMessages
      },
      mergeKey: "group",
      groupIdentity: this.groupIdentity(),
      replyTarget: replyTargetFromTelegramMessage(primaryMessage)
    });
  }

  async handleUpdate(update) {
    if (typeof update.update_id === "number") {
      this.offset = update.update_id + 1;
    }
    if (update.message) {
      await this.handleMessage(update.message);
    }
  }

  async start({ restoreScheduledConversations = true } = {}) {
    if (this.polling) {
      return;
    }

    this.retiring = false;
    await this.initialize({ restoreScheduledConversations });
    this.polling = true;
    this.pollAbortController = new AbortController();

    this.pollPromise = (async () => {
      while (this.polling) {
        try {
          const updates = await this.botApi.getUpdates(
            {
              offset: this.offset,
              timeout: 50
            },
            {
              signal: this.pollAbortController.signal
            }
          );

          for (const update of updates) {
            await this.handleUpdate(update);
          }
        } catch (error) {
          if (!this.polling) {
            break;
          }

          if (error instanceof TelegramApiError) {
            this.log(`telegram polling error: ${error.message}`);
          } else {
            this.log(`polling failure: ${toErrorMessage(error)}`);
          }
          await sleep(2000);
        }
      }
    })();
  }

  async stop() {
    this.requestStop();

    await this.abortBackgroundRuns({ suppressNotification: true });

    for (const session of this.sessions.values()) {
      session.queue = [];
      session.stopTyping();
      await session.abortCurrentRun();
    }

    if (this.pollPromise) {
      await this.pollPromise;
    }
  }
}
