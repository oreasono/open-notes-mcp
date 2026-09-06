# open-notes-mcp — Contract Specification (v0.2, 2026-09-07)

> **Status**: publishable. This document is the clean-room source of truth for the
> open-source implementation. It carries every "why" from the production-proven
> internal implementation with all internal context removed. Code written from
> this spec plus the upstream references below owes nothing to the private tree.
>
> **v0.1 change** (weighting only — no contract change): §3 marks the MCP write
> tools as a *convenience path*, and §9 is stated as load-bearing rather than
> supporting. Rationale in §3 and §9; it follows from §2/§4, which read the
> filesystem and never inspect how a file got there.
>
> **v0.2 change** (resolves a contradiction inside v0/v0.1): §4 said both
> "INDEX.md is carried **in full**" and "hard cap **4000 bytes**". Those two
> cannot both hold once INDEX exceeds the cap — and the cap wins, so the tail
> of INDEX is silently the part that does *not* survive the window cut. §4 now
> says which one wins and §9 makes INDEX compactness a contract term.

## 1. Purpose

With `features.token_budget` enabled, Codex stops summarising a full context
window and hard-cuts to a fresh one (`new_context`: "A new context window will
start without summarizing conversation history"). Nothing is carried across —
which is the right default (a visible cut beats a confident summary that
quietly drops a constraint), but whatever should survive must be written down
first, by the agent, on purpose.

Upstream's own answer (`ext/history-notes`, remote `alpha/history/v2` +
`alpha/notes/v2` endpoints) is **closed in code** to API-key users — all three
gates must pass, and `AuthMode::uses_codex_backend()` is permanently `false`
for `ApiKey`:

```rust
config.token_budget.use_history_notes_extension
  && config.model_provider.is_openai()
  && auth_manager.current_auth_uses_codex_backend()
```

But Codex keeps an ungated fallback. In `core/src/session/mod.rs`, under the
comment **"Keep the legacy bridge hint when native Notes is disabled"**, it
calls MCP server **`notes`**, tool **`thread_hint`**, whenever token budgeting
is on and the native extension is off — checking neither provider name nor auth
mode — and injects the returned text into the new window. This server is the
other end of that call.

⚠️ Upstream calls it a *legacy* bridge; it may be removed, and removal is
**silent** (no error — hints simply stop arriving). The design therefore treats
the bridge as one recovery channel of several, never a dependency: notes are
ordinary files the model can read back explicitly. Losing the bridge costs the
automatic injection, not the notes.

## 2. Bridge contract (verified against rust-v0.148.0 / 0.150 / 0.151 / 0.153.x / 0.154.0-alpha)

- Server name MUST be `notes`; tool name MUST be `thread_hint`.
- Codex calls with `arguments = null`; the thread id arrives in
  `_meta.threadId` (a UUID). A schema requiring fields makes every call invalid
  — advertise an empty object schema.
- Codex joins every non-empty `text` content block with `"\n"` and injects the
  result as a `role=developer` message shaped:

  ```
  <context_window>
  Agent name: <...>
  First context window id: <uuid>
  Current context window id: <uuid>
  Previous context window id: <uuid>      (present from the second window on)
  <thread_hint text>
  </context_window>
  ```

- An **empty result means "inject nothing"** and is not an error. Never return
  a friendly "you have no notes yet" — every new window would burn context to
  say nothing.
- The call is made with `wait_for_server = true` **before** the model request
  is constructed. Two consequences: (a) server startup latency delays every
  window start — keep the binary instant (no runtime fetch); (b) the bridge can
  be probed with a dead model endpoint, because `thread_hint` fires before any
  model traffic.
- `thread_hint` MUST stay off the model's visible tool list. Upstream hides its
  own with `_meta: {"ui": {"visibility": []}}` plus a read-only annotation and
  asserts in core tests that `mcp__notes__thread_hint` is absent from model
  tool exposure. A visible thread_hint is a tool the model would call for
  itself, duplicating the hint it was just handed.

## 3. Tool surface

⭐ **What is actually load-bearing.** The bridge reads the *filesystem* (§4) —
it never inspects how a file came to be there. So the irreducible pair is
**the §9 INDEX contract** (the agent decides to write) plus **§5's writable
notes directory at an agreed path**. The write tools below are a *convenience
path*, not a dependency: an agent that writes with a shell redirect, an editor,
or another harness's own file tool is served exactly as well.

Two consequences worth designing for:

- Do not gate any behaviour on "the write happened through our tool" — no
  bookkeeping that only the write path updates, no index the tools alone
  maintain. Anything the hint needs must be derivable from the files on disk.
- This widens the addressable surface: a harness that never exposes these
  tools still works, provided its agent can write to the notes directory.

One hidden tool plus five model-visible tools:

| tool | schema | notes |
|---|---|---|
| `thread_hint` | empty object | hidden (see §2); read-only annotation |
| `read_file` | `{path}` required | read-only |
| `write_file` | `{path, content}` required | replaces file; **response reports actual bytes written** |
| `append_to_file` | `{path, content}` required | creates if missing; reports bytes |
| `list_files` | `{prefix?}` | newest first, with sizes + RFC3339 mtimes; read-only |
| `search` | `{query}` required | case-insensitive substring, `path:line: text` output; read-only |

Error semantics: a caller mistake (bad path, oversize file) is reported via
MCP `isError: true` with a `text` block — **not** a JSON-RPC error. A JSON-RPC
error reads as "the tool is broken"; `isError` tells the model its own call
was wrong and lets it correct the next one.

Byte-count reporting on writes is not cosmetic: it is the model's only signal
for judging distance to the per-file limit.

## 4. Hint composition

```
Notes you wrote in earlier context windows of this session.
Read any file below with the notes read_file tool.

--- INDEX.md ---
<full contents of INDEX.md, trailing newline normalised>

--- other notes ---
<rel-path> (<size> bytes, <RFC3339 mtime>)
...
```

- `INDEX.md` is carried **in full only while it fits** — it is the model's own
  curated summary. Everything else is listed by name/size/mtime and read on
  demand; that is what keeps the hint bounded.
- ⛔ **"In full" is not a promise; the cap below wins.** Once INDEX alone
  exceeds the cap, the hint carries only its first ~3,900 bytes and the rest is
  cut — so the part of INDEX the agent wrote *last* is exactly the part that
  does not survive the window cut. An INDEX at 2× the cap loses more than half
  of itself, silently, on the one path the whole product exists to protect.
  ⇒ Implementations MUST NOT paper over this by raising the cap (§2 fixes it
  upstream) or by dropping the marker. The fix is §9: keep INDEX small.
- Hard cap **4000 bytes** (upstream's `MAX_THREAD_HINT_BYTES`). Matching it is
  not cosmetic: the hint is prepended to a window that was just cut for being
  too full; an unbounded hint reproduces the problem it exists to solve.
- Truncation cuts on a UTF-8 rune boundary and **says so** with a visible
  marker line pointing at `list_files`/`read_file`. A silently truncated hint
  reads as a complete one and the model acts on a half-sentence.
- ⭐ **When the overflow is INDEX itself, the marker MUST say so and MUST tell
  the agent to split it** (move detail into partition files, leave pointers).
  Reason this belongs here and not only in a write-tool warning: the hint is
  derived from the filesystem, so this message reaches the agent **however it
  wrote the file** (§3) — a shell redirect gets the same correction as a
  `write_file` call. It is the only self-correcting path in the design.
- ⚠️ The marker must stay **absent** when nothing was truncated. A marker that
  is always present carries no information and trains the agent to ignore it.
- No notes on disk → empty result → no injection (§2).

## 5. Storage contract

- Root: `$AGENT_NOTES_DIR`, defaulting to a directory **outside any workspace
  the agent commits from** (`~/.agent-notes`). Rationale: agents run
  `git add -A`; notes inside the working tree end up committed to the user's
  repository.
- Permissions: directory `0700`, files `0600`.
- Per-file cap **1,000,000 bytes** (upstream's single-note ceiling), stated in
  the tool description so the model can split before hitting the error.
- Atomic writes via `*.tmp` staging + rename; `.tmp` suffix is reserved and
  rejected in user paths.
- Dot-prefixed files are bookkeeping, never notes: skipped by listing, search
  and hint. Includes `.last-hint` (§7).
- **Path validation examines raw components before any cleaning**: empty, `.`
  and `..` components are rejected outright (upstream states the same rule).
  Cleaning first would silently accept `./x.md` and `a/b/../c.md` — and then
  the path the model believes it wrote is not the path on disk.

## 6. Transport

Line-delimited JSON-RPC 2.0 over stdio. The read buffer must be far above
bufio's 64 KiB default (8 MiB recommended): a long `write_file` line truncated
mid-JSON surfaces as a parse error that looks like a protocol bug.
Notifications (no `id`) get no reply, per protocol. `initialize`,
`tools/list`, `tools/call` are the required methods.

## 7. Observability (the bridge's only liveness signal)

- Every `thread_hint` call overwrites `.last-hint`:
  `last_thread_hint=<RFC3339> thread_id=<uuid> bytes=<n>` — one line, not an
  append log. The question it answers is "did Codex call us, and when".
  Best-effort: a hint that cannot be recorded is still worth returning.
- ⚠️ Codex captures MCP servers' stderr separately; stderr-only observability
  is blind. File stamps are the truth.
- ⛔ `codex mcp list` / `codex mcp get` never start the server — they read
  config. Any connectivity test built on them is a tautology (a directory
  impersonating the binary still shows `enabled`).

## 8. Verification method (end-to-end, not proxy signals)

Proving "codex called us" is not proving "the bytes reached the model". The
end-to-end probe:

1. Point codex at a **fake Responses API endpoint** that records raw request
   bodies and answers the first turn with a `new_context` tool call, forcing a
   real window cut. (SSE event shapes: copy upstream's own test helper
   `core/tests/common/responses.rs`, don't guess.)
2. Assert across the two recorded requests: window id changes, `Previous`
   points at the old id, and the second request body contains the note text
   inside `<context_window>`.
3. A cheap per-release CI probe needs no fake endpoint at all: one-shot
   `codex exec` with a dead model address + assert `.last-hint` was stamped
   (§2: the bridge fires before model traffic).

## 9. Behavioural layer (load-bearing — half the product, not an add-on)

Production observation: with tools installed and documented, agents wrote
**zero** notes in the initial observation window (0 of 30) — recovery is a
technical problem, but **writing is a behavioural one**.

A later single-agent trial added the INDEX contract below and changed nothing
else; that agent then wrote a substantial INDEX at task boundaries, on its own,
without being forced by a window cut.

⚠️ **Weigh that evidence honestly**: the negative result is 0/30, the positive
one is n=1. It is enough to justify shipping the contract as a first-class part
of the product; it is **not** enough to claim the contract makes agents write.
⛔ Do not put "the contract makes your agent take notes" in the README — say
what the contract *asks for*, and measure what actually happens (§9 metrics).

The installer therefore ships:

- An `AGENTS.md` block (sentinel-marked, idempotently appended) establishing
  the INDEX contract: update `INDEX.md` at task boundaries (conclusions,
  direction changes, completed steps) — *note-taking is part of the workflow,
  not an escape hatch for a full window*.
- ⭐ **The contract MUST state that INDEX is a table of contents, not a
  notebook**: a filename + a one-line summary + a pointer, per topic; every
  detail lives in a partition file. **Target: under ~3,500 bytes.**
  Observed drift: agents treat INDEX as the notebook and grow it past 8 KB —
  more than twice the §4 cap, at which point over half of it stops surviving
  window cuts (§4). A contract that only says "write notes" produces exactly
  this failure; the size discipline has to be stated as part of the contract.
- Optional guard rail, **convenience only**: a `write_file` to `INDEX.md` above
  the threshold may return an advisory alongside the byte count (§3).
  ⛔ It must not be load-bearing — an agent writing by shell redirect never
  sees it. The §4 truncation marker is the path that always reaches.
- Any additional reminder text MUST carry a unique marker string. Codex itself
  emits `You have N tokens left in this context window` every turn; grepping
  for generic phrasing collides with that counter and produces false evidence
  that reminders fired.

## 10. Upstream references

All in `github.com/openai/codex` (Apache-2.0):

- Bridge: `codex-rs/core/src/session/mod.rs` — search "Keep the legacy bridge
  hint" (also: a failed native request must NOT fall back to the bridge).
- Native-path gates: `codex-rs/ext/history-notes/src/extension.rs`.
- `ApiKey => false`: `codex-rs/protocol/src/auth.rs`, `uses_codex_backend()`.
- Hidden-tool fixture + model-exposure assertion: core tests (`hooks_mcp.rs`,
  `token_budget.rs` — `token_budget_context_injects_plain_thread_hint_text`).
- Fake SSE shapes: `codex-rs/core/tests/common/responses.rs`.
- Window ladder: `model-provider/src/provider.rs` +
  `core/src/session/step_activation_tests.rs` (resolved 272,000 / usable 95% /
  auto-compact 90%).
