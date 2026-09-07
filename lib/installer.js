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
  init [--enable-token-budget | --without-token-budget]
  doctor
  uninstall

init asks before enabling features.token_budget. The two flags provide an
explicit non-interactive answer.`;
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

function readInstallState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== 1 || !parsed.tokenBudget || typeof parsed.mcpCommand !== "string") {
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
  for (const arg of args) {
    if (arg === "--enable-token-budget") {
      if (tokenChoice === false) throw new Error("token-budget options are mutually exclusive");
      tokenChoice = true;
    } else if (arg === "--without-token-budget") {
      if (tokenChoice === true) throw new Error("token-budget options are mutually exclusive");
      tokenChoice = false;
    } else {
      throw new Error(`unknown init option: ${arg}`);
    }
  }
  return tokenChoice;
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

function init(args, io = console, env = process.env) {
  const tokenChoice = parseInitOptions(args);
  const loc = locations(env);
  const version = codexVersion(env);
  if (!version.ok) throw new Error(version.detail);
  const nativeBinary = resolveNativeBinary(env);
  const state = readInstallState(loc.statePath);
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
    writeInstallState(loc.statePath, {
      version: 1,
      mcpCommand: loc.binaryPath,
      binaryPath: loc.binaryPath,
      agentsPath: prepared.activeAgentsPath,
      tokenBudget: prepared.originalToken,
      activated: prepared.tokenEnabled,
    });
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

function doctor(_args, io = console, env = process.env) {
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

function uninstall(args, io = console, env = process.env) {
  if (args.length) throw new Error(`unknown uninstall option: ${args[0]}`);
  const loc = locations(env);
  const state = readInstallState(loc.statePath);
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
  io.log("removed open-notes-mcp managed configuration and binary");
  io.log(`preserved notes data: ${loc.notesRoot}`);
  return 0;
}

async function run(args, io = console, env = process.env) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.log(usage());
    return command ? 0 : 1;
  }
  if (command === "init") return init(rest, io, env);
  if (command === "doctor") {
    if (rest.length) throw new Error(`unknown doctor option: ${rest[0]}`);
    return doctor(rest, io, env);
  }
  if (command === "uninstall") return uninstall(rest, io, env);
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

module.exports = {
  AGENTS_BEGIN,
  AGENTS_BLOCK,
  AGENTS_END,
  MCP_BEGIN,
  MCP_END,
  codexVersion,
  enableTokenBudget,
  locations,
  mcpServerEntry,
  mcpBlock,
  removeManagedBlock,
  removeManagedTokenBudget,
  run,
  tokenBudgetEntry,
  upsertManagedBlock,
};
