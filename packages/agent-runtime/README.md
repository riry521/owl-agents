# `@owl/agent-runtime`

This package contains the role runtime boundary used by Core:

- Manager turns a Work into `TaskDetail` records and can return a
  `task.replanned` event or the final Work verdict.
- Worker builds a task prompt, calls a provider, and accepts only a valid
  `ReportEnvelope`.
- Reviewer validates a Worker report and returns `pass`, `fix_required`, or
  `replan_required` without deciding the Core-owned review-round limit.

`createStubAgentRunner()` is a deliberate stage implementation for local
MVP verification. It does not call a CLI and always supplies two Tasks,
successful reports, and a passing review. It is explicit API selection, not a
silent provider fallback; `createAgentRunner()` never changes to the stub when
the configured provider fails.

The default CLI bridge uses the locked-style `claude-cli/v1` argv shape and
requires an absolute `executablePath`, `model`, and explicit environment from
the caller, including non-empty `PATH` and `HOME`. A caller that has built
`packages/providers` can instead inject a `ProviderClient`. Until the provider
package has a consumable package boundary, this package still contains its
local CLI adapter implementation; it must not be described as provider reuse.
Claude stdout is parsed as the whole, single JSON object it is required to
be. Canonical JSONL consumers ignore only the explicitly
permitted `kind:"log"` rows (and activity rows), then require exactly one
valid report.

## Core interface handoff

`packages/core` is the authoritative owner of `AgentRunner`. Its generated
`dist/index.d.ts` is now available in this worktree, and `src/core-contract.ts`
imports it by the relative path `../../core/dist/index.js`. The runtime keeps
the temporary local role types in `src/types.ts` only for the explicit one-cycle
demo overloads; the Core-facing overloads accept Core's
`AgentRunRequest` shapes and return `AgentRunResult` shapes. If this package is
built before Core in a fresh checkout, temporarily use the local
`LocalAgentRunner` export in `core-contract.ts`; once Core produces its `.d.ts`,
restore the relative import, run this package's typecheck/build, and verify the
Core-facing overloads again. The method names remain the packet contract:
`runManagerPlan`, `runWorker`, and `runReviewer`.

No root install, workspace edit, provider edit, or test file is required for
this package.
