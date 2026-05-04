import { describe, expect, it } from "vitest";
import { buildPortForwardInvokeArgs, validateTunnelForm } from "./tunnelForm";

describe("tunnel form validation", () => {
  it("requires a remote port", () => {
    expect(validateTunnelForm({ remotePort: "", remoteHost: "", localPort: "" })).toEqual({
      ok: false,
      message: "Enter a valid remote port between 1 and 65535.",
    });
  });

  it("rejects invalid and out-of-range ports", () => {
    expect(validateTunnelForm({ remotePort: "rdp", remoteHost: "", localPort: "" }).ok).toBe(false);
    expect(validateTunnelForm({ remotePort: "65536", remoteHost: "", localPort: "" }).ok).toBe(false);
    expect(validateTunnelForm({ remotePort: "3389", remoteHost: "", localPort: "0" }).ok).toBe(false);
  });

  it("builds a start_port_forward request from valid input", () => {
    const validation = validateTunnelForm({
      remotePort: "3389",
      remoteHost: " dc01.cyber.cosmos.navy.mil ",
      localPort: " 53989 ",
    });

    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    expect(buildPortForwardInvokeArgs(
      { profile: "cyber-admin", region: "us-gov-west-1", instanceId: "i-06fcede36546e9bba" },
      validation.value,
    )).toEqual({
      request: {
        profile: "cyber-admin",
        region: "us-gov-west-1",
        instanceId: "i-06fcede36546e9bba",
        remotePort: 3389,
        remoteHost: "dc01.cyber.cosmos.navy.mil",
        localPort: 53989,
      },
    });
  });

  it("treats blank optional fields as null", () => {
    const validation = validateTunnelForm({ remotePort: "22", remoteHost: " ", localPort: " " });

    expect(validation).toEqual({
      ok: true,
      value: {
        remotePort: 22,
        remoteHost: null,
        localPort: null,
      },
    });
  });
});
