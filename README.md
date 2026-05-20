# AnyAgent

[![CI](https://github.com/kky42/anyagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/anyagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40kky42%2Fanyagent.svg)](https://www.npmjs.com/package/@kky42/anyagent)

[English](./README.md) | [简体中文](./README.zh-CN.md)

Run Codex, Claude, or Pi from Telegram.

AnyAgent in Telegram

![AnyAgent in Telegram](./assets/example.png)

## Why AnyAgent

- Keep using the CLI agent you already set up locally, in Telegram private chats, with the same config and no migration.
- See live streaming events, so the agent's current state stays visible while it works.
- Use a full set of slash commands for a chat flow that feels close to the local CLI.
- Add only a 7-line attachment contract to the prompt, keeping the relay non-invasive and close to native agent behavior.

## Quick Start

Install AnyAgent globally:

```bash
npm install -g @kky42/anyagent
```

Create a Telegram bot with [BotFather](https://t.me/BotFather), then create an AnyAgent profile:

```bash
anyagent add main codex
```

Edit the generated config:

```bash
~/.anyagent/agents/main/config.json
```

Set your Telegram bot username, bot token, allowed Telegram username, and local workdir.

Start the relay:

```bash
anyagent
```

Open your bot in Telegram and send:

```text
/status
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
      "groupHistory": {
        "hours": 24,
        "messages": 1000
      },
      "bots": [
        {
          "username": "your_bot_username",
          "token": "YOUR_TELEGRAM_BOT_TOKEN"
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
| `allowedUsernames` | Telegram usernames allowed to use this bot. |
| `groupHistory.hours` | Group-chat context window in hours. Defaults to `24`. |
| `groupHistory.messages` | Group-chat context window in observed messages. Defaults to `1000`. |
| `bots[].token` | Telegram bot token from BotFather. |

The `groupHistory` block is optional. If it is omitted, AnyAgent uses the defaults shown above.

If you do not know your Telegram username, send the bot any message once. The unauthorized reply shows the normalized username to add.

## Telegram Group Chats

In group chats, AnyAgent only runs when a message explicitly mentions the bot, for example `@your_bot_username summarize this`.

When triggered, the agent receives observed group context plus the triggering message. Context is limited by `groupHistory.hours`, `groupHistory.messages`, and the previous trigger boundary, so messages already sent to the agent are not resent on the next trigger. Attachments from historical context are shown as metadata only. The relay downloads attachments only from the triggering message and the message it replies to.

Telegram bots cannot fetch arbitrary past group history through the Bot API. After a daemon restart, AnyAgent starts with an empty observed group history. If the bot runs with Telegram Privacy Mode enabled, Telegram may only deliver commands, mentions, and replies to the bot; disable Privacy Mode or make the bot an admin if you need broader observed context.

## Telegram Commands

| Command | Purpose |
| --- | --- |
| `/status` | Show current state, CLI, workdir, settings, context length, and queued messages. |
| `/cli` | Show or change the current CLI. |
| `/workdir` | Show or change the current workspace. |
| `/auto` | Show or change the permission level. |
| `/model` | Show or change the model override. |
| `/reasoning` | Show or change reasoning effort. |
| `/abort` | Stop the active run and clear queued messages. |
| `/new` | Start a fresh agent session for this chat. |
| `/reset` | Reload config from disk and clear chat-specific overrides. |
| `/clear_cache` | Delete cached attachments for this chat. |

Examples:

```text
/cli claude
/workdir ~/projects/my-app
/auto high
/model default
/reasoning high
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

- Only Telegram private chats are supported.
- Messages sent while the relay is stopped are discarded on startup.
- Supported attachments: photos, documents, videos, audio, voice messages, and animations.
- Attachments larger than 20 MB are rejected.
- Chat-specific command changes only affect that Telegram chat.
- Local config and runtime files live under `~/.anyagent/`.

## Migration From codex-telegram-relay

The package and local runtime directory changed.

Move any config you want to keep into:

```bash
~/.anyagent/agents/<profile-name>/config.json
```
