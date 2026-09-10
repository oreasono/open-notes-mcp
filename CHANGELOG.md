# Changelog

## 0.3.0 - 2026-09-10

### History tools

- `history_windows`, `history_search`, and `history_read` can recover earlier
  context windows by handle after a cut. They read only your local Codex
  rollout, with snippets limited to 1,024 bytes and each result limited to
  4,000 bytes.
- Verified with Codex 0.148 through 0.153.4. Unknown rollout record types are
  skipped and counted instead of stopping recovery.

### Installer guidance

- `init` writes `features.token_budget.guidance_message` only when a custom,
  non-OpenAI `model_provider` is configured. Any explicit child key can make
  Codex discard the model catalog's defaults (see openai/codex#42918).
- Use `--with-guidance` or `--without-guidance` to override the default. An
  existing user-owned guidance message is preserved.

### README and specification

- The README now documents the three token-budget gate states and openai/codex#43194,
  the complete tool table, and the local history recovery surface.
- The specification records the INDEX-before-`new_context` workflow in §9 and
  the local rollout history contract in §12.

### For contributors

- Run `npm run probe:e2e` for the end-to-end probe against a fake Responses
  endpoint (Codex >= 0.148). A missing or older Codex is reported as BLOCKED
  with exit status 2.

## 0.2.0

Added the cross-platform installer lifecycle for Codex and Claude Code,
including setup, health checks, and uninstall support. Added the contributor
sign-off checks and made release scans work from source archives.

## 0.1.0

Introduced the file-backed notes MCP server and its standalone probe. Added
the first npm installer, platform packages, and the initial notes bridge and
context-window contract.
