import { describe, expect, it } from "vitest";
import { resolveTooltipPlacement } from "./tooltipPlacement";

describe("resolveTooltipPlacement", () => {
  it("keeps the preferred left-opening placement when it fits", () => {
    expect(resolveTooltipPlacement({
      preferred: "end",
      triggerLeft: 220,
      triggerRight: 240,
      tooltipWidth: 180,
      viewportWidth: 900,
    })).toBe("open-left");
  });

  it("flips to the right when the preferred left-opening placement would clip", () => {
    expect(resolveTooltipPlacement({
      preferred: "end",
      triggerLeft: 18,
      triggerRight: 38,
      tooltipWidth: 220,
      viewportWidth: 900,
    })).toBe("open-right");
  });

  it("flips to the left when the preferred right-opening placement would clip", () => {
    expect(resolveTooltipPlacement({
      preferred: "start",
      triggerLeft: 760,
      triggerRight: 780,
      tooltipWidth: 180,
      viewportWidth: 900,
    })).toBe("open-left");
  });
});
