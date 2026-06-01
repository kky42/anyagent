import test from "node:test";
import assert from "node:assert/strict";

import { buildTurnInputMessage } from "../src/cli_adapter/turn-input.js";

test("buildTurnInputMessage returns plain prompt when there are no attachments", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "  inspect this  ",
      attachments: []
    }),
    "inspect this"
  );
});

test("buildTurnInputMessage renders all local attachments as plain text entries", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "inspect",
      attachments: [
        { kind: "photo", localPath: "/tmp/input.jpg" },
        { kind: "document", localPath: "/tmp/spec.pdf" }
      ]
    }),
    [
      "inspect",
      "",
      "Attached file:",
      "- path: /tmp/input.jpg",
      "- kind: photo",
      "",
      "Attached file:",
      "- path: /tmp/spec.pdf",
      "- kind: document"
    ].join("\n")
  );
});

test("buildTurnInputMessage renders unavailable attachment paths", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "",
      attachments: [
        { kind: "photo", localPath: "" }
      ]
    }),
    [
      "Attached file:",
      "- path: unavailable",
      "- kind: photo"
    ].join("\n")
  );
});
