import process from "node:process";

import { BotRuntime } from "./agent_adapter/telegram/bot-runtime.js";
import { ConfigStore } from "./config-store.js";
import { loadConfig } from "./config.js";
import { DEFAULT_CONFIG_PATH, toErrorMessage } from "./utils.js";

function printHelp() {
  process.stdout.write(`Usage: anyagent [--config /path/to/config.json]

Options:
  --config <path>  Use a custom agent config directory or config.json file
  --help           Show this help
`);
}

function parseArgs(argv) {
  let configPath = DEFAULT_CONFIG_PATH;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, configPath };
    }
    if (arg === "--config") {
      configPath = argv[index + 1];
      index += 1;
      if (!configPath) {
        throw new Error("Missing value after --config");
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false, configPath };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = await loadConfig(args.configPath);
  const configStore = new ConfigStore(config.configPath);

  if (config.telegramBots.length === 0) {
    throw new Error(`No Telegram bots configured under ${config.configPath}.`);
  }

  const runtimes = config.telegramBots.map(
    (botConfig) =>
      new BotRuntime({
        botConfig,
        configStore
      })
  );

  const shutdown = async (signal) => {
    process.stderr.write(`Shutting down on ${signal}\n`);
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const results = await Promise.allSettled(runtimes.map((runtime) => runtime.start()));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) {
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    throw rejected.reason;
  }

  process.stderr.write(
    `Running ${runtimes.length} Telegram bot${runtimes.length === 1 ? "" : "s"} using ${config.configPath}\n`
  );

  await Promise.all(
    runtimes.map((runtime) =>
      runtime.pollPromise?.catch((error) => {
        throw new Error(`Bot runtime failed: ${toErrorMessage(error)}`);
      })
    )
  );
}
