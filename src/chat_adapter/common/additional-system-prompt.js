import fs from "node:fs";

import { toErrorMessage } from "../../utils.js";

export function readProfileInstructions(agent) {
  const filePath = String(agent?.profileInstructionsPath ?? "").trim();
  if (!filePath) {
    return "";
  }

  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }
    throw new Error(`Failed to read profile instructions at ${filePath}: ${toErrorMessage(error)}`);
  }
}

export function buildAdditionalSystemPrompt({
  profileInstructions = "",
  relayInstructions = ""
} = {}) {
  const profileText = String(profileInstructions ?? "").trim();
  const relayText = String(relayInstructions ?? "").trim();

  if (!profileText) {
    return relayText || null;
  }
  if (!relayText) {
    return profileText;
  }

  return [
    "# Profile Instructions",
    "",
    profileText,
    "",
    "# Relay Output Contract",
    "",
    relayText
  ].join("\n");
}
