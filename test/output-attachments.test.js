import test from "node:test";
import assert from "node:assert/strict";

import {
  parseOutput,
  parseGroupOutputSegments,
  parseOutputSegments
} from "../src/chat_adapter/common/output-attachments.js";

test("parseOutputSegments returns a single text segment when no control block exists", () => {
  assert.deepEqual(parseOutputSegments("plain text"), [
    {
      kind: "text",
      text: "plain text"
    }
  ]);
});

test("parseOutputSegments parses singular attachment blocks in source order", () => {
  const segments = parseOutputSegments(
    [
      "Start",
      "ATTACH ./one.png",
      "Middle",
      '<attachment path="./two.pdf" kind="document" />',
      "End"
    ].join("\n")
  );

  assert.deepEqual(segments, [
    { kind: "text", text: "Start\n" },
    {
      kind: "attachment",
      rawText: "ATTACH ./one.png",
      entries: [{ path: "./one.png", kind: "photo", rawKind: null, error: null }]
    },
    { kind: "text", text: "Middle\n" },
    {
      kind: "attachment",
      rawText: '<attachment path="./two.pdf" kind="document" />',
      entries: [{ path: "./two.pdf", kind: "document", rawKind: "document", error: null }]
    },
    { kind: "text", text: "\nEnd" }
  ]);
});

test("parseOutputSegments normalizes quoted and shell-escaped ATTACH paths", () => {
  const segments = parseOutputSegments(
    [
      'ATTACH "/Users/kky/Desktop/Screenshot 2026-05-30 at 01.33.06.png"',
      "ATTACH /Users/kky/Desktop/Screenshot\\ 2026-05-30\\ at\\ 01.33.06.png"
    ].join("\n")
  );

  assert.deepEqual(segments, [
    {
      kind: "attachment",
      rawText: 'ATTACH "/Users/kky/Desktop/Screenshot 2026-05-30 at 01.33.06.png"',
      entries: [
        {
          path: "/Users/kky/Desktop/Screenshot 2026-05-30 at 01.33.06.png",
          kind: "photo",
          rawKind: null,
          error: null
        }
      ]
    },
    {
      kind: "attachment",
      rawText: "ATTACH /Users/kky/Desktop/Screenshot\\ 2026-05-30\\ at\\ 01.33.06.png",
      entries: [
        {
          path: "/Users/kky/Desktop/Screenshot 2026-05-30 at 01.33.06.png",
          kind: "photo",
          rawKind: null,
          error: null
        }
      ]
    }
  ]);
});

test("parseOutputSegments parses group messages with CDATA", () => {
  const segments = parseOutputSegments(
    [
      "ignored",
      "<group_message><![CDATA[",
      "Hello <team> & friends.",
      "]]></group_message>",
      '<attachment path="./chart.png" kind="photo" />'
    ].join("\n")
  );

  assert.equal(segments[1].kind, "group_message");
  assert.equal(segments[1].text, "Hello <team> & friends.");
  assert.equal(segments[2].kind, "text");
  assert.equal(segments[3].kind, "attachment");
});

test("parseOutputSegments decodes XML attributes and text entities", () => {
  const parsed = parseOutputSegments(
    '<group_message>A &amp; B</group_message>\n<attachment path="./reports/a&amp;b.pdf" kind="document" />'
  );

  assert.equal(parsed[0].text, "A & B");
  assert.deepEqual(parsed[2].entries, [
    {
      path: "./reports/a&b.pdf",
      kind: "document",
      rawKind: "document",
      error: null
    }
  ]);
});

test("parseOutputSegments leaves malformed control blocks visible as text", () => {
  const rawText = '<attachment path="./report.pdf" kind="document">';
  assert.deepEqual(parseOutputSegments(rawText), [
    { kind: "text", text: "<" },
    { kind: "text", text: 'attachment path="./report.pdf" kind="document">' }
  ]);
});

test("parseOutputSegments records attachment entry errors", () => {
  const parsed = parseOutputSegments(
    [
      '<attachment kind="document" />',
      '<attachment path="./missing-kind.png" />',
      '<attachment path="./bad.bin" kind="bad" />'
    ].join("\n")
  );

  assert.deepEqual(parsed.filter((segment) => segment.kind === "attachment").map((segment) => segment.entries[0]), [
    {
      path: null,
      kind: "document",
      rawKind: "document",
      error: "path is required"
    },
    {
      path: "./missing-kind.png",
      kind: null,
      rawKind: null,
      error: "kind is required"
    },
    {
      path: "./bad.bin",
      kind: null,
      rawKind: "bad",
      error: 'unsupported kind "bad"'
    }
  ]);
});

test("parseOutput keeps legacy attachments blocks as plain text", () => {
  const rawText = [
    "Before",
    "<attachments>",
    '<attachment path="./chart.png" kind="photo" />',
    "</attachments>",
    "After"
  ].join("\n");
  const parsed = parseOutput(rawText);

  assert.equal(parsed.text, rawText);
  assert.deepEqual(parsed.attachments, []);
});

test("parseOutput normalizes valid entries and extracts group messages", () => {
  const parsed = parseOutput(
    [
      "Before",
      '<attachment path="./chart.png" kind="photo" />',
      '<attachment kind="bad" path="./bad.bin" />',
      "<group_message><![CDATA[Visible]]></group_message>",
      "After"
    ].join("\n")
  );

  assert.equal(parsed.text, "Before\n\n\n\nAfter");
  assert.deepEqual(parsed.attachments, [
    {
      path: "./chart.png",
      kind: "photo"
    }
  ]);
  assert.deepEqual(parsed.groupMessages, ["Visible"]);
});

test("parseGroupOutputSegments suppresses explicit no-reply output", () => {
  assert.deepEqual(parseGroupOutputSegments("NO_REPLY"), []);
  assert.deepEqual(parseGroupOutputSegments("\n  NO_REPLY  \n"), []);
});

test("parseGroupOutputSegments requires an explicit reply marker for raw group text", () => {
  assert.deepEqual(parseGroupOutputSegments("This should stay private scratch text."), []);
});

test("parseGroupOutputSegments parses multiple replies and path-only attachment lines", () => {
  const segments = parseGroupOutputSegments(
    [
      "REPLY",
      "Here is the plan.",
      "",
      "ATTACH ./artifacts/plan.txt",
      "REPLY @alice",
      "The chart is attached.",
      "ATTACH /tmp/chart.png",
      "ignored scratch"
    ].join("\n")
  );

  assert.deepEqual(segments, [
    {
      kind: "group_message",
      text: "Here is the plan.",
      mention: null
    },
    {
      kind: "attachment",
      rawText: "ATTACH ./artifacts/plan.txt",
      entries: [
        {
          path: "./artifacts/plan.txt",
          kind: "document",
          rawKind: null,
          error: null
        }
      ]
    },
    {
      kind: "group_message",
      text: "@alice The chart is attached.",
      mention: "@alice"
    },
    {
      kind: "attachment",
      rawText: "ATTACH /tmp/chart.png",
      entries: [
        {
          path: "/tmp/chart.png",
          kind: "photo",
          rawKind: null,
          error: null
        }
      ]
    }
  ]);
});

test("parseGroupOutputSegments records missing attachment paths", () => {
  const segments = parseGroupOutputSegments(
    [
      "REPLY",
      "Here is the file.",
      "ATTACH"
    ].join("\n")
  );

  assert.deepEqual(segments, [
    {
      kind: "group_message",
      text: "Here is the file.",
      mention: null
    },
    {
      kind: "attachment",
      rawText: "ATTACH",
      entries: [
        {
          path: null,
          kind: null,
          rawKind: null,
          error: "path is required"
        }
      ]
    }
  ]);
});
