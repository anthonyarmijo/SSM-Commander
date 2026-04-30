export type TooltipPreference = "start" | "end";
export type TooltipPlacement = "open-right" | "open-left";

interface ResolveTooltipPlacementOptions {
  preferred: TooltipPreference;
  triggerLeft: number;
  triggerRight: number;
  tooltipWidth: number;
  viewportWidth: number;
  gutter?: number;
}

function placementBounds(
  placement: TooltipPlacement,
  triggerLeft: number,
  triggerRight: number,
  tooltipWidth: number,
) {
  if (placement === "open-left") {
    return {
      left: triggerRight - tooltipWidth,
      right: triggerRight,
    };
  }

  return {
    left: triggerLeft,
    right: triggerLeft + tooltipWidth,
  };
}

function overflowAmount(
  placement: TooltipPlacement,
  triggerLeft: number,
  triggerRight: number,
  tooltipWidth: number,
  viewportWidth: number,
  gutter: number,
) {
  const bounds = placementBounds(placement, triggerLeft, triggerRight, tooltipWidth);
  const leftOverflow = Math.max(0, gutter - bounds.left);
  const rightOverflow = Math.max(0, bounds.right - (viewportWidth - gutter));
  return leftOverflow + rightOverflow;
}

export function resolveTooltipPlacement({
  preferred,
  triggerLeft,
  triggerRight,
  tooltipWidth,
  viewportWidth,
  gutter = 16,
}: ResolveTooltipPlacementOptions): TooltipPlacement {
  const preferredPlacement = preferred === "end" ? "open-left" : "open-right";
  const alternatePlacement = preferredPlacement === "open-left" ? "open-right" : "open-left";

  const preferredOverflow = overflowAmount(
    preferredPlacement,
    triggerLeft,
    triggerRight,
    tooltipWidth,
    viewportWidth,
    gutter,
  );
  const alternateOverflow = overflowAmount(
    alternatePlacement,
    triggerLeft,
    triggerRight,
    tooltipWidth,
    viewportWidth,
    gutter,
  );

  return alternateOverflow < preferredOverflow ? alternatePlacement : preferredPlacement;
}
