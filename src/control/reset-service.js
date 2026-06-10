import { loadConfig, findAgentProfile } from "../config.js";
import { ConversationStateStore } from "../chat_adapter/common/conversation-state.js";
import { toErrorMessage } from "../utils.js";
import { chatBindingKey, runtimeBindingKey } from "./runtime-registry.js";

function bindingRestartSignature(binding) {
  return JSON.stringify({
    platform: binding?.platform ?? null,
    bindingId: binding?.bindingId ?? null,
    username: binding?.username ?? null,
    serverUrl: binding?.serverUrl ?? null,
    token: binding?.token ?? null
  });
}

function bindingConfigSignature(binding) {
  return JSON.stringify(binding ?? null);
}

function resetRecord(record) {
  return {
    ...record,
    session: null,
    overrides: {}
  };
}

function replaceObjectContents(target, source) {
  // Runtime bot configs are normalized plain JSON objects.
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, structuredClone(source));
}

function runtimeScope(runtime) {
  const platform =
    runtime?.botConfig?.platform ?? (runtime?.botConfig?.serverUrl ? "mattermost" : "telegram");
  const bindingId = runtime?.botConfig?.bindingId ?? runtime?.botConfig?.username;
  return {
    agentId: runtime?.botConfig?.agent?.id,
    platform,
    bindingId
  };
}

function resultTextForConversation(session) {
  return `Reset this conversation to current agent profile defaults. Started a new session with CLI ${session.cli}, workdir ${session.workdir}, auto ${session.auto}, model ${session.model}, reasoning effort ${session.reasoningEffort}.`;
}

function formatAgentProfileResetSummary(result) {
  const status = result.ok ? "Reset agent profile" : "Reset agent profile with errors";
  const lines = [
    `${status} ${result.agentId}.`,
    `Bindings: ${result.bindings.added} added, ${result.bindings.removed} removed, ${result.bindings.restarted} restarted, ${result.bindings.updated} updated, ${result.bindings.unchanged} unchanged, ${result.bindings.failed} failed.`,
    `Conversations: ${result.conversations.live} live reset, ${result.conversations.durable} durable reset.`,
    `Schedules: ${result.schedules.timers} active timers resynced.`
  ];
  if (result.runs.aborted > 0 || result.runs.queuesCleared > 0) {
    lines.push(`Runs: ${result.runs.aborted} aborted, ${result.runs.queuesCleared} queues cleared.`);
  }
  if (result.failures.length > 0) {
    lines.push("Failed:");
    for (const failure of result.failures) {
      lines.push(`${failure.target}: ${failure.message}`);
    }
  }
  return lines.join("\n");
}

export class ResetService {
  constructor({
    configPath,
    runtimeRegistry,
    operationLocks,
    createRuntime,
    stateStore = new ConversationStateStore()
  }) {
    this.configPath = configPath;
    this.runtimeRegistry = runtimeRegistry;
    this.operationLocks = operationLocks;
    this.createRuntime = createRuntime;
    this.stateStore = stateStore;
  }

  async loadAgentProfile(agentId) {
    const config = await loadConfig(this.configPath);
    const agent = findAgentProfile(config, { agentId });
    if (!agent) {
      throw new Error(`Agent profile "${agentId}" not found in ${config.configPath}`);
    }
    return { config, agent };
  }

  async sessionForConversation({ runtime, platform, bindingId, conversationId }) {
    const key = String(conversationId ?? "").trim();
    if (!key) {
      throw new Error("conversation id must be a non-empty string");
    }

    const liveSession = runtime.sessions.get(key);
    if (liveSession) {
      return liveSession;
    }

    const scope = runtime.stateStore.scopeFor({
      agentId: runtime.botConfig.agent.id,
      platform,
      bindingId,
      conversationId
    });
    const record = await runtime.stateStore.loadRecord(scope);
    const deliveryAnchor = record.deliveryAnchor;
    if (platform === "telegram") {
      const chatId = deliveryAnchor?.chatId;
      if (chatId === null || chatId === undefined) {
        throw new Error("Conversation is not live and has no Telegram delivery anchor.");
      }
      return runtime.sessionFor(chatId, { conversationId, deliveryAnchor });
    }
    if (platform === "mattermost") {
      const channelId = String(deliveryAnchor?.channelId ?? "").trim();
      if (!channelId) {
        throw new Error("Conversation is not live and has no Mattermost delivery anchor.");
      }
      return runtime.sessionFor(channelId, { conversationId, deliveryAnchor });
    }
    throw new Error(`Unsupported chat binding platform: ${platform}`);
  }

  async resetConversation({ agentId, platform, bindingId, conversationId }) {
    return this.operationLocks.runExclusive(agentId, async () => {
      const { agent } = await this.loadAgentProfile(agentId);
      const runtime = this.runtimeRegistry.find({ platform, bindingId });
      if (!runtime || runtime.botConfig.agent.id !== agentId) {
        throw new Error(`Chat binding "${platform}:${bindingId}" for agent "${agentId}" is not running.`);
      }
      const session = await this.sessionForConversation({
        runtime,
        platform,
        bindingId,
        conversationId
      });
      const result = await session.resetToAgentProfileDefaults({ agentProfile: agent });
      if (!result.ok) {
        throw new Error(result.text);
      }
      runtime.syncConversationSchedules?.(session);
      return {
        ok: true,
        text: resultTextForConversation(session)
      };
    });
  }

  async abortRuntimeBackgroundRuns(runtime, failures) {
    try {
      if (typeof runtime.abortBackgroundRuns === "function") {
        return await runtime.abortBackgroundRuns({ suppressNotification: true });
      }

      const backgroundRuns = [...(runtime.activeBackgroundRuns ?? [])];
      for (const run of backgroundRuns) {
        run.suppressBackgroundNotification = true;
        run.abort?.();
      }
      await Promise.allSettled(
        backgroundRuns.map((run) => (run.backgroundDone ?? run.done ?? Promise.resolve()).catch(() => null))
      );
      return backgroundRuns.length;
    } catch (error) {
      failures.push({
        target: runtimeBindingKey(runtime),
        message: toErrorMessage(error)
      });
      return 0;
    }
  }

  async resetLiveRuntimeSessions(runtime, agentProfile, failures, seenLiveScopes = new Set()) {
    let live = 0;
    let aborted = await this.abortRuntimeBackgroundRuns(runtime, failures);
    let queuesCleared = 0;
    const runtimeScopeParts = runtimeScope(runtime);
    for (const session of runtime.sessions.values()) {
      const scopeKey = `${runtimeScopeParts.agentId}:${runtimeScopeParts.platform}:${runtimeScopeParts.bindingId}:${session.conversationId}`;
      seenLiveScopes.add(scopeKey);
      if (session.isRunning) {
        aborted += 1;
      }
      if (session.queue.length > 0) {
        queuesCleared += 1;
      }
      try {
        const result = await session.resetToAgentProfileDefaults({ agentProfile });
        if (!result.ok) {
          throw new Error(result.text);
        }
        runtime.syncConversationSchedules?.(session);
        live += 1;
      } catch (error) {
        failures.push({
          target: scopeKey,
          message: toErrorMessage(error)
        });
      }
    }
    return { live, aborted, queuesCleared };
  }

  async resetDurableAgentRecords(agentId, failures, seenLiveScopes = new Set()) {
    const records = await this.stateStore.loadAgentRecords(
      { agentId },
      {
        onError: (error, details) => {
          failures.push({
            target: details.stateJsonPath,
            message: toErrorMessage(error)
          });
        }
      }
    );
    let durable = 0;
    for (const { scope, record } of records) {
      if (seenLiveScopes.has(scope.scopeKey)) {
        continue;
      }
      try {
        await this.stateStore.saveRecord(scope, resetRecord(record));
        durable += 1;
      } catch (error) {
        failures.push({
          target: scope.scopeKey,
          message: toErrorMessage(error)
        });
      }
    }
    return durable;
  }

  requestRuntimeStop(runtime, failures) {
    try {
      if (typeof runtime.requestStop === "function") {
        runtime.requestStop();
      } else {
        runtime.retiring = true;
      }
      return true;
    } catch (error) {
      failures.push({
        target: runtimeBindingKey(runtime),
        message: toErrorMessage(error)
      });
      return false;
    }
  }

  async stopRuntime(runtime, failures) {
    try {
      await runtime.stop();
      return true;
    } catch (error) {
      failures.push({
        target: runtimeBindingKey(runtime),
        message: toErrorMessage(error)
      });
      return false;
    }
  }

  async startRuntime(bindingConfig, failures, startOptions = {}) {
    const key = chatBindingKey(bindingConfig);
    try {
      const runtime = this.createRuntime(structuredClone(bindingConfig));
      await runtime.start(startOptions);
      return runtime;
    } catch (error) {
      failures.push({
        target: key,
        message: toErrorMessage(error)
      });
      return null;
    }
  }

  retireConflictingRuntimeForAddedBinding({ key, desired, agentId, failures, pendingStops }) {
    const existing = this.runtimeRegistry.find({
      platform: desired.platform,
      bindingId: desired.bindingId
    });
    if (!existing) {
      return true;
    }

    const existingAgentId = existing.botConfig?.agent?.id;
    if (existingAgentId === agentId) {
      failures.push({
        target: key,
        message: "Chat binding runtime is already registered for this agent."
      });
      return false;
    }

    const stopRequested = this.requestRuntimeStop(existing, failures);
    if (!stopRequested) {
      return false;
    }
    this.runtimeRegistry.removeByKey(key);
    pendingStops.push(existing);
    return true;
  }

  classifyBindings(currentRuntimes, desiredBindings) {
    const currentByKey = new Map(currentRuntimes.map((runtime) => [runtimeBindingKey(runtime), runtime]));
    const desiredByKey = new Map(desiredBindings.map((binding) => [chatBindingKey(binding), binding]));
    const removed = [];
    const added = [];
    const unchanged = [];
    const updated = [];
    const restarted = [];

    for (const [key, runtime] of currentByKey.entries()) {
      const desired = desiredByKey.get(key);
      if (!desired) {
        removed.push({ key, runtime });
        continue;
      }
      if (bindingRestartSignature(runtime.botConfig) !== bindingRestartSignature(desired)) {
        restarted.push({ key, runtime, desired });
        continue;
      }
      if (bindingConfigSignature(runtime.botConfig) !== bindingConfigSignature(desired)) {
        updated.push({ key, runtime, desired });
        continue;
      }
      unchanged.push({ key, runtime, desired });
    }

    for (const [key, desired] of desiredByKey.entries()) {
      if (!currentByKey.has(key)) {
        added.push({ key, desired });
      }
    }

    return { removed, added, unchanged, updated, restarted };
  }

  async resetAgentProfile(agentId) {
    const pendingStops = [];
    const result = await this.operationLocks.runExclusive(agentId, async () => {
      const { config, agent } = await this.loadAgentProfile(agentId);
      const desiredBindings = config.chatBindings.filter((binding) => binding.agent.id === agentId);
      const currentRuntimes = this.runtimeRegistry.forAgent(agentId);
      const classified = this.classifyBindings(currentRuntimes, desiredBindings);
      const failures = [];
      const result = {
        ok: true,
        agentId,
        bindings: {
          added: 0,
          removed: 0,
          restarted: 0,
          updated: 0,
          unchanged: classified.unchanged.length,
          failed: 0
        },
        conversations: {
          live: 0,
          durable: 0
        },
        schedules: {
          timers: 0
        },
        runs: {
          aborted: 0,
          queuesCleared: 0
        },
        failures
      };
      const seenLiveScopes = new Set();

      for (const { key, desired } of classified.added) {
        const canAdd = this.retireConflictingRuntimeForAddedBinding({
          key,
          desired,
          agentId,
          failures,
          pendingStops
        });
        if (!canAdd) {
          continue;
        }
        const runtime = await this.startRuntime(desired, failures, {
          restoreScheduledConversations: false
        });
        if (runtime) {
          this.runtimeRegistry.add(runtime);
          result.bindings.added += 1;
        }
      }

      for (const { key, runtime, desired } of classified.restarted) {
        const replacement = await this.startRuntime(desired, failures, {
          restoreScheduledConversations: false
        });
        if (!replacement) {
          continue;
        }
        const resetCounts = await this.resetLiveRuntimeSessions(runtime, agent, failures, seenLiveScopes);
        result.conversations.live += resetCounts.live;
        result.runs.aborted += resetCounts.aborted;
        result.runs.queuesCleared += resetCounts.queuesCleared;
        const stopRequested = this.requestRuntimeStop(runtime, failures);
        if (!stopRequested) {
          this.requestRuntimeStop(replacement, failures);
          pendingStops.push(replacement);
          continue;
        }
        this.runtimeRegistry.replaceByKey(key, replacement);
        pendingStops.push(runtime);
        result.bindings.restarted += 1;
      }

      for (const { key, runtime } of classified.removed) {
        const resetCounts = await this.resetLiveRuntimeSessions(runtime, agent, failures, seenLiveScopes);
        result.conversations.live += resetCounts.live;
        result.runs.aborted += resetCounts.aborted;
        result.runs.queuesCleared += resetCounts.queuesCleared;
        const stopRequested = this.requestRuntimeStop(runtime, failures);
        if (!stopRequested) {
          continue;
        }
        this.runtimeRegistry.removeByKey(key);
        pendingStops.push(runtime);
        result.bindings.removed += 1;
      }

      for (const { runtime, desired } of classified.updated) {
        replaceObjectContents(runtime.botConfig, desired);
        result.bindings.updated += 1;
      }

      for (const runtime of this.runtimeRegistry.forAgent(agentId)) {
        const resetCounts = await this.resetLiveRuntimeSessions(runtime, agent, failures, seenLiveScopes);
        result.conversations.live += resetCounts.live;
        result.runs.aborted += resetCounts.aborted;
        result.runs.queuesCleared += resetCounts.queuesCleared;
      }

      result.conversations.durable = await this.resetDurableAgentRecords(agentId, failures, seenLiveScopes);

      for (const runtime of this.runtimeRegistry.forAgent(agentId)) {
        try {
          await runtime.restoreScheduledConversations?.();
        } catch (error) {
          failures.push({
            target: runtimeBindingKey(runtime),
            message: toErrorMessage(error)
          });
        }
        result.schedules.timers += runtime.scheduleTimers?.size ?? 0;
      }

      return result;
    });

    for (const runtime of pendingStops) {
      await this.stopRuntime(runtime, result.failures);
    }

    result.bindings.failed = result.failures.length;
    result.ok = result.failures.length === 0;
    return {
      ...result,
      text: formatAgentProfileResetSummary(result)
    };
  }
}
