function normalizeText(value) {
  return String(value ?? "").trim();
}

export function buildReferenceContextBlock(referenceText) {
  const normalized = normalizeText(referenceText);
  if (!normalized) {
    return "";
  }
  return `Reference context:\n${normalized}`;
}

export function appendReferenceContext(messageText, referenceText) {
  const normalizedMessage = normalizeText(messageText);
  const referenceBlock = buildReferenceContextBlock(referenceText);
  if (!referenceBlock) {
    return normalizedMessage;
  }
  if (!normalizedMessage) {
    return referenceBlock;
  }
  return `${normalizedMessage}\n\n${referenceBlock}`;
}
