import fs from "node:fs/promises";
import path from "node:path";

import { formatAuto, parseAutoArgument } from "../../auto-mode.js";
import { SUPPORTED_AGENT_CLIS, cliAdapterFor } from "../../cli_adapter/index.js";
import { buildTurnInputMessage } from "../../cli_adapter/turn-input.js";
import {
  buildAdditionalSystemPrompt,
  readProfileInstructions
} from "./additional-system-prompt.js";
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
import { buildCacheScope } from "./cache-scope.js";
import { buildGroupInputMessage, mergeGroupTurns } from "./group-turn.js";
import {
  buildGroupOutputDeveloperInstructions,
  PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS
} from "./output-instructions.js";
import { renderStatusMessage } from "./render.js";
import { ConversationStateStore } from "./conversation-state.js";
import { NOOP_CONFIG_STORE, SessionPersistence } from "./session-persistence.js";
import { prepareForSessionReset, resetSession } from "./session-reset.js";

const CLI_COMMAND_CHOICES = ["codex", "pi", "claude"];

function looksLikeResumeFailure(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    /(resume|session|thread)/.test(normalized) &&
    /(not found|unknown|missing|invalid|expired|cannot|can't|failed|does not exist|no such)/.test(
      normalized
    )
  );
}

function ignorePersistenceFailure(promise, logger, label) {
  void promise.catch((error) => {
    logger(`failed to persist ${label}: ${toErrorMessage(error)}`);
  });
}

function redactDebugArgs(args, promptLength, additionalSystemPromptLength) {
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--append-system-prompt") {
      redacted.push(arg);
      if (index + 1 < args.length) {
        redacted.push(`<additional-system-prompt:${additionalSystemPromptLength}>`);
        index += 1;
      }
      continue;
    }
    if (
      arg === "-c" &&
      index + 1 < args.length &&
      String(args[index + 1]).startsWith("developer_instructions=")
    ) {
      redacted.push(
        arg,
        `developer_instructions=<additional-system-prompt:${additionalSystemPromptLength}>`
      );
      index += 1;
      continue;
    }
    redacted.push(arg);
  }

  if (redacted.length > 0) {
    redacted[redacted.length - 1] = `<prompt:${promptLength}>`;
  }
  return redacted;
}

/**
 * @typedef {import("../../cli_adapter/turn-input.js").Turn} Turn
 */

export class ChatSession {
  constructor({
    bindingConfig,
    botConfig = null,
    output,
    configStore = NOOP_CONFIG_STORE,
    logger = () => {},
    platform,
    bindingId,
    conversationId,
    cacheRootDir = DEFAULT_CACHE_PATH,
    stateStore = null,
    deliveryAnchor = null,
    createAgentRun = null,
    createCodexRun = null,
    resolveContextLength = null,
    resolveHomeDir
  }) {
    this.bindingConfig = bindingConfig ?? botConfig;
    this.botConfig = this.bindingConfig;
    this.cliAdapter = cliAdapterFor(this.bindingConfig.agent?.cli);
    this.output = output;
    this.configStore = configStore;
    this.logger = logger;
    this.platform = platform ?? this.bindingConfig.platform;
    this.bindingId = bindingId ?? this.bindingConfig.bindingId ?? this.bindingConfig.username;
    this.conversationId = conversationId;
    this.cacheRootDir = cacheRootDir;
    this.queue = [];
    this.isRunning = false;
    this.activeRun = null;
    this.activeReplyTarget = null;
    this.groupRootIncluded = false;
    this.usesDefaultRunFactory = !createAgentRun && !createCodexRun;
    this.createAgentRun =
      createAgentRun ?? createCodexRun ?? ((params) => this.cliAdapter.startRun(params));
    this.usesDefaultContextLengthResolver = !resolveContextLength;
    this.resolveContextLength = resolveContextLength ?? this.cliAdapter.resolveContextLength;
    this.resolveHomeDir = resolveHomeDir;
    this.persistence = SessionPersistence.loadSync({
      bindingConfig: this.bindingConfig,
      platform: this.platform,
      bindingId: this.bindingId,
      conversationId: this.conversationId,
      deliveryAnchor,
      stateStore:
        stateStore ??
        new ConversationStateStore({
          rootDir: path.join(path.dirname(this.cacheRootDir), "state")
        }),
      logger: this.logger
    });
  }

  get sessionId() {
    return this.persistence.sessionId;
  }

  set sessionId(sessionId) {
    ignorePersistenceFailure(
      this.persistence.updateSessionId(sessionId),
      this.logger,
      "session id"
    );
  }

  get contextLength() {
    return this.persistence.contextLength;
  }

  set contextLength(contextLength) {
    ignorePersistenceFailure(
      this.persistence.updateContextLength(contextLength),
      this.logger,
      "context length"
    );
  }

  get additionalSystemPromptSnapshot() {
    return this.persistence.additionalSystemPromptSnapshot;
  }

  get cli() {
    return this.persistence.cli;
  }

  get workdir() {
    return this.persistence.workdir;
  }

  get auto() {
    return this.persistence.auto;
  }

  get model() {
    return this.persistence.model;
  }

  get reasoningEffort() {
    return this.persistence.reasoningEffort;
  }

  get schedules() {
    return this.persistence.schedules;
  }

  get deliveryAnchor() {
    return this.persistence.deliveryAnchor;
  }

  resetTransientTurnState() {
    return this.output.resetTransientState?.();
  }

  sendMessageChunk(rawChunk, options = {}) {
    return this.output.sendMessageChunk(rawChunk, options);
  }

  editMessageChunk(messageId, rawChunk, options = {}) {
    return this.output.editMessageChunk(messageId, rawChunk, options);
  }

  sendSplitText(rawText, options = {}) {
    return this.output.sendSplitText(rawText, options);
  }

  renderProgressText(text, options = {}) {
    return this.output.renderProgressText(text, options);
  }

  clearProgressMessage() {
    return this.output.clearProgressMessage();
  }

  renderFinalMessage(text, options = {}) {
    return this.output.renderFinalMessage(text, {
      ...options,
      workdir: this.workdir
    });
  }

  renderGroupFinalMessage(text, options = {}) {
    return this.output.renderGroupFinalMessage(text, {
      ...options,
      workdir: this.workdir
    });
  }

  renderErrorText(text, options = {}) {
    return this.output.renderErrorText(text, options);
  }

  sendText(text, options = {}) {
    return this.output.sendText(text, options);
  }

  sendCodexOutput(text, options = {}) {
    return this.output.sendCodexOutput(text, {
      ...options,
      workdir: this.workdir
    });
  }

  startTyping(replyTarget = this.activeReplyTarget) {
    return this.output.startTyping?.(replyTarget);
  }

  stopTyping() {
    return this.output.stopTyping?.();
  }

  cacheScope() {
    return buildCacheScope({
      cacheRootDir: this.cacheRootDir,
      agentId: this.bindingConfig.agent?.id,
      platform: this.platform,
      bindingId: this.bindingId,
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
      return promptText ? { mode: "private", promptText, attachments: [], replyTarget: null } : null;
    }

    const mode = turn?.mode === "group" ? "group" : "private";
    const groupInput = turn?.groupInput && typeof turn.groupInput === "object"
      ? {
          includesRoot: Boolean(turn.groupInput.includesRoot),
          messages: Array.isArray(turn.groupInput.messages)
            ? turn.groupInput.messages.filter(Boolean)
            : []
        }
      : null;
    const promptText = String(
      turn?.promptText ?? (groupInput ? buildGroupInputMessage(groupInput) : "")
    ).trim();
    const attachments = Array.isArray(turn?.attachments) ? turn.attachments.filter(Boolean) : [];
    if (!promptText && attachments.length === 0) {
      return null;
    }

    return {
      mode,
      promptText,
      attachments,
      replyTarget: turn?.replyTarget ?? null,
      groupInput,
      mergeKey: turn?.mergeKey ?? null,
      groupIdentity: turn?.groupIdentity ?? null,
      developerInstructions: turn?.developerInstructions ?? null,
      suppressQueueNotice: Boolean(turn?.suppressQueueNotice),
      scheduleName: typeof turn?.scheduleName === "string" ? turn.scheduleName : null,
      resumeRetryCount:
        Number.isInteger(turn?.resumeRetryCount) && turn.resumeRetryCount > 0
          ? turn.resumeRetryCount
          : 0
    };
  }

  shouldIncludeGroupRoot() {
    if (this.groupRootIncluded) {
      return false;
    }
    this.groupRootIncluded = true;
    return true;
  }

  async clearCache() {
    await fs.rm(this.chatCacheDir(), { recursive: true, force: true });
  }

  updateSessionId(sessionId, options = {}) {
    return this.persistence.updateSessionId(sessionId, options);
  }

  updateContextLength(contextLength) {
    return this.persistence.updateContextLength(contextLength);
  }

  updateDeliveryAnchor(deliveryAnchor) {
    return this.persistence.updateDeliveryAnchor(deliveryAnchor);
  }

  clearSessionState() {
    return this.persistence.clearSessionState();
  }

  resetChatToBindingDefaults() {
    return this.persistence.resetChatToBindingDefaults();
  }

  resetChatToBotDefaults() {
    return this.resetChatToBindingDefaults();
  }

  applyRuntimeSettings(patch) {
    return this.persistence.applyRuntimeSettings(patch);
  }

  replaceSchedules(schedules) {
    return this.persistence.replaceSchedules(schedules);
  }

  removeQueuedScheduledTurns(scheduleName) {
    const normalizedName = String(scheduleName ?? "").trim();
    if (!normalizedName) {
      return 0;
    }

    const previousLength = this.queue.length;
    this.queue = this.queue.filter((turn) => turn.scheduleName !== normalizedName);
    return previousLength - this.queue.length;
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
    await this.applyRuntimeSettings({ workdir: nextWorkdir });
    await this.clearSessionState();

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
    await this.applyRuntimeSettings({ cli: normalizedCli });
    this.cliAdapter = cliAdapterFor(this.cli);
    if (this.usesDefaultRunFactory) {
      this.createAgentRun = (params) => this.cliAdapter.startRun(params);
    }
    if (this.usesDefaultContextLengthResolver) {
      this.resolveContextLength = this.cliAdapter.resolveContextLength;
    }
    await this.clearSessionState();

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
      queue: this.queue,
      schedules: this.schedules
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
    await resetSession(this, { clearSessionState: true });
    await this.sendText(
      `Started a new session. The next message will open a fresh ${this.cliAdapter.displayName} session.`,
      options
    );
  }

  async reloadBindingConfig() {
    return this.configStore.loadChatBindingConfig({
      platform: this.platform,
      agentId: this.bindingConfig.agent.id,
      bindingId: this.bindingId
    });
  }

  buildFreshAdditionalSystemPrompt(relayInstructions = null) {
    return buildAdditionalSystemPrompt({
      profileInstructions: readProfileInstructions(this.bindingConfig.agent),
      relayInstructions
    });
  }

  resolveAdditionalSystemPrompt(relayInstructions = null) {
    if (this.sessionId) {
      return this.additionalSystemPromptSnapshot;
    }
    return this.buildFreshAdditionalSystemPrompt(relayInstructions);
  }

  async handleReset(options = {}) {
    let reloadedBindingConfig;
    try {
      reloadedBindingConfig = await this.reloadBindingConfig();
    } catch (error) {
      await this.sendText(`Failed to reload bot config: ${toErrorMessage(error)}`, options);
      return;
    }

    await prepareForSessionReset(this);
    Object.assign(this.bindingConfig, reloadedBindingConfig);
    this.botConfig = this.bindingConfig;
    this.cliAdapter = cliAdapterFor(this.bindingConfig.agent?.cli);
    if (this.usesDefaultRunFactory) {
      this.createAgentRun = (params) => this.cliAdapter.startRun(params);
    }
    if (this.usesDefaultContextLengthResolver) {
      this.resolveContextLength = this.cliAdapter.resolveContextLength;
    }
    await this.resetChatToBindingDefaults();

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

    if (normalizedTurn.mode === "group") {
      const lastQueuedTurn = this.queue.at(-1);
      if (
        lastQueuedTurn?.mode === "group" &&
        lastQueuedTurn.mergeKey &&
        lastQueuedTurn.mergeKey === normalizedTurn.mergeKey
      ) {
        mergeGroupTurns(lastQueuedTurn, normalizedTurn);
        if (!this.isRunning) {
          void this.drainQueue();
        }
        return;
      }
    }

    if (this.isRunning) {
      this.queue.push(normalizedTurn);
      if (normalizedTurn.mode === "group" || normalizedTurn.suppressQueueNotice) {
        return;
      }
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
    let resumeFailureMessage = null;
    const runCli = this.cli;
    const runCliAdapter = this.cliAdapter;
    const isGroupTurn = nextTurn.mode === "group";
    const initialSessionId = this.sessionId;
    const mayRetryFailedResume = Boolean(initialSessionId) && nextTurn.resumeRetryCount === 0;
    const message = nextTurn.groupInput
      ? buildGroupInputMessage(nextTurn.groupInput)
      : buildTurnInputMessage(nextTurn);
    const relayInstructions = nextTurn.developerInstructions ??
      (isGroupTurn
        ? buildGroupOutputDeveloperInstructions(nextTurn.groupIdentity ?? {})
        : PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS);
    let developerInstructions;
    try {
      developerInstructions = this.resolveAdditionalSystemPrompt(relayInstructions);
    } catch (error) {
      await this.renderErrorText(toErrorMessage(error), {
        replyTarget: nextTurn.replyTarget
      });
      this.activeReplyTarget = null;
      this.isRunning = false;
      this.stopTyping();
      this.resetTransientTurnState();
      if (this.queue.length > 0) {
        void this.drainQueue();
      }
      return;
    }
    const additionalSystemPromptSnapshot = this.sessionId
      ? this.additionalSystemPromptSnapshot
      : developerInstructions;
    const buildArgParams = {
      sessionId: this.sessionId,
      message,
      autoMode: this.auto,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      developerInstructions
    };
    const runParams = {
      cli: runCli,
      workdir: this.workdir,
      ...buildArgParams
    };
    const redactedArgs = redactDebugArgs(
      runCliAdapter.buildArgs(buildArgParams),
      message.length,
      String(developerInstructions ?? "").length
    );
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
            await this.updateSessionId(action.sessionId, {
              additionalSystemPromptSnapshot
            });
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
            if (isGroupTurn) {
              this.logger(`${runCliAdapter.id} progress: ${action.text}`);
              continue;
            }
            await this.renderProgressText(action.text, { replyTarget: nextTurn.replyTarget });
            continue;
          }
          if (action.kind === "error") {
            if (mayRetryFailedResume && looksLikeResumeFailure(action.text)) {
              resumeFailureMessage = action.text;
              continue;
            }
            emittedError = true;
            await this.renderErrorText(action.text, { replyTarget: nextTurn.replyTarget });
            continue;
          }
          if (action.kind === "message") {
            try {
              if (isGroupTurn) {
                await this.renderGroupFinalMessage(action.text, {
                  replyTarget: nextTurn.replyTarget
                });
              } else {
                await this.renderFinalMessage(action.text, { replyTarget: nextTurn.replyTarget });
              }
            } catch (error) {
              emittedError = true;
              if (isGroupTurn) {
                await this.renderErrorText(
                  `Failed to deliver group output: ${toErrorMessage(error)}`,
                  {
                    replyTarget: nextTurn.replyTarget
                  }
                );
                continue;
              }
              throw error;
            }
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
      if (!result.sawTerminalEvent && !emittedError && !resumeFailureMessage) {
        await this.renderErrorText(
          `${runCliAdapter.displayName} exited without a terminal JSON event.`,
          {
            replyTarget: nextTurn.replyTarget
          }
        );
      }
    } catch (error) {
      const processErrorText = `${runCliAdapter.displayName} process error: ${toErrorMessage(error)}`;
      if (mayRetryFailedResume && looksLikeResumeFailure(processErrorText)) {
        resumeFailureMessage = processErrorText;
      } else {
        await this.renderErrorText(processErrorText, {
          replyTarget: nextTurn.replyTarget
        });
      }
    } finally {
      this.activeRun = null;
      this.activeReplyTarget = null;
      this.isRunning = false;
      this.stopTyping();
      this.resetTransientTurnState();
      if (resumeFailureMessage) {
        await this.clearProgressMessage();
        await this.clearSessionState();
        this.queue.unshift({
          ...nextTurn,
          resumeRetryCount: nextTurn.resumeRetryCount + 1
        });
        await this.sendText(
          "Stored session could not be resumed. Started a fresh session for this conversation.",
          {
            replyTarget: nextTurn.replyTarget
          }
        );
      }
      if (this.queue.length > 0) {
        void this.drainQueue();
      }
    }
  }
}
