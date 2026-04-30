export type ActiveView = "home" | "initialize" | "instances" | "console" | "activity" | "logs";

export const navItems: Array<{ view: ActiveView; label: string }> = [
  { view: "home", label: "Home" },
  { view: "initialize", label: "Initialize" },
  { view: "instances", label: "Instances" },
  { view: "console", label: "Console" },
  { view: "activity", label: "SSM Activity" },
  { view: "logs", label: "Logs" },
];

export const SSM_COMMANDER_ASCII = [
  "  ____ ____  __  __    ____                                          _           ",
  " / ___/ ___||  \\/  |  / ___|___  _ __ ___  _ __ ___   __ _ _ __   __| | ___ _ __ ",
  " \\___ \\___ \\| |\\/| | | |   / _ \\| '_ ` _ \\| '_ ` _ \\ / _` | '_ \\ / _` |/ _ \\ '__|",
  "  ___) |__) | |  | | | |__| (_) | | | | | | | | | | | (_| | | | | (_| |  __/ |   ",
  " |____/____/|_|  |_|  \\____\\___/|_| |_| |_|_| |_| |_|\\__,_|_| |_|\\__,_|\\___|_|   ",
];
