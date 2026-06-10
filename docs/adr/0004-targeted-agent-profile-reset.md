# Targeted Agent Profile Reset

AnyAgent distinguishes **Conversation Reset** from **Agent Profile Reset**: a Conversation Reset refreshes one conversation's session state and profile defaults without changing its chat binding, while an Agent Profile Reset reloads the profile's chat bindings, reconciles running runtimes for that profile, and resets both live and durable conversations historically associated with the profile. Chat-window and CLI Conversation Reset use the same command semantics. Reset preserves schedule definitions, reloads them from durable conversation state, and resyncs timers for active bindings; CLI-driven reset is online-only and must talk to the running relay process, single-conversation reset requires the full conversation selector, and profile reset reports concise counts for binding reconciliation, conversation resets, schedule timer resyncs, and failures. We chose this split so a single conversation can recover or reload schedules without being invalidated by binding edits, while operators still have a targeted alternative to a full relay restart when adding, removing, or changing bindings for one profile; historical association also prevents removed bindings from leaving stale session snapshots behind if they are later re-added.

During Agent Profile Reset, AnyAgent restarts a chat binding runtime when transport identity or connectivity changes, such as token, server URL, username, or binding identity. It updates a runtime in place when only authorization lists or profile-derived defaults change.

Agent Profile Reset applies Conversation Reset behavior to affected live conversations, including aborting active foreground runs, aborting active background scheduled runs, suppressing stale background completion notifications, and clearing queued turns, so stale in-flight work does not continue under old profile settings.

Agent Profile Reset resets live conversations before durable-only conversations. Durable state files for live conversations are not reset a second time during the durable scan; their state is already rewritten by the live reset path. Durable conversations historically associated with removed bindings are still reset, but their schedules remain dormant because no active chat binding runtime exists to run timers or deliver output.

Agent Profile Reset is best-effort rather than atomic. Removed bindings are stopped, unchanged or successfully updated bindings keep running, and changed bindings keep their old runtime if the replacement cannot start. If a replacement starts but the old runtime cannot stop, the replacement is stopped and the old runtime remains registered.

When a binding key has moved from another Agent Profile to the profile being reset, Agent Profile Reset stops the existing runtime for that binding key before starting the new profile's runtime. If the old runtime cannot stop, the new runtime is not started and the old runtime remains registered. Runtime registration refuses implicit overwrites; replacement must be explicit.

When multiple binding changes are present, Agent Profile Reset reconciles them as one batch with per-binding outcomes: valid additions and replacements start, moved bindings first stop the previous owner runtime, valid removals stop, failed additions are skipped, and failed replacements or failed moved-binding stops leave the old runtime running while the command reports errors.

Agent Profile Reset is serialized per Agent Profile so concurrent resets and incoming work do not interleave with runtime reconciliation. The implementation should keep this locking simple and robust.

Incoming chat events and schedule triggers for an Agent Profile wait behind that profile's reset lock and then process normally with the refreshed runtime state.

CLI reset exits successfully only when all requested reset work succeeds. Partial success still applies completed changes but exits non-zero and reports failures.

Conversation Reset user-facing text names "current agent profile defaults" rather than "config defaults" so it does not imply chat binding fields were reloaded.

CLI Agent Profile Reset reports results only to the CLI and does not send reset notifications into affected chats.

The CLI talks to the running relay through a local loopback HTTP control endpoint with a generic command envelope. Reset is the only command implemented initially, but the envelope leaves room for other chat-control commands without changing the transport contract.

Control endpoint discovery is keyed by the canonical config path, so `anyagent --config <path> reset ...` targets the relay process that was started with the same resolved config path.

The control endpoint binds only to loopback and requires a bearer token stored in the per-config control file. The control file is written with private file permissions before the token is written. CLI commands read the token automatically from that file; users do not pass the token manually.

The CLI treats a successful HTTP request as the only proof that a relay is controllable. If the per-config control file is stale because the relay exited or crashed, the CLI reports that the relay is not running and never falls back to offline state mutation.

The reset CLI keeps a compact syntax but validates scope strictly: `anyagent reset --agent <id>` performs Agent Profile Reset, while Conversation Reset also requires platform, chat binding, and conversation id. `anyagent reset --help` shows CLI usage instead of being parsed as a reset option.

Conversation Reset reloads only the Agent Profile defaults by agent id and updates the profile-derived portion of the live conversation binding. It does not reload or change chat binding fields such as platform identity, tokens, server URLs, bot usernames, allowed users, or manager users.

When Agent Profile Reset updates an existing binding runtime in place, it also updates the runtime binding config and each live session's binding config before applying Conversation Reset behavior, so live sessions use the refreshed profile defaults.

Authorization-only chat binding changes take effect in place during Agent Profile Reset by updating the runtime's allowed and manager usernames without restarting the chat transport.
