# `@owl/server`

This package is the MVP `owl-core` process boundary: REST, WebSocket, `/owl/`
static export delivery, and the `owl` lifecycle CLI live together because the
architecture freezes Core + REST + WS + static Web as one local process. Keeping the CLI in
`apps/server` (instead of creating `apps/cli`) prevents a second process owner
from appearing at the boundary and keeps the PID, shutdown, and contract checks
under the same lifecycle implementation.

## Local execution

Build from this directory with `npx tsc -p tsconfig.json`. The compiled server
uses the repository root from `OWL_ROOT` or from its monorepo location, reads the
contract manifest and all listed artifact digests before listening, and serves
the existing `apps/web/out` export at `/owl/`.

`OWL_DATA_DIR` can select the runtime data directory; the default is `<OWL_ROOT>/data`.
SQLite, logs, PID/state files, uploads, connector secrets, and app settings use this
same directory. A missing file may be copied from the legacy `<OWL_ROOT>/.owl-data`
location without overwriting either existing side. `OWL_PORT` defaults to `3787`,
and `OWL_BIND` defaults to `127.0.0.1`; `OWL_HOST` is not a supported alias.

The project `.env` is loaded automatically, with explicit process environment values
winning over `.env`. A non-loopback bind requires a non-empty `OWL_API_TOKEN`
before listening. Tailscale Serve needs no token, because only tailnet devices can
reach it; requests through Tailscale Funnel are never treated as local. Tailscale
is never configured by ordinary `owl start`; use `owl serve` or
`OWL_TAILSCALE_SERVE=1` explicitly.

The CLI accepts the frozen `start`, `status`, `stop`, and `restart` argv forms.
`owl stop` stops the server-managed connectors and any standalone helper
processes belonging to this checkout before waiting for the server PID to exit.
`owl status --json` emits the contract JSON; plain `owl status` prints the required
human-readable service table. `./bin/owl --help` is the supported help entry point.

SIGINT is reserved for the force-shutdown path: Ctrl+C in a foreground server
always reaches shutdown as `force=true`. SIGTERM is the normal graceful-stop
path.

The current default selects the built Core package and fails fast if its
relative `packages/core/dist/index.js` artifact exposes no compatible
`createCore({db, agentRunner, git, version})` contract. Use
`OWL_CORE_MODE=standalone` only as an explicit temporary mode while the
parallel package build is incomplete; standalone is never selected
automatically. The default agent mode is the real provider boundary unless `.env`
selects the safe example value `OWL_PROVIDER=stub`. Stub mode does not require
Claude, Codex, or network access. Real mode checks the selected
adapter/model/executable and reports remediation; it does not install provider CLIs.
