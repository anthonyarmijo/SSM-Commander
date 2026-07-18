import { describe, expect, it } from "vitest";
import type { CredentialSummary } from "../../types/models";
import { filterCredentials, moveCredentialByOffset, moveCredentialToTarget } from "./list";

const credentials: CredentialSummary[] = [
  { id: "ssh-a", label: "Alpha Linux", kind: "ssh", username: "ec2-user", isDefault: false, updatedAt: "2026-01-01" },
  { id: "rdp-b", label: "Bravo Windows", kind: "rdp", username: "Administrator", domain: "CORP", isDefault: false, updatedAt: "2026-01-01" },
  { id: "ssh-c", label: "Charlie Linux", kind: "ssh", username: "ubuntu", isDefault: false, updatedAt: "2026-01-01" },
];

describe("credential list helpers", () => {
  it("filters by protocol and searchable credential metadata", () => {
    expect(filterCredentials(credentials, "linux", "ssh").map(({ id }) => id)).toEqual(["ssh-a", "ssh-c"]);
    expect(filterCredentials(credentials, "corp", "all").map(({ id }) => id)).toEqual(["rdp-b"]);
    expect(filterCredentials(credentials, "", "rdp").map(({ id }) => id)).toEqual(["rdp-b"]);
  });

  it("moves a dragged credential to the drop target position", () => {
    expect(moveCredentialToTarget(credentials, "ssh-c", "ssh-a").map(({ id }) => id)).toEqual(["ssh-c", "ssh-a", "rdp-b"]);
    expect(moveCredentialToTarget(credentials, "ssh-a", "ssh-c").map(({ id }) => id)).toEqual(["rdp-b", "ssh-c", "ssh-a"]);
  });

  it("supports one-step keyboard reordering", () => {
    expect(moveCredentialByOffset(credentials, "rdp-b", -1).map(({ id }) => id)).toEqual(["rdp-b", "ssh-a", "ssh-c"]);
    expect(moveCredentialByOffset(credentials, "ssh-a", -1)).toBe(credentials);
  });
});
