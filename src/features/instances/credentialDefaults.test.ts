import { describe, expect, it } from "vitest";
import { selectDefaultCredentialId } from "./credentialDefaults";
import type { CredentialSummary } from "../../types/models";

const credentials: CredentialSummary[] = [
  {
    id: "ssh-1",
    label: "SSH 1",
    kind: "ssh",
    username: "ec2-user",
    isDefault: false,
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "rdp-1",
    label: "RDP 1",
    kind: "rdp",
    username: "Administrator",
    isDefault: false,
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "ssh-2",
    label: "SSH 2",
    kind: "ssh",
    username: "ubuntu",
    isDefault: true,
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("credential defaults", () => {
  it("selects the per-protocol default credential", () => {
    expect(selectDefaultCredentialId(credentials, {
      exists: true,
      unlocked: true,
      credentialCount: 3,
      defaultSshCredentialId: "ssh-2",
      defaultRdpCredentialId: "rdp-1",
    }, "ssh")).toBe("ssh-2");
  });

  it("falls back to the first matching credential", () => {
    expect(selectDefaultCredentialId(credentials, {
      exists: true,
      unlocked: true,
      credentialCount: 3,
      defaultSshCredentialId: "missing",
      defaultRdpCredentialId: null,
    }, "ssh")).toBe("ssh-1");
  });
});
