import { describe, expect, it } from "vitest";
import { buildConsoleSessionRequest, buildRdpCredentialUsername } from "./consoleSessionRequest";

const base = {
  profile: "demo",
  region: "us-west-2",
  instanceId: "i-1",
  localPort: 54001,
  sshUser: "jhak_scan",
  sshPassword: "ssh-secret",
  sshKeyPath: "",
  sshPrivateKeyContent: "",
  sshCredentialId: "saved-ssh",
  rdpUsername: "Administrator",
  rdpDomain: "DEMO",
  rdpPassword: "rdp-secret",
  rdpCredentialId: "saved-rdp",
  rdpSecurityMode: "auto" as const,
  terminalCols: 100,
  terminalRows: 30,
  width: 1280,
  height: 720,
};

describe("console session requests", () => {
  it("sends SSH passwords only for SSH sessions", () => {
    expect(buildConsoleSessionRequest({ ...base, kind: "ssh" }).sshPassword).toBe("ssh-secret");
    expect(buildConsoleSessionRequest({ ...base, kind: "rdp" }).sshPassword).toBeNull();
    expect(buildConsoleSessionRequest({ ...base, kind: "shell" }).sshPassword).toBeNull();
  });

  it("sends saved credential ids only for matching console kinds", () => {
    expect(buildConsoleSessionRequest({ ...base, kind: "ssh" }).sshCredentialId).toBe("saved-ssh");
    expect(buildConsoleSessionRequest({ ...base, kind: "rdp" }).rdpCredentialId).toBe("saved-rdp");
    expect(buildConsoleSessionRequest({ ...base, kind: "shell" }).sshCredentialId).toBeNull();
    expect(buildConsoleSessionRequest({ ...base, kind: "shell" }).rdpCredentialId).toBeNull();
  });

  it("combines RDP domain and username", () => {
    expect(buildRdpCredentialUsername("Administrator", "DEMO")).toBe("DEMO\\Administrator");
    expect(buildRdpCredentialUsername("DEMO\\Administrator", "OTHER")).toBe("DEMO\\Administrator");
  });
});
