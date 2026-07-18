import type { CredentialKind, CredentialSummary } from "../../types/models";

export type CredentialKindFilter = "all" | CredentialKind;

export function filterCredentials(
  credentials: CredentialSummary[],
  query: string,
  kindFilter: CredentialKindFilter,
): CredentialSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  return credentials.filter((credential) => {
    if (kindFilter !== "all" && credential.kind !== kindFilter) return false;
    if (!normalizedQuery) return true;
    return [credential.label, credential.kind, credential.username ?? "", credential.domain ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

export function moveCredentialToTarget(
  credentials: CredentialSummary[],
  draggedId: string,
  targetId: string,
): CredentialSummary[] {
  if (!draggedId || draggedId === targetId) return credentials;
  const draggedIndex = credentials.findIndex((credential) => credential.id === draggedId);
  const targetIndex = credentials.findIndex((credential) => credential.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0) return credentials;

  const next = [...credentials];
  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged);
  return next;
}

export function moveCredentialByOffset(
  credentials: CredentialSummary[],
  credentialId: string,
  offset: -1 | 1,
): CredentialSummary[] {
  const index = credentials.findIndex((credential) => credential.id === credentialId);
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= credentials.length) return credentials;
  const next = [...credentials];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
}
