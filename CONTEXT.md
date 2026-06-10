# AnyAgent Relay

AnyAgent relays chat conversations to local CLI agents. This glossary names the chat-scoped concepts that govern how turns, sessions, and scheduled work relate to each other.

## Language

**Agent Profile**:
A named local agent identity that can be bound to chat destinations and owns the default settings used to start **Conversation Sessions**.
_Avoid_: CLI agent, bot, profile directory

**Chat Binding**:
The association between an **Agent Profile** and a chat destination that lets AnyAgent receive and deliver conversation turns through a chat platform.
_Avoid_: Binding info, bot config

**Profile Instructions**:
Per-**Agent Profile** guidance that shapes a **Conversation Session** when that session starts fresh.
_Avoid_: Global system prompt, per-turn prompt, chat instructions

**Conversation**:
A chat-scoped interaction with its own agent context and settings; Telegram forum topics and Mattermost threads are separate conversations.
_Avoid_: Chat window, raw chat id, channel

**Live Conversation State**:
The currently loaded state of a **Conversation** while the relay process is running.
_Avoid_: Memory state, frontend state

**Durable Conversation State**:
The saved state of a **Conversation** that survives relay restarts.
_Avoid_: Cache, config defaults

**Reference Context**:
Previously visible chat content that becomes input context only because a human explicitly quoted or replied to it in a later message; when rendered for the agent, it follows the new message that referenced it.
_Avoid_: Implicit history, automatic transcript merge

**Work Feedback**:
Problems encountered inside the agent's own work, such as tool, script, or command failures that the agent can still interpret and continue from.
_Avoid_: Relay error, run failure

**Run Failure**:
A failure where AnyAgent cannot obtain or complete a normal agent turn result for a **Conversation**.
_Avoid_: Tool feedback, ordinary agent reasoning

**Conversation Session**:
The resumable front-agent context attached to a **Conversation** and used by normal user turns and **Heartbeat Scheduled Turns**.
_Avoid_: Background session, one-off run

**Conversation Reset**:
A reset of one **Conversation** that starts its next **Conversation Session** fresh using current **Agent Profile** defaults without changing its **Chat Binding**.
_Avoid_: Chat-session reset

**Agent Profile Reset**:
A reset that refreshes **Chat Bindings** for one **Agent Profile** and applies reset behavior to all known **Conversations** historically associated with that profile, including both **Live Conversation State** and **Durable Conversation State**.
_Avoid_: Agent reset, global reset

**Delivery Anchor**:
The platform-specific destination details needed to deliver output back into the same **Conversation**, such as a private chat, group topic, or thread.
_Avoid_: Raw conversation id, inferred destination

**Scheduled Run**:
Work requested ahead of time for a specific **Conversation**, delivered either as a **Background Scheduled Run** or a **Heartbeat Scheduled Turn**.
_Avoid_: Cron job, recurring task

**Background Scheduled Run**:
A **Scheduled Run** with fresh agent context whose result is posted back to the **Conversation** as a labeled notification; the notification does not enter the conversation's agent context unless a human explicitly replies to it as reference context.
_Avoid_: Background cron job, invisible agent message

**Heartbeat Scheduled Turn**:
A **Scheduled Run** that becomes a normal queued turn in the **Conversation**, sharing that conversation's agent context and visible reply behavior.
_Avoid_: Heartbeat job, front cron job

## Example Dialogue

Dev: "Should this stock-news check be a Scheduled Run?"

Domain expert: "Yes. If the chat agent should remember it and respond like any other turn, make it a Heartbeat Scheduled Turn. If it should run with fresh context and only post a labeled result, make it a Background Scheduled Run."

Dev: "Does a Mattermost thread get the same schedule as the channel?"

Domain expert: "No. A thread is its own Conversation, so it has its own Scheduled Runs."

Dev: "If I edit a schedule, is that only a saved setting?"

Domain expert: "No. It changes the Live Conversation State immediately and is saved into Durable Conversation State so the change survives restart."
