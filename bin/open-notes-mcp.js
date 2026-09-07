#!/usr/bin/env node

"use strict";

const { run } = require("../lib/installer");

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`open-notes-mcp: ${error.message}\n`);
    process.exitCode = 1;
  },
);
