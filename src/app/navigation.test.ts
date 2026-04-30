import { describe, expect, it } from "vitest";
import { navItems, SSM_COMMANDER_ASCII } from "./navigation";

describe("navigation", () => {
  it("uses the SSM Commander workspace order", () => {
    expect(navItems.map((item) => item.label)).toEqual([
      "Home",
      "Initialize",
      "Instances",
      "Console",
      "SSM Activity",
      "Logs",
    ]);
  });

  it("provides the SSM Commander ASCII banner content", () => {
    expect(SSM_COMMANDER_ASCII.join("\n")).toContain("____");
    expect(SSM_COMMANDER_ASCII.join("\n")).toContain("___");
  });
});
