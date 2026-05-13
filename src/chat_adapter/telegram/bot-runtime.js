import { cliAdapterFor } from "../../cli_adapter/index.js";
import { DEFAULT_CACHE_PATH, normalizeTelegramUsername, sleep, toErrorMessage } from "../../utils.js";
import { ALBUM_QUIET_PERIOD_MS, hasSupportedAttachment, unsupportedAttachmentMessage } from "./attachments.js";
import { ChatSession } from "./chat-session.js";
import { routeTextMessage } from "./command-router.js";
import { MediaGroupBuffer } from "./media-group-buffer.js";
import { NOOP_CONFIG_STORE } from "./session-persistence.js";
import { TelegramApiError, TelegramBotApi } from "./telegram-api.js";

export const TELEGRAM_COMMANDS = [
  { command: "status", description: "Show current agent status" },
  { command: "workdir", description: "Show or change the bot workdir" },
  { command: "auto", description: "Set agent automation level for this chat" },
  { command: "model", description: "Set model for future runs" },
  { command: "reasoning", description: "Set reasoning effort for future runs" },
  { command: "clear_cache", description: "Clear cached attachments for this bot" },
  { command: "abort", description: "Abort current run and clear queued messages" },
  { command: "new", description: "Start a fresh session and clear context" },
  { command: "reset", description: "Reload config defaults for this chat" }
];

function unauthorizedMessage(user) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return `You are not authorized to use this bot. Your Telegram username is @${username}. Add "${username}" to allowedUsernames in this Telegram binding.`;
  }

  return "You are not authorized to use this bot. Your Telegram account has no username set. Add one in Telegram Settings, then add it to allowedUsernames in this Telegram binding.";
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
    this.createAgentRun =
      createAgentRun ?? createCodexRun ?? ((params) => cliAdapterFor(this.botConfig.agent?.cli).startRun(params));
    this.cacheRootDir = cacheRootDir;
    this.albumQuietPeriodMs = albumQuietPeriodMs;
    this.botUsername = null;
    this.offset = undefined;
    this.polling = false;
    this.pollPromise = null;
    this.pollAbortController = null;
    this.sessions = new Map();
    this.mediaGroupBuffer = new MediaGroupBuffer({ quietPeriodMs: albumQuietPeriodMs });
  }

  log(message) {
    process.stderr.write(`[telegram:@${this.botConfig.username}] ${message}\n`);
  }

  sessionFor(chatId) {
    const key = String(chatId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new ChatSession({
        botConfig: this.botConfig,
        botApi: this.botApi,
        configStore: this.configStore,
        logger: (message) => this.log(`${chatId}: ${message}`),
        chatId,
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
    return Boolean(username && this.botConfig.allowedUsernames.includes(username));
  }

  async initialize() {
    const me = await this.botApi.getMe();
    this.botUsername = normalizeTelegramUsername(me.username);
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

  async handleClearCache(chatId) {
    const session = this.sessionFor(chatId);
    if (this.hasPendingBotWork()) {
      await session.sendText("Cannot clear cache while runs, queued turns, or media albums are pending.");
      return;
    }

    try {
      await session.clearCache();
    } catch (error) {
      await session.sendText(`Failed to clear cache: ${toErrorMessage(error)}`);
      return;
    }

    await session.sendText(`Cleared cache for @${this.botConfig.username}.`);
  }

  async handleMessage(message) {
    const chatId = message.chat?.id;
    if (!chatId) {
      return;
    }

    if (message.chat?.type !== "private") {
      await this.sendDirectMessage(chatId, "This bot only supports private chats.");
      return;
    }

    if (!this.isAuthorized(message.from)) {
      await this.sendDirectMessage(chatId, unauthorizedMessage(message.from));
      return;
    }

    const session = this.sessionFor(chatId);
    if (hasSupportedAttachment(message)) {
      await this.mediaGroupBuffer.queue(session, message);
      return;
    }

    const text = message.text;
    if (typeof text === "string" && text.trim()) {
      await routeTextMessage({
        text,
        botUsername: this.botUsername,
        session,
        runtime: this
      });
      return;
    }

    await session.sendText(unsupportedAttachmentMessage());
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
