"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MCP_BEGIN = "# open-notes-mcp:mcp:begin";
const MCP_END = "# open-notes-mcp:mcp:end";
const AGENTS_BEGIN = "<!-- open-notes-mcp:begin -->";
const AGENTS_END = "<!-- open-notes-mcp:end -->";
const CLAUDE_BEGIN = "<!-- open-notes-mcp:claude-code:begin -->";
const CLAUDE_END = "<!-- open-notes-mcp:claude-code:end -->";
const CLAUDE_HOOK_SENTINEL = "open-notes-mcp:claude-code";
const TOKEN_ADDED_KEY = "# open-notes-mcp:token-budget:added-key";
const TOKEN_ADDED_TABLE = "# open-notes-mcp:token-budget:added-table";
const TOKEN_CHANGED = "# open-notes-mcp:token-budget:changed:";
const INSTALL_STATE = "open-notes-mcp.install.json";
const MIN_CODEX_VERSION = Object.freeze([0, 148, 0]);

const AGENTS_BLOCK = `${AGENTS_BEGIN}
## Cross-window notes

Maintain cross-window memory in \`$AGENT_NOTES_DIR\` when it is set, otherwise in \`~/.agent-notes\`.

- Update \`INDEX.md\` at task boundaries: conclusions, direction changes, and completed steps. Note-taking is part of the workflow, not an escape hatch for a full context window.
- Keep \`INDEX.md\` as a table of contents, not a notebook. For each topic, record a filename, a one-line summary, and a pointer. Put all detail in partition files.
- Keep \`INDEX.md\` under about 3,500 bytes so it survives the 4,000-byte context-window hint limit.
- Read partition files with the notes tools when their detail is needed.
${AGENTS_END}`;

const CLAUDE_BLOCK = `${CLAUDE_BEGIN}
## Cross-window notes

Maintain cross-window memory in \`$AGENT_NOTES_DIR\` when it is set, otherwise in \`~/.agent-notes\`.

- Update \`INDEX.md\` at task boundaries: conclusions, direction changes, and completed steps. Note-taking is part of the workflow, not an escape hatch for a full context window.
- Keep \`INDEX.md\` as a table of contents, not a notebook. For each topic, record a filename, a one-line summary, and a pointer. Put all detail in partition files.
- Keep \`INDEX.md\` under about 3,500 bytes so it survives the 4,000-byte context-window hint limit.
- Read partition files with the notes tools when their detail is needed.
${CLAUDE_END}`;

const PLATFORM_PACKAGES = new Map([
  ["darwin-arm64", "@open-notes-mcp/darwin-arm64"],
  ["darwin-x64", "@open-notes-mcp/darwin-x64"],
  ["linux-arm64", "@open-notes-mcp/linux-arm64"],
  ["linux-x64", "@open-notes-mcp/linux-x64"],
  ["win32-arm64", "@open-notes-mcp/win32-arm64"],
  ["win32-x64", "@open-notes-mcp/win32-x64"],
]);

function usage() {
  return `Usage: open-notes-mcp <command> [options]

Commands:
  init [--harness codex|claude-code] [--enable-token-budget | --without-token-budget]
  doctor [--harness codex|claude-code]
  uninstall [--harness codex|claude-code]

init asks before enabling features.token_budget for the Codex harness. The two
flags provide an explicit non-interactive answer.`;
}

function locations(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  let dataHome;
  if (platform === "win32") {
    dataHome = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  } else {
    dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  }
  const installRoot = path.join(dataHome, "open-notes-mcp");
  return {
    home,
    codexHome,
    configPath: path.join(codexHome, "config.toml"),
    statePath: path.join(codexHome, INSTALL_STATE),
    agentsPath: path.join(codexHome, "AGENTS.md"),
    agentsOverridePath: path.join(codexHome, "AGENTS.override.md"),
    claudeHome: env.CLAUDE_HOME || path.join(home, ".claude"),
    claudeSettingsPath: path.join(env.CLAUDE_HOME || path.join(home, ".claude"), "settings.json"),
    claudeMdPath: path.join(env.CLAUDE_HOME || path.join(home, ".claude"), "CLAUDE.md"),
    notesRoot: env.AGENT_NOTES_DIR || path.join(home, ".agent-notes"),
    installRoot,
    binaryPath: path.join(installRoot, "bin", platform === "win32" ? "notes-mcp.exe" : "notes-mcp"),
  };
}

function countOccurrences(text, marker) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(marker, offset)) !== -1) {
    count += 1;
    offset += marker.length;
  }
  return count;
}

function managedBlockRange(text, begin, end, label) {
  const beginCount = countOccurrences(text, begin);
  const endCount = countOccurrences(text, end);
  if (beginCount === 0 && endCount === 0) return null;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(`${label} has duplicate or unmatched managed sentinels`);
  }
  const start = text.indexOf(begin);
  const endStart = text.indexOf(end);
  if (endStart < start) throw new Error(`${label} managed sentinels are out of order`);
  let finish = endStart + end.length;
  if (text.slice(finish, finish + 2) === "\r\n") finish += 2;
  else if (text[finish] === "\n") finish += 1;
  return { start, finish };
}

function appendBlock(text, block) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const normalizedBlock = newline === "\r\n" ? block.replace(/\n/g, "\r\n") : block;
  if (text.length === 0) return `${normalizedBlock}${newline}`;
  if (text.endsWith(`${newline}${newline}`)) return `${text}${normalizedBlock}${newline}`;
  if (text.endsWith(newline)) return `${text}${newline}${normalizedBlock}${newline}`;
  return `${text}${newline}${newline}${normalizedBlock}${newline}`;
}

function upsertManagedBlock(text, begin, end, block, label) {
  const range = managedBlockRange(text, begin, end, label);
  if (!range) return appendBlock(text, block);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const normalizedBlock = newline === "\r\n" ? block.replace(/\n/g, "\r\n") : block;
  return `${text.slice(0, range.start)}${normalizedBlock}${newline}${text.slice(range.finish)}`;
}

function removeManagedBlock(text, begin, end, label) {
  const range = managedBlockRange(text, begin, end, label);
  if (!range) return text;
  let start = range.start;
  if (start >= 4 && text.slice(start - 4, start) === "\r\n\r\n") start -= 2;
  else if (start >= 2 && text.slice(start - 2, start) === "\n\n") start -= 1;
  return `${text.slice(0, start)}${text.slice(range.finish)}`;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function mcpBlock(binaryPath) {
  return `${MCP_BEGIN}\n[mcp_servers.notes]\ncommand = ${tomlString(binaryPath)}\n${MCP_END}`;
}

function mcpServerEntry(config) {
  const { lines } = splitLines(config);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[\s*mcp_servers\s*\.\s*(?:notes|"notes"|'notes')\s*\]\s*(?:#.*)?$/.test(lines[index])) {
      if (start !== -1) throw new Error("Codex config defines mcp_servers.notes more than once");
      start = index;
      continue;
    }
    if (start !== -1 && /^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  if (start === -1) return null;
  let command = null;
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*command\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
    if (match) {
      try {
        command = JSON.parse(match[1]);
      } catch {
        command = null;
      }
      break;
    }
  }
  return { start, end, command };
}

function hasUnmanagedNotesServer(config) {
  const withoutManaged = removeManagedBlock(config, MCP_BEGIN, MCP_END, "Codex config");
  return mcpServerEntry(withoutManaged) !== null;
}

function splitLines(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.replace(/\r\n/g, "\n").split("\n"), newline };
}

function tokenBudgetEntry(config) {
  const { lines } = splitLines(config);
  let table = "";
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const tableMatch = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
    if (tableMatch) {
      table = tableMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    let match;
    let installedLine;
    if (table === "features") {
      match = line.match(/^(\s*)token_budget\s*=\s*(true|false)\s*(?:#.*)?$/);
      if (match) installedLine = `${match[1]}token_budget = true`;
    } else if (table === "") {
      match = line.match(/^(\s*)features\s*\.\s*token_budget\s*=\s*(true|false)\s*(?:#.*)?$/);
      if (match) installedLine = `${match[1]}features.token_budget = true`;
    }
    if (match) entries.push({
      index,
      value: match[2] === "true",
      line,
      installedLine,
      kind: table === "features" ? "table" : "dotted",
    });
  }
  if (entries.length > 1) throw new Error("Codex config defines features.token_budget more than once");
  return entries[0] || null;
}

function enableTokenBudget(config) {
  const current = tokenBudgetEntry(config);
  if (current?.value) return config;
  const { lines, newline } = splitLines(config);
  if (current) {
    const encoded = Buffer.from(current.line, "utf8").toString("base64url");
    lines.splice(current.index, 1, `${TOKEN_CHANGED}${encoded}`, current.installedLine);
    return lines.join(newline);
  }

  const featuresIndex = lines.findIndex((line) => /^\s*\[\s*["']?features["']?\s*\]\s*(?:#.*)?$/.test(line));
  if (featuresIndex !== -1) {
    lines.splice(featuresIndex + 1, 0, TOKEN_ADDED_KEY, "token_budget = true");
    return lines.join(newline);
  }

  let result = config;
  const block = `[features]\n${TOKEN_ADDED_TABLE}\ntoken_budget = true`;
  result = appendBlock(result, block);
  return result;
}

function removeManagedTokenBudget(config) {
  const { lines, newline } = splitLines(config);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === TOKEN_ADDED_KEY) {
      if (lines[index + 1] === "token_budget = true") {
        lines.splice(index, 2);
      } else {
        lines.splice(index, 1);
      }
      return lines.join(newline);
    }
    if (line === TOKEN_ADDED_TABLE) {
      const headerIndex = index - 1;
      const expectedHeader = /^\s*\[\s*["']?features["']?\s*\]\s*(?:#.*)?$/.test(lines[headerIndex] || "");
      const expectedValue = lines[index + 1] === "token_budget = true";
      let nextTable = index + 2;
      while (nextTable < lines.length && !/^\s*\[/.test(lines[nextTable])) nextTable += 1;
      const extra = lines.slice(index + 2, nextTable).some((candidate) => candidate.trim() && !candidate.trim().startsWith("#"));
      if (expectedHeader && expectedValue && !extra) {
        let removeCount = 3;
        if (lines[index + 2] === "") removeCount += 1;
        lines.splice(headerIndex, removeCount);
      } else {
        lines.splice(index, expectedValue ? 2 : 1);
      }
      return lines.join(newline);
    }
    if (line.startsWith(TOKEN_CHANGED)) {
      const encoded = line.slice(TOKEN_CHANGED.length);
      let original;
      try {
        original = Buffer.from(encoded, "base64url").toString("utf8");
      } catch {
        original = "";
      }
      if (!original) throw new Error("Codex config has an invalid token-budget ownership marker");
      const tableMatch = original.match(/^(\s*)token_budget\s*=\s*false\s*(?:#.*)?$/);
      const dottedMatch = original.match(/^(\s*)features\s*\.\s*token_budget\s*=\s*false\s*(?:#.*)?$/);
      if (!tableMatch && !dottedMatch) throw new Error("Codex config has an invalid token-budget ownership marker");
      const installedLine = tableMatch
        ? `${tableMatch[1]}token_budget = true`
        : `${dottedMatch[1]}features.token_budget = true`;
      if (lines[index + 1] === installedLine) {
        lines.splice(index, 2, original);
      } else {
        lines.splice(index, 1);
      }
      return lines.join(newline);
    }
  }
  return config;
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function skipJsonWhitespace(text, offset) {
  while (offset < text.length && /\s/.test(text[offset])) offset += 1;
  return offset;
}

function jsonStringEnd(text, start) {
  if (text[start] !== '"') throw new Error("settings.json contains an invalid string");
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') return index + 1;
  }
  throw new Error("settings.json contains an unterminated string");
}

function jsonValueEnd(text, start) {
  const character = text[start];
  if (character === '"') return jsonStringEnd(text, start);
  if (character === "{") {
    let offset = skipJsonWhitespace(text, start + 1);
    if (text[offset] === "}") return offset + 1;
    while (offset < text.length) {
      offset = skipJsonWhitespace(text, offset);
      offset = jsonStringEnd(text, offset);
      offset = skipJsonWhitespace(text, offset);
      if (text[offset] !== ":") throw new Error("settings.json contains an invalid object");
      offset = skipJsonWhitespace(text, offset + 1);
      offset = jsonValueEnd(text, offset);
      offset = skipJsonWhitespace(text, offset);
      if (text[offset] === "}") return offset + 1;
      if (text[offset] !== ",") throw new Error("settings.json contains an invalid object");
      offset += 1;
    }
  }
  if (character === "[") {
    let offset = skipJsonWhitespace(text, start + 1);
    if (text[offset] === "]") return offset + 1;
    while (offset < text.length) {
      offset = skipJsonWhitespace(text, offset);
      offset = jsonValueEnd(text, offset);
      offset = skipJsonWhitespace(text, offset);
      if (text[offset] === "]") return offset + 1;
      if (text[offset] !== ",") throw new Error("settings.json contains an invalid array");
      offset += 1;
    }
  }
  let offset = start;
  while (offset < text.length && !/[,\]}\s]/.test(text[offset])) offset += 1;
  return offset;
}

function jsonObjectInfo(text, start) {
  if (text[start] !== "{") throw new Error("settings.json object expected");
  const entries = [];
  let offset = skipJsonWhitespace(text, start + 1);
  if (text[offset] === "}") return { start, end: offset + 1, entries };
  while (offset < text.length) {
    offset = skipJsonWhitespace(text, offset);
    const keyStart = offset;
    const keyEnd = jsonStringEnd(text, offset);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    offset = skipJsonWhitespace(text, keyEnd);
    if (text[offset] !== ":") throw new Error("settings.json contains an invalid object");
    const valueStart = skipJsonWhitespace(text, offset + 1);
    const valueEnd = jsonValueEnd(text, valueStart);
    entries.push({ key, start: keyStart, valueStart, end: valueEnd, commaAfter: null });
    offset = skipJsonWhitespace(text, valueEnd);
    if (text[offset] === "}") return { start, end: offset + 1, entries };
    if (text[offset] !== ",") throw new Error("settings.json contains an invalid object");
    entries[entries.length - 1].commaAfter = offset;
    offset += 1;
  }
  throw new Error("settings.json contains an unterminated object");
}

function jsonArrayInfo(text, start) {
  if (text[start] !== "[") throw new Error("settings.json array expected");
  const items = [];
  let offset = skipJsonWhitespace(text, start + 1);
  if (text[offset] === "]") return { start, end: offset + 1, items };
  while (offset < text.length) {
    offset = skipJsonWhitespace(text, offset);
    const itemStart = offset;
    const itemEnd = jsonValueEnd(text, offset);
    items.push({ start: itemStart, end: itemEnd, commaAfter: null });
    offset = skipJsonWhitespace(text, itemEnd);
    if (text[offset] === "]") return { start, end: offset + 1, items };
    if (text[offset] !== ",") throw new Error("settings.json contains an invalid array");
    items[items.length - 1].commaAfter = offset;
    offset += 1;
  }
  throw new Error("settings.json contains an unterminated array");
}

function settingsInfo(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("root is not an object");
  } catch (error) {
    throw new Error(`settings.json is invalid JSON: ${error.message}`);
  }
  const start = skipJsonWhitespace(text, 0);
  const root = jsonObjectInfo(text, start);
  if (skipJsonWhitespace(text, root.end) !== text.length) throw new Error("settings.json has trailing data");
  return root;
}

function property(info, name) {
  if (!info) return null;
  const matches = info.entries.filter((entry) => entry.key === name);
  if (matches.length > 1) throw new Error(`settings.json defines ${name} more than once`);
  return matches[0] || null;
}

function objectAt(text, entry, label) {
  if (!entry) return null;
  try {
    return jsonObjectInfo(text, entry.valueStart);
  } catch {
    throw new Error(`settings.json ${label} must be an object`);
  }
}

function arrayAt(text, entry, label) {
  if (!entry) return null;
  try {
    return jsonArrayInfo(text, entry.valueStart);
  } catch {
    throw new Error(`settings.json ${label} must be an array`);
  }
}

function claudeHookEntry(binaryPath) {
  const command = `${JSON.stringify(binaryPath)} hint --source claude-code --open-notes-mcp-hook=${CLAUDE_HOOK_SENTINEL}`;
  return {
    matcher: "startup|resume|compact",
    hooks: [{ type: "command", command, timeout: 10 }],
  };
}

function claudeHookCommand(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return null;
  const commands = entry.hooks.filter((hook) => hook && hook.type === "command" && typeof hook.command === "string")
    .map((hook) => hook.command).filter((command) => command.includes(CLAUDE_HOOK_SENTINEL));
  return commands.length === 1 ? commands[0] : commands.length > 1 ? "duplicate" : null;
}

function claudeSettingsHook(text) {
  const root = settingsInfo(text);
  const hooksProperty = property(root, "hooks");
  const hooks = objectAt(text, hooksProperty, "hooks");
  const sessionProperty = property(hooks, "SessionStart");
  const session = arrayAt(text, sessionProperty, "hooks.SessionStart");
  const managed = [];
  if (session) {
    for (const item of session.items) {
      let value;
      try {
        value = JSON.parse(text.slice(item.start, item.end));
      } catch {
        throw new Error("settings.json contains an invalid SessionStart hook");
      }
      const command = claudeHookCommand(value);
      if (command === "duplicate") throw new Error("settings.json contains duplicate open-notes-mcp Claude hooks");
      if (command) managed.push({ item, value, command });
    }
  }
  if (managed.length > 1) throw new Error("settings.json contains duplicate open-notes-mcp Claude hooks");
  return { root, hooksProperty, hooks, sessionProperty, session, managed: managed[0] || null };
}

function insertJsonProperty(text, object, key, value) {
  const close = object.end - 1;
  const hasEntries = text.slice(object.start + 1, close).trim().length > 0;
  return `${text.slice(0, close)}${hasEntries ? "," : ""}${JSON.stringify(key)}:${JSON.stringify(value)}${text.slice(close)}`;
}

function insertJsonArrayItem(text, array, value) {
  const close = array.end - 1;
  const hasItems = text.slice(array.start + 1, close).trim().length > 0;
  return `${text.slice(0, close)}${hasItems ? "," : ""}${JSON.stringify(value)}${text.slice(close)}`;
}

function upsertClaudeSettings(text, binaryPath) {
  if (!text.trim()) {
    const value = claudeHookEntry(binaryPath);
    return {
      text: `{"hooks":{"SessionStart":[${JSON.stringify(value)}]}}\n`,
      settingsCreated: true,
      addedHooks: true,
      addedSessionStart: true,
      command: value.hooks[0].command,
    };
  }
  const current = claudeSettingsHook(text);
  if (current.managed) {
    return {
      text,
      settingsCreated: false,
      addedHooks: false,
      addedSessionStart: false,
      command: current.managed.command,
    };
  }
  const value = claudeHookEntry(binaryPath);
  let next = text;
  let addedHooks = false;
  let addedSessionStart = false;
  if (!current.hooksProperty) {
    const rootValue = { SessionStart: [value] };
    next = insertJsonProperty(next, current.root, "hooks", rootValue);
    addedHooks = true;
    addedSessionStart = true;
  } else if (!current.sessionProperty) {
    next = insertJsonProperty(next, current.hooks, "SessionStart", [value]);
    addedSessionStart = true;
  } else {
    next = insertJsonArrayItem(next, current.session, value);
  }
  return { text: next, settingsCreated: false, addedHooks, addedSessionStart, command: value.hooks[0].command };
}

function removeJsonArrayItem(text, array, itemIndex) {
  const item = array.items[itemIndex];
  if (array.items.length === 1) return `${text.slice(0, item.start)}${text.slice(item.end)}`;
  if (itemIndex === 0) return `${text.slice(0, item.start)}${text.slice(item.commaAfter + 1)}`;
  const previous = array.items[itemIndex - 1];
  return `${text.slice(0, previous.commaAfter)}${text.slice(item.end)}`;
}

function removeJsonProperty(text, object, key) {
  const index = object.entries.findIndex((entry) => entry.key === key);
  if (index < 0) return text;
  const entry = object.entries[index];
  if (object.entries.length === 1) return `${text.slice(0, entry.start)}${text.slice(entry.end)}`;
  if (index === 0) return `${text.slice(0, entry.start)}${text.slice(entry.commaAfter + 1)}`;
  const previous = object.entries[index - 1];
  return `${text.slice(0, previous.commaAfter)}${text.slice(entry.end)}`;
}

function removeClaudeHook(text, state = {}) {
  if (!text.trim()) return text;
  let current = claudeSettingsHook(text);
  if (!current.managed) return text;
  const itemIndex = current.session.items.indexOf(current.managed.item);
  let next = removeJsonArrayItem(text, current.session, itemIndex);
  current = claudeSettingsHook(next);
  if (state.addedSessionStart && current.sessionProperty) {
    const session = arrayAt(next, current.sessionProperty, "hooks.SessionStart");
    if (session.items.length === 0) {
      next = removeJsonProperty(next, current.hooks, "SessionStart");
      current = claudeSettingsHook(next);
    }
  }
  if (state.addedHooks && current.hooksProperty && current.hooks.entries.length === 0) {
    next = removeJsonProperty(next, current.root, "hooks");
  }
  return next;
}

function readInstallState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const hasCodex = parsed && parsed.tokenBudget && typeof parsed.mcpCommand === "string" && parsed.mcpCommand.length > 0;
    const hasClaude = parsed && parsed.claudeCode && typeof parsed.claudeCode.command === "string";
    if (!parsed || parsed.version !== 1 || (!hasCodex && !hasClaude)) {
      throw new Error("invalid install state");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError || error.message === "invalid install state") {
      throw new Error(`invalid ${INSTALL_STATE}: ${error.message}`);
    }
    throw error;
  }
}

function writeInstallState(file, state) {
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

function removeFileIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function atomicWrite(file, content, newMode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let mode = newMode;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode, flag: "wx" });
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function copyBinary(source, destination) {
  const bytes = fs.readFileSync(source);
  let unchanged = false;
  try {
    const current = fs.readFileSync(destination);
    unchanged = current.equals(bytes);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!unchanged) atomicWrite(destination, bytes, 0o755);
  fs.chmodSync(destination, 0o755);
}

function resolveNativeBinary(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.OPEN_NOTES_MCP_BINARY) return path.resolve(env.OPEN_NOTES_MCP_BINARY);
  const key = `${platform}-${arch}`;
  const packageName = PLATFORM_PACKAGES.get(key);
  if (!packageName) throw new Error(`unsupported platform ${key}`);
  let manifest;
  try {
    manifest = require.resolve(`${packageName}/package.json`, { paths: [__dirname] });
  } catch {
    throw new Error(`native package ${packageName} is missing; reinstall open-notes-mcp with optional dependencies enabled`);
  }
  return path.join(path.dirname(manifest), "bin", platform === "win32" ? "notes-mcp.exe" : "notes-mcp");
}

function codexCommand(env = process.env) {
  return env.OPEN_NOTES_MCP_CODEX_BIN || "codex";
}

function codexVersion(env = process.env) {
  const result = childProcess.spawnSync(codexCommand(env), ["--version"], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error?.code === "ENOENT") return { ok: false, missing: true, supported: false, detail: "Codex CLI not found on PATH" };
  if (result.error) return { ok: false, missing: false, supported: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, missing: false, supported: false, detail: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  const detail = [result.stdout, result.stderr].filter(Boolean).join(" ").trim();
  const match = detail.match(/\b(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return { ok: false, missing: false, supported: false, detail: `unable to parse Codex version from: ${detail || "(empty output)"}` };
  const version = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  const supported = version[0] > MIN_CODEX_VERSION[0]
    || (version[0] === MIN_CODEX_VERSION[0] && (version[1] > MIN_CODEX_VERSION[1]
      || (version[1] === MIN_CODEX_VERSION[1] && version[2] >= MIN_CODEX_VERSION[2])));
  return {
    ok: supported,
    missing: false,
    supported,
    version,
    detail: supported ? detail : `Codex ${detail} is too old; requires >= 0.148.0`,
  };
}

function readConsent() {
  process.stderr.write("Enable features.token_budget? This opts Codex into hard context-window cuts and activates automatic notes hints. [y/N] ");
  const buffer = Buffer.alloc(1);
  let answer = "";
  try {
    while (fs.readSync(0, buffer, 0, 1, null) === 1) {
      const character = buffer.toString("utf8");
      if (character === "\n" || character === "\r") break;
      answer += character;
    }
  } catch (error) {
    if (error.code !== "EAGAIN") throw error;
  }
  return /^(?:y|yes)$/i.test(answer.trim());
}

function parseInitOptions(args) {
  let tokenChoice = null;
  let harness = "codex";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--enable-token-budget") {
      if (tokenChoice === false) throw new Error("token-budget options are mutually exclusive");
      tokenChoice = true;
    } else if (arg === "--without-token-budget") {
      if (tokenChoice === true) throw new Error("token-budget options are mutually exclusive");
      tokenChoice = false;
    } else if (arg === "--harness") {
      const value = args[++index];
      if (value !== "codex" && value !== "claude-code") throw new Error("--harness requires codex or claude-code");
      harness = value;
    } else {
      throw new Error(`unknown init option: ${arg}`);
    }
  }
  return { tokenChoice, harness };
}

function runCodex(args, env = process.env) {
  return childProcess.spawnSync(codexCommand(env), args, {
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function codexMcpAdd(binaryPath, env = process.env) {
  const result = runCodex(["mcp", "add", "notes", "--", binaryPath], env);
  if (result.error || result.status !== 0) {
    throw new Error(`Codex MCP registration failed: ${result.error?.message || (result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
}

function codexMcpRemove(env = process.env) {
  const result = runCodex(["mcp", "remove", "notes"], env);
  if (result.error || result.status !== 0) {
    throw new Error(`Codex MCP removal failed: ${result.error?.message || (result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
}

function restoreFile(file, existed, content) {
  if (existed) atomicWrite(file, content, 0o600);
  else removeFileIfPresent(file);
}

function prepareInit(loc, binaryPath, tokenChoice, state) {
  const config = readFileOrEmpty(loc.configPath);
  const agentsFiles = [loc.agentsPath, loc.agentsOverridePath].map((file) => ({
    file,
    content: readFileOrEmpty(file),
  }));
  const existingMcp = mcpServerEntry(config);
  if (existingMcp && (!state || existingMcp.command !== state.mcpCommand)) {
    throw new Error("Codex config already has an unmanaged [mcp_servers.notes] table; remove or rename it before init");
  }
  for (const entry of agentsFiles) {
    managedBlockRange(entry.content, AGENTS_BEGIN, AGENTS_END, path.basename(entry.file));
  }
  const activeAgentsPath = agentsFiles[1].content.trim() ? loc.agentsOverridePath : loc.agentsPath;

  const currentToken = tokenBudgetEntry(config);
  let enableToken = currentToken?.value === true;
  if (!enableToken) enableToken = tokenChoice === null ? readConsent() : tokenChoice;

  let nextConfig = config;
  if (enableToken && !currentToken?.value) nextConfig = enableTokenBudget(nextConfig);
  const agentsUpdates = agentsFiles.map((entry) => ({
    ...entry,
    next: entry.file === activeAgentsPath
      ? upsertManagedBlock(entry.content, AGENTS_BEGIN, AGENTS_END, AGENTS_BLOCK, path.basename(entry.file))
      : removeManagedBlock(entry.content, AGENTS_BEGIN, AGENTS_END, path.basename(entry.file)),
  }));
  const originalToken = state?.tokenBudget || {
    present: Boolean(currentToken),
    value: currentToken ? currentToken.value : null,
    kind: currentToken?.kind || null,
    line: currentToken?.line || null,
  };
  return {
    config,
    nextConfig,
    agentsUpdates,
    activeAgentsPath,
    tokenEnabled: enableToken,
    existingMcp,
    originalToken,
  };
}

function initCodex(tokenChoice, io = console, env = process.env) {
  const loc = locations(env);
  const version = codexVersion(env);
  if (!version.ok) throw new Error(version.detail);
  const nativeBinary = resolveNativeBinary(env);
  const installedState = readInstallState(loc.statePath);
  const state = installedState?.mcpCommand ? installedState : null;
  const prepared = prepareInit(loc, loc.binaryPath, tokenChoice, state);
  const codexHomeExisted = fs.existsSync(loc.codexHome);
  const configExisted = fs.existsSync(loc.configPath);
  const stateExisted = fs.existsSync(loc.statePath);
  const originalAgents = prepared.agentsUpdates.map((entry) => ({ file: entry.file, existed: fs.existsSync(entry.file), content: entry.content }));

  fs.mkdirSync(loc.codexHome, { recursive: true, mode: 0o700 });
  copyBinary(nativeBinary, loc.binaryPath);
  try {
    if (prepared.nextConfig !== prepared.config) atomicWrite(loc.configPath, prepared.nextConfig, 0o600);
    if (!prepared.existingMcp) {
      codexMcpAdd(loc.binaryPath, env);
      const registered = mcpServerEntry(readFileOrEmpty(loc.configPath));
      if (!registered || registered.command !== loc.binaryPath) {
        throw new Error("Codex MCP registration did not produce the expected notes server entry");
      }
    } else if (prepared.existingMcp.command !== loc.binaryPath) {
      throw new Error("existing notes MCP entry points at a different binary");
    }
    for (const entry of prepared.agentsUpdates) {
      if (entry.next !== entry.content) atomicWrite(entry.file, entry.next, 0o644);
    }
    const nextState = {
      version: 1,
      mcpCommand: loc.binaryPath,
      binaryPath: loc.binaryPath,
      agentsPath: prepared.activeAgentsPath,
      tokenBudget: prepared.originalToken,
      activated: prepared.tokenEnabled,
    };
    if (installedState?.claudeCode) nextState.claudeCode = installedState.claudeCode;
    writeInstallState(loc.statePath, nextState);
  } catch (error) {
    restoreFile(loc.configPath, configExisted, prepared.config);
    for (const entry of originalAgents) restoreFile(entry.file, entry.existed, entry.content);
    if (!stateExisted) removeFileIfPresent(loc.statePath);
    removeFileIfPresent(loc.binaryPath);
    for (const directory of [path.dirname(loc.binaryPath), loc.installRoot, !codexHomeExisted ? loc.codexHome : null]) {
      if (!directory) continue;
      try {
        fs.rmdirSync(directory);
      } catch (cleanupError) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(cleanupError.code)) throw cleanupError;
      }
    }
    throw error;
  }

  io.log(`installed notes MCP binary: ${loc.binaryPath}`);
  io.log(`configured Codex via codex mcp add: ${loc.configPath}`);
  io.log(`installed notes workflow block: ${prepared.activeAgentsPath}`);
  if (!prepared.tokenEnabled) {
    io.log("features.token_budget: disabled by your choice; automatic hints will not be injected");
    io.log("To enable later: npx open-notes-mcp init --enable-token-budget");
    return 2;
  }
  io.log("features.token_budget: enabled");
  const live = livenessProbe(loc, env);
  if (!live.ok) {
    io.error?.(`FAIL liveness: ${live.detail}`);
    return 1;
  }
  io.log(`PASS liveness: ${live.detail}`);
  return 0;
}

function binaryHandshake(binaryPath, notesRoot, env = process.env) {
  const started = process.hrtime.bigint();
  const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`;
  const result = childProcess.spawnSync(binaryPath, [], {
    input,
    env: { ...env, AGENT_NOTES_DIR: notesRoot },
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.error) return { ok: false, detail: result.error.message, elapsedMs };
  if (result.status !== 0) return { ok: false, detail: (result.stderr || `exit ${result.status}`).trim(), elapsedMs };
  try {
    const response = JSON.parse(result.stdout.trim());
    const ok = response?.result?.serverInfo?.name === "notes" && elapsedMs < 200;
    return { ok, detail: ok ? `${elapsedMs.toFixed(1)}ms` : `unexpected initialize response (${elapsedMs.toFixed(1)}ms)`, elapsedMs };
  } catch (error) {
    return { ok: false, detail: `invalid initialize response: ${error.message}`, elapsedMs };
  }
}

function livenessProbe(loc, env = process.env) {
  const stampPath = path.join(loc.notesRoot, ".last-hint");
  let before = null;
  try {
    before = fs.readFileSync(stampPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, detail: error.message };
  }
  const started = Date.now();
  const provider = "open_notes_mcp_doctor";
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "-c", `model_provider=${tomlString(provider)}`,
    "-c", `model_providers.${provider}.name=${tomlString("open-notes-mcp doctor")}`,
    "-c", `model_providers.${provider}.base_url=${tomlString("http://127.0.0.1:9/v1")}`,
    "-c", `model_providers.${provider}.env_key=${tomlString("OPENAI_API_KEY")}`,
    "-c", `model_providers.${provider}.wire_api=${tomlString("responses")}`,
    "-c", `model_providers.${provider}.request_max_retries=0`,
    "-c", `model_providers.${provider}.stream_max_retries=0`,
    "Reply with OK.",
  ];
  childProcess.spawnSync(codexCommand(env), args, {
    cwd: os.tmpdir(),
    env: { ...env, OPENAI_API_KEY: "open-notes-mcp-doctor-placeholder" },
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });

  try {
    const after = fs.readFileSync(stampPath, "utf8");
    const stat = fs.statSync(stampPath);
    const valid = /^last_thread_hint=\S+ thread_id=[0-9a-f-]+ bytes=\d+\n?$/.test(after);
    const fresh = after !== before && stat.mtimeMs >= started - 1000;
    return { ok: valid && fresh, detail: valid && fresh ? `fresh stamp at ${stampPath}` : "codex exec did not produce a fresh valid .last-hint" };
  } catch (error) {
    return { ok: false, detail: `codex exec did not create ${stampPath}: ${error.message}` };
  }
}

function claudeCommand(env = process.env) {
  return env.OPEN_NOTES_MCP_CLAUDE_BIN || "claude";
}

function claudeAvailable(env = process.env) {
  const result = childProcess.spawnSync(claudeCommand(env), ["--version"], {
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") return { present: false, detail: "Claude Code CLI not found on PATH" };
  if (result.error) return { present: true, detail: result.error.message };
  return { present: true, detail: [result.stdout, result.stderr].filter(Boolean).join(" ").trim() || `exit ${result.status}` };
}

function claudeStamp(stampPath) {
  try {
    const text = fs.readFileSync(stampPath, "utf8");
    const match = text.match(/^last_thread_hint=\S+ source=claude-code session_id=\S+ bytes=\d+\n?$/);
    return match ? { text, stat: fs.statSync(stampPath) } : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function claudeLivenessProbe(loc, env = process.env) {
  const stampPath = path.join(loc.notesRoot, ".last-hint");
  let before = null;
  try {
    before = { text: fs.readFileSync(stampPath, "utf8"), mtimeMs: fs.statSync(stampPath).mtimeMs };
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, detail: error.message };
  }
  const started = Date.now();
  childProcess.spawnSync(claudeCommand(env), ["-p", "Reply with OK.", "--output-format", "text"], {
    cwd: os.tmpdir(),
    env: {
      ...env,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      ANTHROPIC_API_KEY: "open-notes-mcp-doctor-placeholder",
    },
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  try {
    const stamp = claudeStamp(stampPath);
    const fresh = stamp && stamp.stat.mtimeMs >= started - 1000
      && (!before || stamp.stat.mtimeMs > before.mtimeMs || stamp.text !== before.text);
    return {
      ok: Boolean(fresh),
      detail: fresh ? `fresh source=claude-code stamp at ${stampPath}` : "Claude Code session did not produce a fresh source=claude-code stamp",
    };
  } catch (error) {
    return { ok: false, detail: `could not inspect ${stampPath}: ${error.message}` };
  }
}

function initClaude(io = console, env = process.env) {
  const loc = locations(env);
  const nativeBinary = resolveNativeBinary(env);
  const installedState = readInstallState(loc.statePath);
  const settingsExisted = fs.existsSync(loc.claudeSettingsPath);
  const claudeMdExisted = fs.existsSync(loc.claudeMdPath);
  const settings = readFileOrEmpty(loc.claudeSettingsPath);
  const claudeMd = readFileOrEmpty(loc.claudeMdPath);
  const settingsUpdate = upsertClaudeSettings(settings, loc.binaryPath);
  const nextClaudeMd = upsertManagedBlock(claudeMd, CLAUDE_BEGIN, CLAUDE_END, CLAUDE_BLOCK, "CLAUDE.md");
  const stateExisted = fs.existsSync(loc.statePath);
  const binaryExisted = fs.existsSync(loc.binaryPath);
  const claudeRecord = {
    ...(installedState?.claudeCode || {}),
    binaryPath: loc.binaryPath,
    command: settingsUpdate.command,
    settingsPath: loc.claudeSettingsPath,
    claudeMdPath: loc.claudeMdPath,
    claudeMdCreated: Boolean(installedState?.claudeCode?.claudeMdCreated || !claudeMdExisted),
    settingsCreated: Boolean(installedState?.claudeCode?.settingsCreated || settingsUpdate.settingsCreated),
    addedHooks: Boolean(installedState?.claudeCode?.addedHooks || settingsUpdate.addedHooks),
    addedSessionStart: Boolean(installedState?.claudeCode?.addedSessionStart || settingsUpdate.addedSessionStart),
  };
  fs.mkdirSync(loc.claudeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(loc.codexHome, { recursive: true, mode: 0o700 });
  copyBinary(nativeBinary, loc.binaryPath);
  try {
    if (settingsUpdate.text !== settings) atomicWrite(loc.claudeSettingsPath, settingsUpdate.text, 0o600);
    if (nextClaudeMd !== claudeMd) atomicWrite(loc.claudeMdPath, nextClaudeMd, 0o644);
    const nextState = installedState ? { ...installedState, claudeCode: claudeRecord } : { version: 1, claudeCode: claudeRecord };
    writeInstallState(loc.statePath, nextState);
  } catch (error) {
    restoreFile(loc.claudeSettingsPath, settingsExisted, settings);
    restoreFile(loc.claudeMdPath, claudeMdExisted, claudeMd);
    if (!binaryExisted) removeFileIfPresent(loc.binaryPath);
    if (!stateExisted) removeFileIfPresent(loc.statePath);
    throw error;
  }

  io.log(`installed notes MCP binary: ${loc.binaryPath}`);
  io.log(`registered Claude Code SessionStart hook: ${loc.claudeSettingsPath}`);
  io.log(`installed notes workflow block: ${loc.claudeMdPath}`);
  const available = claudeAvailable(env);
  if (!available.present) {
    io.log(`SKIP liveness: ${available.detail}`);
    return 2;
  }
  const live = claudeLivenessProbe(loc, env);
  if (!live.ok) {
    io.error?.(`FAIL liveness: ${live.detail}`);
    return 1;
  }
  io.log(`PASS liveness: ${live.detail}`);
  return 0;
}

function doctorClaude(io = console, env = process.env) {
  const loc = locations(env);
  let failed = false;
  let available;
  const report = (kind, label, detail) => {
    io.log(`${kind} ${label}: ${detail}`);
    if (kind === "FAIL") failed = true;
  };
  let settings = "";
  try {
    settings = readFileOrEmpty(loc.claudeSettingsPath);
    const current = claudeSettingsHook(settings);
    const value = current.managed?.value;
    const hook = value?.hooks?.length === 1 ? value.hooks[0] : null;
    const hookOk = Boolean(current.managed
      && current.managed.command.includes(CLAUDE_HOOK_SENTINEL)
      && value.matcher === "startup|resume|compact"
      && hook?.type === "command"
      && hook.timeout === 10);
    report(hookOk ? "PASS" : "FAIL", "Claude hook", hookOk ? `SessionStart startup|resume|compact timeout=10 at ${loc.claudeSettingsPath}` : "managed SessionStart hook is missing, duplicated, or differs from this release");
  } catch (error) {
    report("FAIL", "Claude hook", error.message);
  }
  try {
    const content = readFileOrEmpty(loc.claudeMdPath);
    const range = managedBlockRange(content, CLAUDE_BEGIN, CLAUDE_END, "CLAUDE.md");
    const matches = range && content.slice(range.start, range.finish).replace(/\r\n/g, "\n").trimEnd() === CLAUDE_BLOCK;
    report(matches ? "PASS" : "FAIL", "CLAUDE.md", matches ? `managed workflow block in ${loc.claudeMdPath}` : "managed block is missing, duplicated, or differs from this release");
  } catch (error) {
    report("FAIL", "CLAUDE.md", error.message);
  }
  try {
    const stamp = claudeStamp(path.join(loc.notesRoot, ".last-hint"));
    report(stamp ? "PASS" : "WARN", "last hint", stamp ? `source=claude-code stamp in ${path.join(loc.notesRoot, ".last-hint")}` : "no source=claude-code stamp yet");
  } catch (error) {
    report("FAIL", "last hint", error.message);
  }
  if (!fs.existsSync(loc.binaryPath)) report("FAIL", "binary", `missing ${loc.binaryPath}`);
  available = claudeAvailable(env);
  if (!available.present) {
    io.log(`SKIP liveness: ${available.detail}`);
    return failed ? 1 : 2;
  }
  const live = claudeLivenessProbe(loc, env);
  report(live.ok ? "PASS" : "FAIL", "liveness", live.detail);
  return failed ? 1 : live.ok ? 0 : 1;
}

function doctorCodex(io = console, env = process.env) {
  const loc = locations(env);
  let failed = false;
  let inactive = false;
  const report = (kind, label, detail) => {
    io.log(`${kind} ${label}: ${detail}`);
    if (kind === "FAIL") failed = true;
  };

  const version = codexVersion(env);
  if (version.ok) report("PASS", "codex", version.detail);
  else report("FAIL", "codex", version.detail);

  const config = readFileOrEmpty(loc.configPath);
  const state = (() => {
    try {
      return readInstallState(loc.statePath);
    } catch (error) {
      report("FAIL", "install state", error.message);
      return null;
    }
  })();
  try {
    const entry = mcpServerEntry(config);
    const matches = Boolean(state && entry && entry.command === state.mcpCommand && entry.command === loc.binaryPath);
    report(matches ? "PASS" : "FAIL", "config", matches ? "notes server registered by codex mcp add" : entry ? "notes server entry differs from this installation" : "notes server entry is missing");
  } catch (error) {
    report("FAIL", "config", error.message);
  }

  const agentsFiles = [loc.agentsPath, loc.agentsOverridePath].map((file) => ({
    file,
    content: readFileOrEmpty(file),
  }));
  try {
    const ranges = agentsFiles.map((entry) => managedBlockRange(entry.content, AGENTS_BEGIN, AGENTS_END, path.basename(entry.file)));
    const activeIndex = agentsFiles[1].content.trim() ? 1 : 0;
    const range = ranges[activeIndex];
    const matches = ranges.filter(Boolean).length === 1
      && range
      && agentsFiles[activeIndex].content.slice(range.start, range.finish).replace(/\r\n/g, "\n").trimEnd() === AGENTS_BLOCK;
    report(matches ? "PASS" : "FAIL", "AGENTS.md", matches ? `managed workflow block in ${path.basename(agentsFiles[activeIndex].file)}` : "managed block is missing, duplicated, inactive, or differs from this release");
  } catch (error) {
    report("FAIL", "AGENTS.md", error.message);
  }

  try {
    const token = tokenBudgetEntry(config);
    if (token?.value) report("PASS", "token budget", "enabled");
    else {
      inactive = true;
      report("WARN", "token budget", "installed but inactive; automatic hints will not be injected");
      io.log("To enable later: npx open-notes-mcp init --enable-token-budget");
    }
  } catch (error) {
    report("FAIL", "token budget", error.message);
  }

  const handshake = binaryHandshake(loc.binaryPath, loc.notesRoot, env);
  report(handshake.ok ? "PASS" : "FAIL", "binary initialize", handshake.detail);

  if (!version.ok) {
    io.log(`SKIP liveness: ${version.detail}`);
    failed = true;
  } else if (inactive) {
    io.log("SKIP liveness: token_budget is disabled by user choice");
  } else if (!handshake.ok) {
    io.log("SKIP liveness: installed binary failed initialize");
    failed = true;
  } else {
    const live = livenessProbe(loc, env);
    report(live.ok ? "PASS" : "FAIL", "liveness", live.detail);
  }
  return failed ? 1 : inactive ? 2 : 0;
}

function removeMcpServerTable(config) {
  const entry = mcpServerEntry(config);
  if (!entry) return config;
  const { lines, newline } = splitLines(config);
  let start = entry.start;
  let end = entry.end;
  if (start > 0 && lines[start - 1] === "") start -= 1;
  if (end < lines.length && lines[end] === "") end += 1;
  lines.splice(start, end - start);
  return lines.join(newline);
}

function uninstallCodex(io = console, env = process.env) {
  const loc = locations(env);
  const state = readInstallState(loc.statePath);
  if (state && !state.mcpCommand) throw new Error("install state contains only the Claude Code harness; use uninstall --harness claude-code");
  const config = readFileOrEmpty(loc.configPath);
  const agentsFiles = [loc.agentsPath, loc.agentsOverridePath].map((file) => ({
    file,
    content: readFileOrEmpty(file),
  }));
  let nextConfig = config;
  if (state) {
    const entry = mcpServerEntry(config);
    if (entry && entry.command !== state.mcpCommand) {
      throw new Error("notes MCP entry points at a different binary; refusing to remove user configuration");
    }
    if (entry) {
      try {
        codexMcpRemove(env);
        nextConfig = readFileOrEmpty(loc.configPath);
      } catch (error) {
        nextConfig = removeMcpServerTable(config);
        if (nextConfig === config) throw error;
        atomicWrite(loc.configPath, nextConfig, 0o600);
      }
    }
    if (state.tokenBudget.value === false || state.tokenBudget.value === null) {
      nextConfig = removeManagedTokenBudget(nextConfig);
    }
  } else {
    io.log(`install state missing; unable to determine original token_budget, keeping current value`);
  }
  if (nextConfig !== config) atomicWrite(loc.configPath, nextConfig, 0o600);
  for (const entry of agentsFiles) {
    const next = removeManagedBlock(entry.content, AGENTS_BEGIN, AGENTS_END, path.basename(entry.file));
    if (next !== entry.content) atomicWrite(entry.file, next, 0o644);
  }

  if (state?.claudeCode) {
    writeInstallState(loc.statePath, { version: 1, claudeCode: state.claudeCode });
  } else {
    try {
      fs.unlinkSync(loc.binaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const directory of [path.dirname(loc.binaryPath), loc.installRoot]) {
      try {
        fs.rmdirSync(directory);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      }
    }
    if (state) removeFileIfPresent(loc.statePath);
  }
  io.log("removed open-notes-mcp managed configuration and binary");
  io.log(`preserved notes data: ${loc.notesRoot}`);
  return 0;
}

function parseHarnessOption(args, command) {
  if (args.length === 0) return "codex";
  if (args.length === 2 && args[0] === "--harness" && (args[1] === "codex" || args[1] === "claude-code")) return args[1];
  throw new Error(`unknown ${command} option: ${args[0]}`);
}

function uninstallClaude(io = console, env = process.env) {
  const loc = locations(env);
  const state = readInstallState(loc.statePath);
  const claudeState = state?.claudeCode || {};
  const settings = readFileOrEmpty(loc.claudeSettingsPath);
  const nextSettings = removeClaudeHook(settings, claudeState);
  if (nextSettings !== settings) {
    let emptySettings = false;
    try {
      emptySettings = Object.keys(JSON.parse(nextSettings)).length === 0;
    } catch {
      emptySettings = false;
    }
    if (claudeState.settingsCreated && emptySettings) {
      removeFileIfPresent(loc.claudeSettingsPath);
    } else {
      atomicWrite(loc.claudeSettingsPath, nextSettings, 0o600);
    }
  }
  const claudeMd = readFileOrEmpty(loc.claudeMdPath);
  const nextClaudeMd = removeManagedBlock(claudeMd, CLAUDE_BEGIN, CLAUDE_END, "CLAUDE.md");
  if (nextClaudeMd !== claudeMd) {
    if (claudeState.claudeMdCreated && nextClaudeMd === "") removeFileIfPresent(loc.claudeMdPath);
    else atomicWrite(loc.claudeMdPath, nextClaudeMd, 0o644);
  }

  const hasCodex = Boolean(state?.mcpCommand);
  if (!hasCodex) {
    removeFileIfPresent(loc.binaryPath);
    try {
      fs.rmdirSync(path.dirname(loc.binaryPath));
      fs.rmdirSync(loc.installRoot);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
    }
  }
  if (state) {
    if (state.claudeCode) {
      const nextState = { ...state };
      delete nextState.claudeCode;
      if (hasCodex) writeInstallState(loc.statePath, nextState);
      else removeFileIfPresent(loc.statePath);
    } else {
      removeFileIfPresent(loc.statePath);
    }
  }
  io.log("removed open-notes-mcp Claude Code hook and managed workflow block");
  io.log(`preserved notes data: ${loc.notesRoot}`);
  return 0;
}

function init(args, io = console, env = process.env) {
  const options = parseInitOptions(args);
  if (options.harness === "claude-code") {
    if (options.tokenChoice !== null) throw new Error("token-budget options apply only to the Codex harness");
    return initClaude(io, env);
  }
  return initCodex(options.tokenChoice, io, env);
}

function doctor(args, io = console, env = process.env) {
  const harness = parseHarnessOption(args, "doctor");
  return harness === "claude-code" ? doctorClaude(io, env) : doctorCodex(io, env);
}

function uninstall(args, io = console, env = process.env) {
  const harness = parseHarnessOption(args, "uninstall");
  return harness === "claude-code" ? uninstallClaude(io, env) : uninstallCodex(io, env);
}

async function run(args, io = console, env = process.env) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.log(usage());
    return command ? 0 : 1;
  }
  if (command === "init") return init(rest, io, env);
  if (command === "doctor") return doctor(rest, io, env);
  if (command === "uninstall") return uninstall(rest, io, env);
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

module.exports = {
  AGENTS_BEGIN,
  AGENTS_BLOCK,
  AGENTS_END,
  CLAUDE_BEGIN,
  CLAUDE_BLOCK,
  CLAUDE_END,
  CLAUDE_HOOK_SENTINEL,
  MCP_BEGIN,
  MCP_END,
  claudeSettingsHook,
  removeClaudeHook,
  codexVersion,
  enableTokenBudget,
  locations,
  mcpServerEntry,
  mcpBlock,
  removeManagedBlock,
  removeManagedTokenBudget,
  run,
  upsertClaudeSettings,
  tokenBudgetEntry,
  upsertManagedBlock,
};
