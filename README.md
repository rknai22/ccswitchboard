# ccswitchboard

Telegram forum topics for Claude Code: **one Telegram group, one long-lived Claude
Code session per topic, an orchestrator session in General.**

You write in the topic «WMS», and the WMS session answers there. You write in
General, and the orchestrator answers: an overview of what goes on where, a new
topic (with its own folder and session), or a task handed to a topic. Every
session is a terminal in Orca, so you can open any of
them and keep working at the keyboard. After a reboot, the sessions come back and
resume their conversations.

## Origin and licence

ccswitchboard is derived from the official Telegram channel plugin for Claude
Code (`anthropics/claude-plugins-official`, `external_plugins/telegram`),
© Anthropic, PBC, Apache License 2.0. The tool interface (`reply`, `react`,
`edit_message`, `download_attachment`), the channel notification format, text
chunking and attachment handling follow that plugin.

New in ccswitchboard:
- the split into a broker and a shim;
- forum topics and the topic registry;
- sessions in Orca and the watchdog;
- the setup wizard;
- the pinned limits message and the morning digest.

Licensed under Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

### How it differs from the official plugin

| | Official plugin | ccswitchboard |
|---|---|---|
| Sessions | one session reads the bot | one session **per forum topic**, plus General |
| Bot token | in the session's plugin config | **only in the broker**; sessions never see it |
| Who polls Telegram | the plugin inside the session | the broker (one `getUpdates` consumer — no 409 between sessions) |
| Access | DM pairing codes, allowlist | one owner, confirmed by a button in the group; only that group and the owner's DM |
| Permission prompts relayed to Telegram | yes | no — sessions run with `--dangerously-skip-permissions` |
| Extras | — | topic creation and forwarding from General, sessions in Orca, pinned Claude limits, morning digest |

## How it works

```
             Telegram (one forum group)
                     │  Bot API (long poll, sends)
          ┌──────────┴──────────┐
          │       broker        │  Bun + grammY · holds the bot token
          │ topics · sessions · │  durable queue (SQLite) · rate limits
          │   pin · digest      │  topic registry · setup / reset
          └──────────┬──────────┘
          NDJSON over TCP (host:port), one connection per session,
          addressed by the topic key the session was launched with
       ┌─────────────┼──────────────┐
   shim (General)  shim (WMS)     shim (…)    ← ccswitchboard plugin = MCP channel server
   Claude Code     Claude Code    Claude Code   one Orca terminal each, in its own folder
```

- **The broker** is the only process that holds the bot token and talks to the
  Bot API.
  - It writes each update to a SQLite queue together with the poll offset, in
    one transaction.
  - It routes the update by `message_thread_id` to that topic's queue (General
    and the owner's DM go to General).
  - An event counts as delivered only when the session's shim acknowledges it.
    After a reconnect, everything unacknowledged is sent again, in order.
  - It sends with the group's rate limits, splits long texts, and moves files as
    bytes. A session can edit or react only to messages of its own topic.
- **The shim** (this repo's `plugin/`) is a Claude Code channel plugin.
  - It has no token and no Telegram code. It connects to the broker with its
    topic key (`CCSB_KEY`) and exposes the official plugin's tools without any
    chat or thread argument: the broker addresses every send by the connection's
    topic.
  - General's session also gets `create_topic` and `forward`. `forward` reposts
    the owner's own message from General in a topic («📨 from the owner via
    General: …») and delivers it to that topic's session. A session's own text
    cannot be forwarded.
- **Topics → sessions.** `create_topic` does all of this:
  - creates the Telegram topic and gives it a fresh key;
  - prepares `<projects_root>/<name>`: `git init` (an existing git folder, e.g.
    a clone of your project, is used as is); `CLAUDE.local.md` from
    `templates/` (only if absent); `CLAUDE.local.md` and `STATUS.json` added to
    `.git/info/exclude`;
  - starts `claude` in an Orca terminal titled `tg:<name>`.

  A watchdog checks every minute that each open topic's shim is connected:
  - **Alive** means the shim is connected, or a Claude process with the
    topic's key is still running. A session cut off from the broker is
    reported, not killed.
  - A dead session is relaunched with `--resume <session id>`. Only terminals
    the broker can prove it created are ever closed.
- **Modules on top of the core:**
  - `pin` — one pinned «Claude limits» message in General, updated every
    5 minutes from the usage poller's file;
  - `digest` — a morning summary per topic from each session's `STATUS.json`,
    built by a script, without the model.

## Requirements

- **Bun** (tested with 1.4.4) on the broker machine and on the session machine
  (the plugin's `.mcp.json` runs `bun`, so it must be on the `PATH` of the
  sessions). `git` and `python3` on the session machine.
- **Claude Code** with channels (research preview), signed in on the session
  machine.
- **Channel allowlist.** A channel plugin only delivers messages if it is
  allowed:
  - **Team / Enterprise organisation.** Set the allowlist in the
    organisation's **server-managed settings** (claude.ai admin):

    ```json
    { "channelsEnabled": true,
      "allowedChannelPlugins": [{ "marketplace": "ccswitchboard", "plugin": "ccswitchboard" }] }
    ```

    This list *replaces* Anthropic's default one for the whole organisation,
    so add every other channel plugin you use.

    File-based managed settings (`/etc/claude-code/managed-settings.json`) are
    **ignored** once server-managed settings exist: only the highest-priority
    source is read.

    Without the allowlist the setup wizard still works (it uses tools), but no
    Telegram message ever reaches a session.
  - **Individual plans.** ccswitchboard is not on Anthropic's default
    allowlist. Start sessions with
    `--dangerously-load-development-channels plugin:ccswitchboard@ccswitchboard`.
    That flag shows a confirmation dialog at every start, so the watchdog
    cannot bring sessions up unattended.
- **Orca** on the session machine: the app or the headless `orca serve`, with
  the `orca` CLI. Used by the sessions module to open one terminal per topic.
- **Telegram:**
  - a bot from @BotFather;
  - a supergroup with **Topics** turned on;
  - the bot as an admin with **Manage topics** and **Pin messages**.

  If the bot does not see plain messages, turn privacy mode off
  (`/setprivacy` → Disable).

## Broker

The broker can run on the session machine or on another one. It is safer as
**another user or another machine** — see [Security model](#security-model).

```sh
git clone <this repo> /opt/ccswitchboard
cd /opt/ccswitchboard/broker && bun install --frozen-lockfile
cp config.example.json /etc/ccswitchboard/config.json   # then edit it
bun /opt/ccswitchboard/broker/src/main.ts serve --config /etc/ccswitchboard/config.json
```

`config.json` is read-only for the broker: it never writes it. The bot token,
the owner and the group go to `<state_dir>/secret.json` (0600), written by the
setup wizard.

| Field | Default | Meaning |
|---|---|---|
| `listen` | `127.0.0.1:2223` | address the shims connect to |
| `state_dir` | `/var/lib/ccswitchboard` | queue DB and `secret.json` |
| `api_root` | `https://api.telegram.org` | Bot API base URL |
| `lang` | `en` | language of the bot's texts: `en` or `ru` |
| `runner` | `[]` | argv prefix that runs a command **on the session machine**; `[]` = this machine. See below |
| `orca` | `orca` | Orca CLI on the session machine |
| `projects_root` | `~/projects` | topic folders live directly in it (on the session machine) |
| `claude_cmd` | `claude --channels plugin:ccswitchboard@ccswitchboard --dangerously-skip-permissions` | how a topic session is started; the broker prepends `CCSB_KEY=<key>` and appends `--resume <id>` |
| `usage_file` | `~/.local/state/ccswitchboard/usage.json` | the usage poller's output on the session machine |
| `timezone` | `Europe/Moscow` | for times in the pin and the digest |
| `digest_at` | `10:00` | daily digest time in `timezone` |

**`runner` must pass argv through unchanged.**
- Good: container exec wrappers that take the command as separate arguments,
  e.g. `["docker", "exec", "-u", "<user>", "-e", "HOME=/home/<user>", "<container>"]`
  (or your container manager's `exec … --` equivalent).
- **Not** a bare `["ssh", "host"]`: ssh joins argv into one remote shell
  string. Topic titles and paths would become shell syntax, and the broker's
  `python3 -c <script>` calls break.
- `$HOME` under the runner must be the session user's home: every `~/…` path
  is resolved through it.

**The first word of `claude_cmd` must be the Claude binary itself**, e.g.
`claude` or its absolute path, not a wrapper script with another name. The
watchdog recognises a live session by that program name among the processes
holding the topic key.

A systemd unit, for example (adapt the paths and the user):

```ini
[Unit]
Description=ccswitchboard broker
After=network-online.target
Wants=network-online.target

[Service]
User=ccswitchboard
ExecStart=/usr/local/bin/bun /opt/ccswitchboard/broker/src/main.ts serve --config /etc/ccswitchboard/config.json
Restart=always
RestartSec=5
UMask=0077
StateDirectory=ccswitchboard
NoNewPrivileges=yes
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

Other commands:
- `bun broker/src/main.ts status --config …` — setup state, bot, group, topic
  and queue counts; never the token;
- `reset` — wipe the setup without the Telegram button, when the bot is lost;
- `key <topic>` — print a topic's key (root or the DB owner only);
- `digest --now` — send the digest now.

## Plugin (on the session machine)

In Claude Code:

```
/plugin marketplace add <path-or-git-url-of-this-repo>
/plugin install ccswitchboard@ccswitchboard
```

Tell the shim where the broker is: put **only** the broker address into
`~/.config/ccswitchboard/env`:

```
CCSB_BROKER=127.0.0.1:2223
```

**Never put `CCSB_KEY` there.** The broker gives each topic session its own key
in its launch command. A key in this file would bind every session on the
machine to one topic.

### Usage poller (for the pinned limits message)

`usage/usage-poll.ts` runs every 5 minutes as a systemd **user** unit of the
user Claude Code is signed in as. It asks Anthropic for the current
5-hour/weekly utilisation with that user's Claude login and writes
`usage_file`.

```sh
cp usage/ccswitchboard-usage.{service,timer} ~/.config/systemd/user/   # adjust the bun and checkout paths inside
systemctl --user daemon-reload && systemctl --user enable --now ccswitchboard-usage.timer
loginctl enable-linger "$USER"
```

The endpoint is **undocumented** (it is what `/usage` uses). If Anthropic
changes it, the pin shows «no data» — never a made-up 0 %. The poller never
refreshes the login token, so while no session runs for a while, the pin says
the data is stale.

## Setup and reset

1. Start the broker (unconfigured).
2. On the session machine, start a session without a topic key:
   `claude --channels plugin:ccswitchboard@ccswitchboard`.
3. Run `/ccswitchboard:setup` and follow the wizard:
   - paste the bot token — the broker checks it with `getMe` and keeps it;
   - add the bot to your forum group as an admin;
   - press «Yes, it's ours» under the bot's message in the group. **Whoever
     presses it becomes the owner.**
4. The broker locks the setup, pins the limits message and starts the General
   session in `<projects_root>/general`.

**After setup:**
- Only the owner's messages in that group and in the owner's DM with the bot
  reach sessions. Everyone else is ignored silently.
- **Turn off "Remain anonymous"** in your group admin rights. An anonymous
  admin posts as the group, and the broker drops those messages (they are only
  logged).
- Topic service events (close, reopen, rename) count only when the owner does
  them.

**Topics in Telegram:**
- **Close** a topic to pause it. Its session is unbound, and new messages there
  get one «This topic is closed — reopen it to continue» and are not queued.
- **Reopen** it, and the session is replaced and resumes its conversation.
  Nothing written while it was closed is replayed.
- **Delete** a topic, and it leaves the registry and its terminal is closed.
  Its folder is always kept.

**Reset:**
- `/ccswitchboard:reset` posts a reset button in General. It lives 10 minutes,
  and only the owner's press counts. It erases the token, the owner, the group
  and the topic registry. Folders and sessions stay, but receive nothing until
  the next setup.
- If the bot or the group is lost, run `bun broker/src/main.ts reset --config …`
  on the broker machine.

## Security model

Be clear about what this protects and what it does not.

- **The token passes through the setup session's history.** You paste it into
  a Claude session: it goes to Anthropic as conversation text and stays in that
  session's history on disk (and in its backups). There is no clean-up, by
  design. If you suspect a leak, `/revoke` it at @BotFather and set up again
  after a reset.
- **"The token stays in the broker" protects only if the broker runs as another
  user or on another machine.** On one machine under one user, the token in
  `secret.json` sits next to the agent: any session could read it, poll the
  bot itself (409) or post anywhere.
- **No isolation between topics against a compromised agent.**
  - All sessions on the session machine are one user, and keys are visible in
    their launch commands.
  - A misbehaving or compromised session can read other topics' keys and folders
    and connect as them.
  - Topics separate the context of well-behaved sessions. They do not separate
    hostile ones.
- **Setup is first come, first served.**
  - Until the owner presses the button, any local session can give the broker
    a token.
  - Whoever presses the claim button becomes the owner.

  Set up right after installing, in a group where only you can press it.
- **Sessions run with `--dangerously-skip-permissions`** (the default
  `claude_cmd`): they act without asking. The topic template asks them to
  push and open PRs only after the owner's «yes» in that topic. That is an
  instruction, not a technical lock.
- The broker trusts only folders directly in `projects_root` (it marks them
  trusted for Claude Code). Forwarding carries only the owner's own words;
  instructions found in files, web pages or other topics are data.

## Known limits

- **Not verified against a live Orca:**
  - whether Orca, after its own restart or a reboot, restores our tabs (and
    re-runs their commands);
  - whether a restored tab keeps its tab id.

  The watchdog does not start a second Claude while one with the topic's key is
  alive. Unrecognisable leftover tabs are never closed for you.
- **Counting live Claude processes** is exact on Linux (`/proc`). On macOS
  `ps -E` can prove presence but not absence. There, an unidentified terminal
  in a topic folder keeps the watchdog from relaunching.
- **Not verified against a live Telegram:** what Telegram answers for a
  deleted topic, `is_topic_message` in General, and the setup events on
  enabling topics.
- The usage endpoint is undocumented (see above).
- Channels are a research preview: the protocol or the flags may change.

## Repository layout

| Path | What |
|---|---|
| `broker/` | the broker (Bun, grammY) — `src/main.ts` is the CLI |
| `plugin/` | the Claude Code channel plugin (shim) and its `setup` / `reset` skills; `plugin/protocol.ts` is the wire contract |
| `templates/` | `CLAUDE.local.md` templates for General and topic sessions |
| `usage/` | the usage poller and its systemd user units |
| `.claude-plugin/marketplace.json` | the plugin marketplace (`ccswitchboard`) |
