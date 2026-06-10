import process from "node:process";

import { BotRuntime as MattermostBotRuntime } from "./chat_adapter/mattermost/bot-runtime.js";
import { BotRuntime as TelegramBotRuntime } from "./chat_adapter/telegram/bot-runtime.js";
import { ConfigStore } from "./config-store.js";
import { addAgentConfig } from "./config-scaffold.js";
import { loadConfig } from "./config.js";
import { sendControlCommand } from "./control/client.js";
import { ControlServer } from "./control/server.js";
import { AgentOperationLocks } from "./control/operation-locks.js";
import { ResetService } from "./control/reset-service.js";
import { RuntimeRegistry } from "./control/runtime-registry.js";
import { DEFAULT_CONFIG_PATH } from "./utils.js";

function printHelp() {
  process.stdout.write(`Usage:
  anyagent [--config /path/to/agents]
  anyagent [--config /path/to/agents] add <agent-name> <cli-name>
  anyagent [--config /path/to/agents] reset --agent <agent-name>
  anyagent [--config /path/to/agents] reset --agent <agent-name> --platform <platform> --binding <binding-id> --conversation-id <conversation-id>

Options:
  --config <path>  Use a custom agent config directory
  --help           Show this help

Commands:
  add              Create an agent config under the config directory
  reset            Reset one agent profile, or one conversation with a full selector
`);
}

function parseResetArgs(args) {
  const parsed = {
    agentId: null,
    platform: null,
    bindingId: null,
    conversationId: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--agent") {
      parsed.agentId = value;
      index += 1;
    } else if (arg === "--platform") {
      parsed.platform = value;
      index += 1;
    } else if (arg === "--binding") {
      parsed.bindingId = value;
      index += 1;
    } else if (arg === "--conversation-id") {
      parsed.conversationId = value;
      index += 1;
    } else {
      throw new Error(`Unknown reset option: ${arg}`);
    }
    if (!value) {
      throw new Error(`Missing value after ${arg}`);
    }
  }

  if (!parsed.agentId) {
    throw new Error("reset requires --agent <agent-name>");
  }

  const conversationFields = [parsed.platform, parsed.bindingId, parsed.conversationId];
  const hasConversationField = conversationFields.some(Boolean);
  const hasFullConversationSelector = conversationFields.every(Boolean);
  if (hasConversationField && !hasFullConversationSelector) {
    throw new Error("Conversation reset requires --agent, --platform, --binding, and --conversation-id.");
  }

  return {
    command: "reset",
    scope: hasFullConversationSelector ? "conversation" : "agent-profile",
    ...parsed
  };
}

function parseArgs(argv) {
  let configPath = DEFAULT_CONFIG_PATH;
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { command: "help", configPath };
    }
    if (arg === "--config") {
      configPath = argv[index + 1];
      index += 1;
      if (!configPath) {
        throw new Error("Missing value after --config");
      }
      continue;
    }
    if (positionals.length === 0 && arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    return { command: "run", configPath };
  }

  const [command, ...args] = positionals;
  if (command === "add") {
    if (args.length !== 2) {
      throw new Error("Usage: anyagent add <agent-name> <cli-name>");
    }
    return {
      command,
      configPath,
      agentId: args[0],
      cli: args[1]
    };
  }
  if (command === "reset") {
    return {
      configPath,
      ...parseResetArgs(args)
    };
  }

  throw new Error(`Unknown command: ${command}`);
}

function keepProcessAlive() {
  const timer = setInterval(() => {}, 60000);
  return () => clearInterval(timer);
}

async function runServer(configPath) {
  const config = await loadConfig(configPath);
  const configStore = new ConfigStore(config.configPath);
  const operationLocks = new AgentOperationLocks();

  if (config.chatBindings.length === 0) {
    throw new Error(`No chat bots configured under ${config.configPath}.`);
  }

  const createRuntime = (botConfig) => {
    if (botConfig.platform === "telegram") {
      return new TelegramBotRuntime({
        botConfig,
        configStore,
        operationLocks
      });
    }
    if (botConfig.platform === "mattermost") {
      return new MattermostBotRuntime({
        botConfig,
        configStore,
        operationLocks
      });
    }
    throw new Error(`Unsupported chat binding platform: ${botConfig.platform}`);
  };
  const registry = new RuntimeRegistry(config.chatBindings.map((botConfig) => createRuntime(botConfig)));
  const resetService = new ResetService({
    configPath: config.configPath,
    runtimeRegistry: registry,
    operationLocks,
    createRuntime
  });
  const controlServer = new ControlServer({
    configPath: config.configPath,
    resetService
  });

  const shutdown = async (signal) => {
    process.stderr.write(`Shutting down on ${signal}\n`);
    await controlServer.stop();
    await Promise.allSettled(registry.runtimes.map((runtime) => runtime.stop()));
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const results = await Promise.allSettled(registry.runtimes.map((runtime) => runtime.start()));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) {
    await Promise.allSettled(registry.runtimes.map((runtime) => runtime.stop()));
    throw rejected.reason;
  }
  try {
    await controlServer.start();
  } catch (error) {
    await controlServer.stop().catch(() => {});
    await Promise.allSettled(registry.runtimes.map((runtime) => runtime.stop()));
    throw error;
  }

  process.stderr.write(
    `Running ${registry.runtimes.length} chat bot${registry.runtimes.length === 1 ? "" : "s"} using ${config.configPath}\n`
  );

  const stopKeepAlive = keepProcessAlive();
  try {
    await new Promise(() => {});
  } finally {
    stopKeepAlive();
  }
}

async function addAgent(args) {
  const result = await addAgentConfig({
    agentId: args.agentId,
    cli: args.cli,
    configPath: args.configPath
  });

  process.stdout.write(`Created agent "${result.agentId}" at ${result.configFilePath}\n`);
  process.stdout.write("Add the chat bot entry you want to use, then fill in usernames, tokens, and allowed usernames before running anyagent.\n");
}

async function resetViaControl(args) {
  const payload =
    args.scope === "conversation"
      ? {
          command: "reset",
          scope: "conversation",
          agentId: args.agentId,
          platform: args.platform,
          bindingId: args.bindingId,
          conversationId: args.conversationId
        }
      : {
          command: "reset",
          scope: "agent-profile",
          agentId: args.agentId
        };
  const result = await sendControlCommand(args.configPath, payload);
  process.stdout.write(`${result.text ?? ""}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "add") {
    await addAgent(args);
    return;
  }

  if (args.command === "reset") {
    await resetViaControl(args);
    return;
  }

  await runServer(args.configPath);
}
