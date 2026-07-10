import { describe, expect, it } from "vitest";
import { ASCII_TERRARIUM, isInitializationGatedView, navItems } from "./navigation";

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

  it("provides the animated ASCII terrarium content", () => {
    expect(ASCII_TERRARIUM.cloud.join("\n")).toContain("~~~~");
    expect(ASCII_TERRARIUM.server.join("\n")).toContain("::::::");
    expect(ASCII_TERRARIUM.laptop.join("\n")).toContain(">_");
  });

  it("gates workspace views that require initialization", () => {
    expect(navItems.filter((item) => isInitializationGatedView(item.view)).map((item) => item.label)).toEqual([
      "Instances",
      "Console",
      "SSM Activity",
    ]);
  });
});
