import { describe, expect, it } from "vitest";
import { clampRdpDisplaySize, estimateRdpConsolePaneSize, measuredRdpDisplaySize } from "./rdpDisplaySize";

describe("RDP display sizing", () => {
  it("estimates the visible console pane below tabs and beside the sidebar", () => {
    expect(
      estimateRdpConsolePaneSize({
        sidebarWidth: 270,
        windowHeight: 900,
        windowWidth: 1440,
      }),
    ).toEqual({ width: 1170, height: 858 });
  });

  it("clamps RDP sizes to backend-safe minimums", () => {
    expect(clampRdpDisplaySize(320.8, 240.2)).toEqual({ width: 640, height: 480 });
  });

  it("ignores empty pane measurements instead of resizing RDP to the minimum", () => {
    expect(measuredRdpDisplaySize(0, 720)).toBeNull();
    expect(measuredRdpDisplaySize(1200, 0)).toBeNull();
    expect(measuredRdpDisplaySize(1200.8, 700.9)).toEqual({ width: 1200, height: 700 });
  });
});
