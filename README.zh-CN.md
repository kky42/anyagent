# AnyAgent

[![CI](https://github.com/kky42/anyagent/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/anyagent/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40kky42%2Fanyagent.svg)](https://www.npmjs.com/package/@kky42/anyagent)

[English](./README.md) | [简体中文](./README.zh-CN.md)

把 Codex、Claude 或 Pi 直接带到 Telegram 或 Mattermost 里用。

AnyAgent in Telegram

![AnyAgent in Telegram](./assets/example.png)

## 为什么选 AnyAgent

- 直接复用你本地已经配好的 CLI agent 和配置，在 Telegram 或 Mattermost 聊天里继续用，无需迁移。
- direct chat 里支持实时进度输出，agent 运行时也会显示 typing 状态。
- 完整的聊天命令，让聊天里的体验接近本地 CLI。
- 使用很小的输出协议控制文件和群聊可见消息，relay 行为清晰、容易检查。

## 快速开始

全局安装 AnyAgent：

```bash
npm install -g @kky42/anyagent
```

先用 [BotFather](https://t.me/BotFather) 创建一个 Telegram bot，或创建 Mattermost bot account 和 access token，然后创建 AnyAgent profile：

```bash
anyagent add main codex
```

编辑生成的配置文件：

```bash
~/.anyagent/agents/main/config.json
```

填入聊天平台 bot 凭证、允许访问的 username、manager username，以及本地 workdir。

启动 relay：

```bash
anyagent
```

打开你的 Telegram 或 Mattermost bot，在 Telegram 发送 `/status`，在 Mattermost 发送 `!status`：

```text
/status
!status
```

## 配置

每个 profile 都位于 `~/.anyagent/agents/<profile-name>/`。

较完整的配置示例：

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

重要字段：

| 字段 | 含义 |
| --- | --- |
| `profile.cli` | 要运行的本地 agent CLI：`codex`、`claude` 或 `pi`。 |
| `profile.workdir` | agent 使用的本地工作目录。必须是已存在的绝对路径或 `~/...`。 |
| `profile.auto` | agent 执行动作时的权限等级：`low`、`medium` 或 `high`。 |
| `profile.model` | 可选的模型覆盖配置。使用 `default` 表示沿用 CLI 默认值。 |
| `profile.reasoningEffort` | 可选的 reasoning 覆盖配置。使用 `default` 表示沿用 CLI 默认值。 |
| `allowedUsernames` | direct/private chat 里允许和 agent 对话的聊天平台 username。group-like chat 里普通参与者消息不受这个列表限制。 |
| `managerUsernames` | 允许运行聊天命令的 username。省略时使用 `allowedUsernames` 作为 manager。manager 在 direct/private chat 中会自动获得访问权限。 |
| `bots[].token` | BotFather 提供的 Telegram bot token。 |
| `mattermost.bots[].serverUrl` | Mattermost server 的基础 URL。 |
| `mattermost.bots[].token` | Mattermost bot access token。 |

如果你不知道自己的 Telegram username，先给 bot 发送任意消息。未授权回复里会显示需要加入配置的标准化 username。

## Telegram 群聊

在 group 和 supergroup 里，只要聊天平台把非命令消息投递给 bot，AnyAgent 就会触发 agent，或把这条消息合并进下一次等待处理的 agent turn。agent 正在运行时收到多条未处理群消息，AnyAgent 会按投递顺序把它们合并成一段 plain-text transcript，包含时间、显示名、handle、消息正文，以及紧贴对应消息的已下载附件。

群聊命令必须在支持的位置提到当前 bot：命令前（`@your_bot_username /status`）、命令 token 内（`/status@your_bot_username`），或紧跟在命令后、命令参数前（`/status @your_bot_username`、`/auto @your_bot_username high`）。位于命令参数之后的 target，例如 `/auto high @your_bot_username`，不会被解析为命令 target。使用这些 target 形式指向其他 bot 的命令会被静默忽略。命令形态的消息不会发送给 agent。

Telegram forum topic 使用独立 agent session。普通 group reply 不会创建独立 session。

Telegram Bot API 不能读取任意历史群聊消息。daemon 重启后，AnyAgent 会启动新的 session，只能看到启动后被投递给 bot 的消息。如果 bot 开启了 Telegram Privacy Mode，Telegram 可能只投递命令、提及 bot 的消息和对 bot 的回复；如果需要每条群消息都触发 agent，需要关闭 Privacy Mode 或把 bot 设为管理员。
Telegram bot 也收不到其他 bot 发出的消息，所以同一个群里的一个 bot 不会因为另一个 bot 的发言而触发。

## Mattermost 聊天

在 direct message 里，每个 Mattermost direct channel 对应一个 agent session。在普通 channel 和 group message 里，每个非命令 post 都会触发 agent，或合并进下一次等待处理的 agent turn。

Mattermost channel post、group message 和 thread 都属于 group-like chat。Mattermost thread 会按 thread root 创建独立 agent session。thread 的第一次 turn 会把 thread root 当作普通 transcript message 放在新消息前面。

Mattermost group-like command 必须在支持的位置提到当前 bot：命令前（`@your_bot_username !status`）、命令 token 内（`!status@your_bot_username`），或紧跟在命令后、命令参数前（`!status @your_bot_username`、`!auto @your_bot_username high`）。位于命令参数之后的 target，例如 `!auto high @your_bot_username`，不会被解析为命令 target。使用这些 target 形式指向其他 bot 的命令会被忽略，包括 `@other_bot !status` 和 `@other_bot /status`。

Mattermost 输出使用原生 Markdown 渲染，包括表格和 fenced code block。relay 会用 Mattermost post edit 显示 transient progress，并用 WebSocket typing indicator 表示运行中。
和 Telegram 不同，Mattermost bot account 可以收到同一 channel 或 thread 里其他 bot 发出的 post。AnyAgent 仍会忽略自己发出的 bot post；但其他 bot 的 post 可能出现在 transcript 中，也可能触发 agent。

## Agent 输出协议

在 direct/private chat 里，agent 的普通文本会直接发送到聊天里。任何聊天类型里如果要发送本地文件，把每个 `ATTACH` directive 单独放在一行：

```text
ATTACH ./artifacts/chart.png
```

在 group-like chat 里，agent 的 raw text 不会发送到群里。如果不需要可见回复，输出必须完全等于：

```text
NO_REPLY
```

可见群消息必须使用 `REPLY` block。需要随这条回复发送文件时，把 `ATTACH` 放在对应的 `REPLY` block 内：

```text
REPLY
Message to the group.
ATTACH ./artifacts/chart.png

REPLY @alice
Message to a specific participant.
```

只有 `REPLY` block 内的内容会发送到 group-like chat。`REPLY` block 外的文本会被当作 private scratch，不会投递。relay 会按 final agent output 里的出现顺序发送可见群消息和附件。中间事件不会发送到 group-like chat。

## 聊天命令

Telegram 命令使用 `/`。Mattermost 命令使用 `!`，因为 Mattermost 会先处理 `/` slash command；除非另行配置 slash-command integration，否则这类命令不会投递到这个 WebSocket relay。

所有聊天命令都要求 manager username。direct/private chat 里 bot target 可省略。group-like chat 里，缺少受支持 bot target 的命令会被可见警告拒绝，指向其他 bot 的命令会被忽略，未知命令会被拒绝而不是发送给 agent。支持的 group target 位置是命令前、命令 token 内，或紧跟在命令后且位于任何命令参数之前。

| Telegram | Mattermost | 用途 |
| --- | --- | --- |
| `/status` | `!status` | 查看当前状态、CLI、workdir、配置、context length 和排队消息。 |
| `/cli` | `!cli` | 查看或切换当前 CLI。 |
| `/workdir` | `!workdir` | 查看或切换当前工作目录。 |
| `/auto` | `!auto` | 查看或切换权限等级。 |
| `/model` | `!model` | 查看或切换模型覆盖配置。 |
| `/reasoning` | `!reasoning` | 查看或切换 reasoning effort。 |
| `/abort` | `!abort` | 停止当前运行，并清空排队消息。 |
| `/new` | `!new` | 为当前聊天启动一个新的 agent session。 |
| `/reset` | `!reset` | 为当前聊天重新加载配置默认值，并清除当前聊天的覆盖配置。 |
| `/clear_cache` | `!clear_cache` | 删除当前聊天的附件缓存。 |
| `/schedule` | `!schedule` | 查看或管理当前聊天的定时运行。 |

示例：

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
/schedule add background news 0 9 * * * summarize overnight updates
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
!schedule add heartbeat pulse */5 * * * * check the queue
@your_bot_username !auto high
!auto@your_bot_username high
!auto @your_bot_username high
```

`/schedule add` 和 `!schedule add` 支持多行格式或单行格式。多行格式中，第一行是 `schedule add <heartbeat|background> <name>`，第二行是五字段 cron 表达式，后续行是 prompt。单行格式中，在 name 后写五个 cron 字段，然后写 prompt。`heartbeat` schedule 会在当前聊天 session 中排入一个普通 turn。`background` schedule 会启动一个新的 agent turn，并在完成后发送带标记的通知。

## 使用 PM2 持久部署

如果希望 AnyAgent 常驻后台运行，可以全局安装 AnyAgent 并用 PM2 管理：

```bash
npm install -g @kky42/anyagent pm2
pm2 start anyagent --name anyagent
pm2 save
```

如果使用自定义配置目录，把参数放在 `--` 后面传给 AnyAgent：

```bash
pm2 start anyagent --name anyagent -- --config /path/to/agents
pm2 save
```

常用 PM2 命令：

```bash
pm2 status
pm2 logs anyagent
pm2 restart anyagent
pm2 stop anyagent
```

需要让全局配置变更生效时，重启 relay 进程。进程重启会从磁盘重新加载所有 agent profile 和聊天绑定；新增 agent 会开始运行，删除的 agent 会停止，token、workdir、manager、model 或权限默认值等变更也会生效。聊天里的 `/reset` 只影响当前 chat session，不是全局 relay reload。

更新 AnyAgent 并重启 relay：

```bash
npm install -g @kky42/anyagent@latest
pm2 restart anyagent
pm2 save
```

## 说明和限制

- relay 启动时会丢弃停止期间收到的消息。
- 支持 Telegram 和 Mattermost 聊天。群聊或 channel 消息在聊天平台投递给 bot 时会触发运行。
- Telegram 支持的附件类型：照片、文档、视频、音频、语音消息和动画。Mattermost 支持文件附件。
- inbound 聊天附件超过 20 MB 会被拒绝。agent 使用 `ATTACH` 发送的 outbound 本地文件限制为 50 MB。
- 通过 slash command 修改的配置只影响当前 chat session。
- 本地配置和运行时文件位于 `~/.anyagent/`。

## 从 codex-telegram-relay 迁移

包名和本地运行目录已经变更。

如果需要保留旧配置，请移动到：

```bash
~/.anyagent/agents/<profile-name>/config.json
```
