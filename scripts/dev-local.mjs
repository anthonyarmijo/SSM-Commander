import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcTauriDir = path.join(repoRoot, "src-tauri");
const containerName = "ssm-commander-guacd";
const guacdImage = "guacamole/guacd";
const guacdHost = "127.0.0.1";
const guacdPort = 4822;
const guacdReadyTimeoutMs = 30_000;
const guacdStopTimeoutMs = 10_000;

let tauriProcess;
let startedContainer = false;
let shuttingDown = false;
let guacdMonitor;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function requireSuccess(result, message) {
  if (result.status === 0) {
    return;
  }

  const detail = [result.stderr, result.stdout]
    .filter(Boolean)
    .join("\n")
    .trim();
  throw new Error(detail ? `${message}\n${detail}` : message);
}

function docker(args, options) {
  return run("docker", args, options);
}

function ensureDocker() {
  const version = docker(["--version"]);
  requireSuccess(
    version,
    "Docker is not available. Install Docker Desktop and make sure the docker CLI is on PATH.",
  );

  const info = docker(["info"]);
  requireSuccess(
    info,
    "Docker is installed, but the Docker daemon is not running. Start Docker Desktop and try again.",
  );
}

function resolveCargoTargetDir() {
  if (!process.env.CARGO_TARGET_DIR) {
    return path.join(srcTauriDir, "target");
  }

  return path.isAbsolute(process.env.CARGO_TARGET_DIR)
    ? process.env.CARGO_TARGET_DIR
    : path.resolve(srcTauriDir, process.env.CARGO_TARGET_DIR);
}

function readTextFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > 1024 * 1024) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function candidateCargoMetadataFiles(targetDir) {
  const files = [];

  for (const profile of ["debug", "release"]) {
    const buildDir = path.join(targetDir, profile, "build");
    let entries;

    try {
      entries = fs.readdirSync(buildDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageBuildDir = path.join(buildDir, entry.name);
      files.push(path.join(packageBuildDir, "root-output"));
      files.push(path.join(packageBuildDir, "output"));
    }
  }

  return files;
}

function findStaleCargoTargetPath() {
  const targetDir = resolveCargoTargetDir();
  const currentTargetPrefix = `${path.resolve(targetDir)}${path.sep}`;
  const targetPathPattern = /\/[^\s"'`]+\/src-tauri\/target(?:\/[^\s"'`]*)?/g;

  for (const filePath of candidateCargoMetadataFiles(targetDir)) {
    const contents = readTextFile(filePath);
    const matches = contents.match(targetPathPattern) ?? [];
    const stalePath = matches.find((match) => !path.resolve(match).startsWith(currentTargetPrefix));

    if (stalePath) {
      return stalePath;
    }
  }

  return undefined;
}

function cleanTauriBuildCache(reason) {
  console.log(`Detected stale Tauri/Cargo build cache path: ${reason}`);
  console.log("Cleaning src-tauri Cargo build cache before starting...");
  const result = run("cargo", ["clean"], { cwd: srcTauriDir, stdio: "inherit" });
  requireSuccess(result, "Could not clean the Tauri Cargo build cache.");
}

function cleanStaleTauriBuildCache() {
  const stalePath = findStaleCargoTargetPath();

  if (stalePath) {
    cleanTauriBuildCache(stalePath);
  }
}

function portIsOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: guacdHost, port: guacdPort });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortState(expectedOpen, timeoutMs, label) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if ((await portIsOpen()) === expectedOpen) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(label);
}

function removeNamedContainer() {
  const existing = docker(["ps", "-aq", "--filter", `name=^/${containerName}$`]);
  requireSuccess(existing, "Could not inspect Docker containers.");

  if (!existing.stdout.trim()) {
    return false;
  }

  console.log(`Removing existing ${containerName} container...`);
  const removed = docker(["rm", "-f", containerName], { stdio: "inherit" });
  requireSuccess(removed, `Could not remove existing ${containerName} container.`);
  return true;
}

function containerIsRunning() {
  const running = docker(["ps", "-q", "--filter", `name=^/${containerName}$`]);
  return running.status === 0 && Boolean(running.stdout.trim());
}

function startGuacdMonitor() {
  if (guacdMonitor) {
    clearInterval(guacdMonitor);
  }

  guacdMonitor = setInterval(() => {
    if (shuttingDown || !startedContainer) {
      return;
    }

    if (!containerIsRunning()) {
      console.error(`${containerName} is no longer running. Embedded RDP requires guacd on ${guacdHost}:${guacdPort}.`);
      startedContainer = false;
      void shutdown(1);
    }
  }, 2_000);
}

async function assertGuacdPortFree() {
  const lsof = run("lsof", ["-nP", `-iTCP:${guacdPort}`, "-sTCP:LISTEN"]);
  if (lsof.status === 0 && lsof.stdout.trim()) {
    throw new Error(
      `Port ${guacdPort} is already in use on ${guacdHost}.\n${lsof.stdout.trim()}\nStop that process before running npm start.`,
    );
  }

  if (await portIsOpen()) {
    throw new Error(
      `Port ${guacdPort} is already in use on ${guacdHost}.\nStop that process before running npm start.`,
    );
  }
}

async function startGuacd() {
  console.log(`Starting ${containerName} on ${guacdHost}:${guacdPort}...`);
  const platformArgs = process.arch === "arm64" ? ["--platform", "linux/amd64"] : [];
  const result = docker(
    [
      "run",
      "-d",
      ...platformArgs,
      "--name",
      containerName,
      "-p",
      `${guacdHost}:${guacdPort}:${guacdPort}`,
      guacdImage,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  requireSuccess(result, `Could not start ${containerName}.`);
  startedContainer = true;

  await waitForPortState(
    true,
    guacdReadyTimeoutMs,
    `Timed out waiting for guacd to listen on ${guacdHost}:${guacdPort}.`,
  );
  console.log(`guacd is ready on ${guacdHost}:${guacdPort}.`);
  startGuacdMonitor();
}

async function stopGuacd() {
  if (guacdMonitor) {
    clearInterval(guacdMonitor);
    guacdMonitor = undefined;
  }

  if (!startedContainer) {
    return;
  }

  const result = docker(["ps", "-q", "--filter", `name=^/${containerName}$`]);
  if (result.status !== 0 || !result.stdout.trim()) {
    startedContainer = false;
    return;
  }

  console.log(`Stopping ${containerName}...`);
  const stopped = docker(["stop", "--timeout", String(guacdStopTimeoutMs / 1000), containerName], {
    stdio: "inherit",
  });
  if (stopped.status !== 0) {
    console.error(`Could not stop ${containerName}; you may need to run docker rm -f ${containerName}.`);
    return;
  }
  const removed = docker(["rm", containerName], { stdio: "inherit" });
  if (removed.status !== 0) {
    console.error(`Could not remove ${containerName}; it will be replaced on the next npm start.`);
  }
  startedContainer = false;
}

async function shutdown(exitCode = 0, signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (tauriProcess && tauriProcess.exitCode === null && !tauriProcess.killed) {
    tauriProcess.kill(signal ?? "SIGTERM");
  }

  await stopGuacd();
  process.exit(exitCode);
}

function startTauri() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  tauriProcess = spawn(npmCommand, ["run", "tauri:dev"], {
    env: {
      ...process.env,
      SSM_COMMANDER_GUACD_RDP_HOST: "host.docker.internal",
    },
    stdio: "inherit",
  });

  tauriProcess.on("exit", (code, signal) => {
    void shutdown(code ?? (signal ? 130 : 1), signal ?? undefined);
  });
  tauriProcess.on("error", (error) => {
    console.error(`Could not start Tauri dev command: ${error.message}`);
    void shutdown(1);
  });
}

process.on("SIGINT", () => {
  void shutdown(130, "SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown(143, "SIGTERM");
});
process.on("uncaughtException", async (error) => {
  console.error(error.message);
  await stopGuacd();
  process.exit(1);
});

try {
  cleanStaleTauriBuildCache();
  ensureDocker();
  const removedContainer = removeNamedContainer();
  if (removedContainer) {
    await waitForPortState(
      false,
      5_000,
      `Timed out waiting for ${guacdHost}:${guacdPort} to be released after removing ${containerName}.`,
    );
  }
  await assertGuacdPortFree();
  await startGuacd();
  startTauri();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stopGuacd();
  process.exit(1);
}
