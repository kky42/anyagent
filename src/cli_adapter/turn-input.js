/**
 * @typedef {object} Turn
 * @property {string} promptText
 * @property {any[]} attachments
 */

export function formatInputAttachment(attachment) {
  const localPath = String(attachment?.localPath ?? attachment?.path ?? "unavailable").trim() || "unavailable";
  const kind = String(attachment?.kind ?? "document").trim() || "document";
  return [
    "Attached file:",
    `- path: ${localPath}`,
    `- kind: ${kind}`
  ].join("\n");
}

function buildAttachmentPrompt(promptText, attachments) {
  const normalizedPrompt = String(promptText ?? "").trim();
  const localAttachments = attachments.filter(Boolean);

  if (localAttachments.length === 0) {
    return normalizedPrompt;
  }

  const attachmentBlock = localAttachments.map(formatInputAttachment).join("\n\n");
  return normalizedPrompt ? `${normalizedPrompt}\n\n${attachmentBlock}` : attachmentBlock;
}

/**
 * @param {Turn} turn
 */
export function buildTurnInputMessage(turn) {
  return buildAttachmentPrompt(turn?.promptText ?? "", turn?.attachments ?? []);
}
