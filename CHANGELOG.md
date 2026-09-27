# Changelog

## 1.0.0 - 2026-09-22

Established the minimum safety and installability needed for the public v1 release.

- Auto-load `.env`, with explicit process environment variables taking precedence
- `OWL_BIND`, loopback default, and a required Bearer token for external bind / Tailscale Serve
- Made Tailscale Serve an explicit opt-in
- Made the stub provider require no external CLI, and cleaned up doctor/setup provider detection into a selectable form
- Made `OWL_DATA_DIR` the common root for the DB, logs, settings, and the connector Vault
- Made the legacy `.owl-data` backward-compatible via a safe missing-file-only migration
- Treat the doctor check on a fresh data directory as a `not_initialized` warning
- Documented the macOS/Linux support range, Windows unsupported/experimental status, backup/restore, and known limitations
- Added root typecheck/test/audit scripts and CI

Known limitations are documented in [README.md](README.md) and [docs/operations.md](docs/operations.md).
