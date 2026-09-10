#!/usr/bin/env node

"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "open-notes-mcp-leak-"));
const marker = `ONM-LEAK-${process.pid}`;
const tracker = process.env.OPEN_NOTES_MCP_TRACKER_MODULE
  || path.join(root, "scripts", "lib", "child-tracker.js");
const fixture = path.join(temp, "fixture.js");
const probes = ["probe", "probe:e2e", "probe:installer"];
const runs = Number(process.env.OPEN_NOTES_MCP_LEAK_RUNS || 20);
if (!Number.isInteger(runs) || runs < 1) throw new Error("OPEN_NOTES_MCP_LEAK_RUNS must be a positive integer");
fs.writeFileSync(fixture, `const cp = require("child_process");
const { track, cleanup } = require(process.env.TRACKER_MODULE);
const child = track(cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000); // " + process.env.TRACKER_MARKER], { stdio: "ignore" }));
child.unref();
cleanup().then(() => process.exit(0));
`, { mode: 0o700 });

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: root,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 120000,
    killSignal: options.killSignal || "SIGTERM",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function snapshot() {
  let result = run("ps", ["-eo", "pid=,ppid=,stat=,args="], { timeout: 5000 });
  if (result.status !== 0) result = run("ps", ["-axo", "pid=,ppid=,stat=,command="], { timeout: 5000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || "ps failed");
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return [];
    const command = match[4];
    const executable = path.basename(command.split(/\s+/, 1)[0]).replace(/^\[|\]$/g, "").toLowerCase();
    return [{ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3], command,
      matching: !match[3].startsWith("Z") && /^(?:notes-mcp|codex|codex-cli)(?:\.exe)?$/.test(executable) }];
  });
}

const before = snapshot();
const beforePids = new Set(before.map((entry) => entry.pid));
let failures = 0;
let firstFailure = "";
const passed = Object.fromEntries(probes.map((name) => [name, 0]));
for (let iteration = 0; iteration < runs; iteration += 1) {
  const result = run(process.execPath, [fixture], {
    env: { ...process.env, TRACKER_MODULE: tracker, TRACKER_MARKER: `${marker}-normal-${iteration}` },
    timeout: 5000,
  });
  if (result.error || result.status !== 0) {
    failures += 1;
    firstFailure ||= `tracker iteration ${iteration + 1}: ${result.error?.message || result.stderr || `exit ${result.status}`}`;
  }
}

const trackerLeaks = snapshot().filter((entry) => entry.command.includes(marker));
if (!trackerLeaks.length) {
  for (let iteration = 0; iteration < runs; iteration += 1) {
    const runTemp = fs.mkdtempSync(path.join(temp, "run-"));
    for (const name of probes) {
      const probe = run("npm", ["run", "--silent", name], {
        env: { ...process.env, TMPDIR: runTemp }, timeout: 240000,
      });
      if (!probe.error && probe.status === 0) passed[name] += 1;
      else {
        failures += 1;
        firstFailure ||= `${name} iteration ${iteration + 1}: ${probe.error?.message || probe.stderr || `exit ${probe.status}`}`;
      }
    }
    fs.rmSync(runTemp, { recursive: true, force: true });
  }
}
const after = snapshot();
const residual = after.filter((entry) => !beforePids.has(entry.pid));
const leaks = after.filter((entry) => entry.command.includes(marker));
const zombies = residual.filter((entry) => entry.stat.startsWith("Z") && entry.ppid !== 1);
const matching = residual.filter((entry) => entry.matching);
const initZombies = [before, after].map((entries) => entries.filter((entry) => entry.stat.startsWith("Z") && entry.ppid === 1).length);
fs.rmSync(temp, { recursive: true, force: true });
process.stdout.write(`runs=${runs} probe=${passed.probe}/${runs} e2e=${passed["probe:e2e"]}/${runs} installer=${passed["probe:installer"]}/${runs} failures=${failures} residual_notes_or_codex=${matching.length} marker_leaks=${leaks.length} live_parent_zombies=${zombies.length} init_zombies=${initZombies.join("->")}\n`);
if (firstFailure) process.stderr.write(`${firstFailure.trim()}\n`);
if (matching.length || leaks.length || zombies.length || failures) process.exitCode = 1;
