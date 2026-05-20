import fs from "node:fs/promises";
import path from "node:path";

import {
  ATTACHMENT_SIZE_LIMIT_BYTES,
  attachmentDescriptorFromMessage,
  attachmentLimitText,
  buildAttachmentFileName
} from "./attachments.js";
import { formatAuto, parseAutoArgument } from "../../auto-mode.js";
import { SUPPORTED_AGENT_CLIS, cliAdapterFor } from "../../cli_adapter/index.js";
import { buildTurnInputMessage } from "../../cli_adapter/turn-input.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../output-instructions.js";
import { buildCacheScope, ensureCacheScope } from "../cache-scope.js";
import { renderStatusMessage } from "./render.js";
import {
  normalizeSettingArgument
} from "../../runtime-settings.js";
import {
  DEFAULT_CACHE_PATH,
  expandWorkdirPath,
  formatTokenCountK,
  INVALID_WORKDIR_MESSAGE,
  resolveWorkdirPath,
  toErrorMessage
} from "../../utils.js";
import { unsupportedAttachmentMessage } from "./attachments.js";
import { MessageRenderer } from "./message-renderer.js";
import { NOOP_CONFIG_STORE, SessionPersistence } from "./session-persistence.js";
import { prepareForSessionReset, resetSession } from "./session-reset.js";

const CLI_COMMAND_CHOICES = ["codex", "pi", "claude"];

function normalizeCaption(value) {
  return String(value ?? "").trim();
}

export function replyTargetFromTelegramMessage(message) {
  const target = {};
  const messageThreadId = message?.message_thread_id;
  const directMessagesTopicId = message?.direct_messages_topic?.topic_id;
  const isPrivateChat = message?.chat?.type === "private";

  if (messageThreadId !== null && messageThreadId !== undefined) {
    target.messageThreadId = messageThreadId;
  }
  if (
    directMessagesTopicId !== null &&
    directMessagesTopicId !== undefined
  ) {
    target.directMessagesTopicId = directMessagesTopicId;
  }
  if (
    isPrivateChat &&
    target.directMessagesTopicId === undefined &&
    messageThreadId !== null &&
    messageThreadId !== undefined
  ) {
    target.directMessagesTopicId = messageThreadId;
  }
  if (
    isPrivateChat &&
    target.messageThreadId === undefined &&
    directMessagesTopicId !== null &&
    directMessagesTopicId !== undefined
  ) {
    target.messageThreadId = directMessagesTopicId;
  }
  return Object.keys(target).length > 0 ? target : null;
}

/**
 * @typedef {import("../../cli_adapter/turn-input.js").Turn} Turn
 */

export class ChatSession {
  constructor({
    botConfig,
    botApi,
    configStore = NOOP_CONFIG_STORE,
    logger,
    chatId,
    conversationId = chatId,
    cacheRootDir = DEFAULT_CACHE_PATH,
    createAgentRun = null,
    createCodexRun = null,
    resolveContextLength = null,
    resolveHomeDir
  }) {
    this.botConfig = botConfig;
    this.cliAdapter = cliAdapterFor(botConfig.agent?.cli);
    this.botApi = botApi;
    this.configStore = configStore;
    this.logger = logger;
    this.chatId = chatId;
    this.conversationId = conversationId;
    this.cacheRootDir = cacheRootDir;
    this.queue = [];
    this.isRunning = false;
    this.activeRun = null;
    this.activeReplyTarget = null;
    this.typingTimer = null;
    this.usesDefaultRunFactory = !createAgentRun && !createCodexRun;
    this.createAgentRun =
      createAgentRun ?? createCodexRun ?? ((params) => this.cliAdapter.startRun(params));
    this.usesDefaultContextLengthResolver = !resolveContextLength;
    this.resolveContextLength = resolveContextLength ?? this.cliAdapter.resolveContextLength;
    this.resolveHomeDir = resolveHomeDir;
    this.messageRenderer = new MessageRenderer({ botApi, chatId });
    this.persistence = new SessionPersistence({
      botConfig
    });
  }

  get sessionId() {
    return this.persistence.sessionId;
  }

  set sessionId(sessionId) {
    this.persistence.sessionId = sessionId;
  }

  get contextLength() {
    return this.persistence.contextLength;
  }

  set contextLength(contextLength) {
    this.persistence.contextLength = contextLength;
  }

  get cli() {
    return this.persistence.cli;
  }

  set cli(cli) {
    this.persistence.cli = cli;
  }

  get workdir() {
    return this.persistence.workdir;
  }

  set workdir(workdir) {
    this.persistence.workdir = workdir;
  }

  get auto() {
    return this.persistence.auto;
  }

  set auto(auto) {
    this.persistence.auto = auto;
  }

  get model() {
    return this.persistence.model;
  }

  set model(model) {
    this.persistence.model = model;
  }

  get reasoningEffort() {
    return this.persistence.reasoningEffort;
  }

  set reasoningEffort(reasoningEffort) {
    this.persistence.reasoningEffort = reasoningEffort;
  }

  resetTransientTurnState() {
    this.messageRenderer.resetTransientState();
  }

  sendMessageChunk(rawChunk, options = {}) {
    return this.messageRenderer.sendMessageChunk(rawChunk, options);
  }

  editMessageChunk(messageId, rawChunk, options = {}) {
    return this.messageRenderer.editMessageChunk(messageId, rawChunk, options);
  }

  sendSplitText(rawText, options = {}) {
    return this.messageRenderer.sendSplitText(rawText, options);
  }

  renderProgressText(text, options = {}) {
    return this.messageRenderer.renderProgressText(text, options);
  }

  clearProgressMessage() {
    return this.messageRenderer.clearProgressMessage();
  }

  renderFinalMessage(text, options = {}) {
    return this.messageRenderer.renderFinalMessage(text, {
      ...options,
      workdir: this.workdir
    });
  }

  renderErrorText(text, options = {}) {
    return this.messageRenderer.renderErrorText(text, options);
  }

  sendText(text, options = {}) {
    return this.messageRenderer.sendText(text, options);
  }

  sendCodexOutput(text, options = {}) {
    return this.messageRenderer.sendCodexOutput(text, {
      ...options,
      workdir: this.workdir
    });
  }

  startTyping(replyTarget = this.activeReplyTarget) {
    if (this.typingTimer) {
      return;
    }

    const tick = async () => {
      try {
        await this.botApi.sendChatAction({
          chatId: this.chatId,
          action: "typing",
          ...replyTarget
        });
      } catch (error) {
        this.logger(`typing indicator failed: ${toErrorMessage(error)}`);
      }
    };

    void tick();
    this.typingTimer = setInterval(() => {
      void tick();
    }, 4000);
  }

  stopTyping() {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }

  cacheScope() {
    return buildCacheScope({
      cacheRootDir: this.cacheRootDir,
      agentId: this.botConfig.agent?.id,
      platform: "telegram",
      bindingId: this.botConfig.username,
      conversationId: this.conversationId
    });
  }

  cacheDir() {
    return this.cacheScope().scopeDir;
  }

  chatCacheDir() {
    return this.cacheDir();
  }

  normalizeTurn(turn) {
    if (typeof turn === "string") {
      const promptText = String(turn).trim();
      return promptText ? { promptText, attachments: [], replyTarget: null } : null;
    }

    const promptText = String(turn?.promptText ?? "").trim();
    const attachments = Array.isArray(turn?.attachments) ? turn.attachments.filter(Boolean) : [];
    if (!promptText && attachments.length === 0) {
      return null;
    }

    return {
      promptText,
      attachments,
      replyTarget: turn?.replyTarget ?? null
    };
  }

  async clearCache() {
    await fs.rm(this.chatCacheDir(), { recursive: true, force: true });
  }

  async resolveAttachmentLocalPath(descriptor, filePath) {
    const scope = this.cacheScope();
    await ensureCacheScope(scope);

    for (let collisionIndex = 1; collisionIndex <= 1000; collisionIndex += 1) {
      const fileName = buildAttachmentFileName({
        kind: descriptor.kind,
        fileName: descriptor.fileName,
        filePath,
        sourceMessageId: descriptor.sourceMessageId,
        collisionIndex
      });
      const localPath = path.join(scope.scopeDir, fileName);

      try {
        await fs.stat(localPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return { fileName, localPath };
        }
        throw error;
      }
    }

    throw new Error("Could not allocate a unique attachment cache filename.");
  }

  async stageAttachment(descriptor) {
    if (descriptor.fileSize !== null && descriptor.fileSize > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${descriptor.fileName ?? descriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }

    const file = await this.botApi.getFile(descriptor.telegramFileId);
    const resolvedFileSize =
      Number.isFinite(Number(file?.file_size)) ? Number(file.file_size) : descriptor.fileSize;
    if (resolvedFileSize !== null && resolvedFileSize > ATTACHMENT_SIZE_LIMIT_BYTES) {
      throw new Error(
        `${descriptor.fileName ?? descriptor.kind} exceeds the ${attachmentLimitText()} limit.`
      );
    }

    if (typeof file?.file_path !== "string" || !file.file_path) {
      throw new Error("Telegram did not return a downloadable file path.");
    }

    const { fileName, localPath } = await this.resolveAttachmentLocalPath(
      descriptor,
      file.file_path
    );

    const buffer = await this.botApi.downloadFile(file.file_path, {
      maxBytes: ATTACHMENT_SIZE_LIMIT_BYTES
    });
    await fs.writeFile(localPath, buffer);

    return {
      ...descriptor,
      localPath,
      fileName,
      fileSize: resolvedFileSize ?? buffer.length
    };
  }

  async buildAttachmentTurn(messages) {
    const attachments = [];
    const downloadedPaths = [];
    let promptText = "";

    try {
      for (const message of messages) {
        const descriptor = attachmentDescriptorFromMessage(message);
        if (!descriptor) {
          throw new Error(unsupportedAttachmentMessage());
        }

        promptText ||= normalizeCaption(message?.caption);
        const attachment = await this.stageAttachment(descriptor);
        attachments.push(attachment);
        downloadedPaths.push(attachment.localPath);
      }
    } catch (error) {
      await Promise.allSettled(downloadedPaths.map((filePath) => fs.rm(filePath, { force: true })));
      throw error;
    }

    return {
      promptText,
      attachments
    };
  }

  async stageAttachmentsFromMessages(messages) {
    const attachments = [];
    const downloadedPaths = [];

    try {
      for (const message of messages) {
        const descriptor = attachmentDescriptorFromMessage(message);
        if (!descriptor) {
          continue;
        }

        const attachment = await this.stageAttachment(descriptor);
        attachments.push(attachment);
        downloadedPaths.push(attachment.localPath);
      }
    } catch (error) {
      await Promise.allSettled(downloadedPaths.map((filePath) => fs.rm(filePath, { force: true })));
      throw error;
    }

    return attachments;
  }

  async handleAttachmentMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }
    const replyTarget = replyTargetFromTelegramMessage(messages[0]);

    try {
      const turn = await this.buildAttachmentTurn(messages);
      turn.replyTarget = replyTarget;
      await this.enqueueTurn(turn);
    } catch (error) {
      await this.sendText(toErrorMessage(error), { replyTarget });
    }
  }

  updateSessionId(sessionId) {
    return this.persistence.updateSessionId(sessionId);
  }

  updateContextLength(contextLength) {
    return this.persistence.updateContextLength(contextLength);
  }

  clearPersistedState() {
    return this.persistence.clearPersistedState();
  }

  resetChatToBotDefaults() {
    return this.persistence.resetChatToBotDefaults();
  }

  applyRuntimeSettings(patch) {
    return this.persistence.applyRuntimeSettings(patch);
  }

  workdirValidationError() {
    return `Invalid workdir. ${INVALID_WORKDIR_MESSAGE}`;
  }

  async resolveRequestedWorkdir(args) {
    try {
      return await resolveWorkdirPath(args, {
        homeDir: this.resolveHomeDir ? this.resolveHomeDir() : undefined
      });
    } catch (error) {
      if (error instanceof Error && error.message === INVALID_WORKDIR_MESSAGE) {
        throw new Error(this.workdirValidationError());
      }
      throw error;
    }
  }

  async handleWorkdir(args, options = {}) {
    const requestedWorkdir = normalizeSettingArgument(args);
    if (!requestedWorkdir) {
      await this.sendText(`Current workdir: ${this.workdir}.`, options);
      return;
    }

    const homeDir = this.resolveHomeDir ? this.resolveHomeDir() : undefined;
    let normalizedWorkdir;
    try {
      normalizedWorkdir = expandWorkdirPath(requestedWorkdir, { homeDir });
    } catch (error) {
      if (error instanceof Error && error.message === INVALID_WORKDIR_MESSAGE) {
        await this.sendText(this.workdirValidationError(), options);
        return;
      }
      await this.sendText(toErrorMessage(error), options);
      return;
    }

    if (normalizedWorkdir === this.workdir) {
      await this.sendText(`Workdir is already set to ${normalizedWorkdir}.`, options);
      return;
    }

    let nextWorkdir;
    try {
      nextWorkdir = await this.resolveRequestedWorkdir(normalizedWorkdir);
    } catch (error) {
      await this.sendText(toErrorMessage(error), options);
      return;
    }

    await prepareForSessionReset(this);
    this.workdir = nextWorkdir;
    await this.clearPersistedState();

    await this.sendText(
      `Workdir set to ${nextWorkdir}. Started a new session. The next message will open a fresh ${this.cliAdapter.displayName} session.`,
      options
    );
  }

  async handleCli(args, options = {}) {
    const normalizedCli = normalizeSettingArgument(args)?.toLowerCase();
    if (!normalizedCli) {
      await this.sendText(`Current CLI: ${this.cliAdapter.id}.`, options);
      return;
    }

    if (!SUPPORTED_AGENT_CLIS.includes(normalizedCli)) {
      await this.sendText(`Unknown CLI. Use /cli ${CLI_COMMAND_CHOICES.join("|")}.`, options);
      return;
    }

    if (normalizedCli === this.cliAdapter.id) {
      await this.sendText(`CLI is already set to ${normalizedCli}.`, options);
      return;
    }

    await prepareForSessionReset(this);
    this.cli = normalizedCli;
    this.cliAdapter = cliAdapterFor(normalizedCli);
    if (this.usesDefaultRunFactory) {
      this.createAgentRun = (params) => this.cliAdapter.startRun(params);
    }
    if (this.usesDefaultContextLengthResolver) {
      this.resolveContextLength = this.cliAdapter.resolveContextLength;
    }
    await this.clearPersistedState();

    await this.sendText(
      `CLI set to ${normalizedCli}. Started a new session. The next message will open a fresh ${this.cliAdapter.displayName} session.`,
      options
    );
  }

  statusText() {
    return renderStatusMessage({
      isRunning: this.isRunning,
      cli: this.cli,
      workdir: this.workdir,
      auto: this.auto,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      usage: {
        contextLength: formatTokenCountK(this.contextLength)
      },
      queue: this.queue
    });
  }

  async handleStatus(options = {}) {
    await this.sendText(this.statusText(), options);
  }

  async handleAuto(args, options = {}) {
    const normalized = String(args || "").trim();
    if (!normalized) {
      await this.sendText(`Current auto level: ${formatAuto(this.auto)}.`, options);
      return;
    }

    const nextAuto = parseAutoArgument(normalized);
    if (nextAuto === null) {
      await this.sendText(
        "Unknown auto level. Use /auto, /auto low, /auto medium, or /auto high.",
        options
      );
      return;
    }

    const previousAuto = this.auto;
    try {
      await this.applyRuntimeSettings({ auto: nextAuto });
    } catch (error) {
      await this.sendText(`Failed to persist auto level: ${toErrorMessage(error)}`, options);
      return;
    }

    if (this.isRunning) {
      await this.sendText(
        `Auto level set to ${formatAuto(nextAuto)}. The current run stays on ${formatAuto(previousAuto)}; the next run will use ${formatAuto(nextAuto)}.`,
        options
      );
      return;
    }

    await this.sendText(`Auto level set to ${formatAuto(nextAuto)}.`, options);
  }

  async handleModel(args, options = {}) {
    const nextModel = normalizeSettingArgument(args);
    if (!nextModel) {
      await this.sendText(`Current model: ${this.model}.`, options);
      return;
    }

    const previousModel = this.model;
    try {
      await this.applyRuntimeSettings({ model: nextModel });
    } catch (error) {
      await this.sendText(`Failed to persist model setting: ${toErrorMessage(error)}`, options);
      return;
    }

    if (this.isRunning) {
      await this.sendText(
        `Model set to ${nextModel}. The current run stays on ${previousModel}; the next run will use ${nextModel}.`,
        options
      );
      return;
    }

    await this.sendText(`Model set to ${nextModel}.`, options);
  }

  async handleReasoningEffort(args, options = {}) {
    const nextReasoningEffort = normalizeSettingArgument(args);
    if (!nextReasoningEffort) {
      await this.sendText(`Current reasoning effort: ${this.reasoningEffort}.`, options);
      return;
    }

    const previousReasoningEffort = this.reasoningEffort;
    try {
      await this.applyRuntimeSettings({ reasoningEffort: nextReasoningEffort });
    } catch (error) {
      await this.sendText(
        `Failed to persist reasoning effort setting: ${toErrorMessage(error)}`,
        options
      );
      return;
    }

    if (this.isRunning) {
      await this.sendText(
        `Reasoning effort set to ${nextReasoningEffort}. The current run stays on ${previousReasoningEffort}; the next run will use ${nextReasoningEffort}.`,
        options
      );
      return;
    }

    await this.sendText(`Reasoning effort set to ${nextReasoningEffort}.`, options);
  }

  async abortCurrentRun() {
    const run = this.activeRun;
    if (!run) {
      return false;
    }
    run.abort();
    try {
      await run.done;
    } catch (error) {
      this.logger(`abort wait failed: ${toErrorMessage(error)}`);
    }
    return true;
  }

  async handleAbort(options = {}) {
    const wasRunning = this.isRunning;
    await resetSession(this);
    await this.sendText(
      wasRunning ? "Aborted current run and cleared the queue." : "No active run. Queue cleared.",
      options
    );
  }

  async handleNewSession(options = {}) {
    await resetSession(this, { clearPersistedState: true });
    await this.sendText(
      `Started a new session. The next message will open a fresh ${this.cliAdapter.displayName} session.`,
      options
    );
  }

  async handleReset(options = {}) {
    let reloadedBotConfig;
    try {
      reloadedBotConfig = await this.configStore.loadTelegramBotConfig({
        agentId: this.botConfig.agent.id,
        username: this.botConfig.username
      });
    } catch (error) {
      await this.sendText(`Failed to reload bot config: ${toErrorMessage(error)}`, options);
      return;
    }

    await prepareForSessionReset(this);
    this.botConfig.allowedUsernames = reloadedBotConfig.allowedUsernames;
    this.botConfig.agent = reloadedBotConfig.agent;
    this.cliAdapter = cliAdapterFor(this.botConfig.agent?.cli);
    if (this.usesDefaultRunFactory) {
      this.createAgentRun = (params) => this.cliAdapter.startRun(params);
    }
    if (this.usesDefaultContextLengthResolver) {
      this.resolveContextLength = this.cliAdapter.resolveContextLength;
    }
    await this.resetChatToBotDefaults();

    await this.sendText(
      `Reset current chat to config defaults. Started a new session with CLI ${this.cli}, workdir ${this.workdir}, auto ${formatAuto(this.auto)}, model ${this.model}, reasoning effort ${this.reasoningEffort}.`,
      options
    );
  }

  async enqueueTurn(turn) {
    const normalizedTurn = this.normalizeTurn(turn);
    if (!normalizedTurn) {
      return;
    }

    if (this.isRunning) {
      this.queue.push(normalizedTurn);
      await this.sendText(`Queued message ${this.queue.length}.`, {
        replyTarget: normalizedTurn.replyTarget
      });
      return;
    }

    this.queue.push(normalizedTurn);
    void this.drainQueue();
  }

  async enqueueMessage(text, options = {}) {
    await this.enqueueTurn({
      promptText: text,
      attachments: [],
      replyTarget: options.replyTarget ?? null
    });
  }

  async drainQueue() {
    if (this.isRunning) {
      return;
    }

    const nextTurn = this.queue.shift();
    if (!nextTurn) {
      return;
    }

    this.isRunning = true;
    this.activeReplyTarget = nextTurn.replyTarget;
    this.startTyping(nextTurn.replyTarget);
    this.resetTransientTurnState();

    let emittedError = false;
    let currentSessionId = this.sessionId;
    let completedTurn = false;
    const runCli = this.cli;
    const runCliAdapter = this.cliAdapter;
    const message = buildTurnInputMessage(nextTurn);
    const buildArgParams = {
      sessionId: this.sessionId,
      message,
      autoMode: this.auto,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      developerInstructions: ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS
    };
    const runParams = {
      cli: runCli,
      workdir: this.workdir,
      ...buildArgParams
    };
    const debugArgs = runCliAdapter.buildArgs(buildArgParams);
    const redactedArgs = debugArgs.slice();
    if (redactedArgs.length > 0) {
      redactedArgs[redactedArgs.length - 1] = `<prompt:${message.length}>`;
    }
    this.logger(
      `starting ${runCliAdapter.id} run ${JSON.stringify({
        sessionId: this.sessionId,
        attachments: nextTurn.attachments.map((attachment) => ({
          kind: attachment.kind,
          localPath: attachment.localPath
        })),
        args: redactedArgs
      })}`
    );

    const run = this.createAgentRun({
      ...runParams,
      onEvent: async (event) => {
        const actions = runCliAdapter.eventToActions(event);
        for (const action of actions) {
          if (action.kind === "session_started" && action.sessionId) {
            currentSessionId = action.sessionId;
            await this.updateSessionId(action.sessionId);
            continue;
          }
          if (action.kind === "turn_completed") {
            completedTurn = true;
            continue;
          }
          if (action.kind === "context_length") {
            await this.updateContextLength(action.contextLength);
            continue;
          }
          if (action.kind === "progress") {
            await this.renderProgressText(action.text, { replyTarget: nextTurn.replyTarget });
            continue;
          }
          if (action.kind === "error") {
            emittedError = true;
            await this.renderErrorText(action.text, { replyTarget: nextTurn.replyTarget });
            continue;
          }
          if (action.kind === "message") {
            await this.renderFinalMessage(action.text, { replyTarget: nextTurn.replyTarget });
          }
        }
      },
      onStdErr: (chunk) => {
        const message = chunk.trim();
        if (message) {
          this.logger(`${runCliAdapter.id} stderr: ${message}`);
        }
      }
    });

    this.activeRun = run;

    try {
      const result = await run.done;
      if (result.aborted) {
        return;
      }
      if (completedTurn && currentSessionId) {
        const contextLength = await this.resolveContextLength(currentSessionId);
        if (contextLength !== null && contextLength !== undefined) {
          await this.updateContextLength(contextLength);
        }
      }
      if (completedTurn) {
        await this.clearProgressMessage();
      }
      if (!result.sawTerminalEvent && !emittedError) {
        await this.renderErrorText(
          `${runCliAdapter.displayName} exited without a terminal JSON event.`,
          {
            replyTarget: nextTurn.replyTarget
          }
        );
      }
    } catch (error) {
      await this.renderErrorText(`${runCliAdapter.displayName} process error: ${toErrorMessage(error)}`, {
        replyTarget: nextTurn.replyTarget
      });
    } finally {
      this.activeRun = null;
      this.activeReplyTarget = null;
      this.isRunning = false;
      this.stopTyping();
      this.resetTransientTurnState();
      if (this.queue.length > 0) {
        void this.drainQueue();
      }
    }
  }
}
