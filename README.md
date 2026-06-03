# AnyAgent

[![CI](https://github.com/kky42/anyagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/anyagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40kky42%2Fanyagent.svg)](https://www.npmjs.com/package/@kky42/anyagent)

[English](./README.md) | [简体中文](./README.zh-CN.md)

Run Codex, Claude, or Pi from Telegram or Mattermost.

AnyAgent in Telegram

![AnyAgent in Telegram](./assets/example.png)

## Why AnyAgent

- Keep using the CLI agent you already set up locally, in Telegram or Mattermost chats, with the same config and no migration.
- See live progress in direct chats and typing indicators while the agent works.
- Use a full set of chat commands for a flow that feels close to the local CLI.
- Use a small output contract for files and group-visible messages, keeping the relay explicit and inspectable.

## Quick Start

Install AnyAgent globally:

```bash
npm install -g @kky42/anyagent
```

Create a Telegram bot with [BotFather](https://t.me/BotFather), or create a Mattermost bot account and personal access token, then create an AnyAgent profile:

```bash
anyagent add main codex
```

Edit the generated config:

```bash
~/.anyagent/agents/main/config.json
```

Set your chat bot credentials, allowed username, manager username, and local workdir.

Start the relay:

```bash
anyagent
```

Open your bot in Telegram or Mattermost and send `/status` in Telegram or `!status` in Mattermost:

```text
/status
!status
```

## Configuration

Each profile lives under `~/.anyagent/agents/<profile-name>/`.

A fuller config example looks like this:

```json
{
  "profile": {
    "cli": "codex",
    "workdir": "/Users/you/projects",
    "auto": "medium",
    "model": "default",
    "reasoningEffort": "default"
  },
  "bindings": {
    "telegram": {
      "allowedUsernames": ["your-telegram-username"],
      "managerUsernames": ["your-telegram-username"],
      "bots": [
        {
          "username": "your_bot_username",
          "token": "YOUR_TELEGRAM_BOT_TOKEN",
          "managerUsernames": ["teammate-who-can-change-settings"]
        }
      ]
    },
    "mattermost": {
      "allowedUsernames": ["your-mattermost-username"],
      "managerUsernames": ["your-mattermost-username"],
      "bots": [
        {
          "serverUrl": "https://mattermost.example.com",
          "username": "your_bot_username",
          "token": "YOUR_MATTERMOST_BOT_TOKEN",
          "managerUsernames": ["teammate-who-can-change-settings"]
        }
      ]
    }
  }
}
```

Important fields:

| Field | Meaning |
| --- | --- |
| `profile.cli` | Local agent CLI to run: `codex`, `claude`, or `pi`. |
| `profile.workdir` | Local workspace used by the agent. Must be an existing absolute path or `~/...`. |
| `profile.auto` | Permission level for agent actions: `low`, `medium`, or `high`. |
| `profile.model` | Optional model override. Use `default` to keep the CLI default. |
| `profile.reasoningEffort` | Optional reasoning override. Use `default` to keep the CLI default. |
| `allowedUsernames` | Chat usernames allowed to talk to the agent in direct/private chats. Group-like chats allow normal participant messages without this list. |
| `managerUsernames` | Chat usernames allowed to run chat commands. If omitted, `allowedUsernames` are used as managers. Managers are automatically allowed in direct/private chats. |
| `bots[].token` | Telegram bot token from BotFather. |
| `mattermost.bots[].serverUrl` | Base URL for the Mattermost server. |
| `mattermost.bots[].token` | Mattermost bot access token. |

If you do not know your Telegram username, send the bot any message once. The unauthorized reply shows the normalized username to add.

## Telegram Group Chats

In group chats and supergroups, every non-command message delivered to the bot triggers the agent or joins the next pending agent turn. If multiple unprocessed group messages arrive while the agent is running, AnyAgent sends them to the agent as one plain-text transcript in delivery order, including timestamp, display name, handle, message text, and downloaded attachments next to the message that carried them.

Group commands must mention the bot in a supported target position: before the command (`@your_bot_username /status`), inside the command token (`/status@your_bot_username`), or immediately after the command (`/status @your_bot_username`, `/auto @your_bot_username high`). Targets after command arguments, such as `/auto high @your_bot_username`, are not parsed as command targets. Commands for another bot using the same target positions are silently ignored. Command-shaped messages are never sent to the agent.

Telegram forum topics use separate agent sessions. Ordinary replies inside a group do not create separate sessions.

Telegram bots cannot fetch arbitrary past group history through the Bot API. After a daemon restart, AnyAgent starts fresh sessions and only sees messages delivered after startup. If the bot runs with Telegram Privacy Mode enabled, Telegram may only deliver commands, mentions, and replies to the bot; disable Privacy Mode or make the bot an admin if you need every group message to trigger the agent.
Telegram bots also do not receive messages from other bots, so one bot in a group will not react to another bot's posts.

## Mattermost Chats

In direct messages, each Mattermost direct channel maps to one agent session. In channels and group messages, every non-command post triggers the agent or joins the next pending agent turn.

Mattermost channel posts, group messages, and threads are group-like chats. A Mattermost thread gets its own agent session keyed by the thread root. The first turn in a thread includes the thread root as a normal transcript message before the new message.

Group-like Mattermost commands must mention the bot in a supported target position: before the command (`@your_bot_username !status`), inside the command token (`!status@your_bot_username`), or immediately after the command (`!status @your_bot_username`, `!auto @your_bot_username high`). Targets after command arguments, such as `!auto high @your_bot_username`, are not parsed as command targets. Commands addressed to another bot with the same target forms, including `@other_bot !status` and `@other_bot /status`, are ignored.

Mattermost renders the agent output as native Markdown, including tables and fenced code blocks. The relay uses Mattermost post edits for transient progress and WebSocket typing indicators for active runs.
Unlike Telegram, Mattermost bot accounts can receive posts from other bots in the same channel or thread. AnyAgent still ignores its own bot posts, but another bot's post can appear in the transcript and can trigger the agent.

## Agent Output Contract

In direct/private chats, normal agent text is sent to the chat. To send a local file in any chat type, put one `ATTACH` directive per file on its own line:

```text
ATTACH ./artifacts/chart.png
```

In group-like chats, raw agent text is not sent to the group. If no visible reply is needed, output exactly:

```text
NO_REPLY
```

Visible group replies must use `REPLY` blocks. Put `ATTACH` inside the `REPLY` block that should carry the file:

```text
REPLY
Message to the group.
ATTACH ./artifacts/chart.png

REPLY @alice
Message to a specific participant.
```

Only content inside `REPLY` blocks is sent to group-like chats. Text outside `REPLY` blocks is private scratch and is not delivered. The relay sends visible group messages and attachments in the order they appear in the final agent output. Intermediate agent events are not sent to group-like chats.

## Chat Commands

Telegram commands use `/`. Mattermost commands use `!` because Mattermost handles `/` slash commands before they reach this WebSocket relay unless you configure a separate slash-command integration.

All chat commands require a manager username. In direct/private chats, the bot target is optional. In group-like chats, commands without a supported bot target are rejected with a visible warning, commands targeting another bot are ignored, and unknown commands are rejected instead of being sent to the agent. Supported group target positions are before the command, inside the command token, or immediately after the command before any command arguments.

| Telegram | Mattermost | Purpose |
| --- | --- | --- |
| `/status` | `!status` | Show current state, CLI, workdir, settings, context length, and queued messages. |
| `/cli` | `!cli` | Show or change the current CLI. |
| `/workdir` | `!workdir` | Show or change the current workspace. |
| `/auto` | `!auto` | Show or change the permission level. |
| `/model` | `!model` | Show or change the model override. |
| `/reasoning` | `!reasoning` | Show or change reasoning effort. |
| `/abort` | `!abort` | Stop the active run and clear queued messages. |
| `/new` | `!new` | Start a fresh agent session for this chat. |
| `/reset` | `!reset` | Reload config defaults for this chat and clear chat-specific overrides. |
| `/clear_cache` | `!clear_cache` | Delete cached attachments for this chat. |
| `/schedule` | `!schedule` | List or manage scheduled runs for this chat. |

Examples:

```text
/cli claude
/workdir ~/projects/my-app
/auto high
/model default
/reasoning high
/schedule list
/schedule add heartbeat pulse
*/5 * * * *
check the queue
@your_bot_username /auto high
/auto@your_bot_username high
/auto @your_bot_username high
!cli claude
!workdir ~/projects/my-app
!auto high
!model default
!reasoning high
!schedule list
!schedule add background news
0 9 * * *
summarize overnight updates
@your_bot_username !auto high
!auto@your_bot_username high
!auto @your_bot_username high
```

`/schedule add` and `!schedule add` use three or more lines: the first line is `schedule add <heartbeat|background> <name>`, the second line is a five-field cron expression, and the remaining lines are the prompt. `heartbeat` schedules enqueue a normal turn in the chat session. `background` schedules run a fresh agent turn and post a marked notification when finished.

## Persistent Deployment With PM2

For always-on usage, install AnyAgent globally and run it with PM2:

```bash
npm install -g @kky42/anyagent pm2
pm2 start anyagent --name anyagent
pm2 save
```

With a custom config directory, pass the config path after `--` so PM2 gives it to AnyAgent:

```bash
pm2 start anyagent --name anyagent -- --config /path/to/agents
pm2 save
```

Useful PM2 commands:

```bash
pm2 status
pm2 logs anyagent
pm2 restart anyagent
pm2 stop anyagent
```

Restart the relay process to apply global config changes. A process restart reloads all agent profiles and chat bindings from disk, so newly added agents start running, removed agents stop, and changed tokens, workdirs, managers, models, or permission defaults are applied. Chat `/reset` only affects the current chat session; it is not a global relay reload.

To update AnyAgent and restart the relay:

```bash
npm install -g @kky42/anyagent@latest
pm2 restart anyagent
pm2 save
```

## Notes And Limits

- Messages sent while the relay is stopped are discarded on startup.
- Telegram and Mattermost chats are supported. Group/channel messages trigger when the chat platform delivers them to the bot.
- Supported Telegram attachments: photos, documents, videos, audio, voice messages, and animations. Mattermost file attachments are supported as files.
- Inbound chat attachments larger than 20 MB are rejected. Outbound local files sent with `ATTACH` are limited to 50 MB.
- Chat-specific command changes only affect that chat session.
- Local config and runtime files live under `~/.anyagent/`.

## Migration From codex-telegram-relay

The package and local runtime directory changed.

Move any config you want to keep into:

```bash
~/.anyagent/agents/<profile-name>/config.json
```
