function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTextBlockText(block) {
  if (!isRecord(block) || block.type !== "text") {
    return null;
  }

  return typeof block.text === "string" ? block.text : "";
}

function asToolUseProgress(block) {
  if (!isRecord(block) || block.type !== "tool_use") {
    return null;
  }

  return typeof block.name === "string" && block.name ? block.name : "tool_use";
}

function usageToContextLength(usage) {
  if (!isRecord(usage)) {
    return null;
  }

  const inputTokens = Number(usage.input_tokens);
  const cacheReadInputTokens = Number(usage.cache_read_input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens);
  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(cacheReadInputTokens) ||
    !Number.isFinite(outputTokens)
  ) {
    return null;
  }

  return inputTokens + cacheReadInputTokens + outputTokens;
}

export function parseJsonlLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {any} event
 * @returns {import("../types.js").CliAction[]}
 */
export function eventToActions(event) {
  if (!isRecord(event)) {
    return [];
  }

  switch (event.type) {
    case "system":
      if (event.subtype !== "init") {
        return [];
      }
      return [{ kind: "session_started", sessionId: event.session_id ?? null }];
    case "assistant": {
      if (!isRecord(event.message) || !Array.isArray(event.message.content)) {
        return [];
      }

      const contextLength = usageToContextLength(event.message.usage);
      const contextActions =
        contextLength === null ? [] : [{ kind: "context_length", contextLength }];
      const progressActions = event.message.content
        .map(asToolUseProgress)
        .filter((text) => text !== null)
        .map((text) => ({ kind: "progress", text }));
      const text = event.message.content.map(asTextBlockText).filter((text) => text !== null).join("");
      return text
        ? [...contextActions, ...progressActions, { kind: "message", text }]
        : [...contextActions, ...progressActions];
    }
    case "result": {
      const actions = [];
      if (event.is_error) {
        actions.push({
          kind: "error",
          text: `Claude failed: ${event.errors?.[0] ?? event.subtype ?? "turn failed"}`
        });
      }

      actions.push({ kind: "turn_completed" });
      return actions;
    }
    case "error":
      return [
        {
          kind: "error",
          text: `Claude error: ${event.message ?? "unknown error"}`
        }
      ];
    default:
      return [];
  }
}
