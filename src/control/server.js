import crypto from "node:crypto";
import http from "node:http";

import { deleteControlFile, writeControlFile } from "./control-file.js";
import { toErrorMessage } from "../utils.js";

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

export class ControlServer {
  constructor({ configPath, resetService }) {
    this.configPath = configPath;
    this.resetService = resetService;
    this.token = crypto.randomBytes(32).toString("hex");
    this.server = null;
  }

  async handleCommand(payload) {
    if (payload?.command !== "reset") {
      return {
        ok: false,
        text: "Unsupported control command.",
        statusCode: 400
      };
    }

    if (payload.scope === "conversation") {
      return this.resetService.resetConversation({
        agentId: payload.agentId,
        platform: payload.platform,
        bindingId: payload.bindingId,
        conversationId: payload.conversationId
      });
    }

    if (payload.scope === "agent-profile") {
      return this.resetService.resetAgentProfile(payload.agentId);
    }

    return {
      ok: false,
      text: "Unsupported reset scope.",
      statusCode: 400
    };
  }

  async start() {
    if (this.server) {
      return;
    }

    this.server = http.createServer(async (request, response) => {
      try {
        if (request.method !== "POST" || request.url !== "/commands") {
          sendJson(response, 404, { ok: false, text: "Not found." });
          return;
        }
        const auth = String(request.headers.authorization ?? "");
        if (auth !== `Bearer ${this.token}`) {
          sendJson(response, 401, { ok: false, text: "Unauthorized." });
          return;
        }
        const payload = await readJsonBody(request);
        const result = await this.handleCommand(payload);
        const { statusCode, ...responsePayload } = result;
        sendJson(response, statusCode ?? (result.ok ? 200 : 500), responsePayload);
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          text: toErrorMessage(error)
        });
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address();
    await writeControlFile(this.configPath, {
      pid: process.pid,
      url: `http://127.0.0.1:${address.port}`,
      token: this.token
    });
  }

  async stop() {
    await deleteControlFile(this.configPath);
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }
}
