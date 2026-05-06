import { describe, expect, it } from "vitest";
import { defaultConnectionKindForInstance, isLinuxInstance } from "./connectionDefaults";

describe("instance connection defaults", () => {
  it("detects Linux platforms", () => {
    expect(isLinuxInstance({ platform: "Linux/UNIX" })).toBe(true);
    expect(isLinuxInstance({ platform: "windows" })).toBe(false);
  });

  it("defaults Linux instances to SSH and other platforms to RDP", () => {
    expect(defaultConnectionKindForInstance({ platform: "Linux" })).toBe("ssh");
    expect(defaultConnectionKindForInstance({ platform: "Windows" })).toBe("rdp");
  });
});
