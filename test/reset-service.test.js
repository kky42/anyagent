import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ConversationState,
  ConversationStateStore
} from "../src/chat_adapter/common/conversation-state.js";
import { AgentOperationLocks } from "../src/control/operation-locks.js";
import { ResetService } from "../src/control/reset-service.js";
import { RuntimeRegistry } from "../src/control/runtime-registry.js";

function agentProfile(overrides = {}) {
  return {
    id: "primary",
    cli: "codex",
    workdir: "/tmp/project",
    auto: "medium",
    model: "default",
    reasoningEffort: "default",
    ...overrides
  };
}

function telegramBinding({ username, token, agent = agentProfile(), allowedUsernames = ["alloweduser"] }) {
  return {
    platform: "telegram",
    bindingId: username,
    username,
    token,
    allowedUsernames,
    managerUsernames: allowedUsernames,
    agent
  };
}

class FakeSession {
  constructor({ conversationId, stateStore, scope, isRunning = false, queue = [] }) {
    this.conversationId = conversationId;
    this.stateStore = stateStore;
    this.scope = scope;
    this.isRunning = isRunning;
    this.queue = queue;
    this.resetCount = 0;
  }

  async resetToAgentProfileDefaults() {
    this.resetCount += 1;
    this.isRunning = false;
    this.queue = [];
    const record = await this.stateStore.loadRecord(this.scope);
    await this.stateStore.saveRecord(this.scope, {
      ...record,
      session: null,
      overrides: {}
    });
    return { ok: true, text: "reset" };
  }
}

class FakeRuntime {
  constructor(botConfig, { stateStore, failStart = false, failStop = false } = {}) {
    this.botConfig = botConfig;
    this.stateStore = stateStore;
    this.failStart = failStart;
    this.failStop = failStop;
    this.started = false;
    this.stopped = false;
    this.sessions = new Map();
    this.scheduleTimers = new Map();
    this.activeBackgroundRuns = new Set();
    this.synced = [];
    this.restoreCount = 0;
    this.stopRequested = false;
  }

  async start() {
    if (this.failStart) {
      throw new Error(`start failed for ${this.botConfig.bindingId}`);
    }
    this.started = true;
  }

  async stop() {
    this.stopped = true;
    if (this.failStop) {
      throw new Error(`stop failed for ${this.botConfig.bindingId}`);
    }
  }

  requestStop() {
    this.stopRequested = true;
  }

  syncConversationSchedules(session) {
    this.synced.push(session.conversationId);
    this.scheduleTimers.set(`${session.conversationId}:pulse`, {});
  }

  async restoreScheduledConversations() {
    this.restoreCount += 1;
  }
}

function createBackgroundRun() {
  let resolveDone;
  const run = {
    aborted: false,
    suppressBackgroundNotification: false,
    done: new Promise((resolve) => {
      resolveDone = resolve;
    }),
    abort() {
      this.aborted = true;
      resolveDone({ aborted: true, sawTerminalEvent: true });
    }
  };
  run.backgroundDone = run.done;
  return run;
}

async function writeAgentConfig(rootDir, agentId, config) {
  const agentDir = path.join(rootDir, agentId);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "config.json"), JSON.stringify(config, null, 2));
}

async function createDurableRecord({ stateStore, binding, conversationId, schedule = false }) {
  const state = await ConversationState.load({
    bindingConfig: binding,
    platform: binding.platform,
    bindingId: binding.bindingId,
    conversationId,
    deliveryAnchor: {
      chatId: Number(conversationId.replace(/\D/g, "")) || 1001,
      replyTarget: null
    },
    stateStore
  });
  await state.applyRuntimeSettings({ model: "old-model" });
  await state.updateSessionId(`session-${conversationId}`, {
    additionalSystemPromptSnapshot: "old prompt"
  });
  if (schedule) {
    await state.replaceSchedules([
      {
        name: "pulse",
        mode: "heartbeat",
        cron: "*/5 * * * *",
        prompt: "check",
        enabled: true
      }
    ]);
  }
  return stateStore.scopeFor({
    agentId: binding.agent.id,
    platform: binding.platform,
    bindingId: binding.bindingId,
    conversationId
  });
}

test("ResetService reconciles agent profile bindings and resets live and durable conversations", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-service-"));
  const configRoot = path.join(tempDir, "agents");
  const stateStore = new ConversationStateStore({ rootDir: path.join(tempDir, "state") });
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  const nextAgent = agentProfile({ cli: "claude", workdir, auto: "high" });
  await writeAgentConfig(configRoot, "primary", {
    profile: {
      cli: nextAgent.cli,
      workdir,
      auto: nextAgent.auto,
      model: nextAgent.model,
      reasoningEffort: nextAgent.reasoningEffort
    },
    bindings: {
      telegram: {
        bots: [
          { username: "relaybot", token: "same-token", allowedUsernames: ["newuser"] },
          { username: "restartbot", token: "new-token", allowedUsernames: ["alloweduser"] },
          { username: "newbot", token: "newbot-token", allowedUsernames: ["alloweduser"] },
          { username: "badbot", token: "bad-token", allowedUsernames: ["alloweduser"] }
        ]
      }
    }
  });

  const oldAgent = agentProfile({ workdir: "/tmp/old-project" });
  const relayRuntime = new FakeRuntime(
    telegramBinding({ username: "relaybot", token: "same-token", agent: oldAgent, allowedUsernames: ["olduser"] }),
    { stateStore }
  );
  relayRuntime.botConfig.legacyFlag = "stale";
  const restartRuntime = new FakeRuntime(
    telegramBinding({ username: "restartbot", token: "old-token", agent: oldAgent }),
    { stateStore }
  );
  const removedRuntime = new FakeRuntime(
    telegramBinding({ username: "oldbot", token: "oldbot-token", agent: oldAgent }),
    { stateStore }
  );

  const relayScope = await createDurableRecord({
    stateStore,
    binding: relayRuntime.botConfig,
    conversationId: "1001",
    schedule: true
  });
  const removedScope = await createDurableRecord({
    stateStore,
    binding: removedRuntime.botConfig,
    conversationId: "2002",
    schedule: true
  });
  const durableOnlyScope = await createDurableRecord({
    stateStore,
    binding: relayRuntime.botConfig,
    conversationId: "3003",
    schedule: true
  });
  const backgroundRun = createBackgroundRun();
  relayRuntime.activeBackgroundRuns.add(backgroundRun);
  relayRuntime.sessions.set(
    "1001",
    new FakeSession({
      conversationId: "1001",
      stateStore,
      scope: relayScope,
      isRunning: true,
      queue: [{ promptText: "queued" }]
    })
  );
  removedRuntime.sessions.set(
    "2002",
    new FakeSession({
      conversationId: "2002",
      stateStore,
      scope: removedScope
    })
  );

  const registry = new RuntimeRegistry([relayRuntime, restartRuntime, removedRuntime]);
  const created = [];
  const service = new ResetService({
    configPath: configRoot,
    runtimeRegistry: registry,
    operationLocks: new AgentOperationLocks(),
    stateStore,
    createRuntime: (bindingConfig) => {
      const runtime = new FakeRuntime(bindingConfig, {
        stateStore,
        failStart: bindingConfig.bindingId === "badbot"
      });
      created.push(runtime);
      return runtime;
    }
  });

  const result = await service.resetAgentProfile("primary");

  assert.equal(result.ok, false);
  assert.equal(result.bindings.added, 1);
  assert.equal(result.bindings.updated, 1);
  assert.equal(result.bindings.restarted, 1);
  assert.equal(result.bindings.removed, 1);
  assert.equal(result.bindings.failed, 1);
  assert.equal(relayRuntime.botConfig.allowedUsernames.includes("newuser"), true);
  assert.equal(relayRuntime.botConfig.legacyFlag, undefined);
  assert.equal(restartRuntime.stopped, true);
  assert.equal(removedRuntime.stopped, true);
  assert.equal(registry.find({ platform: "telegram", bindingId: "newbot" }).started, true);
  assert.equal(registry.find({ platform: "telegram", bindingId: "restartbot" }).botConfig.token, "new-token");
  assert.equal(registry.find({ platform: "telegram", bindingId: "oldbot" }), null);
  assert.equal(registry.find({ platform: "telegram", bindingId: "badbot" }), null);
  assert.match(result.text, /badbot: start failed for badbot/);
  assert.ok(created.some((runtime) => runtime.botConfig.bindingId === "badbot"));
  assert.equal(backgroundRun.aborted, true);
  assert.equal(backgroundRun.suppressBackgroundNotification, true);

  const relayRecord = await stateStore.loadRecord(relayScope);
  assert.equal(relayRecord.session, null);
  assert.deepEqual(relayRecord.overrides, {});
  assert.equal(relayRecord.schedules.length, 1);

  const removedRecord = await stateStore.loadRecord(removedScope);
  assert.equal(removedRecord.session, null);
  assert.deepEqual(removedRecord.overrides, {});
  assert.equal(removedRecord.schedules.length, 1);
  const durableOnlyRecord = await stateStore.loadRecord(durableOnlyScope);
  assert.equal(durableOnlyRecord.session, null);
  assert.deepEqual(durableOnlyRecord.overrides, {});
  assert.equal(durableOnlyRecord.schedules.length, 1);
  assert.equal(result.conversations.live, 2);
  assert.equal(result.conversations.durable, 1);
  assert.equal(result.runs.aborted, 2);
  assert.equal(result.runs.queuesCleared, 1);
});

test("ResetService defers started runtime schedule restore until after durable state reset", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-service-"));
  const configRoot = path.join(tempDir, "agents");
  const stateStore = new ConversationStateStore({ rootDir: path.join(tempDir, "state") });
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  await writeAgentConfig(configRoot, "primary", {
    profile: {
      cli: "codex",
      workdir,
      auto: "medium",
      model: "new-model",
      reasoningEffort: "default"
    },
    bindings: {
      telegram: {
        bots: [
          { username: "restartbot", token: "new-token", allowedUsernames: ["alloweduser"] },
          { username: "newbot", token: "newbot-token", allowedUsernames: ["alloweduser"] }
        ]
      }
    }
  });

  class StartupRestoringRuntime extends FakeRuntime {
    constructor(botConfig, options) {
      super(botConfig, options);
      this.startOptions = null;
      this.restoreSnapshots = [];
    }

    async start(options = {}) {
      this.startOptions = options;
      await super.start(options);
      if (options.restoreScheduledConversations !== false) {
        await this.restoreScheduledConversations();
      }
    }

    async restoreScheduledConversations() {
      this.restoreCount += 1;
      const records = await this.stateStore.loadBindingRecords({
        agentId: this.botConfig.agent.id,
        platform: this.botConfig.platform,
        bindingId: this.botConfig.bindingId
      });
      for (const { scope, record } of records) {
        if (!Array.isArray(record.schedules) || record.schedules.length === 0) {
          continue;
        }
        this.restoreSnapshots.push({
          conversationId: scope.conversationId,
          session: record.session,
          overrides: record.overrides
        });
        this.scheduleTimers.set(`${scope.conversationId}:pulse`, {});
      }
    }
  }

  const oldAgent = agentProfile({ model: "old-model" });
  const restartRuntime = new FakeRuntime(
    telegramBinding({ username: "restartbot", token: "old-token", agent: oldAgent }),
    { stateStore }
  );
  const restartScope = await createDurableRecord({
    stateStore,
    binding: restartRuntime.botConfig,
    conversationId: "4004",
    schedule: true
  });
  const newBinding = telegramBinding({ username: "newbot", token: "newbot-token", agent: oldAgent });
  const newScope = await createDurableRecord({
    stateStore,
    binding: newBinding,
    conversationId: "5005",
    schedule: true
  });

  const registry = new RuntimeRegistry([restartRuntime]);
  const created = [];
  const service = new ResetService({
    configPath: configRoot,
    runtimeRegistry: registry,
    operationLocks: new AgentOperationLocks(),
    stateStore,
    createRuntime: (bindingConfig) => {
      const runtime = new StartupRestoringRuntime(bindingConfig, { stateStore });
      created.push(runtime);
      return runtime;
    }
  });

  const result = await service.resetAgentProfile("primary");

  assert.equal(result.ok, true);
  assert.equal(result.bindings.added, 1);
  assert.equal(result.bindings.restarted, 1);
  assert.equal(result.conversations.durable, 2);
  assert.equal(result.schedules.timers, 2);

  const replacement = registry.find({ platform: "telegram", bindingId: "restartbot" });
  const added = registry.find({ platform: "telegram", bindingId: "newbot" });
  assert.deepEqual(replacement.startOptions, { restoreScheduledConversations: false });
  assert.deepEqual(added.startOptions, { restoreScheduledConversations: false });
  assert.equal(replacement.restoreCount, 1);
  assert.equal(added.restoreCount, 1);
  assert.deepEqual(
    [...replacement.restoreSnapshots, ...added.restoreSnapshots].map((snapshot) => ({
      conversationId: snapshot.conversationId,
      session: snapshot.session,
      overrides: snapshot.overrides
    })),
    [
      { conversationId: "4004", session: null, overrides: {} },
      { conversationId: "5005", session: null, overrides: {} }
    ]
  );

  const restartRecord = await stateStore.loadRecord(restartScope);
  const newRecord = await stateStore.loadRecord(newScope);
  assert.equal(restartRecord.session, null);
  assert.deepEqual(restartRecord.overrides, {});
  assert.equal(newRecord.session, null);
  assert.deepEqual(newRecord.overrides, {});
});

test("ResetService reports final stop failures after retiring old runtimes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-service-"));
  const configRoot = path.join(tempDir, "agents");
  const stateStore = new ConversationStateStore({ rootDir: path.join(tempDir, "state") });
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  await writeAgentConfig(configRoot, "primary", {
    profile: {
      cli: "codex",
      workdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    bindings: {
      telegram: {
        bots: [
          { username: "restartbot", token: "new-token", allowedUsernames: ["alloweduser"] }
        ]
      }
    }
  });

  const oldAgent = agentProfile({ workdir: "/tmp/old-project" });
  const restartRuntime = new FakeRuntime(
    telegramBinding({ username: "restartbot", token: "old-token", agent: oldAgent }),
    { stateStore, failStop: true }
  );
  const removedRuntime = new FakeRuntime(
    telegramBinding({ username: "oldbot", token: "oldbot-token", agent: oldAgent }),
    { stateStore, failStop: true }
  );

  const registry = new RuntimeRegistry([restartRuntime, removedRuntime]);
  const created = [];
  const service = new ResetService({
    configPath: configRoot,
    runtimeRegistry: registry,
    operationLocks: new AgentOperationLocks(),
    stateStore,
    createRuntime: (bindingConfig) => {
      const runtime = new FakeRuntime(bindingConfig, { stateStore });
      created.push(runtime);
      return runtime;
    }
  });

  const result = await service.resetAgentProfile("primary");

  assert.equal(result.ok, false);
  assert.equal(result.bindings.restarted, 1);
  assert.equal(result.bindings.removed, 1);
  assert.equal(result.bindings.failed, 2);
  assert.equal(restartRuntime.stopRequested, true);
  assert.equal(removedRuntime.stopRequested, true);
  assert.equal(restartRuntime.stopped, true);
  assert.equal(removedRuntime.stopped, true);
  assert.equal(created.find((runtime) => runtime.botConfig.bindingId === "restartbot").stopped, false);
  assert.equal(registry.find({ platform: "telegram", bindingId: "restartbot" }).botConfig.token, "new-token");
  assert.equal(registry.find({ platform: "telegram", bindingId: "oldbot" }), null);
  assert.match(result.text, /telegram:restartbot: stop failed for restartbot/);
  assert.match(result.text, /telegram:oldbot: stop failed for oldbot/);
});

test("ResetService waits for retired runtime shutdown after releasing the agent lock", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-service-"));
  const configRoot = path.join(tempDir, "agents");
  const stateStore = new ConversationStateStore({ rootDir: path.join(tempDir, "state") });
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  await writeAgentConfig(configRoot, "primary", {
    profile: {
      cli: "codex",
      workdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    bindings: {
      telegram: {
        bots: []
      }
    }
  });

  const operationLocks = new AgentOperationLocks();
  class LockObservingRuntime extends FakeRuntime {
    async stop() {
      this.stopSawAgentLock = operationLocks.tails.has(this.botConfig.agent.id);
      await super.stop();
    }
  }

  const oldRuntime = new LockObservingRuntime(
    telegramBinding({ username: "oldbot", token: "oldbot-token" }),
    { stateStore }
  );
  const registry = new RuntimeRegistry([oldRuntime]);
  const service = new ResetService({
    configPath: configRoot,
    runtimeRegistry: registry,
    operationLocks,
    stateStore,
    createRuntime: (bindingConfig) => new FakeRuntime(bindingConfig, { stateStore })
  });

  const result = await service.resetAgentProfile("primary");

  assert.equal(result.ok, true);
  assert.equal(oldRuntime.stopRequested, true);
  assert.equal(oldRuntime.stopped, true);
  assert.equal(oldRuntime.stopSawAgentLock, false);
  assert.equal(registry.find({ platform: "telegram", bindingId: "oldbot" }), null);
});

test("ResetService stops a moved binding runtime before adding it to the target agent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-service-"));
  const configRoot = path.join(tempDir, "agents");
  const stateStore = new ConversationStateStore({ rootDir: path.join(tempDir, "state") });
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  await writeAgentConfig(configRoot, "primary", {
    profile: {
      cli: "codex",
      workdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    bindings: {
      telegram: {
        bots: [
          { username: "sharedbot", token: "new-token", allowedUsernames: ["alloweduser"] }
        ]
      }
    }
  });

  const otherAgent = agentProfile({ id: "other", workdir: "/tmp/other-project" });
  const conflictingRuntime = new FakeRuntime(
    telegramBinding({ username: "sharedbot", token: "old-token", agent: otherAgent }),
    { stateStore }
  );
  const registry = new RuntimeRegistry([conflictingRuntime]);
  const service = new ResetService({
    configPath: configRoot,
    runtimeRegistry: registry,
    operationLocks: new AgentOperationLocks(),
    stateStore,
    createRuntime: (bindingConfig) => new FakeRuntime(bindingConfig, { stateStore })
  });

  const result = await service.resetAgentProfile("primary");

  assert.equal(result.ok, true);
  assert.equal(conflictingRuntime.stopped, true);
  assert.equal(result.bindings.added, 1);
  const runtime = registry.find({ platform: "telegram", bindingId: "sharedbot" });
  assert.equal(runtime.botConfig.agent.id, "primary");
  assert.equal(runtime.botConfig.token, "new-token");
  assert.equal(runtime.started, true);
});

test("ResetService reports moved binding stop failures after replacing the old runtime", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-reset-service-"));
  const configRoot = path.join(tempDir, "agents");
  const stateStore = new ConversationStateStore({ rootDir: path.join(tempDir, "state") });
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-workdir-"));
  await writeAgentConfig(configRoot, "primary", {
    profile: {
      cli: "codex",
      workdir,
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    bindings: {
      telegram: {
        bots: [
          { username: "sharedbot", token: "new-token", allowedUsernames: ["alloweduser"] }
        ]
      }
    }
  });

  const otherAgent = agentProfile({ id: "other", workdir: "/tmp/other-project" });
  const conflictingRuntime = new FakeRuntime(
    telegramBinding({ username: "sharedbot", token: "old-token", agent: otherAgent }),
    { stateStore, failStop: true }
  );
  const registry = new RuntimeRegistry([conflictingRuntime]);
  const service = new ResetService({
    configPath: configRoot,
    runtimeRegistry: registry,
    operationLocks: new AgentOperationLocks(),
    stateStore,
    createRuntime: (bindingConfig) => new FakeRuntime(bindingConfig, { stateStore })
  });

  const result = await service.resetAgentProfile("primary");

  assert.equal(result.ok, false);
  assert.equal(result.bindings.added, 1);
  assert.equal(result.bindings.failed, 1);
  assert.equal(conflictingRuntime.stopRequested, true);
  assert.equal(conflictingRuntime.stopped, true);
  const runtime = registry.find({ platform: "telegram", bindingId: "sharedbot" });
  assert.notEqual(runtime, conflictingRuntime);
  assert.equal(runtime.botConfig.agent.id, "primary");
  assert.equal(runtime.botConfig.token, "new-token");
  assert.match(result.text, /telegram:sharedbot: stop failed for sharedbot/);
});
