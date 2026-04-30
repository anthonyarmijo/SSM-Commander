import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import process from "node:process";

const containerName = "ssm-commander-guacd";
const guacdImage = "guacamole/guacd";
const guacdHost = "127.0.0.1";
const guacdPort = 4822;
const guacdReadyTimeoutMs = 30_000;
const guacdStopTimeoutMs = 10_000;

let tauriProcess;
let startedContainer = false;
let shuttingDown = false;

function run(command, args, options = {}) {
  return spawnSync(command, args, {
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
      "--rm",
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
}

async function stopGuacd() {
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
