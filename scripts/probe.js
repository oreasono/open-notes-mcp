#!/usr/bin/env node

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-probe-"));
const notesRoot = path.join(tempRoot, "notes");
const codexHome = path.join(tempRoot, "codex");
const builtBinary = path.join(tempRoot, "notes-mcp");
const requestedBinary = process.argv[2];
const binary = requestedBinary ? path.resolve(process.cwd(), requestedBinary) : builtBinary;
const marker = `ONM-PROBE-${crypto.randomUUID()}`;
const threadID = crypto.randomUUID();
const checks = [];

function check(label, condition, detail) {
  const ok = Boolean(condition);
  checks.push(ok);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}\n`);
}

function buildIfNeeded() {
  if (requestedBinary) return;
  const result = childProcess.spawnSync(process.env.GO_BIN || "go", ["build", "-o", builtBinary, "./cmd/notes-mcp"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.error?.message || "go build failed\n");
    process.exit(2);
  }
}

function run(requests) {
  const input = requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
  const result = childProcess.spawnSync(binary, [], {
    input,
    cwd: repoRoot,
    env: { ...process.env, AGENT_NOTES_DIR: notesRoot, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `binary exited ${result.status}`);
  const lines = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
  return lines.map((line) => JSON.parse(line));
}

function call(id, name, argumentsValue, meta) {
  const params = { name };
  if (argumentsValue !== undefined) params.arguments = argumentsValue;
  if (meta) params._meta = meta;
  return { jsonrpc: "2.0", id, method: "tools/call", params };
}

function resultOf(response) {
  return response && response.result;
}

function markdownSection(markdown, heading) {
  const headingStart = markdown.indexOf(heading);
  if (headingStart === -1) return "";
  const sectionStart = markdown.indexOf("\n", headingStart) + 1;
  const nextHeading = markdown.indexOf("\n## ", sectionStart);
  return markdown.slice(sectionStart, nextHeading === -1 ? markdown.length : nextHeading);
}

function readmeToolNames(readme) {
  const heading = "## What the model gets";
  const section = markdownSection(readme, heading);
  const names = new Set();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    const toolCell = line.split("|")[1] || "";
    for (const name of ["append_to_file", "history_read", "history_search", "history_windows", "list_files", "read_file", "search", "thread_hint", "write_file"]) {
      if (toolCell.includes(`\`${name}\``)) names.add(name);
    }
  }
  return names;
}

function writeHistoryFixture() {
  const sessions = path.join(codexHome, "sessions", "2026", "09", "09");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const firstWindow = crypto.randomUUID();
  const secondWindow = crypto.randomUUID();
  const lines = [
    { timestamp: "2026-09-09T01:00:00Z", type: "session_meta", payload: { id: threadID } },
    { timestamp: "2026-09-09T01:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${marker} history fixture` }] } },
    { timestamp: "2026-09-09T01:00:02Z", type: "response_item", payload: { type: "function_call", name: "history_lookup", arguments: `{"query":"${marker}"}` } },
    { timestamp: "2026-09-09T01:00:03Z", type: "compacted", payload: { window_number: 1, first_context_window_id: firstWindow, previous_context_window_id: firstWindow, context_window_id: secondWindow } },
    { timestamp: "2026-09-09T01:00:04Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "current window" }] } },
  ];
  const rollout = path.join(sessions, `rollout-${threadID}.jsonl`);
  fs.writeFileSync(rollout, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
  return { firstWindow, secondWindow };
}

try {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const spec = fs.readFileSync(path.join(repoRoot, "docs", "SPEC.md"), "utf8");
  const readmeLineCount = readme.trimEnd().split(/\r?\n/).length;
  check("README stays at most 100 lines", readmeLineCount <= 100, `${readmeLineCount} lines`);

  const gateTableStart = readme.indexOf("| you are… | native notes? |");
  const gateRow = gateTableStart === -1 ? "" : readme.slice(gateTableStart).split(/\r?\n/)[2] || "";
  check("README gate table lists Plus / Pro / Pro Lite and #43194",
    gateRow.includes("ChatGPT sign-in")
      && gateRow.includes("Plus / Pro / Pro Lite")
      && gateRow.includes("reported 404 in practice")
      && gateRow.includes("#43194"),
    gateRow || "gate row missing");

  const problemSection = markdownSection(readme, "## The problem");
  const apiNoteTerms = [
    "features.token_budget", "new_context", "get_context_remaining", "DirectModelOnly",
    "tools.new_context()", "context_management.experimental_mode", "no-op",
  ];
  const missingApiNoteTerms = apiNoteTerms.filter((term) => !problemSection.includes(term));
  check("README explains API-key token-budget tools", missingApiNoteTerms.length === 0,
    missingApiNoteTerms.join(", ") || "all terms present");

  const statusSection = markdownSection(readme, "## Status");
  check("README states the observed new_context count",
    statusSection.includes("**4/30**")
      && statusSection.includes("`\"name\":\"new_context\"`")
      && statusSection.includes("5 calls"));

  const behavioralSection = markdownSection(spec, "## 9.");
  check("SPEC requires writing INDEX before new_context",
    /Update `INDEX\.md` before calling `new_context`/.test(behavioralSection)
      && /`new_context` itself\s+saves nothing/.test(behavioralSection)
      && behavioralSection.includes("openai/codex#43194")
      && behavioralSection.includes("this bridge"));

  const referencesSection = markdownSection(spec, "## 10.");
  const referenceTerms = ["spec_plan.rs:1190-1193", "token_budget.rs:13-35", "models.json"];
  const missingReferenceTerms = referenceTerms.filter((term) => !referencesSection.includes(term));
  check("SPEC cites token-budget upstream sources", missingReferenceTerms.length === 0,
    missingReferenceTerms.join(", ") || "all references present");

  buildIfNeeded();
  fs.mkdirSync(notesRoot, { recursive: true, mode: 0o700 });
  const historyFixture = writeHistoryFixture();

  const coldStart = process.hrtime.bigint();
  const cold = run([{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }]);
  const elapsedMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
  check("initialize roundtrip < 200ms", cold.length === 1 && elapsedMs < 200, `${elapsedMs.toFixed(1)}ms`);

  const listed = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const tools = resultOf(listed[1])?.tools || [];
  const names = tools.map((tool) => tool.name).sort();
  check("tools/list exposes exactly eight model tools", JSON.stringify(names) === JSON.stringify([
    "append_to_file", "history_read", "history_search", "history_windows", "list_files", "read_file", "search", "write_file",
  ]) && !names.includes("thread_hint"), names.join(", "));
  const documentedToolNames = readmeToolNames(readme);
  const missingFromReadme = names.filter((name) => name !== "thread_hint" && !documentedToolNames.has(name));
  check("tools/list names are documented in README table", missingFromReadme.length === 0, missingFromReadme.join(", ") || "all present");
  check("README table includes hidden thread_hint", documentedToolNames.has("thread_hint"), [...documentedToolNames].join(", "));

  const historyResponses = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "history_windows", {}, { threadId: threadID }),
    call(3, "history_search", { query: marker }, { threadId: threadID }),
  ]);
  const historyWindows = resultOf(historyResponses[1])?.content?.[0]?.text || "";
  const historySearch = resultOf(historyResponses[2])?.content?.[0]?.text || "";
  let historyMatch;
  try {
    historyMatch = JSON.parse(historySearch).matches?.[0];
  } catch {
    historyMatch = null;
  }
  check("history_windows summarizes both local windows", historyWindows.includes(historyFixture.firstWindow) && historyWindows.includes(historyFixture.secondWindow));
  check("history_search finds the earlier fixture text", historyMatch?.handle === "w1#2" && historyMatch.window_id === historyFixture.firstWindow);
  const historyRead = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "history_read", { handle: historyMatch?.handle, max_bytes: 4000 }, { threadId: threadID }),
  ]);
  const historyReadText = resultOf(historyRead[1])?.content?.[0]?.text || "";
  check("history_read returns original fixture text", historyReadText.includes(`${marker} history fixture`));

  fs.writeFileSync(path.join(notesRoot, "INDEX.md"), `${marker}\ncurated conclusion\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(notesRoot, "note-a.md"), "alpha\n", { mode: 0o600 });
  fs.writeFileSync(path.join(notesRoot, "note-b.md"), "beta\n", { mode: 0o600 });
  const hintResponses = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "thread_hint", null, { threadId: threadID }),
  ]);
  const hintResult = resultOf(hintResponses[1]);
  const hint = hintResult?.content?.map((block) => block.text || "").join("\n") || "";
  check("thread_hint includes full INDEX marker", hint.includes(marker));
  check("thread_hint lists other notes with metadata", hint.includes("note-a.md") && hint.includes("note-b.md") && /\(\d+ bytes, \d{4}-\d\d-\d\dT/.test(hint));
  check("thread_hint is at most 4000 bytes", Buffer.byteLength(hint, "utf8") <= 4000, `${Buffer.byteLength(hint, "utf8")} bytes`);
  check("small INDEX has no truncation marker", !hint.includes("Hint truncated"));
  check("thread_hint advertises earlier-window history", hint.includes("history_search is available for earlier windows of this session"));
  const stampPath = path.join(notesRoot, ".last-hint");
  const stamp = fs.readFileSync(stampPath, "utf8");
  check(".last-hint is one line and contains thread id", stamp.trimEnd().split("\n").length === 1 && stamp.includes(`thread_id=${threadID}`));

  fs.writeFileSync(path.join(notesRoot, "INDEX.md"), "界".repeat(3000), { mode: 0o600 });
  const oversizedThread = crypto.randomUUID();
  const oversizedResponses = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "thread_hint", null, { threadId: oversizedThread }),
  ]);
  const oversizedResult = resultOf(oversizedResponses[1]);
  const oversizedHint = oversizedResult?.content?.map((block) => block.text || "").join("\n") || "";
  check("oversized INDEX hint is capped", Buffer.byteLength(oversizedHint, "utf8") <= 4000);
  check("oversized INDEX marker names source and split action", oversizedHint.includes("INDEX.md is too large") && oversizedHint.includes("split details"));

  fs.writeFileSync(path.join(notesRoot, "INDEX.md"), "x".repeat(1000001), { mode: 0o600 });
  const fileCapThread = crypto.randomUUID();
  const fileCapResponses = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "thread_hint", null, { threadId: fileCapThread }),
  ]);
  const fileCapResult = resultOf(fileCapResponses[1]);
  const fileCapHint = fileCapResult?.content?.map((block) => block.text || "").join("\n") || "";
  check("oversize INDEX file still produces a capped hint", Buffer.byteLength(fileCapHint, "utf8") <= 4000);
  check("oversize INDEX file names source and split action", fileCapHint.includes("INDEX.md is too large") && fileCapHint.includes("split details"));

  const pathResponses = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "write_file", { path: "./x.md", content: "x" }),
    call(3, "write_file", { path: "a/b/../c.md", content: "x" }),
    call(4, "write_file", { path: "../escape.md", content: "x" }),
    call(5, "write_file", { path: "foo.tmp", content: "x" }),
    call(6, "write_file", { path: "notes/day1.md", content: "hello" }),
    call(7, "write_file", { path: "too-large.md", content: "x".repeat(1000001) }),
    call(8, "write_file", { path: "bad.md" }),
  ]);
  for (let i = 2; i <= 5; i += 1) check(`path validation rejects case ${i - 1}`, resultOf(pathResponses[i - 1])?.isError === true);
  check("write_file reports actual byte count", resultOf(pathResponses[5])?.content?.[0]?.text?.includes("bytes_written=5"));
  check("oversize write isError", resultOf(pathResponses[6])?.isError === true);
  check("caller mistake uses isError", resultOf(pathResponses[7])?.isError === true && !pathResponses[7].error);

  for (const entry of fs.readdirSync(notesRoot)) {
    if (entry !== ".last-hint") fs.rmSync(path.join(notesRoot, entry), { recursive: true, force: true });
  }
  const emptyThread = crypto.randomUUID();
  const emptyResponses = run([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call(2, "thread_hint", null, { threadId: emptyThread }),
  ]);
  const emptyResult = resultOf(emptyResponses[1]);
  check("thread_hint is empty after notes are cleared", emptyResult && !emptyResult.isError && Array.isArray(emptyResult.content) && emptyResult.content.length === 0);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 2;
}

if (checks.length > 0 && checks.every(Boolean) && process.exitCode === undefined) process.exitCode = 0;
else if (process.exitCode === undefined) process.exitCode = 1;
