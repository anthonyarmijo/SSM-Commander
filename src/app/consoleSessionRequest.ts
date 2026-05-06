import type { ConsoleSessionKind, ConsoleSessionRequest, RdpSecurityMode } from "../types/models";

export interface BuildConsoleSessionRequestInput {
  kind: ConsoleSessionKind;
  profile: string;
  region: string;
  instanceId: string;
  localPort?: number | null;
  sshUser: string;
  sshPassword: string;
  sshKeyPath: string;
  sshPrivateKeyContent: string;
  rdpUsername: string;
  rdpDomain: string;
  rdpPassword: string;
  rdpSecurityMode: RdpSecurityMode;
  terminalCols: number;
  terminalRows: number;
  width: number;
  height: number;
}

export function buildRdpCredentialUsername(username: string, domain: string): string {
  const trimmedUsername = username.trim();
  const trimmedDomain = domain.trim();
  if (!trimmedUsername || !trimmedDomain) return trimmedUsername;
  if (trimmedUsername.includes("\\") || trimmedUsername.includes("@")) return trimmedUsername;
  return `${trimmedDomain}\\${trimmedUsername}`;
}

export function buildConsoleSessionRequest(input: BuildConsoleSessionRequestInput): ConsoleSessionRequest {
  return {
    kind: input.kind,
    profile: input.profile,
    region: input.region,
    instanceId: input.instanceId,
    localPort: input.kind === "shell" ? null : input.localPort ?? null,
    username: input.kind === "ssh" ? input.sshUser || null : null,
    sshPassword: input.kind === "ssh" ? input.sshPassword || null : null,
    sshKeyPath: input.kind === "ssh" ? input.sshKeyPath || null : null,
    sshPrivateKeyContent: input.kind === "ssh" ? input.sshPrivateKeyContent || null : null,
    rdpUsername: input.kind === "rdp" ? buildRdpCredentialUsername(input.rdpUsername, input.rdpDomain) || null : null,
    rdpPassword: input.kind === "rdp" ? input.rdpPassword || null : null,
    rdpSecurityMode: input.kind === "rdp" ? input.rdpSecurityMode : null,
    terminalCols: input.terminalCols,
    terminalRows: input.terminalRows,
    width: input.width,
    height: input.height,
  };
}
