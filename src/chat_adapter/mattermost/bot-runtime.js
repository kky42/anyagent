import path from "node:path";

import { buildTurnInputMessage } from "../../cli_adapter/turn-input.js";
import {
  DEFAULT_CACHE_PATH,
  formatLocalTimestamp,
  sleep,
  toErrorMessage
} from "../../utils.js";
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

function deliveryAnchorFromMattermostPost(post) {
  const channelId = String(post?.channel_id ?? "").trim();
  if (!channelId) {
    return null;
  }
  return {
    channelId,
    replyTarget: replyTargetFromMattermostPost(post)
  };
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
    stateRootDir = null,
    watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
    staleWebSocketMs = DEFAULT_STALE_WEBSOCKET_MS,
    operationLocks = null
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
    this.stateStore = new ConversationStateStore({
      rootDir: stateRootDir || path.join(path.dirname(cacheRootDir), "state")
    });
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
    this.scheduleTimers = new Map();
    this.activeBackgroundRuns = new Set();
    this.operationLocks = operationLocks;
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
        platform: "mattermost",
        bindingId: this.botConfig.bindingId
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

      const channelId = String(record.deliveryAnchor?.channelId ?? "").trim();
      if (!channelId) {
        this.log(`skipping scheduled restore for ${scope.conversationId}: missing delivery anchor`);
        continue;
      }

      const session = this.sessionFor(channelId, {
        conversationId: scope.conversationId,
        deliveryAnchor: record.deliveryAnchor
      });
      this.syncConversationSchedules(session);
    }
  }

  async loadReferencePost(post) {
    const rootId = String(post?.root_id ?? "").trim();
    if (!rootId) {
      return null;
    }

    try {
      const referencePost = await this.botApi.getPost(rootId);
      return await this.enrichPost(referencePost);
    } catch {
      return null;
    }
  }

  async buildPrivateReferenceText(session, post) {
    const referencePost = await this.loadReferencePost(post);
    if (!referencePost) {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromPost(referencePost);
    return buildTurnInputMessage({
      promptText: normalizedPostText(referencePost).trim(),
      attachments
    }).trim();
  }

  async buildGroupReferenceText(session, post) {
    const referencePost = await this.loadReferencePost(post);
    if (!referencePost) {
      return "";
    }

    const attachments = await session.stageInputAttachmentsFromPost(referencePost);
    return renderGroupInputPost(referencePost, attachments);
  }

  async runHeartbeatSchedule(session, schedule, now = new Date()) {
    const deliveryAnchor = session.deliveryAnchor ?? { channelId: session.channelId, replyTarget: null };
    const channel = await this.channelFor(deliveryAnchor?.channelId ?? session.channelId);

    if (this.isDirectChannel(channel)) {
      await session.enqueueTurn({
        promptText: buildHeartbeatPrivatePrompt(schedule.name, schedule.prompt),
        replyTarget: deliveryAnchor?.replyTarget ?? null,
        scheduleName: schedule.name,
        suppressQueueNotice: true
      });
      return;
    }

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
  }

  async runBackgroundSchedule(session, schedule, now = new Date()) {
    const deliveryAnchor = session.deliveryAnchor ?? { channelId: session.channelId, replyTarget: null };
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
      await session.sendText(scheduleCommandHelp("!schedule"), options);
      return;
    }

    const action = trimmedArgs.split(/\s+/, 1)[0]?.toLowerCase();
    const schedules = session.schedules;

    try {
      if (action === "list") {
        await session.sendText(buildScheduleListText(schedules), options);
        return;
      }

      if (action === "add") {
        const schedule = parseScheduleAddArgs(trimmedArgs);
        if (schedules.some((candidate) => candidate.name === schedule.name)) {
          throw new Error(`Schedule "${schedule.name}" already exists.`);
        }
        await session.replaceSchedules([...schedules, { ...schedule, enabled: true }]);
        this.syncConversationSchedules(session);
        await session.sendText(buildScheduleConfirmation("Added", schedule), options);
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
        await session.sendText(buildScheduleConfirmation("Removed", schedule), options);
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
        await session.sendText(
          buildScheduleConfirmation(enabled ? "Enabled" : "Disabled", {
            ...schedule,
            enabled
          }),
          options
        );
        return;
      }

      await session.sendText(scheduleCommandHelp("!schedule"), options);
    } catch (error) {
      await session.sendText(toErrorMessage(error), options);
    }
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

  async initialize({ restoreScheduledConversations = true } = {}) {
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
    if (restoreScheduledConversations) {
      await this.restoreScheduledConversations();
    }
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
    return !this.stopRequested;
  }

  requestStop() {
    this.stopRequested = true;
    this.running = false;
    this.wakeConnectionLoop?.();
    this.pendingWebSocket?.close?.();
    this.pendingWebSocket = null;
    this.websocket?.close?.();
    this.websocket = null;
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

  async sendDirectMessage(channelId, text) {
    const session = this.sessionFor(channelId, {
      deliveryAnchor: {
        channelId,
        replyTarget: null
      }
    });
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
    await this.waitForAgentOperation();
    if (!this.isActive()) {
      return;
    }
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
    const parsedCommand = parseCommand(text, this.botUsername, this.botDisplayName);
    if (parsedCommand?.ignored && !isDirect) {
      return;
    }
    const session = this.sessionFor(platformChannelId, {
      conversationId,
      deliveryAnchor: deliveryAnchorFromMattermostPost(post)
    });

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
      const referenceText = await this.buildPrivateReferenceText(session, post);
      await session.handleAttachmentPosts([post], { referenceText });
      return;
    }

    const isCommandLike = Boolean(parsedCommand?.commandLike);
    const replyTarget = replyTargetFromMattermostPost(post);
    if (isCommandLike && !isDirect && parsedCommand.target === "none") {
      await session.sendText(missingTargetMessage(this.botUsername), { replyTarget });
      return;
    }

    if (isCommandLike) {
      if (
        !this.isManager({ username: post?.user?.username ?? post?.username }) &&
        !(isDirect && allowedInPrivateForAllowedUser(parsedCommand.command))
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

    if (isDirect) {
      await session.enqueueMessage(
        appendReferenceContext(text, await this.buildPrivateReferenceText(session, post)),
        { replyTarget }
      );
      return;
    }

    await this.handleGroupTriggerPost({ session, post });
  }

  async handleGroupTriggerPost({ session, post }) {
    if (!normalizedPostText(post).trim() && !hasSupportedAttachment(post)) {
      return;
    }
    const attachments = await session.stageInputAttachmentsFromPost(post);
    const renderedMessage = renderGroupInputPost(post, attachments);
    const referenceText = await this.buildGroupReferenceText(session, post);

    await session.enqueueTurn({
      mode: "group",
      groupInput: {
        messages: [appendReferenceContext(renderedMessage, referenceText)]
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

  async start({ restoreScheduledConversations = true } = {}) {
    if (this.running) {
      return;
    }
    this.stopRequested = false;
    await this.initialize({ restoreScheduledConversations });
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
    this.requestStop();
    await this.abortBackgroundRuns({ suppressNotification: true });
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
