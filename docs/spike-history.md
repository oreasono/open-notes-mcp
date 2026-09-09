# J-0: Codex local rollout history spike

Scope: inspect upstream Codex `rust-v0.148.0` and `rust-v0.153.4`, then run
Codex `0.153.4` once with a disposable `CODEX_HOME` and a fake Responses SSE
endpoint. The run returned `new_context` first and an assistant message second.
All IDs and paths in the samples below are sanitized; the source references are
the upstream checkout at the two tags.

## 1. Window boundary

**(a) Source evidence**

- `rust-v0.148.0`: `codex-rs/core/src/session/mod.rs:3715-3763` starts a
  requested new window and calls `replace_compacted_history`; the writer at
  `:3316-3358` persists `RolloutItem::Compacted`, then optional world state and
  `TurnContext`. Automatic token-budget compaction advances the IDs and calls
  the same path at `codex-rs/core/src/compact.rs:360-384`.
- `rust-v0.148.0` wire shape is
  `codex-rs/history/src/rollout_payload.rs:21-41,126-142`: the boundary is a
  `type: "compacted"` item whose payload has `window_number`,
  `first_window_id`, `previous_window_id`, and `window_id`.
- `rust-v0.153.4`: the corresponding paths are
  `codex-rs/core/src/session/mod.rs:4183-4231` (requested new window),
  `:3752-3809` (writer), and `codex-rs/core/src/compact.rs:365-390`
  (automatic compaction). The wire shape is
  `codex-rs/history/src/rollout_payload.rs:24-44,145-168`.

**(b) Disposable rollout line**

```json
{"ordinal":13,"type":"compacted","payload":{"message":"","window_number":1,"first_window_id":"<w1>","previous_window_id":"<w1>","window_id":"<w2>","compaction_response_id":null}}
```

The preceding `new_context` call and its output are ordinary
`response_item` records; `compacted` is the persisted boundary record.

**(c) Conclusion: yes.** A token-budget cut records a durable `compacted`
boundary with old/new window identity fields. It does not use a separate
window-boundary type.

## 2. Item to window association

**(a) Source evidence**

- In both tags, `codex-rs/history/src/rollout_payload.rs` defines
  `ResponseItem` as only `payload` plus optional harness `metadata`
  (`rust-v0.148.0:21-29`; `rust-v0.153.4:24-32`). The enum mapping is also
  explicit in `codex-rs/history/src/lib.rs` (`rust-v0.148.0:94-104`;
  `rust-v0.153.4:102-117`). No response item field is a context-window ID.
- `SessionMeta.context_window` carries the initial identity in
  `codex-rs/protocol/src/protocol.rs` (`rust-v0.148.0:2919-2922`;
  `rust-v0.153.4:3094-3099`). `TurnContextItem` has turn/runtime fields but
  no window ID (`rust-v0.148.0:3021-3064`; `rust-v0.153.4:3199-3252`).

**(b) Disposable rollout lines**

```json
{"ordinal":20,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"spike complete"}]}}
{"ordinal":15,"type":"turn_context","payload":{"turn_id":"<turn>","cwd":"<cwd>","model":"mock-model","summary":"auto"}}
```

Neither line has a window ID. The `compacted` line in question 1 is the
positional anchor; items are assigned to the interval after the preceding
boundary and before the next one.

**(c) Conclusion: partial.** Window lookup is possible by boundary positions
and the initial `SessionMeta` anchor, but a `response_item` or `turn_context`
line cannot identify its window by itself.

## 3. Does `new_context` write a boundary?

**(a) Source evidence**

- The handler in both tags requests a new window and returns the model-visible
  tool output (`codex-rs/core/src/tools/handlers/new_context_window.rs:13-41`
  in `rust-v0.148.0`; `:13-44` in `rust-v0.153.4`). The session methods cited
  in question 1 then write `Compacted` plus the new context baseline.

**(b) Disposable run**

The fake endpoint's first response was a `new_context` function call. The
sanitized adjacent JSONL records were:

```json
{"ordinal":9,"type":"response_item","payload":{"type":"function_call","name":"new_context","arguments":"{}","call_id":"<call>"}}
{"ordinal":11,"type":"response_item","payload":{"type":"function_call_output","call_id":"<call>","output":"A new context window will start without summarizing conversation history."}}
{"ordinal":13,"type":"compacted","payload":{"message":"","window_number":1,"first_window_id":"<w1>","previous_window_id":"<w1>","window_id":"<w2>"}}
{"ordinal":15,"type":"turn_context","payload":{"turn_id":"<turn>","model":"mock-model","summary":"auto"}}
{"ordinal":20,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"spike complete"}]}}
```

This is one real run: rollout status was 0, it contains windows 1 and 2, and
the boundary is the `compacted` line between the tool output and the second
assistant response.

Separately, a disposable notes run stamped
`.last-hint` as
`last_thread_hint=<time> thread_id=01a07f62-4492-78d2-b0e9-2ff36771ba0b bytes=0`.
Its rollout filename ended in the same
`01a07f62-4492-78d2-b0e9-2ff36771ba0b.jsonl` UUID, proving the zero-config
filename lookup assumption.

**(c) Conclusion: yes.** A successful `new_context` call is followed by a
durable `compacted` boundary and a fresh `turn_context` baseline.

## 4. Format stability and canonical storage

**(a) Source evidence and differences**

- The stable core wire types in both tags are `session_meta`, `response_item`,
  `inter_agent_communication`, `inter_agent_communication_metadata`,
  `compacted`, `turn_context`, `world_state`, `security_risk_score`, and
  `event_msg` (`history/src/rollout_payload.rs` in each tag).
- `rust-v0.153.4` adds `token_usage_record` and `realtime_item` wire variants
  (`:45-59`), plus `guardian_history`, `mcp_resource_origins`,
  `compaction_response_id`, and `latest_token_usage_record` to
  `CompactedItemWire` (`:153-168`). The owning struct shows the same additions
  at `codex-rs/history/src/lib.rs:156-173`; there are no corresponding fields
  in `rust-v0.148.0` (`:140-148`).
- `TurnContextItem` gains `root_turn_id`, `active_permission_profile`,
  `cyber_access_program`, and related compatibility fields in 0.153
  (`codex-rs/protocol/src/protocol.rs:3199-3252`) compared with 0.148
  (`:3021-3064`).

**(b) Disposable sample**

The run contains both the legacy/common records and the 0.153 additions:
`type: "compacted"` with `window_id`, followed by `type: "turn_context"` and
`type: "token_usage_record"`; the sample's `compacted` payload has
`compaction_response_id: null` and a `latest_token_usage_record` snapshot in
the unsanitized file.

**(c) Conclusion: partial.** The boundary contract is stable across these tags,
but 0.153 is an additive schema and consumers must tolerate new top-level
types and optional compacted fields.

**Canonical storage.** In 0.153, `codex-rs/thread-store/src/local/live_writer.rs:334-347`
calls `durable_write` first and only then
`thread_history_materialization::materialize_to_sqlite`. The latter reads the
rollout JSONL from byte offset 0 or its projection checkpoint
(`codex-rs/thread-store/src/local/thread_history_materialization.rs:19-70`).
The recorder documents JSONL as canonical (`codex-rs/rollout/src/recorder.rs:77-84`).
SQLite is therefore a rebuildable projection; the JSONL remains complete and
canonical when SQLite materialization is enabled.

## Scale numbers

The disposable two-window rollout had **1** standalone `function_call_output`
record occupying **411** JSONL bytes (the nested copy inside the `compacted`
replacement history is not counted as a standalone record).

The upstream history extension sends `TruncationPolicy::Bytes(1024)` in
`codex-rs/ext/history-notes/src/backend_tests.rs:60,134` (the user-supplied
`tools.rs` line numbers refer to the same policy contract), and the hint cap is
`MAX_THREAD_HINT_BYTES: usize = 4_000` at
`codex-rs/ext/history-notes/src/extension.rs:28`.

go + 最大风险：0.153 之后继续新增 rollout 类型或可选字段，若索引器把未知类型当成致命错误，会丢失窗口边界后的可检索内容。
