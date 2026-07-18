import { describe, expect, it } from "vitest";
import {
  instanceCredentialPreferenceKey,
  rememberedInstanceCredentialId,
  rememberInstanceCredential,
  selectDefaultCredentialId,
} from "./credentialDefaults";
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

  it("defaults a VM to manual entry until a credential has been remembered", () => {
    expect(rememberedInstanceCredentialId(undefined, credentials, "dev", "us-west-2", "i-123", "ssh")).toBe("");
  });

  it("remembers credentials independently per VM and protocol", () => {
    const remembered = rememberInstanceCredential(undefined, "dev", "us-west-2", "i-123", "ssh", "ssh-2");
    expect(rememberedInstanceCredentialId(remembered, credentials, "dev", "us-west-2", "i-123", "ssh")).toBe("ssh-2");
    expect(rememberedInstanceCredentialId(remembered, credentials, "dev", "us-west-2", "i-456", "ssh")).toBe("");
    expect(rememberedInstanceCredentialId(remembered, credentials, "dev", "us-west-2", "i-123", "rdp")).toBe("");
  });

  it("ignores remembered credentials that were deleted or have the wrong protocol", () => {
    const key = instanceCredentialPreferenceKey("dev", "us-west-2", "i-123", "ssh");
    expect(rememberedInstanceCredentialId({ [key]: "missing" }, credentials, "dev", "us-west-2", "i-123", "ssh")).toBe("");
    expect(rememberedInstanceCredentialId({ [key]: "rdp-1" }, credentials, "dev", "us-west-2", "i-123", "ssh")).toBe("");
  });
});
