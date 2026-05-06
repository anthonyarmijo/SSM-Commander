import { describe, expect, it } from "vitest";
import { clearCredentialFormSecrets } from "./credentialForm";

describe("credential form state", () => {
  it("clears edited secrets for lock/reset flows", () => {
    const cleared = clearCredentialFormSecrets();

    expect(cleared.id).toBe("");
    expect(cleared.password).toBe("");
    expect(cleared.sshPrivateKeyContent).toBe("");
    expect(cleared.sshKeyPath).toBe("");
  });
});
