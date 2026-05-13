import { TelegramApiError } from "../../src/agent_adapter/telegram/telegram-api.js";

export class FakeBotApi {
  constructor({
    failHtmlOnce = false,
    failMarkdownOnce = false,
    failHtmlEditOnce = false,
    failMarkdownEditOnce = false,
    attachmentFailures = null,
    getUpdatesResult = []
  } = {}) {
    this.failHtmlOnce = failHtmlOnce;
    this.failMarkdownOnce = failMarkdownOnce;
    this.failHtmlEditOnce = failHtmlEditOnce;
    this.failMarkdownEditOnce = failMarkdownEditOnce;
    this.messages = [];
    this.edits = [];
    this.attachments = [];
    this.actions = [];
    this.deletions = [];
    this.filesById = new Map();
    this.filesByPath = new Map();
    this.getFileCalls = [];
    this.downloadCalls = [];
    this.getUpdatesCalls = [];
    this.nextMessageId = 1;
    this.attachmentFailures = attachmentFailures ?? new Map();
    this.getUpdatesResult = getUpdatesResult;
  }

  async sendMessage(payload) {
    const normalizedPayload =
      payload.parseMode === null || payload.parseMode === undefined
        ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "parseMode"))
        : payload;
    if (this.failHtmlOnce && payload.parseMode === "HTML") {
      this.failHtmlOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    if (this.failMarkdownOnce && payload.parseMode === "MarkdownV2") {
      this.failMarkdownOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    this.messages.push(normalizedPayload);
    return { message_id: this.nextMessageId++ };
  }

  async editMessageText(payload) {
    const normalizedPayload =
      payload.parseMode === null || payload.parseMode === undefined
        ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "parseMode"))
        : payload;
    if (this.failHtmlEditOnce && payload.parseMode === "HTML") {
      this.failHtmlEditOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    if (this.failMarkdownEditOnce && payload.parseMode === "MarkdownV2") {
      this.failMarkdownEditOnce = false;
      throw new TelegramApiError("can't parse entities", { errorCode: 400 });
    }
    this.edits.push(normalizedPayload);
    return { message_id: payload.messageId };
  }

  async deleteMessage(payload) {
    this.deletions.push(payload);
    return true;
  }

  async sendLocalAttachment(payload) {
    const normalizedPayload = Object.fromEntries(
      Object.entries(payload).filter(
        ([, value]) => value !== null && value !== undefined && value !== ""
      )
    );
    const failure =
      this.attachmentFailures instanceof Map
        ? this.attachmentFailures.get(normalizedPayload.filePath)
        : this.attachmentFailures?.[normalizedPayload.filePath];
    if (failure) {
      throw new TelegramApiError(String(failure), { errorCode: 400 });
    }
    this.attachments.push(normalizedPayload);
    return { message_id: this.nextMessageId++ };
  }

  async sendChatAction(payload) {
    this.actions.push(payload);
    return true;
  }

  async getMe() {
    return { username: "relaybot" };
  }

  async getUpdates(payload) {
    this.getUpdatesCalls.push(payload);
    return typeof this.getUpdatesResult === "function"
      ? await this.getUpdatesResult(payload)
      : structuredClone(this.getUpdatesResult);
  }

  async setMyCommands() {
    return true;
  }

  registerFile(
    fileId,
    {
      filePath = `${fileId}.bin`,
      body = Buffer.from(`file:${fileId}`),
      fileSize = body.length
    } = {}
  ) {
    this.filesById.set(fileId, {
      file_id: fileId,
      file_path: filePath,
      file_size: fileSize
    });
    this.filesByPath.set(filePath, Buffer.from(body));
  }

  async getFile(fileId) {
    this.getFileCalls.push(fileId);
    const file = this.filesById.get(fileId);
    if (!file) {
      throw new Error(`Unknown Telegram file: ${fileId}`);
    }
    return { ...file };
  }

  async downloadFile(filePath, options = {}) {
    this.downloadCalls.push({ filePath, options });
    const body = this.filesByPath.get(filePath);
    if (!body) {
      throw new Error(`Unknown Telegram file path: ${filePath}`);
    }
    if (Number.isFinite(options.maxBytes) && body.length > options.maxBytes) {
      throw new Error("download exceeds limit");
    }
    return Buffer.from(body);
  }
}

export class FakeConfigStore {
  constructor({ loadedBotConfig = null } = {}) {
    this.patches = [];
    this.loads = [];
    this.loadFailure = null;
    this.loadedBotConfig = loadedBotConfig;
  }

  async loadTelegramBotConfig({ agentId, username }) {
    if (this.loadFailure) {
      throw this.loadFailure;
    }
    this.loads.push({ agentId, username });
    return structuredClone(
      this.loadedBotConfig ?? {
        username,
        agent: {
          id: agentId,
          cli: "codex",
          workdir: "/tmp/project",
          auto: "medium",
          model: "default",
          reasoningEffort: "default"
        },
        allowedUsernames: ["alloweduser"]
      }
    );
  }
}

export function createControlledRunnerFactory() {
  const runs = [];

  return {
    runs,
    createRun(params) {
      let resolveDone;
      const run = {
        params,
        aborted: false,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
        async emit(event) {
          await params.onEvent(event);
        },
        finish(result = { code: 0, signal: null, aborted: false, sawTerminalEvent: true }) {
          resolveDone(result);
        },
        abort() {
          this.aborted = true;
          resolveDone({ code: null, signal: "SIGTERM", aborted: true, sawTerminalEvent: false });
        }
      };
      runs.push(run);
      return run;
    }
  };
}
