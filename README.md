# AnyAgent

Run CLI coding agents from chat platforms.

The current implementation ships one CLI adapter (`codex`) and one chat platform adapter
(`telegram`). The internal layout is ready for additional CLI agents such as Claude Code
and Pi, and additional chat platforms such as Mattermost.

![codex in telegram example](./assets/example.png)

## Start

Run it directly without installing the package globally:

```bash
npx anyagent
```

Foreground mode keeps the relay attached to the current terminal. If you close the terminal, log out, reboot the computer, or the process crashes, the relay stops.

If you used the previous `codex-telegram-relay` package, the CLI and local
runtime directory have intentionally changed. Move any local config you want to
keep from `~/.codex-telegram-relay/config.json` to `~/.anyagent/config.json`.

## Adapter Layout

- CLI adapters live in `src/cli_adapter/<agent>/`.
- Chat platform adapters live in `src/agent_adapter/<platform>/`.
- Current adapters: `src/cli_adapter/codex/` and `src/agent_adapter/telegram/`.

## Config

Default config path: `~/.anyagent/config.json`

Example:

```json
{
  "allowedUsernames": ["your-telegram-username"],
  "bots": [
    {
      "name": "anyname",
      "token": "YOUR_TELEGRAM_BOT_TOKEN",
      "workdir": "/Users/you/project",
      "auto": "medium",
      "model": "gpt-5.4",
      "reasoningEffort": "xhigh"
    }
  ]
}
```

Notes:

- Top-level `allowedUsernames` is optional and merged into every bot.
- Bot-level `allowedUsernames` is optional and is merged with the top-level list.
- `allowedUsernames` matching is case-insensitive and accepts values with or without `@`.
- `name` must be unique and may contain only letters, numbers, `_`, and `-`.
- `workdir` is optional. If omitted, the relay uses your home directory. It must already exist.
- `auto` defaults to `medium`.
- `model` and `reasoningEffort` default to `default`, which means the relay does not pass an override to `codex exec`.
- `auto: low` maps to `codex exec --sandbox read-only`.
- `auto: medium` maps to `codex exec --sandbox workspace-write`.
- `auto: high` maps to `codex exec --dangerously-bypass-approvals-and-sandbox`.
- If you do not know your Telegram username, send the bot any message once. The unauthorized reply shows the normalized username to add.
- Multiple bots can be configured in one file and run in one process.

## Persistent Deployment

The relay does not daemonize itself and does not restart itself after crashes or reboots. For always-on usage, run it under a process manager.

### PM2 Example

Use PM2 when you want the relay to keep running in the background and restart automatically after crashes:

```bash
npm install -g pm2 anyagent
pm2 start anyagent --name anyagent
pm2 save
```

Useful PM2 commands:

- `pm2 status`
- `pm2 logs anyagent`
- `pm2 restart anyagent`
- `pm2 stop anyagent`

## Telegram Commands

- `/status` shows running state, current workdir, auto/model/reasoning values, the latest context length, and the queued messages for the current chat.
- `/workdir` shows the current bot workdir.
- `/workdir <path>` changes the bot workdir. Only absolute paths and `~/...` are accepted.
- `/auto` shows the current auto level.
- `/auto <low|medium|high>` sets the auto level for future runs in the current chat and persists the bot default.
- `/model` shows the current model value.
- `/model <value>` sets the model for future runs in the current chat and persists the bot default. Use `/model default` to return to CLI defaults.
- `/reasoning` shows the current reasoning value.
- `/reasoning <value>` sets reasoning effort for future runs in the current chat and persists the bot default. Use `/reasoning default` to return to CLI defaults.
- `/reset` reloads the current bot defaults from `config.json`, clears chat-specific auto/model/reasoning overrides, and starts a fresh session for this chat.
- `/clear_cache` deletes cached Telegram attachments for the current bot instance.
- `/abort` interrupts Codex and clears the queued messages while keeping the current `threadId`.
- `/new` interrupts Codex, clears queued messages, and drops the current chat's stored `threadId`.

## Behavior

- Only private chats are supported.
- Each `(bot, chat)` pair has its own queue, `threadId`, and usage state.
- Supported Telegram attachments are `photo`, `document`, `video`, `audio`, `voice`, and `animation`.
- `photo` attachments are passed to `codex exec` natively with `--image`. Other supported attachments are downloaded to `~/.anyagent/cache/<bot-name>/c<base36-chat-id>/...` and passed to Codex by local file path in the prompt.
- Captionless photo-only turns send an empty prompt plus one or more `--image` flags.
- Telegram media albums are grouped by `media_group_id` and submitted as one logical Codex turn.
- Attachments larger than 20 MB are rejected.
- Fresh prompts use `codex exec --json --skip-git-repo-check`; continued prompts use `codex exec resume`.
- Fresh interactive threads inject relay-specific `developer_instructions` that tell Codex to prefer Telegram HTML-compatible output.
- The relay persists `threadId` from `thread.started` and the latest `context_length` for the chat.
- `context_length` is derived from the final `token_count.last_token_usage` event in the thread's rollout file under `~/.codex/sessions/...`.
- Completed `agent_message` items become the visible final reply.
- Non-message items such as `reasoning`, `web_search`, and `command_execution` reuse one in-flight Telegram message that is edited as progress changes.
- Telegram sends replies with `HTML` parse mode first, then falls back to `MarkdownV2`, then plain text if parsing still fails.
- Slash commands that change bot settings persist those defaults to `config.json`. They apply immediately to the invoking chat; other already-loaded chats keep their current in-memory settings until restart.
- `/clear_cache` is bot-wide. It clears only `~/.anyagent/cache/<bot-name>/` and refuses to run while turns or media albums are pending.
- `/workdir <path>` is bot-wide. It updates the stored bot workdir, aborts the invoking chat's current run, clears that chat's queue, and resets that chat to a fresh Codex session.
- `/abort` affects only the interactive run and queue for the current chat.
