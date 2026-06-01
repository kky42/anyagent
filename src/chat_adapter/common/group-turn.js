export function buildGroupInputMessage(groupInput = {}) {
  const messages = Array.isArray(groupInput.messages) ? groupInput.messages.filter(Boolean) : [];
  if (messages.length === 0) {
    return "";
  }

  const intro = groupInput.includesRoot
    ? "This transcript includes the thread root followed by messages since your last turn."
    : "Messages since your last turn:";

  return [intro, ...messages].join("\n\n").trim();
}

export function mergeGroupInput(target = {}, source = {}) {
  return {
    ...target,
    includesRoot: Boolean(target.includesRoot || source.includesRoot),
    messages: [
      ...(Array.isArray(target.messages) ? target.messages : []),
      ...(Array.isArray(source.messages) ? source.messages : [])
    ]
  };
}

export function mergeGroupTurns(target, source) {
  target.groupInput = mergeGroupInput(target.groupInput, source.groupInput);
  target.promptText = buildGroupInputMessage(target.groupInput);
  return target;
}
