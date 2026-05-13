/**
 * @typedef {object} CliAction
 * @property {"session_started" | "turn_completed" | "progress" | "error" | "message" | "context_length"} kind
 * @property {string | null | undefined} [sessionId]
 * @property {string | undefined} [text]
 * @property {number | null | undefined} [contextLength]
 */
