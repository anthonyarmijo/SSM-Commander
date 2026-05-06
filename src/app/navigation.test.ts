import { describe, expect, it } from "vitest";
import { isInitializationGatedView, navItems, SSM_COMMANDER_ASCII } from "./navigation";

describe("navigation", () => {
  it("uses the SSM Commander workspace order", () => {
    expect(navItems.map((item) => item.label)).toEqual([
      "Home",
      "Initialize",
      "Credentials",
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

  it("gates workspace views that require initialization", () => {
    expect(navItems.filter((item) => isInitializationGatedView(item.view)).map((item) => item.label)).toEqual([
      "Instances",
      "Console",
      "SSM Activity",
    ]);
  });
});
