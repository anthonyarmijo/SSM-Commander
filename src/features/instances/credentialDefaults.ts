import type { CredentialKind, CredentialStoreStatus, CredentialSummary } from "../../types/models";

export function matchingCredentials(credentials: CredentialSummary[], kind: CredentialKind): CredentialSummary[] {
  return credentials.filter((credential) => credential.kind === kind);
}

export function defaultCredentialIdForKind(status: CredentialStoreStatus | null, kind: CredentialKind): string {
  if (!status?.unlocked) return "";
  return kind === "ssh" ? status.defaultSshCredentialId ?? "" : status.defaultRdpCredentialId ?? "";
}

export function selectDefaultCredentialId(
  credentials: CredentialSummary[],
  status: CredentialStoreStatus | null,
  kind: CredentialKind,
): string {
  const candidates = matchingCredentials(credentials, kind);
  if (candidates.length === 0) return "";
  const defaultId = defaultCredentialIdForKind(status, kind);
  if (defaultId && candidates.some((credential) => credential.id === defaultId)) return defaultId;
  return candidates[0].id;
}
