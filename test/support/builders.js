import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BotRuntime } from "../../src/agent_adapter/telegram/bot-runtime.js";
import { ChatSession } from "../../src/agent_adapter/telegram/chat-session.js";
import { createControlledRunnerFactory, FakeBotApi, FakeConfigStore } from "./fakes.js";

export async function createSession(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-"));
  const cacheRootDir = path.join(tempDir, "cache");

  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const agent = {
    id: "primary-agent",
    cli: "codex",
    workdir: "/tmp/project",
    auto: "medium",
    model: "default",
    reasoningEffort: "default",
    ...(options.agent ?? options.botConfig?.agent ?? {})
  };
  const botConfig = {
    username: "relaybot",
    token: "token",
    allowedUsernames: ["alloweduser"],
    agent,
    ...options.botConfig
  };
  botConfig.agent = {
    ...agent,
    ...(options.botConfig?.workdir !== undefined ? { workdir: options.botConfig.workdir } : {}),
    ...(options.botConfig?.auto !== undefined ? { auto: options.botConfig.auto } : {}),
    ...(options.botConfig?.model !== undefined ? { model: options.botConfig.model } : {}),
    ...(options.botConfig?.reasoningEffort !== undefined
      ? { reasoningEffort: options.botConfig.reasoningEffort }
      : {}),
    ...(options.botConfig?.agent ?? {})
  };
  const configStore = options.configStore ?? new FakeConfigStore({ loadedBotConfig: botConfig });

  const session = new ChatSession({
    botConfig,
    botApi: fakeBotApi,
    configStore,
    logger: () => {},
    chatId: 1001,
    cacheRootDir,
    createCodexRun: options.createCodexRun ?? ((params) => runnerFactory.createRun(params)),
    resolveContextLength: options.resolveContextLength ?? (async () => 21300),
    resolveHomeDir: options.resolveHomeDir
  });
  session.startTyping = () => {};
  session.stopTyping = () => {};

  return { session, fakeBotApi, runnerFactory, configStore, cacheRootDir };
}

export async function createRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-runtime-"));
  const fakeBotApi = options.fakeBotApi ?? new FakeBotApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const cacheRootDir = path.join(tempDir, "cache");
  const agent = {
    id: "primary-agent",
    cli: "codex",
    workdir: "/tmp/project",
    auto: "medium",
    model: "default",
    reasoningEffort: "default",
    ...(options.agent ?? options.botConfig?.agent ?? {})
  };
  const botConfig = {
    username: "relaybot",
    token: "token",
    allowedUsernames: ["alloweduser"],
    agent,
    ...options.botConfig
  };
  botConfig.agent = {
    ...agent,
    ...(options.botConfig?.workdir !== undefined ? { workdir: options.botConfig.workdir } : {}),
    ...(options.botConfig?.auto !== undefined ? { auto: options.botConfig.auto } : {}),
    ...(options.botConfig?.model !== undefined ? { model: options.botConfig.model } : {}),
    ...(options.botConfig?.reasoningEffort !== undefined
      ? { reasoningEffort: options.botConfig.reasoningEffort }
      : {}),
    ...(options.botConfig?.agent ?? {})
  };
  const configStore = options.configStore ?? new FakeConfigStore({ loadedBotConfig: botConfig });

  const runtime = new BotRuntime({
    botConfig,
    botApi: fakeBotApi,
    configStore,
    createCodexRun: options.createCodexRun ?? ((params) => runnerFactory.createRun(params)),
    cacheRootDir,
    albumQuietPeriodMs: options.albumQuietPeriodMs
  });

  return { runtime, fakeBotApi, tempDir, cacheRootDir, configStore, runnerFactory };
}
