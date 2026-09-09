# open-notes-mcp

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/open-notes-mcp.svg)](https://www.npmjs.com/package/open-notes-mcp)
[![Codex](https://img.shields.io/badge/codex-%E2%89%A5%200.148-informational)](https://github.com/openai/codex)

**Model agnostic notes memory solution for Codex/ChatGPT.**

## The problem

With `features.token_budget` on, Codex hard-cuts to a fresh context window
without summarising. Nothing survives unless the agent wrote it down — and
upstream's notes (`ext/history-notes`) sit behind three gates:

```rust
config.token_budget.use_history_notes_extension
  && config.model_provider.is_openai()               // ← provider
  && auth_manager.current_auth_uses_codex_backend()  // ← ApiKey => false, always
```

| you are… | native notes? |
|---|---|
| ChatGPT sign-in on **Plus / Pro / Pro Lite** | ✅ — reported 404 in practice ([openai/codex#43194](https://github.com/openai/codex/issues/43194)) |
| **API key**, OpenAI model | ⛔ |
| API key, **any other model provider** | ⛔ |

With an API key, `features.token_budget` alone provides `new_context` /
`get_context_remaining`; `new_context` is `DirectModelOnly` (call it directly in code mode; `tools.new_context()` does not exist).
Do not set `context_management.experimental_mode`: under API-key auth it is a no-op.
**Notes are a subscription feature.** This server answers the bridge Codex still
calls when native notes are off (`notes` / `thread_hint`), which checks **neither** gate. Same cut, same injection point, no membership test.

## Quick start

```sh
npx -y open-notes-mcp init     # idempotent; asks before enabling token_budget
open-notes-mcp doctor          # what is installed, active, or broken
open-notes-mcp uninstall       # undoes its own changes — never your notes
```

`init` proves itself with a real `codex exec` and a fresh `.last-hint` stamp,
not `codex mcp list`. Exit codes: **`0` live · `2` installed but inactive ·
`1` failed** — "installed" and "working" are different claims. For Codex,
guidance is written by default only when `model_provider` names a custom
provider. With no provider or `model_provider = "openai"`, the catalog owns the
token-budget defaults and `doctor` reports `SKIP guidance` without failing. Use
`init --with-guidance` or `init --without-guidance` to override that default;
an existing user-owned guidance message is preserved and passes.

Claude Code uses the same notes directory and INDEX contract through a
`SessionStart` hook:

```sh
npx -y open-notes-mcp init --harness claude-code
open-notes-mcp doctor --harness claude-code
open-notes-mcp uninstall --harness claude-code
```

The hook delivers notes on `startup`, `resume`, and `compact` events. If the
Claude CLI is not installed, setup reports `SKIP` and returns status `2` until
the hook can be probed.

## What the model gets

| tool | what it does |
|---|---|
| `read_file` / `write_file` / `append_to_file` | notes as plain files; writes report the byte count |
| `list_files` | newest first, sizes + mtimes |
| `search` | case-insensitive substring, `path:line: text` |
| `thread_hint` | hidden from the model — Codex calls it at each new window; `INDEX.md` in full, everything else by name |

The notes live at `$AGENT_NOTES_DIR` (default `~/.agent-notes`; directory `0700`, files `0600`).

## The INDEX contract

With the server installed and documented, agents wrote **zero** notes. Writing is behavioural, so the installer ships a contract, not just a tool:

> `INDEX.md` is a **table of contents, not a notebook** — one line per topic,
> detail in its own file, updated at task boundaries, under ~3,500 bytes.

The size rule matters: the hint is capped at 4,000 bytes, and what gets cut is
whatever was written most recently.

## Status

Pre-1.0, verified against Codex `0.148` → `0.154.0-alpha`. Our own deployment, 30 production agents over two days, counted as stated:

| observed | counted by |
|---|---|
| **0 → 25/30** agents writing notes | a non-hidden file in the notes dir — not tool-call counts |
| **25/30** had notes injected after a cut | `.last-hint` byte count `> 0` |
| **7/30** hit the 4,000-byte cap | `INDEX.md` grown to 4–7 KB — found and fixed |
| **4/30** agents called `new_context` on their own, all heavy INDEX writers | `"name":"new_context"` `function_call` in rollouts, call+result deduplicated to 5 calls |

Upstream calls the bridge *legacy*; it may vanish silently. Notes are plain files
an agent can re-read, so that would cost the auto-injection, not the notes.
Whether your agent writes *useful* notes is up to your agent.

Full contract: [docs/SPEC.md](docs/SPEC.md) · Security: [SECURITY.md](SECURITY.md) · [Apache-2.0](LICENSE)
