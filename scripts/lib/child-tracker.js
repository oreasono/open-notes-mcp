"use strict";

const { once } = require("events");

const children = new Set();
let cleaning = null;
const active = (child) => child.exitCode === null && child.signalCode === null;

function track(child) {
  children.add(child);
  const forget = () => children.delete(child);
  child.once("exit", forget);
  child.once("error", forget);
  return child;
}

function signal(child, name) {
  try {
    child.kill(name);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function waitForExit(child, timeout) {
  return Promise.race([
    once(child, "exit").catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeout)),
  ]);
}

async function stop(child) {
  if (!active(child)) return;
  signal(child, "SIGTERM");
  await waitForExit(child, 1000);
  if (!active(child)) return;
  signal(child, "SIGKILL");
  await waitForExit(child, 1000);
}

function cleanup() {
  if (cleaning) return cleaning;
  cleaning = Promise.all([...children].map(stop));
  return cleaning.finally(() => {
    cleaning = null;
  });
}

process.once("exit", () => cleanup());
process.once("uncaughtException", async (error) => {
  try {
    await cleanup();
  } finally {
    throw error;
  }
});

module.exports = { track, cleanup };
