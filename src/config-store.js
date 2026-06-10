import path from "node:path";

import {
  findAgentProfile,
  findChatBindingConfig,
  findTelegramBotConfig,
  loadConfig
} from "./config.js";

export class ConfigStore {
  constructor(configPath) {
    this.configPath = path.resolve(configPath);
  }

  async loadChatBindingConfig({ platform, agentId, bindingId }) {
    const config = await loadConfig(this.configPath);
    const bindingConfig = findChatBindingConfig(config, { platform, agentId, bindingId });
    if (!bindingConfig) {
      throw new Error(
        `Chat binding "${platform}:${bindingId}" for agent "${agentId}" not found in ${this.configPath}`
      );
    }
    return structuredClone(bindingConfig);
  }

  async loadAgentProfile({ agentId }) {
    const config = await loadConfig(this.configPath);
    const agent = findAgentProfile(config, { agentId });
    if (!agent) {
      throw new Error(`Agent profile "${agentId}" not found in ${this.configPath}`);
    }
    return structuredClone(agent);
  }

  async loadTelegramBotConfig({ agentId, username }) {
    const config = await loadConfig(this.configPath);
    const botConfig = findTelegramBotConfig(config, { agentId, username });
    if (!botConfig) {
      throw new Error(
        `Telegram bot "${username}" for agent "${agentId}" not found in ${this.configPath}`
      );
    }
    return structuredClone(botConfig);
  }
}
