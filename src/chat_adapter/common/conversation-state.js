import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { AUTO_DEFAULT } from "../../auto-mode.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../../runtime-settings.js";
import { DEFAULT_STATE_PATH, ensureDir, readJsonFile, writeJsonFileAtomic } from "../../utils.js";
import { buildCacheScope } from "./cache-scope.js";

export const CONVERSATION_STATE_VERSION = 1;

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function normalizeString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizePromptSnapshot(value) {
  const normalized = String(value ?? "");
  return normalized || null;
}

function normalizeContextLength(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDeliveryAnchor(deliveryAnchor) {
  if (!deliveryAnchor || typeof deliveryAnchor !== "object" || Array.isArray(deliveryAnchor)) {
    return null;
  }

  const platformIdKey =
    typeof deliveryAnchor.chatId === "number" || typeof deliveryAnchor.chatId === "string"
      ? "chatId"
      : typeof deliveryAnchor.channelId === "string"
        ? "channelId"
        : null;
  if (!platformIdKey) {
    return null;
  }

  const normalized = {
    [platformIdKey]:
      platformIdKey === "chatId" ? Number(deliveryAnchor.chatId) : String(deliveryAnchor.channelId)
  };

  if (
    deliveryAnchor.replyTarget &&
    typeof deliveryAnchor.replyTarget === "object" &&
    !Array.isArray(deliveryAnchor.replyTarget)
  ) {
    normalized.replyTarget = clone(deliveryAnchor.replyTarget);
  } else {
    normalized.replyTarget = null;
  }

  return normalized;
}

function normalizeOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }

  const normalized = {};
  for (const key of ["cli", "workdir", "auto", "model", "reasoningEffort"]) {
    const value = overrides[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    normalized[key] = String(value);
  }
  return normalized;
}

function normalizeSchedule(schedule, index = 0) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new Error(`schedule[${index}] must be an object`);
  }

  const name = normalizeString(schedule.name);
  const mode = normalizeString(schedule.mode);
  const cron = normalizeString(schedule.cron);
  const prompt = typeof schedule.prompt === "string" ? schedule.prompt.trim() : "";
  if (!name || !mode || !cron || !prompt) {
    throw new Error(`schedule[${index}] must include name, mode, cron, and prompt`);
  }
  if (mode !== "heartbeat" && mode !== "background") {
    throw new Error(`schedule[${index}] mode must be "heartbeat" or "background"`);
  }

  return {
    name,
    mode,
    cron,
    prompt,
    enabled: schedule.enabled !== false
  };
}

function normalizeSchedules(schedules = []) {
  if (!Array.isArray(schedules)) {
    throw new Error("schedules must be an array");
  }
  return schedules.map((schedule, index) => normalizeSchedule(schedule, index));
}

function normalizeSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return null;
  }

  const id = normalizeString(session.id);
  const contextLength = normalizeContextLength(session.contextLength);
  const additionalSystemPromptSnapshot =
    typeof session.basis?.additionalSystemPromptSnapshot === "string"
      ? normalizePromptSnapshot(session.basis.additionalSystemPromptSnapshot)
      : null;
  const basis =
    session.basis && typeof session.basis === "object" && !Array.isArray(session.basis)
      ? {
          cli: normalizeString(session.basis.cli),
          workdir: normalizeString(session.basis.workdir),
          additionalSystemPromptSnapshot
        }
      : null;

  if (!id && contextLength === null) {
    return null;
  }

  return {
    id,
    contextLength,
    basis
  };
}

function normalizeStateRecord(record, scope) {
  if (!record) {
    return {
      version: CONVERSATION_STATE_VERSION,
      conversation: {
        agentId: scope.agentId,
        platform: scope.platform,
        bindingId: scope.bindingId,
        conversationId: scope.conversationId
      },
      deliveryAnchor: null,
      session: null,
      overrides: {},
      schedules: []
    };
  }

  if (typeof record !== "object" || Array.isArray(record)) {
    throw new Error("state file must contain a JSON object");
  }
  if (record.version !== CONVERSATION_STATE_VERSION) {
    throw new Error(`unsupported conversation state version "${record.version}"`);
  }

  return {
    version: CONVERSATION_STATE_VERSION,
    conversation: {
      agentId: scope.agentId,
      platform: scope.platform,
      bindingId: scope.bindingId,
      conversationId: scope.conversationId
    },
    deliveryAnchor: normalizeDeliveryAnchor(record.deliveryAnchor),
    session: normalizeSession(record.session),
    overrides: normalizeOverrides(record.overrides),
    schedules: normalizeSchedules(record.schedules)
  };
}

function runtimeStateFromAgent(agent) {
  return {
    cli: agent?.cli,
    workdir: agent?.workdir,
    auto: agent?.auto ?? AUTO_DEFAULT,
    model: agent?.model ?? DEFAULT_MODEL,
    reasoningEffort: agent?.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  };
}

export class ConversationStateStore {
  constructor({ rootDir = DEFAULT_STATE_PATH } = {}) {
    this.rootDir = rootDir;
  }

  scopeFor({ agentId, platform, bindingId, conversationId }) {
    return buildCacheScope({
      cacheRootDir: this.rootDir,
      agentId,
      platform,
      bindingId,
      conversationId
    });
  }

  scopeDir(scope) {
    return path.join(this.rootDir, scope.scopeHash);
  }

  scopeJsonPath(scope) {
    return path.join(this.scopeDir(scope), "scope.json");
  }

  stateJsonPath(scope) {
    return path.join(this.scopeDir(scope), "state.json");
  }

  async loadRecord(scope) {
    const record = await readJsonFile(this.stateJsonPath(scope), null);
    return normalizeStateRecord(record, scope);
  }

  loadRecordSync(scope) {
    let record = null;
    try {
      const content = fsSync.readFileSync(this.stateJsonPath(scope), "utf8");
      record = JSON.parse(content);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    return normalizeStateRecord(record, scope);
  }

  async saveRecord(scope, record) {
    const normalizedRecord = normalizeStateRecord(record, scope);
    await ensureDir(this.scopeDir(scope));
    await writeJsonFileAtomic(this.scopeJsonPath(scope), {
      agentId: scope.agentId,
      platform: scope.platform,
      bindingId: scope.bindingId,
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey
    });
    await writeJsonFileAtomic(this.stateJsonPath(scope), normalizedRecord);
  }

  async loadBindingRecords({ agentId, platform, bindingId }, options = {}) {
    const onError = options.onError ?? (() => {});
    let entries = [];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const scopeJsonPath = path.join(this.rootDir, entry.name, "scope.json");
      const stateJsonPath = path.join(this.rootDir, entry.name, "state.json");
      try {
        const scopeJson = await readJsonFile(scopeJsonPath, null);
        if (!scopeJson || typeof scopeJson !== "object" || Array.isArray(scopeJson)) {
          continue;
        }
        const scope = this.scopeFor({
          agentId: scopeJson.agentId,
          platform: scopeJson.platform,
          bindingId: scopeJson.bindingId,
          conversationId: scopeJson.conversationId
        });
        if (
          scope.agentId !== agentId ||
          scope.platform !== platform ||
          scope.bindingId !== bindingId
        ) {
          continue;
        }
        const stateJson = await readJsonFile(stateJsonPath, null);
        const record = normalizeStateRecord(stateJson, scope);
        records.push({ scope, record });
      } catch (error) {
        onError(error, { dirName: entry.name, scopeJsonPath, stateJsonPath });
      }
    }

    return records;
  }
}

export class ConversationState {
  static loadSync({
    bindingConfig,
    platform,
    bindingId,
    conversationId,
    deliveryAnchor = null,
    stateStore = new ConversationStateStore(),
    logger = () => {}
  }) {
    const scope = stateStore.scopeFor({
      agentId: bindingConfig.agent.id,
      platform,
      bindingId,
      conversationId
    });
    const record = stateStore.loadRecordSync(scope);
    const state = new ConversationState({
      bindingConfig,
      scope,
      record,
      stateStore,
      logger
    });
    if (deliveryAnchor) {
      state.record.deliveryAnchor = normalizeDeliveryAnchor(deliveryAnchor) ?? state.record.deliveryAnchor;
      try {
        fsSync.mkdirSync(stateStore.scopeDir(scope), { recursive: true });
        fsSync.writeFileSync(
          stateStore.scopeJsonPath(scope),
          `${JSON.stringify(
            {
              agentId: scope.agentId,
              platform: scope.platform,
              bindingId: scope.bindingId,
              conversationId: scope.conversationId,
              scopeKey: scope.scopeKey
            },
            null,
            2
          )}\n`,
          "utf8"
        );
        fsSync.writeFileSync(
          stateStore.stateJsonPath(scope),
          `${JSON.stringify(state.record, null, 2)}\n`,
          "utf8"
        );
      } catch (error) {
        logger(`failed to persist delivery anchor: ${error.message}`);
      }
    }
    if (state.record.session?.id) {
      const basis = state.record.session.basis;
      if (
        !basis ||
        basis.additionalSystemPromptSnapshot === null ||
        basis.cli !== state.cli ||
        basis.workdir !== state.workdir
      ) {
        state.record.session = null;
        try {
          fsSync.mkdirSync(stateStore.scopeDir(scope), { recursive: true });
          fsSync.writeFileSync(
            stateStore.stateJsonPath(scope),
            `${JSON.stringify(state.record, null, 2)}\n`,
            "utf8"
          );
        } catch (error) {
          logger(`failed to invalidate stale session state: ${error.message}`);
        }
      }
    }
    return state;
  }

  static async load({
    bindingConfig,
    platform,
    bindingId,
    conversationId,
    deliveryAnchor = null,
    stateStore = new ConversationStateStore(),
    logger = () => {}
  }) {
    const scope = stateStore.scopeFor({
      agentId: bindingConfig.agent.id,
      platform,
      bindingId,
      conversationId
    });
    const record = await stateStore.loadRecord(scope);
    const state = new ConversationState({
      bindingConfig,
      scope,
      record,
      stateStore,
      logger
    });
    if (deliveryAnchor) {
      state.record.deliveryAnchor = normalizeDeliveryAnchor(deliveryAnchor) ?? state.record.deliveryAnchor;
      await state.persist();
    }
    await state.invalidateSessionIfBasisChanged();
    return state;
  }

  constructor({ bindingConfig, scope, record, stateStore, logger = () => {} }) {
    this.bindingConfig = bindingConfig;
    this.scope = scope;
    this.record = normalizeStateRecord(record, scope);
    this.stateStore = stateStore;
    this.logger = logger;
  }

  get defaults() {
    return runtimeStateFromAgent(this.bindingConfig.agent);
  }

  get effectiveSettings() {
    return {
      cli: this.record.overrides.cli ?? this.defaults.cli,
      workdir: this.record.overrides.workdir ?? this.defaults.workdir,
      auto: this.record.overrides.auto ?? this.defaults.auto,
      model: this.record.overrides.model ?? this.defaults.model,
      reasoningEffort: this.record.overrides.reasoningEffort ?? this.defaults.reasoningEffort
    };
  }

  get cli() {
    return this.effectiveSettings.cli;
  }

  get workdir() {
    return this.effectiveSettings.workdir;
  }

  get auto() {
    return this.effectiveSettings.auto;
  }

  get model() {
    return this.effectiveSettings.model;
  }

  get reasoningEffort() {
    return this.effectiveSettings.reasoningEffort;
  }

  get sessionId() {
    return this.record.session?.id ?? null;
  }

  get contextLength() {
    return this.record.session?.contextLength ?? null;
  }

  get additionalSystemPromptSnapshot() {
    return this.record.session?.basis?.additionalSystemPromptSnapshot ?? null;
  }

  get schedules() {
    return clone(this.record.schedules) ?? [];
  }

  get deliveryAnchor() {
    return clone(this.record.deliveryAnchor);
  }

  async persist() {
    await this.stateStore.saveRecord(this.scope, this.record);
  }

  async invalidateSessionIfBasisChanged() {
    const session = this.record.session;
    if (!session?.id) {
      return;
    }
    if (
      session.basis &&
      session.basis.additionalSystemPromptSnapshot !== null &&
      session.basis.cli === this.cli &&
      session.basis.workdir === this.workdir
    ) {
      return;
    }
    this.record.session = null;
    await this.persist();
  }

  async updateDeliveryAnchor(deliveryAnchor) {
    const normalized = normalizeDeliveryAnchor(deliveryAnchor);
    if (!normalized) {
      return;
    }
    if (JSON.stringify(this.record.deliveryAnchor) === JSON.stringify(normalized)) {
      return;
    }
    this.record.deliveryAnchor = normalized;
    await this.persist();
  }

  async updateSessionId(sessionId, options = {}) {
    const normalized = normalizeString(sessionId);
    if (!normalized) {
      this.record.session = null;
      await this.persist();
      return;
    }

    const hasPromptSnapshot = Object.prototype.hasOwnProperty.call(
      options,
      "additionalSystemPromptSnapshot"
    );
    const currentContextLength = this.record.session?.contextLength ?? null;
    this.record.session = {
      id: normalized,
      contextLength: currentContextLength,
      basis: {
        cli: this.cli,
        workdir: this.workdir,
        additionalSystemPromptSnapshot: hasPromptSnapshot
          ? normalizePromptSnapshot(options.additionalSystemPromptSnapshot)
          : null
      }
    };
    await this.persist();
  }

  async updateContextLength(contextLength) {
    const normalized = normalizeContextLength(contextLength);
    if (!this.record.session) {
      if (normalized === null) {
        return;
      }
      this.record.session = {
        id: null,
        contextLength: normalized,
        basis: {
          cli: this.cli,
          workdir: this.workdir,
          additionalSystemPromptSnapshot: null
        }
      };
    } else {
      this.record.session.contextLength = normalized;
    }
    await this.persist();
  }

  async clearSessionState() {
    this.record.session = null;
    await this.persist();
  }

  async resetChatToBindingDefaults() {
    this.record.session = null;
    this.record.overrides = {};
    await this.persist();
  }

  async resetChatToBotDefaults() {
    await this.resetChatToBindingDefaults();
  }

  async applyRuntimeSettings(patch) {
    const nextOverrides = { ...this.record.overrides };
    const defaults = this.defaults;

    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!["cli", "workdir", "auto", "model", "reasoningEffort"].includes(key)) {
        continue;
      }
      if (value === undefined) {
        delete nextOverrides[key];
        continue;
      }

      if (String(value) === String(defaults[key])) {
        delete nextOverrides[key];
      } else {
        nextOverrides[key] = String(value);
      }
    }

    const previousCli = this.cli;
    const previousWorkdir = this.workdir;
    this.record.overrides = nextOverrides;

    if (this.record.session && (previousCli !== this.cli || previousWorkdir !== this.workdir)) {
      this.record.session = null;
    }

    await this.persist();
  }

  async replaceSchedules(schedules) {
    this.record.schedules = normalizeSchedules(schedules);
    await this.persist();
  }
}
