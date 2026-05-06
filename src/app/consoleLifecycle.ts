import type { ConsoleSessionEndedEvent } from "../types/models";

export function shouldAutoCloseEndedConsoleSession(
  event: ConsoleSessionEndedEvent,
  manuallyClosingSessionIds: Set<string>,
): boolean {
  if (event.kind !== "ssh") return false;
  if (manuallyClosingSessionIds.has(event.sessionId)) {
    manuallyClosingSessionIds.delete(event.sessionId);
    return false;
  }
  return true;
}
