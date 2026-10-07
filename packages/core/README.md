# `@owl/core`

`@owl/core` is the single-writer coordination boundary for Owl. `StateReducer`
is the only module that changes Work or Task state; the Workflow Engine only
issues reducer commands, and the Event Dispatcher only observes and replays
durable events.

The runtime dependency on `@owl/db` is intentionally a relative import of the
built package (`../../db/dist/index.js`). This keeps the package usable without
a root install or a runtime `@owl/*` alias. Build `packages/db` before using a
real database.

`GitGateway` is deliberately a no-op in the MVP. It records requested Git
operations and does not create branches, worktrees, or merge commits. This is
the documented MVP boundary: concrete Git/worktree execution is assigned to a
later phase, while Core still records the requested operation so the state
machine remains observable. Supply a real `GitGateway` through
`createCore({ git })` when that wave is implemented.

The package does not provide an implicit provider or retry fallback. A missing
`AgentRunner` or an invalid command is reported as a human-readable failure.
