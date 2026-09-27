<p align="center">
  <img src="apps/web/app/icon.png" alt="Owl-Agent" width="120">
</p>

<h1 align="center">Owl-Agent</h1>

<p align="center">
  <b>Run AI agents as a team. You only make the calls.</b>
</p>

<p align="center">
  <a href="https://github.com/riry521/owl-agents/actions/workflows/ci.yml"><img src="https://github.com/riry521/owl-agents/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.17-339933.svg" alt="Node.js 22.17+">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg" alt="macOS | Linux">
</p>

<p align="center">
  English | <a href="README.ja.md">日本語</a>
</p>

![The Owl-Agent board](docs/images/en/board.jpg)

Owl-Agent is a local orchestration tool where AI agents with different roles work together as a team.

Tell the Advisor what you want. The Manager plans the work, Workers build it in parallel, a Reviewer checks the results, and the finished work is merged into your project.
You are only asked when a decision is needed, such as choosing a direction or handling a failure, and you can answer from your phone.

Agents run through the **Claude Code** or **Codex** CLI you already have installed.

## Features

- **Just talk to it.** Discuss an idea with the Advisor in chat, and it turns the plan into a Work. You can also [reach the Advisor from Slack or Discord](#talk-to-owl-from-slack-or-discord), get notified there, and answer decisions with a button.
- **A team of roles.** Separate agents plan, design, build, and review. Each Worker gets its own Git worktree, so tasks run in parallel without stepping on each other.
- **You only handle decisions.** You get a question only when a choice is needed or a check fails. Decisions always sit at the top of the board.
- **Use it from anywhere.** Install Tailscale and run `owl serve` once, and your phone opens Owl at your own `ts.net` URL. No port forwarding and no login, and only your own devices can reach it. See [Use it from your phone](#use-it-from-your-phone-or-another-computer-tailscale).
- **Picks up where it left off.** All state lives in SQLite. If a process crashes or a provider hits its rate limit, the work resumes automatically.
- **Gets better with use.** Procedures found during work become skills that the Curator keeps improving. Knowledge is stored as Obsidian-compatible Markdown, and project rules are added only after you approve them.
- **Local and safe by default.** Only your own machine can reach Owl unless you opt in. Agent commands go through a permission hook.

## How it works

Owl-Agent follows one idea: **the DB remembers, the Core advances, the AI thinks.**
Instead of asking an AI to remember everything in a long conversation, state lives in the database and a program (the Core) decides who does what next.
Each agent gets only the information it needs for its current task.

```mermaid
flowchart LR
  Owner([You]) -- chat --> Advisor
  Advisor -- creates Work --> Manager
  Manager -- splits into tasks --> W1[Worker]
  Manager --> W2[Worker]
  W1 --> Reviewer
  W2 --> Reviewer
  Reviewer -- verdict --> Manager
  Manager -- done & merged --> Project[(Project)]
  Manager -. decision needed .-> Owner
```

| Role | What it does |
|---|---|
| Advisor | Your counterpart. Shapes the plan and creates Works |
| Manager | Splits a Work into tasks, coordinates them, and makes the final call |
| Worker | Implements tasks. Several Workers run in parallel |
| Reviewer | Verifies each Worker's result |
| Designer / Lead Designer | Designs the work: architecture, data model, API, and implementation approach |
| Librarian / Curator | Organizes and improves knowledge and skills learned from work |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/images/en/advisor.jpg" alt="Chat with the Advisor"><br><b>Advisor</b>: talk through an idea and it becomes a Work</td>
    <td width="50%"><img src="docs/images/en/work-detail.jpg" alt="Work detail"><br><b>Work detail</b>: task progress and review results</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/en/decision.jpg" alt="A pending decision"><br><b>Decisions</b>: each option explains what happens if you pick it</td>
    <td width="50%"><img src="docs/images/en/skills.jpg" alt="Skills"><br><b>Skills</b>: procedures grown from real work, improved by the Curator</td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/en/mobile-board.jpg" alt="The board on a phone" width="280"><br>
  Check progress and make decisions from your phone, wherever you are, over Tailscale
</p>

## Quick Start

```bash
# Prerequisites: macOS 14+ or Linux, Node.js ≥ 22.17.0 and < 23, pnpm 10.15.0
git clone https://github.com/riry521/owl-agents.git
cd owl-agents
./setup.sh

# Configure
# setup.sh creates .env from .env.example when it is absent; edit that file.
# If you are configuring before setup, use: cp .env.example .env && chmod 600 .env
# The example defaults to the offline stub provider.
# For a real run, set OWL_PROVIDER=real and select an installed CLI with
# OWL_PROVIDER_ADAPTER=claude-cli/v1 or codex-cli/v1.
# .env is loaded automatically; explicit process environment values win.

# Open a new terminal, then start Owl and open the Web UI
owl open

# Check health
owl status
owl doctor
```

`setup.sh` adds the repo's `bin/` directory to `PATH` in your shell startup file,
so the `owl` command works from any directory:

| Shell | File |
|---|---|
| zsh | `~/.zshrc` |
| bash | `~/.bash_profile` (macOS) or `~/.bashrc` (Linux) |
| fish | `~/.config/fish/config.fish` |
| other | `~/.profile` |

It adds one line ending in `# owl-agent` and skips this step when the line is
already there. Open a new terminal (or `source` that file) before using `owl`.
If you move the repo, run `./setup.sh` again. Until then, `./bin/owl` works
from the repo root.

Set `OWL_LANG=ja` or `OWL_LANG=en` for CLI and setup messages. If unset,
`LC_ALL`, then `LC_MESSAGES`, then `LANG` determines the language.

The complete dependency inventory, including workspace packages, native build
requirements, optional provider CLIs, and the lockfile policy, is in
[`docs/dependencies.md`](docs/dependencies.md).

## Creating Work

```bash
# Create a new Work item via API
curl -X POST http://localhost:3787/api/v1/works \
  -H "Content-Type: application/json" \
  -d '{"request_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","idempotency_key":"01ARZ3NDEKTSV4RRFFQ69G5FAW","expected_version":0,"payload":{"title":"Build a login page","summary":"Email/password auth","size":"small","project_id":null}}'

# Check status
curl http://localhost:3787/api/v1/works
```

The server decomposes the Work into Tasks, dispatches Workers, runs Reviews, and reports the final verdict — all automatically.

## Web UI

```bash
owl open
# Starts Owl if needed and opens http://127.0.0.1:3787/owl/ in your browser
```

Pages: Board (work overview), Archive, Work detail, Settings (model config and presets), Projects, Advisor (chat).

## CLI Commands

```bash
owl start          # Start server (background)
owl open           # Open the Web UI in your browser (starts Owl if needed)
owl stop           # Stop Owl and its project-managed helper processes
owl restart        # Restart server
owl status         # Show server status
owl doctor         # Run health checks (--json, --strict)
owl cleanup        # Remove stale workspaces
owl serve          # Publish to your tailnet with Tailscale Serve
owl serve --off    # Stop publishing with Tailscale Serve

# Exposing Owl directly on the network without Tailscale requires a bearer token.
OWL_BIND=0.0.0.0 OWL_API_TOKEN='use-a-long-random-value' owl start
```

## Use it from your phone or another computer (Tailscale)

With [Tailscale](https://tailscale.com/), you can open Owl from your phone wherever you are.

1. Install Tailscale on the computer running Owl and on each device you want to use, and sign in with the same account.
2. With Owl running, run this once on the computer:

   ```bash
   owl serve
   ```

3. Open the printed `https://<machine>.<tailnet>.ts.net/owl/` URL in the device's browser.

Tailscale keeps this setting, so after that `owl start` is enough and the same URL keeps working.
To publish on every `owl start` regardless, set `OWL_TAILSCALE_SERVE=1` in `.env`.
Run `owl serve --off` to stop publishing.

Only devices in your own Tailscale network (tailnet) can open this URL, so no login or token is needed.
Owl rejects requests that arrive through Tailscale Funnel, which would reach the public internet.
If you share your tailnet with other people, they can use Owl too.

## Talk to Owl from Slack or Discord

Connect Slack or Discord and you can work with Owl from the chat app you already use.

- **Talk to the Advisor in a channel**, just like in the Web UI. Images and files you send are saved to the Advisor's shared folder, so "look at the screenshot I just sent" just works.
- **Get notified** when a task finishes, fails, or needs a decision.
- **Answer decisions with buttons** right in the notification.

Each connection uses a conversation channel (your messages and the Advisor's replies) and a notification channel. They can be the same channel. Direct messages and other channels are ignored.
Both are optional, and saving the settings connects right away without a restart.

### Slack

1. Open [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, and paste [`docs/slack-manifest.yaml`](docs/slack-manifest.yaml). The Settings screen also has a button that copies it.
2. Install the app to your workspace and copy the **Bot Token** (`xoxb-...`).
3. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope and copy it (`xapp-...`).
4. Invite the bot to the channels you want to use (`/invite @owl-agent`), and copy each channel ID from the bottom of the channel details.
5. In Owl, open **Settings → Integrations → Slack**, enter the tokens and channel IDs, and save.

### Discord

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and copy the token from the **Bot** page. On the same page, turn on **Message Content Intent**.
2. Under **OAuth2 → URL Generator**, choose the `bot` scope and the **Send Messages**, **Read Message History**, and **Embed Links** permissions. Open the generated URL to add the bot to your server.
3. Turn on Developer Mode in Discord (**User Settings → Advanced**), then right-click each channel and choose **Copy Channel ID**.
4. In Owl, open **Settings → Integrations → Discord**, enter the token and channel IDs, and save.

You can also use `owl setup` or the variables in `.env` (see `.env.example`). Tokens are kept in `.env` with mode `600`.

## Running connectors as a separate process (advanced)

Owl starts configured connectors inside the server, so most setups need nothing here.
Existing `SLACK_CHANNEL_ID` / `DISCORD_CHANNEL_ID` settings continue to be used
for both the conversation and notification roles.
The standalone `apps/connectors` command is also available when Slack or
Discord should run as a separate process. It reuses the same full connector
implementation as the server-managed path, including the configured
notification channel, Advisor replies, and interactive Decision buttons. The
Owl server must be running and `OWL_API_BASE`/`OWL_WS_URL` should point to it.
For a single-provider process, `OWL_CONNECTOR_ACCOUNT_ID` remains supported;
the provider-specific `OWL_SLACK_CONNECTOR_ACCOUNT_ID` and
`OWL_DISCORD_CONNECTOR_ACCOUNT_ID` variables take precedence. `--all` requires
both provider-specific variables; a shared variable alone is rejected.

```bash
# Set env vars (see .env.example), then:
node apps/connectors/dist/cli.js --slack
node apps/connectors/dist/cli.js --discord

# For --all, use two provider-owned Connector Account IDs:
OWL_SLACK_CONNECTOR_ACCOUNT_ID=01... \
OWL_DISCORD_CONNECTOR_ACCOUNT_ID=01... \
node apps/connectors/dist/cli.js --all
```

`owl stop` also stops standalone connector or supervisor processes launched
from this checkout before stopping the server. Processes from another Owl
checkout are treated as a separate instance.

## Supervisor (optional)

Process monitor that restarts the server on crash.

```bash
node apps/supervisor/dist/supervisor.js
```

## Workspace Layout

| Path | Package | Purpose |
|------|---------|---------|
| `packages/shared` | `@owl/shared` | Shared types & contracts |
| `packages/db` | `@owl/db` | SQLite database layer |
| `packages/core` | `@owl/core` | Workflow engine & state management |
| `packages/agent-runtime` | `@owl/agent-runtime` | AI role prompt builders & response parsers |
| `packages/providers` | `@owl/providers` | Provider adapters (stub, claude-cli) |
| `apps/server` | `@owl/server` | HTTP/WS server & CLI |
| `apps/web` | `web` | Next.js dashboard |
| `apps/supervisor` | `@owl/supervisor` | Process monitor |
| `apps/connectors` | `@owl/connectors` | Slack & Discord bridges |

## Provider Modes

- **stub**: Hardcoded responses for development/testing (no AI calls and no provider CLI)
- **real**: Spawns the selected `claude` or `codex` CLI subprocess for actual AI execution

Set `OWL_PROVIDER=stub` for deterministic offline use. For real mode, configure the
selected `OWL_PROVIDER_ADAPTER`, model, and executable. Owl checks only the selected
adapter at startup; provider CLIs are external dependencies and are never installed
automatically. Existing per-role Claude/Codex settings remain supported when both
executables are available.

## Supported systems and data

macOS 14+ and Linux are supported for v1. Windows is unsupported/experimental: no
Windows-specific process, native dependency, or service integration is claimed here.

`OWL_DATA_DIR` is the common durable data root for SQLite, logs, PID/state files,
uploads, connector metadata, and settings. The default is `./data` under
`OWL_ROOT`. Connector Tokens are kept in the project `.env` with mode `600`,
alongside custom Provider API keys. Older `.owl-data` files are copied only when
the canonical file is missing; the legacy directory is never deleted or
overwritten. Existing encrypted connector Vaults are accepted for one-time
migration when `OWL_SECRET_PASSPHRASE` is explicitly supplied, but normal
startup never prompts for it.

Back up the complete `OWL_DATA_DIR` while Owl is stopped (including `owl.sqlite`,
settings, and uploads) and the project `.env` if connector access must be
restored. Do not copy secrets or `.env` into source control.

Known v1 limitation: the Typesafe API key settings UI returns a masked value and
stores the key in the mode-0600 settings file. Connector Tokens and custom
Provider API keys are kept in mode-0600 `.env`; restrict access to the project
directory and use a dedicated account.

## License

[MIT](LICENSE)
