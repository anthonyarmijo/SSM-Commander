#!/usr/bin/env node

// Stages the exact dynamic-library closure used by the native macOS FreeRDP
// renderer. This runs after Cargo creates the release binary and before Tauri
// creates the .app, allowing us to replace Homebrew install names with app-local
// @rpath references.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const resources = path.join(root, "src-tauri", "resources", "macos", "lib");
const freerdpPrefix = process.env.SSM_COMMANDER_FREERDP_PREFIX || [
  process.arch === "arm64" ? "/opt/homebrew/opt/freerdp" : "/usr/local/opt/freerdp",
  "/opt/homebrew/opt/freerdp",
  "/usr/local/opt/freerdp",
].find((prefix) => fs.existsSync(path.join(prefix, "include", "freerdp3", "freerdp", "freerdp.h")));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout.trim();
}

function otoolDependencies(file) {
  return run("otool", ["-L", file])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
}

function isHomebrewDependency(value) {
  return value.startsWith("/opt/homebrew/") || value.startsWith("/usr/local/opt/") || value.startsWith("/usr/local/Cellar/");
}

function releaseBinary() {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE;
  const candidates = [
    target && path.join(root, "src-tauri", "target", target, "release", "ssm-commander"),
    path.join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "ssm-commander"),
    path.join(root, "src-tauri", "target", "release", "ssm-commander"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function copyClosure(roots) {
  const queue = [...roots];
  const copied = new Map();
  while (queue.length > 0) {
    const source = queue.shift();
    if (!isHomebrewDependency(source) || !fs.existsSync(source)) continue;
    const real = fs.realpathSync(source);
    if (copied.has(real)) continue;
    const destination = path.join(resources, path.basename(real));
    fs.copyFileSync(real, destination);
    fs.chmodSync(destination, 0o755);
    copied.set(real, destination);
    for (const dependency of otoolDependencies(real)) {
      if (isHomebrewDependency(dependency)) queue.push(dependency);
    }
  }
  return copied;
}

function stagedName(dependency) {
  return path.basename(fs.realpathSync(dependency));
}

function rewriteStagedLibraries(libraries) {
  for (const [source, destination] of libraries) {
    run("install_name_tool", ["-id", `@rpath/${path.basename(source)}`, destination]);
    for (const dependency of otoolDependencies(source)) {
      if (isHomebrewDependency(dependency)) {
        run("install_name_tool", ["-change", dependency, `@loader_path/${stagedName(dependency)}`, destination]);
      }
    }
    run("codesign", ["--force", "--sign", "-", destination]);
  }
}

function rewriteReleaseBinary(binary) {
  const rpaths = run("otool", ["-l", binary]);
  if (!rpaths.includes("@executable_path/../Resources/lib")) {
    run("install_name_tool", ["-add_rpath", "@executable_path/../Resources/lib", binary]);
  }
  for (const dependency of otoolDependencies(binary)) {
    if (isHomebrewDependency(dependency)) {
      run("install_name_tool", ["-change", dependency, `@rpath/${stagedName(dependency)}`, binary]);
    }
  }
}

function verify(binary) {
  const files = [binary, ...fs.readdirSync(resources).map((name) => path.join(resources, name))];
  const offenders = files.flatMap((file) =>
    otoolDependencies(file).filter(isHomebrewDependency).map((dependency) => `${file}: ${dependency}`),
  );
  if (offenders.length) throw new Error(`Native FreeRDP staging left Homebrew links:\n${offenders.join("\n")}`);
}

function main() {
  if (process.platform !== "darwin") return;
  for (const command of ["otool", "install_name_tool", "codesign"]) run("sh", ["-lc", `command -v ${command}`]);
  const binary = releaseBinary();
  if (!binary) throw new Error("Could not find the macOS release binary to prepare for native FreeRDP bundling.");
  const roots = ["libfreerdp-client3.dylib", "libfreerdp3.dylib", "libwinpr3.dylib"]
    .map((name) => path.join(freerdpPrefix || "", "lib", name));
  const missing = roots.filter((file) => !fs.existsSync(file));
  if (missing.length) throw new Error(`FreeRDP 3 is required for macOS packaging. Missing:\n${missing.join("\n")}`);
  fs.rmSync(resources, { recursive: true, force: true });
  fs.mkdirSync(resources, { recursive: true });
  const libraries = copyClosure(roots);
  if (libraries.size === 0) throw new Error("No FreeRDP libraries were staged.");
  rewriteStagedLibraries(libraries);
  rewriteReleaseBinary(binary);
  verify(binary);
  console.log(`Staged ${libraries.size} app-local FreeRDP libraries for ${path.basename(binary)}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
