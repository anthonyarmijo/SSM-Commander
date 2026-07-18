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

export function instanceCredentialPreferenceKey(
  profile: string,
  region: string,
  instanceId: string,
  kind: CredentialKind,
): string {
  return JSON.stringify([profile, region, instanceId, kind]);
}

export function rememberedInstanceCredentialId(
  rememberedIds: Record<string, string> | null | undefined,
  credentials: CredentialSummary[],
  profile: string,
  region: string,
  instanceId: string,
  kind: CredentialKind,
): string {
  const rememberedId = rememberedIds?.[instanceCredentialPreferenceKey(profile, region, instanceId, kind)] ?? "";
  return credentials.some((credential) => credential.id === rememberedId && credential.kind === kind)
    ? rememberedId
    : "";
}

export function rememberInstanceCredential(
  rememberedIds: Record<string, string> | null | undefined,
  profile: string,
  region: string,
  instanceId: string,
  kind: CredentialKind,
  credentialId: string,
): Record<string, string> {
  if (!credentialId) return { ...rememberedIds };
  return {
    ...rememberedIds,
    [instanceCredentialPreferenceKey(profile, region, instanceId, kind)]: credentialId,
  };
}
