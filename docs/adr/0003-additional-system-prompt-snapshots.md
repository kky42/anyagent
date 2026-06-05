# Additional System Prompt Snapshots

AnyAgent freezes the combined additional system prompt for each **Conversation Session**: profile `AGENTS.md` is read when the session starts fresh, the relay output contract is appended after it, and that exact prompt snapshot is stored with the session id. We chose this because Codex keeps the first developer-instruction prompt and ignores changed resume overrides, while Claude Code and Pi need the same appended prompt passed again on resumed turns; storing the snapshot gives all supported CLIs one rule and prevents `AGENTS.md` edits from changing a session mid-conversation.

Legacy persisted sessions without a prompt snapshot are invalidated once instead of carrying a compatibility branch. `/new`, `/reset`, `/workdir`, and `/cli` clear the snapshot so the next turn can read current profile instructions.
