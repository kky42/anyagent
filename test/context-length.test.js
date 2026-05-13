import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  findCodexRolloutPathForSession,
  readCodexFinalCallTokenUsageFromRollout,
  readContextLengthForSession
} from "../src/cli_adapter/codex/context-length.js";

test("readCodexFinalCallTokenUsageFromRollout returns the last token_count usage", async () => {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", "codex-rollout.jsonl");

  const usage = await readCodexFinalCallTokenUsageFromRollout(fixturePath);

  assert.deepEqual(usage, {
    inputTokens: 1540,
    cachedInputTokens: 910,
    outputTokens: 85,
    reasoningOutputTokens: 0
  });
});

test("findCodexRolloutPathForSession and readContextLengthForSession use the newest rollout file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-rollout-"));
  const sessionId = "session-xyz";
  const dateDir = path.join(tempDir, "2026", "04", "14");
  await fs.mkdir(dateDir, { recursive: true });

  const olderPath = path.join(dateDir, `rollout-older-${sessionId}.jsonl`);
  const newerPath = path.join(dateDir, `rollout-newer-${sessionId}.jsonl`);
  const fixture = await fs.readFile(path.join(process.cwd(), "test", "fixtures", "codex-rollout.jsonl"), "utf8");
  await fs.writeFile(olderPath, fixture.replace("\"input_tokens\":1540", "\"input_tokens\":1100"), "utf8");
  await fs.writeFile(newerPath, fixture, "utf8");

  const olderMtime = new Date("2026-04-14T10:00:00.000Z");
  const newerMtime = new Date("2026-04-14T10:05:00.000Z");
  await fs.utimes(olderPath, olderMtime, olderMtime);
  await fs.utimes(newerPath, newerMtime, newerMtime);

  const rolloutPath = await findCodexRolloutPathForSession(sessionId, { sessionsDir: tempDir });
  const contextLength = await readContextLengthForSession(sessionId, { sessionsDir: tempDir });

  assert.equal(rolloutPath, newerPath);
  assert.equal(contextLength, 1625);
});
