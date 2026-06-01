import { DEFAULT_CACHE_PATH, normalizeTelegramUsername, sleep, toErrorMessage } from "../../utils.js";
import { ALBUM_QUIET_PERIOD_MS, hasSupportedAttachment, unsupportedAttachmentMessage } from "./attachments.js";
import { ChatSession, replyTargetFromTelegramMessage } from "./chat-session.js";
import { parseCommand, routeKnownTextCommand } from "./command-router.js";
import { renderGroupInputMessage } from "./group-input.js";
import { MediaGroupBuffer } from "./media-group-buffer.js";
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

function messageText(message) {
  if (typeof message?.text === "string") {
    return message.text;
  }
  if (typeof message?.caption === "string") {
    return message.caption;
  }
  return "";
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

export class BotRuntime {
  constructor({
    botConfig,
    configStore = NOOP_CONFIG_STORE,
    fetchImpl = globalThis.fetch,
    botApi = null,
    createAgentRun = null,
    createCodexRun = null,
    cacheRootDir = DEFAULT_CACHE_PATH,
    albumQuietPeriodMs = ALBUM_QUIET_PERIOD_MS
  }) {
    this.botConfig = botConfig;
    this.configStore = configStore;
    this.botApi = botApi ?? new TelegramBotApi(botConfig.token, fetchImpl);
    this.createAgentRun = createAgentRun ?? createCodexRun;
    this.cacheRootDir = cacheRootDir;
    this.albumQuietPeriodMs = albumQuietPeriodMs;
    this.botUsername = null;
    this.offset = undefined;
    this.polling = false;
    this.pollPromise = null;
    this.pollAbortController = null;
    this.sessions = new Map();
    this.mediaGroupBuffer = new MediaGroupBuffer({ quietPeriodMs: albumQuietPeriodMs });
    this.botDisplayName = "AnyAgent";
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
        createAgentRun: this.createAgentRun
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  hasPendingBotWork() {
    if (this.mediaGroupBuffer.hasPending()) {
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

  async initialize() {
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

  async resetSessions() {
    this.mediaGroupBuffer.clear();
    await Promise.all([...this.sessions.values()].map((session) =>
      resetSession(session, { clearPersistedState: true })
    ));
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
    const session = this.sessionFor(chatId);
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
    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    const groupConversationId = groupLikeConversationId(message);
    if (groupConversationId !== null) {
      await this.handleGroupMessage(message, { conversationId: groupConversationId });
      return;
    }

    if (message.chat?.type === "private") {
      await this.handlePrivateMessage(message);
      return;
    }
  }

  async handlePrivateMessage(message) {
    const chatId = message.chat?.id;
    if (!this.isAuthorized(message.from)) {
      await this.sendDirectMessage(chatId, unauthorizedMessage(message.from));
      return;
    }

    if (isIgnoredServiceMessage(message)) {
      return;
    }

    const session = this.sessionFor(chatId);
    const replyTarget = replyTargetFromTelegramMessage(message);
    if (hasSupportedAttachment(message)) {
      await this.mediaGroupBuffer.queue(session, message);
      return;
    }

    const text = message.text;
    if (typeof text === "string" && text.trim()) {
      const parsedCommand = parseCommand(text, this.botUsername);
      if (parsedCommand?.ignored) {
        await session.sendText(COMMAND_REJECTION_OTHER_BOT, { replyTarget });
        return;
      }
      if (parsedCommand?.commandLike) {
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

      await session.enqueueMessage(text, { replyTarget });
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
      const session = this.sessionFor(chatId, { conversationId });
      await session.sendText(missingTargetMessage(this.botUsername ?? this.botConfig.username), {
        replyTarget
      });
      return;
    }

    const supportedAttachment = hasSupportedAttachment(message);
    if (!text.trim() && !supportedAttachment) {
      return;
    }

    const session = this.sessionFor(chatId, { conversationId });
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

  async start() {
    if (this.polling) {
      return;
    }

    await this.initialize();
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
    if (!this.polling) {
      return;
    }

    this.polling = false;
    this.pollAbortController?.abort();
    this.mediaGroupBuffer.clear();

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
