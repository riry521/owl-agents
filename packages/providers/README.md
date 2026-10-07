# Provider adapters

This package implements only the MVP adapters `claude-cli/v1` and
`codex-cli/v1`. The enabled set is deliberately exact; a lock row is resolved
and validated before an executable is started.

`other-cli/v1` is a Phase 2 placeholder only. It is not registered, locked,
included in argv construction, or reachable from the execution path. API-key
adapters are Phase 3 and are not implemented here.

The lock document is supplied by the caller and has this exact shape:

```json
{
  "schema_version": "1.0.0",
  "providers": [
    {
      "enabled": true,
      "logical_provider": "claude",
      "adapter": "claude-cli/v1",
      "contract_version": "1.0.0",
      "executable_path": "/absolute/path/to/provider",
      "version": "1.2.3",
      "sha256": "<64 lowercase hex characters>",
      "verified_at": "2026-09-19T00:00:00Z"
    }
  ]
}
```

The same document must contain the enabled `codex-cli/v1` row. The caller
provides an executable root, working directory, and environment allowlist;
the adapter never searches `PATH` or invokes a shell.
