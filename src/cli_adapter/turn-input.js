/**
 * @typedef {object} Turn
 * @property {string} promptText
 * @property {any[]} attachments
 */

function buildAttachmentPrompt(promptText, attachments) {
  const normalizedPrompt = String(promptText ?? "").trim();
  const pathReferences = attachments.filter((attachment) => attachment.mode === "path-reference");

  if (pathReferences.length === 0) {
    return normalizedPrompt;
  }

  const attachmentLines = ["<attachments>"];
  for (const [index, attachment] of pathReferences.entries()) {
    attachmentLines.push(`${index + 1}. kind=${attachment.kind} path=${attachment.localPath}`);
  }
  attachmentLines.push("</attachments>");

  const attachmentBlock = attachmentLines.join("\n");
  return normalizedPrompt ? `${normalizedPrompt}\n\n${attachmentBlock}` : attachmentBlock;
}

/**
 * @param {Turn} turn
 */
export function buildTurnInputMessage(turn) {
  return buildAttachmentPrompt(turn?.promptText ?? "", turn?.attachments ?? []);
}
