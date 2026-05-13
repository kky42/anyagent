import path from "node:path";

import { findTelegramBotConfig, loadConfig } from "./config.js";

export class ConfigStore {
  constructor(configPath) {
    this.configPath = path.resolve(configPath);
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
