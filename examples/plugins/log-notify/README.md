# log-notify example plugin

This generic plugin writes each received Core event as one JSON line to stdout. It uses `BasePlugin`'s default event subscriptions, including `decision.opened`, `work.completed`, `work.cancelled`, and `system.alert`.

## Build

The example is outside the pnpm workspace. Build the SDK from the repository root first, then install and build the example here:

```sh
pnpm --filter @owl/plugin-sdk build
cd examples/plugins/log-notify
npm install
npm run build
```

The example's dependency points to `packages/plugin-sdk` with a relative `file:` reference. For a separate plugin repository, place it as a sibling of the `owl-agents` checkout and use a relative dependency such as `file:../../../owl-agents/packages/plugin-sdk` from the plugin package directory; build the SDK before installing the plugin.

## Run

Set the Core API URL and start the plugin:

```sh
OWL_API_BASE=http://127.0.0.1:3000/api/v1 OWL_PLUGIN_NAME=log-notify npm start
```

`OWL_API_BASE` is required. `OWL_API_TOKEN` and `OWL_WS_URL` are optional; without a WebSocket URL the SDK uses polling. The plugin handles SIGTERM and SIGINT by stopping and exiting with code 0. For example, send SIGTERM from the process manager or terminal to stop it cleanly.
