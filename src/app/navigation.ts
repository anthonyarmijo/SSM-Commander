export type ActiveView = "home" | "initialize" | "credentials" | "instances" | "console" | "activity" | "logs";

export const navItems: Array<{ view: ActiveView; label: string }> = [
  { view: "home", label: "Home" },
  { view: "initialize", label: "Initialize" },
  { view: "credentials", label: "Credentials" },
  { view: "instances", label: "Instances" },
  { view: "console", label: "Console" },
  { view: "activity", label: "SSM Activity" },
  { view: "logs", label: "Logs" },
];

export function isInitializationGatedView(view: ActiveView): boolean {
  return view === "instances" || view === "console" || view === "activity";
}

export const SSM_FIGLET = [
  "███████╗ ███████╗ ███╗   ███╗",
  "██╔════╝ ██╔════╝ ████╗ ████║",
  "███████╗ ███████╗ ██╔████╔██║",
  "╚════██║ ╚════██║ ██║╚██╔╝██║",
  "███████║ ███████║ ██║ ╚═╝ ██║",
  "╚══════╝ ╚══════╝ ╚═╝     ╚═╝",
].join("\n");
