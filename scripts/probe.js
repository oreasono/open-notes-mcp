#!/usr/bin/env node

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-probe-"));
const notesRoot = path.join(tempRoot, "notes");
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
    env: { ...process.env, AGENT_NOTES_DIR: notesRoot },
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

try {
  buildIfNeeded();
  fs.mkdirSync(notesRoot, { recursive: true, mode: 0o700 });

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
  check("tools/list exposes exactly five model tools", JSON.stringify(names) === JSON.stringify([
    "append_to_file", "list_files", "read_file", "search", "write_file",
  ]) && !names.includes("thread_hint"), names.join(", "));

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
