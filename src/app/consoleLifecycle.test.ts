import { describe, expect, it } from "vitest";
import { shouldAutoCloseEndedConsoleSession } from "./consoleLifecycle";

describe("console lifecycle", () => {
  it("auto-closes SSH sessions that ended remotely", () => {
    expect(shouldAutoCloseEndedConsoleSession({
      sessionId: "ssh-1",
      kind: "ssh",
      instanceId: "i-1",
      message: "SSH session disconnected.",
    }, new Set())).toBe(true);
  });

  it("ignores manually closed sessions and non-SSH sessions", () => {
    const manuallyClosing = new Set(["ssh-1"]);
    expect(shouldAutoCloseEndedConsoleSession({
      sessionId: "ssh-1",
      kind: "ssh",
      instanceId: "i-1",
      message: "SSH session disconnected.",
    }, manuallyClosing)).toBe(false);
    expect(manuallyClosing.has("ssh-1")).toBe(false);
    expect(shouldAutoCloseEndedConsoleSession({
      sessionId: "shell-1",
      kind: "shell",
      instanceId: "i-1",
      message: "Shell ended.",
    }, new Set())).toBe(false);
  });
});
