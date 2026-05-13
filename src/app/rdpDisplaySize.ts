export interface RdpDisplaySize {
  width: number;
  height: number;
}

export const DEFAULT_RDP_DISPLAY_SIZE: RdpDisplaySize = {
  width: 1280,
  height: 720,
};

export const MIN_RDP_DISPLAY_SIZE: RdpDisplaySize = {
  width: 640,
  height: 480,
};

export const CONSOLE_TABS_HEIGHT = 42;

export function clampRdpDisplaySize(width: number, height: number): RdpDisplaySize {
  return {
    width: Math.max(MIN_RDP_DISPLAY_SIZE.width, Math.floor(width)),
    height: Math.max(MIN_RDP_DISPLAY_SIZE.height, Math.floor(height)),
  };
}

export function measuredRdpDisplaySize(width: number, height: number): RdpDisplaySize | null {
  if (width <= 0 || height <= 0) {
    return null;
  }

  return clampRdpDisplaySize(width, height);
}

export function estimateRdpConsolePaneSize({
  consoleTabsHeight = CONSOLE_TABS_HEIGHT,
  sidebarWidth,
  windowHeight,
  windowWidth,
}: {
  consoleTabsHeight?: number;
  sidebarWidth: number;
  windowHeight: number;
  windowWidth: number;
}): RdpDisplaySize {
  return clampRdpDisplaySize(windowWidth - sidebarWidth, windowHeight - consoleTabsHeight);
}

export function getBrowserRdpConsolePaneSize(sidebarWidth: number): RdpDisplaySize {
  if (typeof window === "undefined") {
    return DEFAULT_RDP_DISPLAY_SIZE;
  }

  return estimateRdpConsolePaneSize({
    sidebarWidth,
    windowHeight: window.innerHeight,
    windowWidth: Math.max(
      window.innerWidth,
      document.documentElement?.clientWidth ?? 0,
      document.body?.clientWidth ?? 0,
    ),
  });
}
