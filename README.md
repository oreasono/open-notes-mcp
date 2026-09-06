# open-notes-mcp

Cross-window memory for [Codex CLI](https://github.com/openai/codex) users who
run on an API key.

With `features.token_budget` enabled, Codex hard-cuts to a fresh context window
without summarising — a deliberate default, but nothing survives the cut unless
the agent wrote it down first. Upstream's own answer (`ext/history-notes`) is
closed in code to API-key users. This is an MCP server that fills that gap
through the ungated `notes` / `thread_hint` bridge Codex still calls, and keeps
working as plain readable files if that bridge ever goes away.

> **Status: pre-release.** The contract is specified ([docs/SPEC.md](docs/SPEC.md));
> the implementation is in progress. Nothing here is installable yet.

## Development

Build the stdio server with Go 1.23 or newer:

```sh
go build -o notes-mcp ./cmd/notes-mcp
AGENT_NOTES_DIR="$HOME/.agent-notes" ./notes-mcp
```

The server reads and writes line-delimited JSON-RPC on stdin/stdout. Run the
end-to-end probe from the repository root with `scripts/probe.sh` (or pass a
prebuilt binary as its first argument).

## License

Apache-2.0 — see [LICENSE](LICENSE).
