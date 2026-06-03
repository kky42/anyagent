import test from "node:test";
import assert from "node:assert/strict";

import {
  parseScheduleAddArgs,
  scheduleCommandHelp
} from "../src/chat_adapter/common/schedules.js";

test("parseScheduleAddArgs accepts single-line cron and prompt", () => {
  assert.deepEqual(
    parseScheduleAddArgs("add background joke */5 * * * * 讲一个 3 句话的科幻故事"),
    {
      mode: "background",
      name: "joke",
      cron: "*/5 * * * *",
      prompt: "讲一个 3 句话的科幻故事"
    }
  );
});

test("scheduleCommandHelp renders explicit multiline examples", () => {
  const help = scheduleCommandHelp("!schedule");

  assert.match(help, /^Schedule commands:/);
  assert.match(help, /Add heartbeat:\n  !schedule add heartbeat <name>\n  <cron>\n  <prompt>/);
  assert.match(help, /Add background:\n  !schedule add background <name>\n  <cron>\n  <prompt>/);
  assert.match(
    help,
    /Single-line add:\n  !schedule add background <name> <5 cron fields> <prompt>/
  );
  assert.doesNotMatch(help, /^- !schedule add/m);
});
