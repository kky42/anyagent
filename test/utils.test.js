import test from "node:test";
import assert from "node:assert/strict";

import { formatLocalTimestamp } from "../src/utils.js";

test("formatLocalTimestamp uses local timezone without a suffix", () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    assert.equal(formatLocalTimestamp(1700000001), "2023-11-15 06:13:21");
    assert.doesNotMatch(formatLocalTimestamp(1700000001), /UTC|Z\b|[+-]\d\d:\d\d/);
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});
