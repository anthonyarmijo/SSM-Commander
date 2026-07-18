import { describe, expect, it } from "vitest";
import { isInitializationGatedView, navItems, SSM_FIGLET } from "./navigation";

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

  it("provides the Big Signal SSM banner", () => {
    expect(SSM_FIGLET.split("\n")).toHaveLength(6);
    expect(SSM_FIGLET).toContain("███╗");
  });

  it("gates workspace views that require initialization", () => {
    expect(navItems.filter((item) => isInitializationGatedView(item.view)).map((item) => item.label)).toEqual([
      "Instances",
      "Console",
      "SSM Activity",
    ]);
  });
});
