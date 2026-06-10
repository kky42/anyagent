import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { sendControlCommand } from "../src/control/client.js";
import {
  controlFilePath,
  deleteControlFile,
  writeControlFile
} from "../src/control/control-file.js";
import { ControlServer } from "../src/control/server.js";

test("control client uses the token from the per-config control file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-control-"));
  const configPath = path.join(tempDir, "agents");
  const calls = [];
  const server = new ControlServer({
    configPath,
    resetService: {
      async resetAgentProfile(agentId) {
        calls.push(agentId);
        return {
          ok: true,
          text: `reset ${agentId}`
        };
      }
    }
  });

  try {
    await server.start();
    const result = await sendControlCommand(configPath, {
      command: "reset",
      scope: "agent-profile",
      agentId: "primary"
    });

    assert.deepEqual(calls, ["primary"]);
    assert.deepEqual(result, {
      ok: true,
      text: "reset primary"
    });
  } finally {
    await server.stop();
  }
});

test("control server returns 400 for unsupported commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-control-"));
  const configPath = path.join(tempDir, "agents");
  const server = new ControlServer({
    configPath,
    resetService: {}
  });

  try {
    await server.start();
    const info = await fs.readFile(controlFilePath(configPath), "utf8").then(JSON.parse);
    const response = await fetch(`${info.url}/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ command: "unknown" })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      ok: false,
      text: "Unsupported control command."
    });
  } finally {
    await server.stop();
  }
});

test("control client removes stale files when the relay process is gone", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-control-"));
  const configPath = path.join(tempDir, "agents");
  await writeControlFile(configPath, {
    pid: 99999999,
    url: "http://127.0.0.1:9",
    token: "stale"
  });

  await assert.rejects(
    () =>
      sendControlCommand(configPath, {
        command: "reset",
        scope: "agent-profile",
        agentId: "primary"
      }),
    /AnyAgent relay is not running/
  );
  await assert.rejects(() => fs.stat(controlFilePath(configPath)), /ENOENT/);
  await deleteControlFile(configPath);
});

test("control file is written with private permissions", { skip: process.platform === "win32" }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-control-"));
  const configPath = path.join(tempDir, "agents");

  try {
    const filePath = await writeControlFile(configPath, {
      pid: process.pid,
      url: "http://127.0.0.1:9",
      token: "secret"
    });

    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await deleteControlFile(configPath);
  }
});
