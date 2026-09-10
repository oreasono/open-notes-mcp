#!/usr/bin/env node

"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cleanup } = require("./lib/child-tracker");

const repoRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-installer-probe-"));
const packRoot = path.join(tempRoot, "packs");
const harnessRoot = path.join(tempRoot, "harness");
const checks = [];
const APPROVED_PUBLIC_HOSTS = new Set(["github.com", "developers.openai.com", "www.apache.org", "img.shields.io", "www.npmjs.com", "developercertificate.org"]);
const URL_HOST_PATTERN = /\b(?:(?:git\+)?https?|ssh):\/\/([^/\s"'<>`]+)/gi;
const npmEnv = {
  ...process.env,
  NPM_CONFIG_CACHE: path.join(tempRoot, "npm-cache"),
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
};

function check(label, condition, detail = "") {
  const ok = Boolean(condition);
  checks.push(ok);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}\n`);
}

function spawn(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    input: options.input,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    timeout: options.timeout || 30000,
    killSignal: options.killSignal || "SIGTERM",
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
  });
}

function mustRun(command, args, options = {}) {
  const result = spawn(command, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result;
}

function npmPack(directory) {
  const result = mustRun("npm", ["pack", "--json", "--pack-destination", packRoot, directory], { env: npmEnv });
  const parsed = JSON.parse(result.stdout);
  return path.join(packRoot, parsed[0].filename);
}

function unapprovedHost(text) {
  for (const match of text.matchAll(URL_HOST_PATTERN)) {
    const hostPort = match[1].split(/[?#]/, 1)[0];
    const host = hostPort.startsWith("[") ? hostPort.slice(1, hostPort.indexOf("]")) : hostPort.split(":", 1)[0].toLowerCase().replace(/\.$/, "");
    // The installer intentionally probes a dead loopback endpoint during liveness checks.
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) continue;
    if (!APPROVED_PUBLIC_HOSTS.has(host)) return host;
  }
  return null;
}

function scanText(text, label) {
  const host = unapprovedHost(text);
  return host ? { ok: false, detail: `${label} contains unapproved public host ${host}` } : { ok: true };
}

function sourceTreeFiles(root) {
  const files = [];
  const visit = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(childRelative);
    }
  };
  visit(root);
  return files;
}

function scanGitTree() {
  const listing = spawn("git", ["ls-files", "-z"]);
  const entries = listing.error || listing.status !== 0
    ? sourceTreeFiles(repoRoot)
    : listing.stdout.split("\0").filter(Boolean);
  if (!entries.length) {
    return { ok: false, detail: "cannot inspect source tree: no files found" };
  }
  for (const entry of entries) {
    const file = path.join(repoRoot, entry);
    let contents;
    try {
      contents = fs.readFileSync(file).toString("utf8");
    } catch (error) {
      return { ok: false, detail: `cannot read git file ${entry}: ${error.message}` };
    }
    const result = scanText(contents, `git file ${entry}`);
    if (!result.ok) return result;
  }
  return { ok: true, detail: `all ${listing.error || listing.status !== 0 ? "source-tree" : "tracked"} files use approved public hosts` };
}

function scanTarball(tarball) {
  const listing = spawn("tar", ["-tzf", tarball]);
  if (listing.error || listing.status !== 0) {
    return { ok: false, detail: `cannot inspect ${path.basename(tarball)}: ${listing.error?.message || listing.stderr || `exit ${listing.status}`}` };
  }
  for (const entry of listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const pathResult = scanText(entry, `${path.basename(tarball)} path ${entry}`);
    if (!pathResult.ok) return pathResult;
    if (entry.endsWith("/")) continue;
    const contents = spawn("tar", ["-xOf", tarball, entry], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
    if (contents.error || contents.status !== 0) {
      return { ok: false, detail: `cannot read ${entry} from ${path.basename(tarball)}` };
    }
    const fileResult = scanText(contents.stdout.toString("utf8"), `${path.basename(tarball)} file ${entry}`);
    if (!fileResult.ok) return fileResult;
  }
  return { ok: true, detail: "root and native tarballs are free of internal release strings" };
}

function platformDirectory() {
  const key = `${process.platform}-${process.arch}`;
  const supported = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  if (!supported.has(key)) throw new Error(`unsupported probe platform ${key}`);
  return path.join(repoRoot, "npm", key);
}

function isolatedEnv(name) {
  const home = path.join(tempRoot, name, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...npmEnv,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    AGENT_NOTES_DIR: path.join(home, ".agent-notes"),
  };
  delete env.OPEN_NOTES_MCP_BINARY;
  delete env.OPEN_NOTES_MCP_CODEX_BIN;
  return env;
}

function installedCli() {
  return path.join(harnessRoot, "node_modules", "open-notes-mcp", "bin", "open-notes-mcp.js");
}

function runNpx(args, env, input) {
  return spawn("npm", ["exec", "--offline", "--", "open-notes-mcp", ...args], {
    cwd: harnessRoot,
    env,
    input,
    timeout: 30000,
  });
}

function runTarballNpx(args, env, nativeTarball, cliTarball, input) {
  return spawn("npm", [
    "exec",
    "--offline",
    "--yes",
    `--package=${nativeTarball}`,
    `--package=${cliTarball}`,
    "--",
    "open-notes-mcp",
    ...args,
  ], {
    cwd: tempRoot,
    env,
    input,
    timeout: 30000,
  });
}

function runDirect(args, env, input) {
  return spawn(process.execPath, [installedCli(), ...args], {
    cwd: harnessRoot,
    env,
    input,
    timeout: 30000,
  });
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function snapshotTree(root) {
  const snapshot = new Map();
  if (!fs.existsSync(root)) return snapshot;
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else snapshot.set(relative, fs.readFileSync(absolute).toString("base64"));
    }
  };
  visit(root);
  return snapshot;
}

function snapshotsEqual(left, right) {
  return JSON.stringify([...left]) === JSON.stringify([...right]);
}

function commandAvailable(command) {
  const result = spawn(command, ["--version"], { timeout: 5000 });
  return result.error?.code !== "ENOENT";
}

function threadHintText(binary, env) {
  const response = spawn(binary, [], {
    env,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "thread_hint", arguments: null, _meta: { threadId: "probe-thread" } } })}\n`,
  });
  if (response.error || response.status !== 0) return null;
  try {
    const parsed = JSON.parse(response.stdout.trim());
    return parsed.result.content?.[0]?.text || "";
  } catch {
    return null;
  }
}

function claudeHintText(binary, env) {
  const response = spawn(binary, ["hint", "--source", "claude-code"], {
    env,
    input: `${JSON.stringify({ session_id: "probe-session", hook_event_name: "SessionStart" })}\n`,
  });
  if (response.error || response.status !== 0) return null;
  if (!response.stdout.trim()) return "";
  try {
    const parsed = JSON.parse(response.stdout.trim());
    return parsed.hookSpecificOutput?.additionalContext || null;
  } catch {
    return null;
  }
}

function claudeStampText(notesRoot) {
  try {
    return fs.readFileSync(path.join(notesRoot, ".last-hint"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

try {
  fs.mkdirSync(packRoot, { recursive: true });
  fs.mkdirSync(harnessRoot, { recursive: true });
  fs.writeFileSync(path.join(harnessRoot, "package.json"), '{"name":"installer-probe","private":true}\n');

  const cliTarball = npmPack(repoRoot);
  const nativeManifest = path.join(platformDirectory(), "package.json");
  const nativePackage = JSON.parse(fs.readFileSync(nativeManifest, "utf8"));
  const nativeExecutable = path.join(platformDirectory(), "bin", process.platform === "win32" ? "notes-mcp.exe" : "notes-mcp");
  check("prepack builds the current platform binary from source", fs.statSync(nativeExecutable).isFile());
  const nativeTarball = npmPack(platformDirectory());
  const installResult = mustRun("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", nativeTarball, cliTarball], { cwd: harnessRoot, env: npmEnv });
  check("local tarballs install without registry access", installResult.status === 0, nativePackage.name);
  const gitTreeScan = scanGitTree();
  check("git tree contains only approved public hosts", gitTreeScan.ok, gitTreeScan.detail);
  const tarballScan = scanTarball(cliTarball);
  const nativeTarballScan = scanTarball(nativeTarball);
  check("packed tarballs contain no internal release strings", tarballScan.ok && nativeTarballScan.ok,
    tarballScan.ok && nativeTarballScan.ok ? `${tarballScan.detail}; ${nativeTarballScan.detail}` : tarballScan.detail || nativeTarballScan.detail);

  const claudeCommand = process.env.OPEN_NOTES_MCP_CLAUDE_BIN || "claude";
  const claudePresent = commandAvailable(claudeCommand);
  const claudeEnv = isolatedEnv("claude-harness");
  if (process.env.OPEN_NOTES_MCP_CLAUDE_BIN) claudeEnv.OPEN_NOTES_MCP_CLAUDE_BIN = process.env.OPEN_NOTES_MCP_CLAUDE_BIN;
  else if (!claudePresent) claudeEnv.OPEN_NOTES_MCP_CLAUDE_BIN = path.join(tempRoot, "missing-claude");
  const claudeSettings = path.join(claudeEnv.HOME, ".claude", "settings.json");
  const claudeMd = path.join(claudeEnv.HOME, ".claude", "CLAUDE.md");
  const originalClaudeSettings = '{"hooks":{"UserPromptSubmit":[{"matcher":"*","hooks":[]}]}, "custom":true}\n';
  const originalClaudeMd = "user-owned Claude instructions\n";
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(claudeSettings, originalClaudeSettings);
  fs.writeFileSync(claudeMd, originalClaudeMd);
  const claudeInit = runNpx(["init", "--harness", "claude-code"], claudeEnv);
  const claudeParsedSettings = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  const claudeEntry = claudeParsedSettings.hooks.SessionStart.find((entry) => entry.hooks?.some((hook) => hook.command?.includes("open-notes-mcp:claude-code")));
  const claudeInitStamp = claudeStampText(claudeEnv.AGENT_NOTES_DIR);
  const claudeInitStatus = claudePresent
    ? claudeInit.status === 0 && /PASS liveness:/.test(claudeInit.stdout) && /source=claude-code/.test(claudeInitStamp || "")
    : claudeInit.status === 2 && /SKIP liveness: Claude Code CLI not found on PATH/.test(claudeInit.stdout);
  check("Claude init registers startup/resume/compact hook with 10s timeout", claudeInitStatus
    && claudeEntry?.matcher === "startup|resume|compact"
    && claudeEntry.hooks[0].timeout === 10);
  const claudeSettingsHash = sha(claudeSettings);
  const claudeMdHash = sha(claudeMd);
  const claudeSecond = runNpx(["init", "--harness", "claude-code"], claudeEnv);
  check("Claude init is byte-idempotent", claudeSecond.status === (claudePresent ? 0 : 2)
    && sha(claudeSettings) === claudeSettingsHash && sha(claudeMd) === claudeMdHash
    && JSON.parse(fs.readFileSync(claudeSettings, "utf8")).hooks.SessionStart.filter((entry) => entry.hooks?.some((hook) => hook.command?.includes("open-notes-mcp:claude-code"))).length === 1);
  const claudeDoctor = runNpx(["doctor", "--harness", "claude-code"], claudeEnv);
  check("Claude doctor reports installed hook and liveness state", claudeDoctor.status === (claudePresent ? 0 : 2)
    && /PASS Claude hook:/.test(claudeDoctor.stdout)
    && /PASS CLAUDE.md:/.test(claudeDoctor.stdout)
    && (claudePresent ? /PASS liveness:/.test(claudeDoctor.stdout) : /SKIP liveness: Claude Code CLI not found on PATH/.test(claudeDoctor.stdout)));

  const parityNotes = path.join(tempRoot, "claude-hint-parity-notes");
  fs.mkdirSync(parityNotes, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(parityNotes, "INDEX.md"), "parity marker\n", { mode: 0o600 });
  const parityEnv = { ...claudeEnv, AGENT_NOTES_DIR: parityNotes };
  const threadText = threadHintText(nativeExecutable, parityEnv);
  const claudeText = claudeHintText(nativeExecutable, parityEnv);
  check("Claude hint matches thread_hint byte-for-byte", threadText !== null && claudeText !== null
    && Buffer.from(threadText).equals(Buffer.from(claudeText)));
  check("hint parity probe detects an extra newline mutation", threadText !== null && claudeText !== null
    && !Buffer.from(threadText).equals(Buffer.from(`${claudeText}\n`)));

  const emptyNotes = path.join(tempRoot, "claude-empty-notes");
  const emptyResult = spawn(nativeExecutable, ["hint", "--source", "claude-code"], {
    env: { ...claudeEnv, AGENT_NOTES_DIR: emptyNotes },
    input: `${JSON.stringify({ session_id: "empty-probe", hook_event_name: "SessionStart" })}\n`,
  });
  check("Claude hint is silent for an empty notes directory", emptyResult.status === 0 && emptyResult.stdout === "");

  let hookRemovalMutation = true;
  if (claudePresent) {
    const stampBeforeRemoval = claudeStampText(claudeEnv.AGENT_NOTES_DIR);
    const removal = runNpx(["uninstall", "--harness", "claude-code"], claudeEnv);
    const settingsAfterRemoval = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
    const managedAfterRemoval = settingsAfterRemoval.hooks?.SessionStart?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("open-notes-mcp:claude-code")));
    spawn(claudeCommand, ["-p", "noop", "--output-format", "text"], {
      cwd: os.tmpdir(),
      env: { ...claudeEnv, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "open-notes-mcp-probe-placeholder" },
      timeout: 15000,
    });
    hookRemovalMutation = removal.status === 0 && !managedAfterRemoval && claudeStampText(claudeEnv.AGENT_NOTES_DIR) === stampBeforeRemoval;
    runNpx(["init", "--harness", "claude-code"], claudeEnv);
  }
  check("removing the Claude hook prevents a fresh stamp on rerun", hookRemovalMutation,
    claudePresent ? "" : "SKIP: Claude Code CLI not found");
  const claudeNotesBefore = snapshotTree(claudeEnv.AGENT_NOTES_DIR);
  const claudeUninstall = runNpx(["uninstall", "--harness", "claude-code"], claudeEnv);
  check("Claude uninstall restores user files and preserves notes", claudeUninstall.status === 0
    && fs.readFileSync(claudeSettings, "utf8") === originalClaudeSettings
    && fs.readFileSync(claudeMd, "utf8") === originalClaudeMd
    && snapshotsEqual(claudeNotesBefore, snapshotTree(claudeEnv.AGENT_NOTES_DIR))
    && !fs.existsSync(path.join(claudeEnv.CODEX_HOME, "open-notes-mcp.install.json")));

  const env = isolatedEnv("primary");
  const loc = {
    config: path.join(env.CODEX_HOME, "config.toml"),
    state: path.join(env.CODEX_HOME, "open-notes-mcp.install.json"),
    agents: path.join(env.CODEX_HOME, "AGENTS.md"),
    binary: path.join(env.XDG_DATA_HOME, "open-notes-mcp", "bin", process.platform === "win32" ? "notes-mcp.exe" : "notes-mcp"),
    notes: env.AGENT_NOTES_DIR,
  };
  const originalConfig = 'model_provider = "myproxy"\n\n[model_providers.myproxy]\nname = "myproxy"\nbase_url = "http://127.0.0.1:9/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n\n# user-owned config\n[features]\ntoken_budget = false # original value\n';
  const originalAgents = "# User instructions\n\nKeep this text.\n";
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(loc.config, originalConfig);
  fs.writeFileSync(loc.agents, originalAgents);

  const first = runTarballNpx(["init", "--enable-token-budget"], env, nativeTarball, cliTarball);
  check("one-shot npx local-tarball init succeeds offline", first.status === 0, (first.stderr || first.stdout).trim());
  if (first.status !== 0) {
    const detail = `${first.stderr || ""}\n${first.stdout || ""}`;
    process.stdout.write(`BLOCKED preflight: ${/Codex CLI not found on PATH/.test(detail) ? "Codex CLI not found on PATH" : "installer init failed"}; SKIP remaining lifecycle checks\n`);
    process.exitCode = 1;
    throw { preflight: true };
  }
  const firstHashes = new Map([
    ["config", sha(loc.config)],
    ["agents", sha(loc.agents)],
    ["binary", sha(loc.binary)],
  ]);
  const stateAfterInit = JSON.parse(fs.readFileSync(loc.state, "utf8"));
  const configAfterInit = fs.readFileSync(loc.config, "utf8");
  check("init records token budget ownership in CODEX_HOME state", stateAfterInit.tokenBudget.value === false
    && stateAfterInit.tokenBudget.line.includes("original value")
    && (fs.statSync(loc.state).mode & 0o777) === 0o600);
  check("init installs marked token-budget guidance", configAfterInit.includes("open-notes-mcp:guidance:v1")
    && /guidance_message\s*=/.test(configAfterInit));
  const customDoctor = runDirect(["doctor"], env);
  check("custom model provider guidance passes doctor", customDoctor.status === 0
    && /PASS guidance: managed guidance_message installed/.test(customDoctor.stdout));
  const second = runNpx(["init", "--enable-token-budget"], env);
  const secondHashes = new Map([
    ["config", sha(loc.config)],
    ["agents", sha(loc.agents)],
    ["binary", sha(loc.binary)],
  ]);
  check("second init is byte-idempotent", second.status === 0 && snapshotsEqual(firstHashes, secondHashes));
  const agentsOnce = fs.readFileSync(loc.agents, "utf8");
  check("AGENTS sentinel appears exactly once", agentsOnce.split("<!-- open-notes-mcp:begin -->").length - 1 === 1);
  const configWithGuidance = fs.readFileSync(loc.config, "utf8");
  const configWithoutGuidance = configWithGuidance.replace(/,\s*guidance_message\s*=\s*"(?:\\.|[^"\\])*"/, "");
  fs.writeFileSync(loc.config, configWithoutGuidance);
  const missingGuidanceDoctor = runDirect(["doctor"], env);
  check("doctor rejects a missing token-budget guidance message", missingGuidanceDoctor.status === 1
    && /FAIL guidance: no guidance_message configured/.test(missingGuidanceDoctor.stdout));
  fs.writeFileSync(loc.config, configWithGuidance);

  const consentEnv = isolatedEnv("consent-declined");
  const declined = runDirect(["init"], consentEnv, "n\n");
  const declinedConfig = fs.readFileSync(path.join(consentEnv.CODEX_HOME, "config.toml"), "utf8");
  check("declining consent returns inactive status without enabling token budgeting", declined.status === 2
    && /your choice/.test(declined.stdout)
    && /will not be injected/.test(declined.stdout)
    && /init --enable-token-budget/.test(declined.stdout)
    && !/token_budget\s*=\s*true/.test(declinedConfig));
  const declinedDoctor = runDirect(["doctor"], consentEnv);
  check("doctor reports declined token budget as inactive", declinedDoctor.status === 2
    && /WARN token budget: installed but inactive/.test(declinedDoctor.stdout)
    && /SKIP liveness: token_budget is disabled/.test(declinedDoctor.stdout));

  const catalogEnv = isolatedEnv("catalog-owned-guidance");
  const catalogConfigPath = path.join(catalogEnv.CODEX_HOME, "config.toml");
  fs.mkdirSync(catalogEnv.CODEX_HOME, { recursive: true });
  fs.writeFileSync(catalogConfigPath, "[features]\ntoken_budget = true\n");
  const catalogInit = runDirect(["init"], catalogEnv);
  const catalogConfig = fs.readFileSync(catalogConfigPath, "utf8");
  const catalogDoctor = runDirect(["doctor"], catalogEnv);
  check("missing model provider skips guidance without failing doctor", catalogInit.status === 0
    && !catalogConfig.includes("open-notes-mcp:guidance:v1")
    && catalogDoctor.status === 0
    && /SKIP guidance: model catalog owns token-budget defaults \(see openai\/codex#42918\)/.test(catalogDoctor.stdout));

  const openaiEnv = isolatedEnv("openai-owned-guidance");
  const openaiConfigPath = path.join(openaiEnv.CODEX_HOME, "config.toml");
  fs.mkdirSync(openaiEnv.CODEX_HOME, { recursive: true });
  fs.writeFileSync(openaiConfigPath, 'model_provider = "openai"\n[features]\ntoken_budget = true\n');
  const openaiInit = runDirect(["init"], openaiEnv);
  const openaiConfig = fs.readFileSync(openaiConfigPath, "utf8");
  const openaiDoctor = runDirect(["doctor"], openaiEnv);
  check("OpenAI model provider skips guidance without failing doctor", openaiInit.status === 0
    && !openaiConfig.includes("open-notes-mcp:guidance:v1")
    && openaiDoctor.status === 0
    && /SKIP guidance: model catalog owns token-budget defaults \(see openai\/codex#42918\)/.test(openaiDoctor.stdout));

  const forcedGuidanceEnv = isolatedEnv("forced-guidance");
  const forcedConfigPath = path.join(forcedGuidanceEnv.CODEX_HOME, "config.toml");
  fs.mkdirSync(forcedGuidanceEnv.CODEX_HOME, { recursive: true });
  fs.writeFileSync(forcedConfigPath, "[features]\ntoken_budget = true\n");
  const forcedInit = runDirect(["init", "--with-guidance"], forcedGuidanceEnv);
  const forcedConfig = fs.readFileSync(forcedConfigPath, "utf8");
  const forcedDoctor = runDirect(["doctor"], forcedGuidanceEnv);
  check("--with-guidance overrides the catalog gate", forcedInit.status === 0
    && forcedConfig.includes("open-notes-mcp:guidance:v1")
    && forcedDoctor.status === 0
    && /PASS guidance: managed guidance_message installed/.test(forcedDoctor.stdout));

  const suppressedGuidanceEnv = isolatedEnv("suppressed-guidance");
  const suppressedConfigPath = path.join(suppressedGuidanceEnv.CODEX_HOME, "config.toml");
  fs.mkdirSync(suppressedGuidanceEnv.CODEX_HOME, { recursive: true });
  fs.writeFileSync(suppressedConfigPath, 'model_provider = "myproxy"\n\n[model_providers.myproxy]\nname = "myproxy"\nbase_url = "http://127.0.0.1:9/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n\n[features]\ntoken_budget = true\n');
  const suppressedInit = runDirect(["init", "--without-guidance"], suppressedGuidanceEnv);
  const suppressedConfig = fs.readFileSync(suppressedConfigPath, "utf8");
  const suppressedDoctor = runDirect(["doctor"], suppressedGuidanceEnv);
  check("--without-guidance suppresses the custom-provider default", suppressedInit.status === 0
    && !suppressedConfig.includes("open-notes-mcp:guidance:v1")
    && suppressedDoctor.status === 0
    && /SKIP guidance: disabled by explicit choice/.test(suppressedDoctor.stdout));

  const overrideEnv = isolatedEnv("global-override");
  const overrideDefault = path.join(overrideEnv.CODEX_HOME, "AGENTS.md");
  const overrideActive = path.join(overrideEnv.CODEX_HOME, "AGENTS.override.md");
  fs.mkdirSync(overrideEnv.CODEX_HOME, { recursive: true });
  fs.writeFileSync(overrideDefault, "default global instructions\n");
  fs.writeFileSync(overrideActive, "active override instructions\n");
  const overrideInit = runDirect(["init", "--without-token-budget"], overrideEnv);
  check("init puts the workflow block in an active global override", overrideInit.status === 2
    && !fs.readFileSync(overrideDefault, "utf8").includes("open-notes-mcp")
    && fs.readFileSync(overrideActive, "utf8").includes("<!-- open-notes-mcp:begin -->"));
  const overrideUninstall = runDirect(["uninstall"], overrideEnv);
  check("uninstall restores both global instruction candidates", overrideUninstall.status === 0
    && fs.readFileSync(overrideDefault, "utf8") === "default global instructions\n"
    && fs.readFileSync(overrideActive, "utf8") === "active override instructions\n");

  fs.mkdirSync(path.join(loc.notes, "nested"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(loc.notes, "INDEX.md"), "installer probe index\n", { mode: 0o600 });
  fs.writeFileSync(path.join(loc.notes, "nested", "opaque.bin"), crypto.randomBytes(257), { mode: 0o600 });

  const healthy = runNpx(["doctor"], env);
  check("doctor proves liveness through codex exec", healthy.status === 0 && /PASS liveness: fresh stamp/.test(healthy.stdout), (healthy.stderr || healthy.stdout).trim());

  const duplicateOriginal = fs.readFileSync(loc.agents);
  fs.appendFileSync(loc.agents, `\n${agentsOnce.slice(agentsOnce.indexOf("<!-- open-notes-mcp:begin -->"))}`);
  const duplicateDoctor = runDirect(["doctor"], env);
  check("doctor rejects duplicated AGENTS sentinels", duplicateDoctor.status !== 0 && /duplicate or unmatched managed sentinels/.test(duplicateDoctor.stdout));
  fs.writeFileSync(loc.agents, duplicateOriginal);

  const goodBinary = fs.readFileSync(loc.binary);
  fs.writeFileSync(loc.binary, "not a notes MCP executable\n", { mode: 0o755 });
  const badBinaryDoctor = runDirect(["doctor"], env);
  check("doctor rejects a bad installed binary", badBinaryDoctor.status !== 0 && /FAIL binary initialize/.test(badBinaryDoctor.stdout));
  fs.writeFileSync(loc.binary, goodBinary, { mode: 0o755 });

  const noCodexPath = path.join(tempRoot, "no-codex-bin");
  fs.mkdirSync(noCodexPath);
  const missingEnv = { ...env, PATH: noCodexPath };
  const missingDoctor = runDirect(["doctor"], missingEnv);
  check("missing Codex skips liveness and returns nonzero", missingDoctor.status !== 0 && /SKIP liveness: Codex CLI not found on PATH/.test(missingDoctor.stdout));

  const missingInitEnv = { ...isolatedEnv("missing-codex-init"), PATH: noCodexPath };
  const missingInit = runDirect(["init", "--enable-token-budget"], missingInitEnv);
  check("missing Codex makes init fail before mutation", missingInit.status !== 0 && !fs.existsSync(missingInitEnv.CODEX_HOME));

  const oldCodex = path.join(tempRoot, "old-codex-bin");
  fs.writeFileSync(oldCodex, `#!/bin/sh\necho codex-cli 0.147.9\n`, { mode: 0o755 });
  const oldVersionEnv = { ...isolatedEnv("old-codex"), OPEN_NOTES_MCP_CODEX_BIN: oldCodex };
  const oldVersionInit = runDirect(["init", "--enable-token-budget"], oldVersionEnv);
  check("Codex version gate rejects releases below 0.148", oldVersionInit.status === 1
    && /requires >= 0.148.0/.test(oldVersionInit.stderr)
    && !fs.existsSync(oldVersionEnv.CODEX_HOME));

  const stateMissingEnv = isolatedEnv("state-missing");
  fs.mkdirSync(stateMissingEnv.CODEX_HOME, { recursive: true });
  const stateMissingConfig = '[features]\ntoken_budget = true\n\n[mcp_servers.notes]\ncommand = "/user/owned/notes-mcp"\n';
  fs.writeFileSync(path.join(stateMissingEnv.CODEX_HOME, "config.toml"), stateMissingConfig);
  const stateMissingUninstall = runDirect(["uninstall"], stateMissingEnv);
  check("missing install state preserves current configuration", stateMissingUninstall.status === 0
    && /unable to determine original token_budget/.test(stateMissingUninstall.stdout)
    && fs.readFileSync(path.join(stateMissingEnv.CODEX_HOME, "config.toml"), "utf8") === stateMissingConfig);

  const preexistingTrueEnv = isolatedEnv("preexisting-true");
  fs.mkdirSync(preexistingTrueEnv.CODEX_HOME, { recursive: true });
  const preexistingTrueConfig = "[features]\ntoken_budget = true\n";
  fs.writeFileSync(path.join(preexistingTrueEnv.CODEX_HOME, "config.toml"), preexistingTrueConfig);
  const preexistingTrueInit = runDirect(["init", "--enable-token-budget"], preexistingTrueEnv);
  const preexistingTrueUninstall = runDirect(["uninstall"], preexistingTrueEnv);
  check("uninstall preserves a pre-existing true token budget", preexistingTrueInit.status === 0
    && preexistingTrueUninstall.status === 0
    && fs.readFileSync(path.join(preexistingTrueEnv.CODEX_HOME, "config.toml"), "utf8") === preexistingTrueConfig);

  const notesBefore = snapshotTree(loc.notes);
  const uninstallResult = runNpx(["uninstall"], env);
  const notesAfter = snapshotTree(loc.notes);
  check("uninstall preserves every notes file byte-for-byte", uninstallResult.status === 0 && snapshotsEqual(notesBefore, notesAfter));
  check("uninstall restores user-owned config and instructions", !fs.existsSync(loc.binary) && fs.readFileSync(loc.config, "utf8") === originalConfig && fs.readFileSync(loc.agents, "utf8") === originalAgents);
  check("uninstall removes installer state", !fs.existsSync(loc.state));
  const secondUninstall = runNpx(["uninstall"], env);
  check("uninstall is idempotent", secondUninstall.status === 0 && snapshotsEqual(notesAfter, snapshotTree(loc.notes)));
} catch (error) {
  if (!error?.preflight) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}

cleanup().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 2;
}).finally(() => {
  if (checks.length && checks.every(Boolean) && process.exitCode === undefined) process.exitCode = 0;
  else if (process.exitCode === undefined) process.exitCode = 1;
});
