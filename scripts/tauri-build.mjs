#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env };

if (process.platform === "darwin" && !env.CI && !env.TAURI_BUNDLER_DMG_IGNORE_CI) {
  env.CI = "true";
}

const result = spawnSync("tauri", ["build", ...args], {
  env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
