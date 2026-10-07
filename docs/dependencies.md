# Owl-Agent dependency inventory

This file lists the repository's dependencies, split into "what setup requires,"
"what the workspace packages use," and "external tools optionally required at
runtime." The single source of truth for every resolved transitive dependency
and its integrity hash is the repository root's `pnpm-lock.yaml`. Whenever
`package.json` changes, be sure to update the lockfile too.

## Tools required for setup

| Dependency | Requirement | Purpose |
| --- | --- | --- |
| Node.js | `>=22.17.0 <23` | All runtime, TypeScript build, Next.js |
| Corepack | Bundled with Node.js | Pins `pnpm@10.15.0` |
| pnpm | `10.15.0` | Dependency management for the whole workspace |
| Git | Executable must be on PATH | `owl`'s Git operations, workspace/ops |
| C/C++ toolchain | macOS: Xcode Command Line Tools, Linux: gcc/cc + make | Building native modules such as `better-sqlite3` |
| Python 3 | `python3` | `node-gyp` (native module builds) |

`setup.sh` installs Git, macOS's Xcode CLT, Linux build tools, and Python 3 on
supported OSes when they are missing. It never silently swaps Node.js versions
for safety reasons, and stops if the condition is not met.

## Direct dependencies of workspace packages

The version column shows the manifest specification, with the current lockfile
resolution in parentheses. `workspace:*` and `file:../...` are package links
within the same repository.

| package | runtime dependencies | dev/build dependencies |
| --- | --- | --- |
| `@owl/root` | none | `typescript 5.9.2`, `@types/node 22.15.3` |
| `@owl/shared` | none | uses the root TypeScript toolchain |
| `@owl/db` | `better-sqlite3 12.6.2` | `@types/better-sqlite3 9.6.0`, `@types/node ^20`, `typescript ^5.8.2` |
| `@owl/core` | `@owl/db`, `@owl/shared`, `@typesafe-ai/sdk ^0.6.0 (0.6.0)` | `@types/node ^20`, `typescript ^5.8.2` |
| `@owl/agent-runtime` | `@owl/shared` | `typescript ^5.8.2` |
| `@owl/providers` | none | uses the root TypeScript toolchain |
| `@owl/plugin-sdk` | none | `typescript ^5.0.0` |
| `@owl/connector-slack` | `@owl/plugin-sdk`, `@slack/socket-mode ^2.0.0 (2.0.7)`, `@slack/web-api ^7.0.0 (7.19.0)` | `typescript ^5.6.0` |
| `@owl/connector-discord` | `@owl/plugin-sdk`, `discord.js ^14.16.0 (14.27.0)` | `typescript ^5.6.0` |
| `@owl/server` | none in the manifest; loads the built `@owl/*` packages via relative `dist` paths | uses the root TypeScript toolchain |
| `@owl-agent/supervisor` | none | uses the root TypeScript toolchain |
| `@owl-agent/connectors` | `@owl/connector-slack`, `@owl/connector-discord` | uses the root TypeScript toolchain |
| `web` | `next 15.5.24`, `react 19.1.2`, `react-dom 19.1.2` | `typescript 5.8.3`, `@types/node 22.15.3`, `@types/react 19.1.2`, `@types/react-dom 19.1.2` |

### Notes on peer / transitive dependencies

- The standalone connector reuses the `@owl/connector-slack` and
  `@owl/connector-discord` implementations, so `apps/connectors` does not
  redundantly declare the Slack/Discord SDKs directly.
- `web`'s `next@15.5.24` transitively uses `sharp`. Because Next's optional
  range allows multiple majors, the root `pnpm.overrides` pins it to the
  already-patched `sharp@0.35.4`.
- Similarly, because Next pins an older `postcss`, the root `pnpm.overrides`
  pins it to the already-patched `postcss@8.5.23`.
- `better-sqlite3` and `sharp` are targets of native builds. The root
  `package.json`'s `pnpm.onlyBuiltDependencies` allows their build scripts to
  run.
- For other transitive packages, optional dependencies, and OS/CPU-specific
  resolutions, see `pnpm-lock.yaml`.

## Optional external dependencies required at runtime

These are not npm packages, so `pnpm install` does not install them.

| External dependency | Required when | Configuration / verification |
| --- | --- | --- |
| `claude` CLI | Using Claude in real mode where `OWL_PROVIDER` is not `stub` | PATH, or `OWL_CLAUDE_EXECUTABLE` |
| `codex` CLI | Using the Codex provider / persistent Advisor | PATH, or `OWL_CODEX_EXECUTABLE` |
| Typesafe API | Using the Librarian's external triage/scoring | UI setting, or `TYPESAFE_API_KEY` |
| Slack credentials | Starting the Slack connector | Tokens live in the mode-0600 `.env`: `SLACK_BOT_TOKEN`, plus `SLACK_APP_TOKEN` for Socket Mode. `SLACK_SIGNING_SECRET` is optional, kept only for storage compatibility. The conversation channel is `SLACK_CONVERSATION_CHANNEL_ID`, and the task notification channel is `SLACK_NOTIFICATION_CHANNEL_ID` (multiple values separated by commas or newlines). The legacy `SLACK_CHANNEL_ID` falls back to both. |
| Discord credentials | Starting the Discord connector | Tokens live in the mode-0600 `.env`: `DISCORD_BOT_TOKEN`. The conversation channel is `DISCORD_CONVERSATION_CHANNEL_ID`, and the task notification channel is `DISCORD_NOTIFICATION_CHANNEL_ID` (multiple values separated by commas or newlines). The legacy `DISCORD_CHANNEL_ID` falls back to both. No additional Application ID is needed even standalone. |
| Tailscale | Only when using `owl serve` or remote HTTPS exposure | `tailscale` CLI + login |

With `OWL_PROVIDER=stub`, offline smoke testing is possible without any
provider CLI. Setup never installs external CLIs on its own; when one is
missing, it warns with instructions for configuring real mode.

## What `setup.sh` installs

```text
pnpm install --recursive --include-workspace-root --frozen-lockfile --ignore-scripts
pnpm --filter @owl/db rebuild better-sqlite3 --pending
pnpm --filter web rebuild sharp --pending
pnpm run build
```

This means it fetches production, dev, and optional dependencies exactly as
specified by the lockfile for every workspace — not just the root package but
all of `apps/*` and `packages/*` — and also builds native modules and
generates the dist output for every package. `--frozen-lockfile` ensures setup
never silently produces a dependency graph that differs from the manifest.

The workspace treats pnpm as the source of truth, so nested npm lockfiles are
not kept. When you change a dependency, update only the root
`pnpm-lock.yaml`, then verify it with `pnpm install --frozen-lockfile`.

## Dependency audit

The audit below, run on 2026-09-22, completed with no known vulnerabilities.

```text
pnpm audit --prod --audit-level high
No known vulnerabilities found
```
