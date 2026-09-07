"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  AGENTS_BEGIN,
  AGENTS_BLOCK,
  AGENTS_END,
  CLAUDE_BLOCK,
  CLAUDE_BEGIN,
  CLAUDE_END,
  claudeSettingsHook,
  codexVersion,
  enableTokenBudget,
  mcpServerEntry,
  removeManagedBlock,
  removeManagedTokenBudget,
  removeClaudeHook,
  tokenBudgetEntry,
  upsertClaudeSettings,
  upsertManagedBlock,
} = require("../lib/installer");

test("managed block insertion is byte-stable on a second run", () => {
  const original = "user instructions\n";
  const once = upsertManagedBlock(original, AGENTS_BEGIN, AGENTS_END, AGENTS_BLOCK, "AGENTS.md");
  const twice = upsertManagedBlock(once, AGENTS_BEGIN, AGENTS_END, AGENTS_BLOCK, "AGENTS.md");
  assert.strictEqual(twice, once);
  assert.strictEqual(once.split(AGENTS_BEGIN).length - 1, 1);
  assert.strictEqual(removeManagedBlock(once, AGENTS_BEGIN, AGENTS_END, "AGENTS.md"), original);
});

test("managed block rejects duplicate sentinels", () => {
  const duplicate = `${AGENTS_BLOCK}\n${AGENTS_BLOCK}\n`;
  assert.throws(
    () => upsertManagedBlock(duplicate, AGENTS_BEGIN, AGENTS_END, AGENTS_BLOCK, "AGENTS.md"),
    /duplicate or unmatched/,
  );
});

test("managed blocks preserve CRLF files and remain idempotent", () => {
  const original = "user instructions\r\n";
  const once = upsertManagedBlock(original, AGENTS_BEGIN, AGENTS_END, AGENTS_BLOCK, "AGENTS.md");
  const twice = upsertManagedBlock(once, AGENTS_BEGIN, AGENTS_END, AGENTS_BLOCK, "AGENTS.md");
  assert.strictEqual(twice, once);
  assert.ok(!once.replace(/\r\n/g, "").includes("\n"));
  assert.strictEqual(removeManagedBlock(once, AGENTS_BEGIN, AGENTS_END, "AGENTS.md"), original);
});

test("token budget added to a new table is removed cleanly", () => {
  const original = "model = \"example\"\n";
  const enabled = enableTokenBudget(original);
  assert.strictEqual(tokenBudgetEntry(enabled).value, true);
  assert.strictEqual(removeManagedTokenBudget(enabled), original);
});

test("token budget edits preserve CRLF files", () => {
  const original = "model = \"example\"\r\n";
  const enabled = enableTokenBudget(original);
  assert.ok(!enabled.replace(/\r\n/g, "").includes("\n"));
  assert.strictEqual(removeManagedTokenBudget(enabled), original);
});

test("an existing false token budget line is restored with its comment", () => {
  const original = "[features]\n  token_budget = false # user setting\nfoo = true\n";
  const enabled = enableTokenBudget(original);
  assert.strictEqual(tokenBudgetEntry(enabled).value, true);
  assert.strictEqual(removeManagedTokenBudget(enabled), original);
});

test("a root dotted token budget key stays dotted and is restored", () => {
  const original = "features . token_budget = false # user setting\n";
  const enabled = enableTokenBudget(original);
  assert.ok(enabled.includes("features.token_budget = true"));
  assert.strictEqual(tokenBudgetEntry(enabled).value, true);
  assert.strictEqual(removeManagedTokenBudget(enabled), original);
});

test("an existing true token budget setting is not claimed", () => {
  const original = "[features]\ntoken_budget = true\n";
  assert.strictEqual(enableTokenBudget(original), original);
  assert.strictEqual(removeManagedTokenBudget(original), original);
});

test("uninstall preserves a token budget line edited after init", () => {
  const original = "[features]\ntoken_budget = false\n";
  const enabled = enableTokenBudget(original);
  const edited = enabled.replace("token_budget = true", "token_budget = true # user now owns this");
  const removed = removeManagedTokenBudget(edited);
  assert.ok(!removed.includes("open-notes-mcp:token-budget"));
  assert.ok(removed.includes("token_budget = true # user now owns this"));
});

test("Codex version gate accepts 0.148 and rejects older releases", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-version-test-"));
  const script = path.join(directory, "codex");
  fs.writeFileSync(script, "#!/bin/sh\necho codex-cli 0.147.9\n", { mode: 0o755 });
  const old = codexVersion({ ...process.env, OPEN_NOTES_MCP_CODEX_BIN: script });
  assert.strictEqual(old.ok, false);
  assert.match(old.detail, /requires >= 0\.148\.0/);
  fs.writeFileSync(script, "#!/bin/sh\necho codex-cli 0.148.0\n", { mode: 0o755 });
  const minimum = codexVersion({ ...process.env, OPEN_NOTES_MCP_CODEX_BIN: script });
  assert.strictEqual(minimum.ok, true);
});

test("Codex MCP entry parser reads real codex mcp add output", () => {
  const entry = mcpServerEntry('[mcp_servers.notes]\ncommand = "/home/me/.local/share/open-notes-mcp/bin/notes-mcp"\n\n[features]\ntoken_budget = true\n');
  assert.deepStrictEqual(entry, { start: 0, end: 3, command: "/home/me/.local/share/open-notes-mcp/bin/notes-mcp" });
});

test("Claude settings insertion preserves non-managed JSON bytes and is idempotent", () => {
  const original = '{\n  "hooks": {\n    "UserPromptSubmit": [{"matcher":"*","hooks":[]}],\n    "SessionStart": []\n  },\n  "custom": true\n}\n';
  const once = upsertClaudeSettings(original, "/home/me/.local/share/open-notes-mcp/bin/notes-mcp");
  const twice = upsertClaudeSettings(once.text, "/home/me/.local/share/open-notes-mcp/bin/notes-mcp");
  assert.strictEqual(twice.text, once.text);
  assert.strictEqual(claudeSettingsHook(once.text).managed.command, once.command);
  const removed = removeClaudeHook(once.text, once);
  assert.strictEqual(removed, original);
});

test("Claude settings insertion handles missing containers and removes only its additions", () => {
  const original = '{"custom":true}';
  const once = upsertClaudeSettings(original, "/tmp/notes-mcp");
  assert.strictEqual(JSON.parse(once.text).hooks.SessionStart.length, 1);
  assert.strictEqual(removeClaudeHook(once.text, once), original);
});

test("Claude hook block uses a distinct sentinel and remains CRLF-safe", () => {
  const original = "user instructions\r\n";
  const once = upsertManagedBlock(original, CLAUDE_BEGIN, CLAUDE_END, CLAUDE_BLOCK, "CLAUDE.md");
  assert.strictEqual(once.split(CLAUDE_BEGIN).length - 1, 1);
  assert.ok(!once.replace(/\r\n/g, "").includes("\n"));
  assert.strictEqual(removeManagedBlock(once, CLAUDE_BEGIN, CLAUDE_END, "CLAUDE.md"), original);
});

test("Claude hook removal preserves neighboring array items", () => {
  const original = '{"hooks":{"SessionStart":[{"matcher":"*","hooks":[]},{"matcher":"compact","hooks":[]}]}}';
  const once = upsertClaudeSettings(original, "/tmp/notes-mcp");
  const removed = removeClaudeHook(once.text, once);
  assert.strictEqual(removed, original);
});

test("Claude settings reject duplicate managed hook entries", () => {
  const once = upsertClaudeSettings("{}", "/tmp/notes-mcp");
  const parsed = JSON.parse(once.text);
  parsed.hooks.SessionStart.push(parsed.hooks.SessionStart[0]);
  const duplicate = JSON.stringify(parsed);
  assert.throws(() => claudeSettingsHook(duplicate), /duplicate/);
});
