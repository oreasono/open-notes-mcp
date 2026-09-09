#!/usr/bin/env node

"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { once } = require("events");
const { GUIDANCE_MESSAGE } = require("../lib/installer");

const repoRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-e2e-probe-"));
const notesRoot = path.join(tempRoot, "notes");
const codexHome = path.join(tempRoot, "home", ".codex");
const binary = path.join(tempRoot, "notes-mcp");
const checks = [];
const noteMarker = `E2E-PROBE-${crypto.randomUUID()}`;
const guidanceMarker = "open-notes-mcp:guidance:v1";

function check(label, condition, detail = "") {
  const ok = Boolean(condition);
  checks.push(ok);
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}\n`);
}

function spawnSync(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    input: options.input,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    timeout: options.timeout || 30000,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
  });
}

function codexVersion(output) {
  const match = output.match(/(?:^|\s)codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?(?:\s|$)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionAtLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

function blocked(detail) {
  process.stdout.write(`BLOCKED: ${detail}\n`);
  process.exitCode = 2;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: options.env || process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }, options.timeout || 90000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    child.once("error", (error) => finish({ status: null, error }));
    child.once("close", (status, signal) => finish({ status, signal }));
  });
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function responseCreated(id) {
  return { type: "response.created", response: { id } };
}

function responseCompleted(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function newContextCall() {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "e2e-new-context",
      name: "new_context",
      arguments: "{}",
    },
  };
}

function assistantMessage() {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: "e2e-message",
      content: [{ type: "output_text", text: "e2e probe complete" }],
    },
  };
}

function modelList() {
  return { object: "list", data: [{ id: "gpt-5", object: "model", owned_by: "openai" }] };
}

function startResponsesServer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", (error) => {
      requests.push({ path: request.url, error });
      response.destroy(error);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed = null;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        // Keep the raw body for a useful failed assertion below.
      }
      requests.push({ path: request.url, body, parsed });
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(modelList()));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const responseNumber = requests.filter((entry) => entry.path?.endsWith("/responses")).length;
      const responseBody = responseNumber === 1
        ? sse([responseCreated("e2e-response-1"), newContextCall(), responseCompleted("e2e-response-1")])
        : sse([responseCreated("e2e-response-2"), assistantMessage(), responseCompleted("e2e-response-2")]);
      response.writeHead(200, {
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "content-type": "text/event-stream",
      });
      response.end(responseBody);
    });
  });
  return { server, requests };
}

function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function contextWindows(request) {
  if (!request?.parsed) return [];
  return collectStrings(request.parsed)
    .filter((text) => text.includes("<context_window>"))
    .map((text) => ({ text, match: text.match(/<context_window>\nAgent name: [^\n]+\nFirst context window id: ([0-9a-f-]{36})\nCurrent context window id: ([0-9a-f-]{36})(?:\nPrevious context window id: ([0-9a-f-]{36}))?\n/) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ text: entry.text, first: entry.match[1], current: entry.match[2], previous: entry.match[3] || null }));
}

function writeConfig(port) {
  fs.mkdirSync(codexHome, { recursive: true });
  const config = [
    'model = "gpt-5"',
    'model_provider = "e2e-probe"',
    'model_context_window = 10000',
    "",
    "[features.token_budget]",
    "enabled = true",
    `guidance_message = ${JSON.stringify(GUIDANCE_MESSAGE)}`,
    "",
    "[model_providers.e2e-probe]",
    'name = "e2e-probe"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'env_key = "E2E_PROBE_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    "[mcp_servers.notes]",
    `command = ${JSON.stringify(binary)}`,
    `env = { AGENT_NOTES_DIR = ${JSON.stringify(notesRoot)} }`,
    "startup_timeout_sec = 10",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), config, { mode: 0o600 });
}

async function main() {
  const codex = process.env.OPEN_NOTES_MCP_CODEX_BIN || "codex";
  const preflight = spawnSync(codex, ["--version"], { timeout: 5000 });
  if (preflight.error) {
    blocked(`Codex CLI not found on PATH (${preflight.error.message})`);
    return;
  }
  const versionOutput = `${preflight.stdout || ""}\n${preflight.stderr || ""}`;
  const version = codexVersion(versionOutput);
  if (preflight.status !== 0 || !version) {
    blocked(`could not determine Codex CLI version (exit ${preflight.status})`);
    return;
  }
  if (!versionAtLeast(version, [0, 148, 0])) {
    blocked(`Codex CLI 0.148.0 or newer is required; found ${version.join(".")}`);
    return;
  }
  check("Codex preflight is available", true, `codex-cli ${version.join(".")}`);

  fs.mkdirSync(notesRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(notesRoot, "INDEX.md"), `e2e probe marker: ${noteMarker}\n`, { mode: 0o600 });

  const build = spawnSync(process.env.GO_BIN || "go", ["build", "-o", binary, "./cmd/notes-mcp"], { timeout: 60000 });
  check("native bridge builds for the e2e run", build.status === 0 && fs.existsSync(binary), build.stderr?.trim() || "");
  if (build.status !== 0 || !fs.existsSync(binary)) return;

  const { server, requests } = startResponsesServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  writeConfig(address.port);
  const env = {
    ...process.env,
    AGENT_NOTES_DIR: notesRoot,
    CODEX_HOME: codexHome,
    E2E_PROBE_API_KEY: "open-notes-mcp-e2e-probe",
    HOME: path.join(tempRoot, "home"),
    USERPROFILE: path.join(tempRoot, "home"),
  };
  delete env.CODEX_CONFIG;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.OPENAI_API_KEY;
  const run = await runProcess(codex, [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    repoRoot,
    "Call new_context now, then finish the probe.",
  ], { env, timeout: 90000 });
  await new Promise((resolve) => server.close(resolve));

  const responseRequests = requests.filter((entry) => entry.path?.endsWith("/responses"));
  const runDetail = run.error?.message || `exit ${run.status}${run.stderr.trim() ? `: ${run.stderr.trim().slice(0, 240)}` : ""}`;
  check("Codex exec accepts exit 0 or 2 without crashing", run.error == null && (run.status === 0 || run.status === 2), runDetail);
  check("fake Responses endpoint recorded two requests", responseRequests.length === 2, `${responseRequests.length} requests`);
  check("first request body is valid JSON", responseRequests[0]?.parsed != null);
  check("second request body is valid JSON", responseRequests[1]?.parsed != null);

  const firstContexts = contextWindows(responseRequests[0]);
  const secondContexts = contextWindows(responseRequests[1]);
  const firstGuidance = collectStrings(responseRequests[0]?.parsed)
    .filter((text) => text.includes("<context_window_guidance>"));
  const first = firstContexts[0];
  const second = secondContexts[0];
  check("first request carries a context-window envelope", first != null);
  check("second request carries a context-window envelope", second != null);
  check("first request carries the configured context-window guidance", firstGuidance.some((text) => text.includes(guidanceMarker)), guidanceMarker);
  check("window id changes after new_context", first != null && second != null && first.current !== second.current,
    first && second ? `${first.current} -> ${second.current}` : "missing window ids");
  check("second Previous window id points to the first window", first != null && second != null && second.previous === first.current,
    first && second ? `previous=${second.previous || "missing"}` : "missing window ids");
  check("second context-window envelope contains the note text", second?.text.includes(noteMarker), noteMarker);
  check("context-window envelope is closed", second?.text.includes("</context_window>"));
  check("Codex received the new_context tool in the first request", responseRequests[0]?.parsed
    && collectStrings(responseRequests[0].parsed).includes("new_context"));
  const stampPath = path.join(notesRoot, ".last-hint");
  const stamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf8") : "";
  check("bridge stamp records the thread hint", stamp.includes("thread_id="));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 2;
}).finally(() => {
  if (checks.length && checks.every(Boolean) && process.exitCode === undefined) process.exitCode = 0;
  else if (process.exitCode === undefined) process.exitCode = 1;
});
