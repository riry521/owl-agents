English | [日本語](README.ja.md)

# Owl-Agent

AI agent orchestration system. DB remembers, Core advances, AI thinks.

Owl-Agent manages multi-step AI work through a structured lifecycle — decomposing goals into tasks, dispatching AI workers, reviewing results, and reporting back — without persistent AI conversations.

## Architecture

```
Owner (you)
  → Core (Node.js + SQLite) manages state & workflow
    → Manager decomposes Work into Tasks
    → Workers execute Tasks (with optional Executor subprocesses)
    → Reviewers verify results
    → Manager delivers final verdict
```

**Roles**: Owner (human) plus eight AI roles — Advisor (strategic counsel), Manager (planning & coordination), Designer and Lead Designer (visual/UX), Worker (implementation), Reviewer (verification), Librarian (knowledge triage), Curator (knowledge upkeep)

## Quick Start

```bash
# Prerequisites: macOS 14+ or Linux, Node.js ≥ 22.14.0 and < 23, pnpm 10.15.0
./setup.sh

# Configure
# setup.sh creates .env from .env.example when it is absent; edit that file.
# If you are configuring before setup, use: cp .env.example .env && chmod 600 .env
# The example defaults to the offline stub provider.
# For a real run, set OWL_PROVIDER=real and select an installed CLI with
# OWL_PROVIDER_ADAPTER=claude-cli/v1 or codex-cli/v1.
# .env is loaded automatically; explicit process environment values win.

# Start the server
./bin/owl start

# Check health
./bin/owl status
./bin/owl doctor
```

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
cd apps/web
pnpm dev
# Open http://localhost:3000
```

Pages: Board (work overview), Archive, Work detail, Settings (model config and presets), Projects, Advisor (chat).

## CLI Commands

```bash
./bin/owl start          # Start server (background)
./bin/owl stop           # Stop Owl and its project-managed helper processes
./bin/owl restart        # Restart server
./bin/owl status         # Show server status
./bin/owl doctor         # Run health checks (--json, --strict)
./bin/owl cleanup        # Remove stale workspaces
./bin/owl serve           # Explicitly enable Tailscale Serve
./bin/owl serve --off    # Explicitly disable Tailscale Serve

# Public/remote access is opt-in and requires a bearer token.
OWL_BIND=0.0.0.0 OWL_API_TOKEN='use-a-long-random-value' ./bin/owl start
# Or set OWL_TAILSCALE_SERVE=1 plus OWL_API_TOKEN in .env before ./bin/owl start.
```

## Connectors (optional)

The server automatically starts configured Slack/Discord package connectors.
Slack/Discord are optional; leaving both unconfigured is a normal state and does
not produce a startup or doctor warning. Configure them through `owl setup`, the
Settings screen, or the optional variables in `.env`. Each connector has a
conversation channel (for inbound messages and Advisor replies) and a task
notification channel (for task/decision/system notifications). They may be the
same channel. Direct messages and other channels are ignored. Existing
`SLACK_CHANNEL_ID` / `DISCORD_CHANNEL_ID` settings continue to be used for both
roles.
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
