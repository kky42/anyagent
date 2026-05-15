import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { prepareWindowsCliSpawn } from "../src/cli_adapter/process-runner.js";

async function createShimTarget(tempDir, relativeTarget, shimName = "claude.cmd") {
  const targetPath = path.join(tempDir, ...relativeTarget.split("\\"));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, "", "utf8");

  const shimPath = path.join(tempDir, shimName);
  await fs.writeFile(
    shimPath,
    [
      "@echo off",
      '"%~dp0\\node.exe" "%~dp0\\ignored.js" %*',
      `"%~dp0\\${relativeTarget}" %*`,
      ""
    ].join("\r\n"),
    "utf8"
  );

  return targetPath;
}

test("prepareWindowsCliSpawn launches npm shim exe targets directly", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-win-exe-shim-"));
  try {
    const targetPath = await createShimTarget(
      tempDir,
      "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"
    );

    const prepared = prepareWindowsCliSpawn("claude", ["-p", "hello"], {
      env: {
        PATH: tempDir,
        PATHEXT: ".cmd;.exe"
      }
    });

    assert.equal(prepared.command, targetPath);
    assert.deepEqual(prepared.args, ["-p", "hello"]);
    assert.deepEqual(prepared.options, { windowsHide: true });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("prepareWindowsCliSpawn launches npm shim JavaScript targets through node", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-win-js-shim-"));
  try {
    const targetPath = await createShimTarget(tempDir, "node_modules\\pkg\\bin\\cli.js", "pi.cmd");

    const prepared = prepareWindowsCliSpawn("pi", ["--version"], {
      env: {
        PATH: tempDir,
        PATHEXT: ".cmd;.exe"
      }
    });

    assert.equal(prepared.command, process.execPath);
    assert.deepEqual(prepared.args, [targetPath, "--version"]);
    assert.deepEqual(prepared.options, { windowsHide: true });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
