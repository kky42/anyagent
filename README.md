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
- Use a small XML output contract for files and group-visible messages, keeping the relay explicit and inspectable.

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

Set your chat bot credentials, allowed username, and local workdir.

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
      "bots": [
        {
          "username": "your_bot_username",
          "token": "YOUR_TELEGRAM_BOT_TOKEN"
        }
      ]
    },
    "mattermost": {
      "allowedUsernames": ["your-mattermost-username"],
      "bots": [
        {
          "serverUrl": "https://mattermost.example.com",
          "username": "your_bot_username",
          "token": "YOUR_MATTERMOST_BOT_TOKEN"
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
| `allowedUsernames` | Chat usernames allowed to use this bot in direct/private chats. Group-like chats currently ignore this list. |
| `bots[].token` | Telegram bot token from BotFather. |
| `mattermost.bots[].serverUrl` | Base URL for the Mattermost server. |
| `mattermost.bots[].token` | Mattermost bot access token. |

If you do not know your Telegram username, send the bot any message once. The unauthorized reply shows the normalized username to add.

## Telegram Group Chats

In group chats and supergroups, every non-command message delivered to the bot triggers the agent or joins the next pending agent turn. If multiple unprocessed group messages arrive while the agent is running, AnyAgent sends them to the agent as one plain-text transcript in delivery order, including timestamp, display name, handle, message text, and downloaded attachments next to the message that carried them.

Relay commands such as `/status@your_bot_username` stay relay commands and are not sent to the agent. Telegram forum topics use separate agent sessions. Ordinary replies inside a group do not create separate sessions.

Telegram bots cannot fetch arbitrary past group history through the Bot API. After a daemon restart, AnyAgent starts fresh sessions and only sees messages delivered after startup. If the bot runs with Telegram Privacy Mode enabled, Telegram may only deliver commands, mentions, and replies to the bot; disable Privacy Mode or make the bot an admin if you need every group message to trigger the agent.
Telegram bots also do not receive messages from other bots, so one bot in a group will not react to another bot's posts.

## Mattermost Chats

In direct messages, each Mattermost direct channel maps to one agent session. In channels and group messages, every non-command post triggers the agent or joins the next pending agent turn.

Mattermost channel posts, group messages, and threads are group-like chats. A Mattermost thread gets its own agent session keyed by the thread root. The first turn in a thread includes the thread root as a normal transcript message before the new message.

Mattermost renders the agent output as native Markdown, including tables and fenced code blocks. The relay uses Mattermost post edits for transient progress and WebSocket typing indicators for active runs.
Unlike Telegram, Mattermost bot accounts can receive posts from other bots in the same channel or thread. AnyAgent still ignores its own bot posts, but another bot's post can appear in the transcript and can trigger the agent.

## Agent Output Contract

In direct/private chats, normal agent text is sent to the chat. To send a local file in any chat type, the agent uses one XML block per file:

```xml
<attachment path="./artifacts/chart.png" kind="photo" />
```

In group-like chats, raw agent text is not sent to the group. Visible group replies must be inside a group-message block:

```xml
<group_message><![CDATA[
Message to the group.
]]></group_message>
```

The relay sends visible group messages and attachments in the order they appear in the final agent output. Intermediate agent events are not sent to group-like chats.

## Chat Commands

Telegram commands use `/`. Mattermost commands use `!` because Mattermost handles `/` slash commands before they reach this WebSocket relay unless you configure a separate slash-command integration.

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
| `/reset` | `!reset` | Reload config from disk and clear chat-specific overrides. |
| `/clear_cache` | `!clear_cache` | Delete cached attachments for this chat. |

Examples:

```text
/cli claude
/workdir ~/projects/my-app
/auto high
/model default
/reasoning high
!cli claude
!workdir ~/projects/my-app
!auto high
!model default
!reasoning high
```

## Persistent Deployment With PM2

For always-on usage, install AnyAgent globally and run it with PM2:

```bash
npm install -g @kky42/anyagent pm2
pm2 start anyagent --name anyagent
pm2 save
```

Useful PM2 commands:

```bash
pm2 status
pm2 logs anyagent
pm2 restart anyagent
pm2 stop anyagent
```

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
- Attachments larger than 20 MB are rejected.
- Chat-specific command changes only affect that chat session.
- Local config and runtime files live under `~/.anyagent/`.

## Migration From codex-telegram-relay

The package and local runtime directory changed.

Move any config you want to keep into:

```bash
~/.anyagent/agents/<profile-name>/config.json
```
