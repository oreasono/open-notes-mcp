"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const probe = path.resolve(__dirname, "../scripts/e2e-probe.js");

function runProbe(env) {
  return childProcess.spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10000,
  });
}

function assertBlocked(result, detail) {
  assert.strictEqual(result.status, 2, detail);
  assert.strictEqual(result.error, undefined, detail);
  assert.strictEqual(result.stderr, "", detail);
  assert.match(result.stdout, /^BLOCKED: [^\n]+\n?$/s, detail);
  assert.strictEqual((result.stdout.match(/^PASS\b/gm) || []).length, 0, detail);
  assert.strictEqual((result.stdout.match(/^FAIL\b/gm) || []).length, 0, detail);
}

test("e2e probe blocks when Codex is absent without assertions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-e2e-preflight-"));
  const result = runProbe({
    PATH: directory,
    OPEN_NOTES_MCP_CODEX_BIN: undefined,
  });
  assertBlocked(result, result.stderr || result.stdout);
});

test("e2e probe blocks Codex versions older than 0.148.0", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-e2e-preflight-"));
  const codex = path.join(directory, "codex");
  fs.writeFileSync(codex, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.147.9'\n", { mode: 0o755 });
  const result = runProbe({ OPEN_NOTES_MCP_CODEX_BIN: codex });
  assertBlocked(result, result.stderr || result.stdout);
  assert.match(result.stdout, /found 0\.147\.9/);
});
