import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { eventToActions, parseJsonlLine } from "../src/cli_adapter/claude/events.js";

const fixturePath = path.join(process.cwd(), "test", "fixtures", "claude-events.jsonl");

test("parseJsonlLine returns null for non-json lines", () => {
  assert.equal(parseJsonlLine("not-json"), null);
});

test("fixture events produce visible Claude actions and context length", async () => {
  const content = await fs.readFile(fixturePath, "utf8");
  const actions = content
    .trim()
    .split("\n")
    .map((line) => parseJsonlLine(line))
    .flatMap((event) => eventToActions(event));

  assert.deepEqual(actions, [
    {
      kind: "session_started",
      sessionId: "9f4026da-cb03-4e1e-a75c-b3fa94f42156"
    },
    {
      kind: "context_length",
      contextLength: 29234
    },
    {
      kind: "progress",
      text: "Bash"
    },
    {
      kind: "context_length",
      contextLength: 29430
    },
    {
      kind: "message",
      text: "Hello from Claude"
    },
    {
      kind: "turn_completed"
    }
  ]);
});

test("Claude result errors produce an error action and terminal action", () => {
  assert.deepEqual(eventToActions({
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: true,
    errors: ["Reached budget"],
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 200,
      output_tokens: 2
    }
  }), [
    {
      kind: "error",
      text: "Claude failed: Reached budget"
    },
    {
      kind: "turn_completed"
    }
  ]);
});
