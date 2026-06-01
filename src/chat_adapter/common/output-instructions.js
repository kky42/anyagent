import fs from "node:fs";

function readPromptFile(fileName) {
  return fs.readFileSync(new URL(`./prompts/${fileName}`, import.meta.url), "utf8").trim();
}

function interpolatePrompt(template, values) {
  return String(template ?? "").replace(/\{\{([a-z_]+)\}\}/g, (match, key) => {
    const value = values?.[key];
    return value === null || value === undefined || value === "" ? match : String(value);
  });
}

export const PRIVATE_OUTPUT_DEVELOPER_INSTRUCTIONS = readPromptFile("private-output-contract.md");

export function buildGroupOutputDeveloperInstructions({
  botName = "AnyAgent",
  botHandle = "@unknown"
} = {}) {
  return interpolatePrompt(readPromptFile("group-output-contract.md"), {
    bot_name: botName,
    bot_handle: botHandle
  });
}
