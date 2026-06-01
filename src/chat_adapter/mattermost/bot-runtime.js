import { DEFAULT_CACHE_PATH, sleep, toErrorMessage } from "../../utils.js";
import { NOOP_CONFIG_STORE } from "../common/session-persistence.js";
import { resetSession } from "../common/session-reset.js";
import { ChatSession, replyTargetFromMattermostPost } from "./chat-session.js";
import { MattermostApi, postFromWebSocketEvent } from "./mattermost-api.js";
import { mattermostUserDisplayName, renderGroupInputPost } from "./group-input.js";
import { hasSupportedAttachment } from "./attachments.js";
import { parseCommand, routeKnownTextCommand } from "./command-router.js";
import { CHAT_COMMANDS } from "../common/render.js";

export const MATTERMOST_COMMANDS = CHAT_COMMANDS;
const DEFAULT_RECONNECT_DELAY_MS = 2000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 30000;
const DEFAULT_STALE_WEBSOCKET_MS = 5 * 60 * 1000;

function unauthorizedMessage(user) {
  const username = String(user?.username ?? "").trim();
  if (username) {
    return `You are not authorized to use this bot. Your Mattermost username is @${username}. Add "${username}" to allowedUsernames in this Mattermost binding.`;
  }
  return "You are not authorized to use this bot. Add your Mattermost username to allowedUsernames in this Mattermost binding.";
}

const COMMAND_REJECTION_UNAUTHORIZED = "Only manager users can run AnyAgent commands.";
const COMMAND_REJECTION_OTHER_BOT = "That command targets another bot.";
const UNKNOWN_COMMAND_MESSAGE = "Unknown command.";

function missingTargetMessage(botUsername) {
  const suffix = botUsername ? `@${botUsername}` : "@this_bot";
  return `Group commands must mention this bot, for example !status ${suffix}.`;
}

function isBotPost(post, botUserId) {
  return String(post?.user_id ?? "") === String(botUserId ?? "");
}

function isDeletedPost(post) {
  return Boolean(post?.delete_at && Number(post.delete_at) > 0);
}

function normalizedPostText(post) {
  return String(post?.message ?? "");
}

function channelLikeConversationId(post) {
  const channelId = String(post?.channel_id ?? "").trim();
  if (!channelId) {
    return null;
  }
  const rootId = String(post?.root_id ?? "").trim();
  return rootId ? `${channelId}:thread:${rootId}` : channelId;
}

export class BotRuntime {
  constructor({
    botConfig,
    configStore = NOOP_CONFIG_STORE,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = undefined,
    botApi = null,
    createAgentRun = null,
    createCodexRun = null,
    cacheRootDir = DEFAULT_CACHE_PATH,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
    staleWebSocketMs = DEFAULT_STALE_WEBSOCKET_MS
  }) {
    this.botConfig = botConfig;
    this.configStore = configStore;
    this.botApi = botApi ?? new MattermostApi({
      serverUrl: botConfig.serverUrl,
      token: botConfig.token,
      fetchImpl,
      WebSocketImpl,
      logger: (message) => this.log(message)
    });
    this.createAgentRun = createAgentRun ?? createCodexRun;
    this.cacheRootDir = cacheRootDir;
    this.botUsername = null;
    this.botUserId = null;
    this.botDisplayName = "AnyAgent";
    this.websocket = null;
    this.connected = false;
    this.running = false;
    this.sessions = new Map();
    this.channels = new Map();
    this.users = new Map();
    this.reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.staleWebSocketMs = staleWebSocketMs;
    this.stopRequested = false;
    this.connectPromise = null;
    this.pendingWebSocket = null;
    this.lastWsOpenAt = null;
    this.lastWsActivityAt = null;
    this.lastWsMessageAt = null;
    this.lastWsErrorAt = null;
    this.lastWsCloseAt = null;
    this.reconnectCount = 0;
    this.wakeConnectionLoop = null;
  }

  log(message) {
    process.stderr.write(`[mattermost:${this.botConfig.bindingId}] ${message}\n`);
  }

  sessionFor(channelId, options = {}) {
    const conversationId = options.conversationId ?? channelId;
    const key = String(conversationId);
    let session = this.sessions.get(key);
    if (!session) {
      session = new ChatSession({
        botConfig: this.botConfig,
        botApi: this.botApi,
        configStore: this.configStore,
        logger: (message) => this.log(`${key}: ${message}`),
        channelId,
        conversationId,
        websocket: this.websocket,
        cacheRootDir: this.cacheRootDir,
        createAgentRun: this.createAgentRun
      });
      this.sessions.set(key, session);
    }
    return session;
  }

  async channelFor(channelId) {
    const key = String(channelId);
    if (this.channels.has(key)) {
      return this.channels.get(key);
    }
    try {
      const channel = await this.botApi.getChannel(channelId);
      this.channels.set(key, channel);
      return channel;
    } catch (error) {
      this.log(`failed to load Mattermost channel ${key}: ${toErrorMessage(error)}`);
      return null;
    }
  }

  async userFor(userId) {
    const key = String(userId ?? "");
    if (!key) {
      return null;
    }
    if (this.users.has(key)) {
      return this.users.get(key);
    }
    try {
      const user = await this.botApi.getUser(key);
      this.users.set(key, user);
      return user;
    } catch (error) {
      if (error?.status !== 404) {
        this.log(`failed to load Mattermost user ${key}: ${toErrorMessage(error)}`);
      }
      return null;
    }
  }

  async enrichPost(post) {
    if (!post || post.user) {
      return post;
    }
    const user = await this.userFor(post.user_id);
    return user ? { ...post, user } : post;
  }

  isDirectChannel(channel) {
    return channel?.type === "D";
  }

  hasPendingBotWork() {
    for (const session of this.sessions.values()) {
      if (session.isRunning || session.queue.length > 0) {
        return true;
      }
    }
    return false;
  }

  isAuthorized(user) {
    const username = String(user?.username ?? "").trim().replace(/^@+/, "").toLowerCase();
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : [];
    return Boolean(
      username &&
      (this.botConfig.allowedUsernames.includes(username) || managerUsernames.includes(username))
    );
  }

  isManager(user) {
    const username = String(user?.username ?? "").trim().replace(/^@+/, "").toLowerCase();
    const managerUsernames = Array.isArray(this.botConfig.managerUsernames)
      ? this.botConfig.managerUsernames
      : this.botConfig.allowedUsernames;
    return Boolean(username && managerUsernames.includes(username));
  }

  async initialize() {
    const me = await this.botApi.getMe();
    this.botUsername = String(me.username ?? "").trim().toLowerCase();
    this.botUserId = String(me.id ?? "").trim();
    this.botDisplayName = mattermostUserDisplayName(me, "AnyAgent");
    if (this.botConfig.username && this.botUsername !== this.botConfig.username) {
      throw new Error(
        `Configured Mattermost bot username @${this.botConfig.username} does not match token owner @${this.botUsername || "unknown"}.`
      );
    }
    this.log(`ready as @${this.botUsername} for agent ${this.botConfig.agent.id} with workdir ${this.botConfig.agent.workdir}`);
  }

  groupIdentity() {
    const botUsername = this.botUsername || this.botConfig.username;
    return {
      botName: this.botDisplayName,
      botHandle: botUsername ? `@${botUsername}` : "@unknown"
    };
  }

  async resetSessions() {
    await Promise.all([...this.sessions.values()].map((session) =>
      resetSession(session, { clearPersistedState: true })
    ));
  }

  async sendDirectMessage(channelId, text) {
    const session = this.sessionFor(channelId);
    await session.sendText(text);
  }

  async handleClearCache(sessionOrChannelId, options = {}) {
    const session =
      sessionOrChannelId instanceof ChatSession
        ? sessionOrChannelId
        : this.sessionFor(sessionOrChannelId);
    if (this.hasPendingBotWork()) {
      await session.sendText(
        "Cannot clear cache while runs or queued turns are pending.",
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

  async handleEvent(event) {
    let post = postFromWebSocketEvent(event);
    if (!post || isDeletedPost(post) || isBotPost(post, this.botUserId)) {
      return;
    }
    post = await this.enrichPost(post);

    const platformChannelId = String(post?.channel_id ?? "").trim();
    if (!platformChannelId) {
      return;
    }

    const channel = await this.channelFor(platformChannelId);
    if (!channel) {
      return;
    }
    const isDirect = this.isDirectChannel(channel);
    const conversationId = isDirect ? platformChannelId : channelLikeConversationId(post);
    if (!conversationId) {
      return;
    }

    const text = normalizedPostText(post);
    const parsedCommand = parseCommand(text, this.botUsername);
    if (parsedCommand?.ignored && !isDirect) {
      return;
    }
    const session = this.sessionFor(platformChannelId, { conversationId });

    if (isDirect && !this.isAuthorized({ username: post?.user?.username ?? post?.username })) {
      await session.sendText(unauthorizedMessage(post?.user), {
        replyTarget: replyTargetFromMattermostPost(post)
      });
      return;
    }

    if (parsedCommand?.ignored) {
      if (isDirect) {
        await session.sendText(COMMAND_REJECTION_OTHER_BOT, {
          replyTarget: replyTargetFromMattermostPost(post)
        });
      }
      return;
    }

    if (hasSupportedAttachment(post) && isDirect) {
      await session.handleAttachmentPosts([post]);
      return;
    }

    const isCommandLike = Boolean(parsedCommand?.commandLike);
    const replyTarget = replyTargetFromMattermostPost(post);
    if (isCommandLike && !isDirect && parsedCommand.target === "none") {
      await session.sendText(missingTargetMessage(this.botUsername), { replyTarget });
      return;
    }

    if (isCommandLike) {
      if (!this.isManager({ username: post?.user?.username ?? post?.username })) {
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

    if (isDirect) {
      await session.enqueueMessage(text, { replyTarget });
      return;
    }

    await this.handleGroupTriggerPost({ session, post });
  }

  async handleGroupTriggerPost({ session, post }) {
    if (!normalizedPostText(post).trim() && !hasSupportedAttachment(post)) {
      return;
    }

    const referencePost = post.root_id
      ? await this.botApi.getPost(post.root_id).then((rootPost) => this.enrichPost(rootPost)).catch(() => null)
      : null;
    const posts = [];
    let includesRoot = false;
    if (referencePost && session.shouldIncludeGroupRoot()) {
      posts.push(referencePost);
      includesRoot = true;
    }
    posts.push(post);

    const renderedMessages = [];
    for (const candidate of posts) {
      const attachments = await session.stageInputAttachmentsFromPost(candidate);
      renderedMessages.push(renderGroupInputPost(candidate, attachments));
    }

    await session.enqueueTurn({
      mode: "group",
      groupInput: {
        includesRoot,
        messages: renderedMessages
      },
      mergeKey: "group",
      groupIdentity: this.groupIdentity(),
      replyTarget: replyTargetFromMattermostPost(post)
    });
  }

  async connect() {
    if (this.websocket?.socket?.readyState === 1) {
      return this.websocket;
    }
    this.websocket?.close?.();
    this.websocket = null;

    let pendingWebSocket = null;
    try {
      const websocket = await this.botApi.connectWebSocket({
        onClient: (client) => {
          pendingWebSocket = client;
          this.pendingWebSocket = client;
          if (this.stopRequested) {
            client.close?.();
          }
        },
        onOpen: (client) => {
          this.lastWsOpenAt = client.openedAt ?? Date.now();
          this.lastWsActivityAt = client.lastActivityAt ?? client.lastMessageAt ?? this.lastWsOpenAt;
          this.lastWsMessageAt = client.lastMessageAt ?? this.lastWsOpenAt;
          this.log(`websocket open: reconnect_count=${this.reconnectCount}`);
        },
        onActivity: (now) => {
          this.lastWsActivityAt = now;
        },
        onMessage: () => {
          const now = Date.now();
          this.lastWsActivityAt = now;
          this.lastWsMessageAt = now;
        },
        onError: () => {
          this.lastWsErrorAt = Date.now();
        },
        onClose: ({ code, reason } = {}, client) => {
          this.lastWsCloseAt = Date.now();
          this.log(`websocket close observed: code=${code ?? "unknown"} reason=${reason || "none"}`);
          if (!client || this.websocket === client) {
            this.websocket = null;
          }
          this.wakeConnectionLoop?.();
        },
        onEvent: async (event) => {
          if (event.event === "posted") {
            await this.handleEvent(event);
          }
        }
      });

      if (this.pendingWebSocket === pendingWebSocket) {
        this.pendingWebSocket = null;
      }

      if (this.stopRequested) {
        websocket.close?.();
        return null;
      }

      this.websocket = websocket;
      this.reconnectCount += 1;
      this.log(`websocket reconnect success: count=${this.reconnectCount}`);

      for (const session of this.sessions.values()) {
        session.setWebSocket(this.websocket);
      }

      return this.websocket;
    } catch (error) {
      if (this.pendingWebSocket === pendingWebSocket) {
        this.pendingWebSocket = null;
      }
      throw error;
    }
  }

  isWebSocketStale(now = Date.now()) {
    if (!this.websocket || this.websocket.socket?.readyState !== 1) {
      return false;
    }
    const lastActivityAt =
      this.websocket.lastActivityAt ?? this.websocket.lastMessageAt ?? this.lastWsActivityAt ?? this.lastWsMessageAt ?? this.lastWsOpenAt;
    return Boolean(lastActivityAt && now - lastActivityAt > this.staleWebSocketMs);
  }

  closeStaleWebSocket(now = Date.now()) {
    if (!this.isWebSocketStale(now)) {
      return false;
    }
    const lastActivityAt =
      this.websocket?.lastActivityAt ?? this.websocket?.lastMessageAt ?? this.lastWsActivityAt ?? this.lastWsMessageAt ?? this.lastWsOpenAt;
    this.log(
      `websocket stale: last_activity_at=${lastActivityAt ?? "unknown"} stale_ms=${now - lastActivityAt}; reconnecting`
    );
    const websocket = this.websocket;
    this.websocket = null;
    websocket?.close?.();
    return true;
  }

  waitForConnectionLoopWake(ms) {
    return new Promise((resolve) => {
      const previousWake = this.wakeConnectionLoop;
      let settled = false;
      let timer = null;
      const wake = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (this.wakeConnectionLoop === wake) {
          this.wakeConnectionLoop = previousWake;
        }
        resolve();
      };
      this.wakeConnectionLoop = wake;
      timer = setTimeout(wake, ms);
      if (this.stopRequested || this.websocket?.socket?.readyState !== 1) {
        wake();
      }
    });
  }

  async start() {
    if (this.running) {
      return;
    }
    this.stopRequested = false;
    await this.initialize();
    this.running = true;
    this.connectPromise = (async () => {
      while (!this.stopRequested) {
        try {
          await this.connect();
          while (!this.stopRequested && this.websocket?.socket?.readyState === 1) {
            if (this.closeStaleWebSocket()) {
              break;
            }
            await this.waitForConnectionLoopWake(this.watchdogIntervalMs);
          }
        } catch (error) {
          if (this.stopRequested) {
            break;
          }
          this.lastWsErrorAt = Date.now();
          this.log(`mattermost connection failure: ${toErrorMessage(error)}; retrying in ${this.reconnectDelayMs}ms`);
          await sleep(this.reconnectDelayMs);
        }
      }
    })();
  }

  async stop() {
    this.stopRequested = true;
    this.running = false;
    this.wakeConnectionLoop?.();
    this.pendingWebSocket?.close?.();
    this.pendingWebSocket = null;
    this.websocket?.close?.();
    this.websocket = null;
    for (const session of this.sessions.values()) {
      session.queue = [];
      session.stopTyping();
      await session.abortCurrentRun();
    }
    if (this.connectPromise) {
      await this.connectPromise;
    }
  }
}
