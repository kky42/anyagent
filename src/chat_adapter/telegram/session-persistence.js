import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../../runtime-settings.js";
import { AUTO_DEFAULT } from "../../auto-mode.js";

export const NOOP_CONFIG_STORE = {
  async loadTelegramBotConfig() {
    throw new Error("Config reload is unavailable.");
  }
};

function applyObjectPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}

function runtimeStateFromAgent(agent) {
  return {
    sessionId: null,
    contextLength: null,
    workdir: agent?.workdir,
    auto: agent?.auto ?? AUTO_DEFAULT,
    model: agent?.model ?? DEFAULT_MODEL,
    reasoningEffort: agent?.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  };
}

export class SessionPersistence {
  constructor({ botConfig }) {
    this.botConfig = botConfig;
    this.state = runtimeStateFromAgent(botConfig.agent);
  }

  get sessionId() {
    return this.state.sessionId;
  }

  set sessionId(sessionId) {
    this.state.sessionId = sessionId;
  }

  get contextLength() {
    return this.state.contextLength;
  }

  set contextLength(contextLength) {
    this.state.contextLength = contextLength;
  }

  get workdir() {
    return this.state.workdir;
  }

  set workdir(workdir) {
    this.state.workdir = workdir;
  }

  get auto() {
    return this.state.auto;
  }

  set auto(auto) {
    this.state.auto = auto;
  }

  get model() {
    return this.state.model;
  }

  set model(model) {
    this.state.model = model;
  }

  get reasoningEffort() {
    return this.state.reasoningEffort;
  }

  set reasoningEffort(reasoningEffort) {
    this.state.reasoningEffort = reasoningEffort;
  }

  async updateSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  async updateContextLength(contextLength) {
    this.contextLength = contextLength;
  }

  async clearPersistedState() {
    this.sessionId = null;
    this.contextLength = null;
  }

  async resetChatToBotDefaults() {
    this.state = runtimeStateFromAgent(this.botConfig.agent);
  }

  async applyRuntimeSettings(patch) {
    applyObjectPatch(this.state, patch);
  }
}
