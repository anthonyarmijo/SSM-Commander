import type { CredentialKind, RdpSecurityMode, SshAuthMode } from "../types/models";

export interface CredentialFormState {
  id: string;
  label: string;
  kind: CredentialKind;
  username: string;
  password: string;
  domain: string;
  sshAuthMode: SshAuthMode;
  sshKeyPath: string;
  sshPrivateKeyContent: string;
  rdpSecurityMode: RdpSecurityMode;
}

export const emptyCredentialForm: CredentialFormState = {
  id: "",
  label: "",
  kind: "ssh",
  username: "",
  password: "",
  domain: "",
  sshAuthMode: "password",
  sshKeyPath: "",
  sshPrivateKeyContent: "",
  rdpSecurityMode: "auto",
};

export function clearCredentialFormSecrets(): CredentialFormState {
  return { ...emptyCredentialForm };
}
