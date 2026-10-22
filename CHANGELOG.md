# Changelog

## [Unreleased]

### Fixed

- Stop proxy credentials and dashboard sessions from reaching upstream HTTP/WebSocket relays (BUG-001).
- Meter cross-provider streams and native OpenAI JSON usage against client limits (BUG-002, BUG-003).
- Preserve UTF-8 across SSE chunk boundaries (BUG-004).
- Update the vulnerable development dependency and Docker runtime components (BUG-005, BUG-010).
- Harden CodexLB, Claw and OpenCode installation against command injection, invalid credentials/configuration, permissive files and secret disclosure (BUG-006–009, BUG-011).

### Security

- Add dependency, secret-history, installer regression and container scanning in CI.
- Docker runtime uses Node 24 and omits npm/yarn; rebuild the image to update it.

No public API/schema change or release published. These compatible fixes are intended for the next patch release after 2.1.0. See `docs/audit-systematic-2026-10-22/` for evidence and limitations.
