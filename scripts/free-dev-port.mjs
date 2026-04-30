import { execFileSync } from "node:child_process";
import process from "node:process";

const port = "1420";
const host = "127.0.0.1";

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const pids = run("lsof", ["-ti", `TCP@${host}:${port}`, "-sTCP:LISTEN"])
  .split("\n")
  .map((pid) => pid.trim())
  .filter(Boolean);

for (const pid of pids) {
  const command = run("ps", ["-p", pid, "-o", "command="]);

  if (!/\bnode\b/.test(command) || !/\bvite\b/.test(command)) {
    console.error(
      `Port ${port} is already in use by PID ${pid}: ${command || "unknown process"}`,
    );
    console.error("Stop that process or update vite.config.ts and tauri.conf.json to use a different dev port.");
    process.exit(1);
  }

  process.kill(Number(pid), "SIGTERM");
  console.log(`Stopped stale Vite dev server on ${host}:${port} (PID ${pid}).`);
}
