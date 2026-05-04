export interface TunnelFormInput {
  remotePort: string;
  remoteHost: string;
  localPort: string;
}

export interface ValidatedTunnelForm {
  remotePort: number;
  remoteHost: string | null;
  localPort: number | null;
}

export interface TunnelContext {
  profile: string;
  region: string;
  instanceId: string;
}

export interface PortForwardInvokeArgs extends Record<string, unknown> {
  request: TunnelContext & ValidatedTunnelForm;
}

type TunnelFormValidation =
  | { ok: true; value: ValidatedTunnelForm }
  | { ok: false; message: string };

const MIN_PORT = 1;
const MAX_PORT = 65535;

function parsePort(value: string, label: string, required: boolean): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return required
      ? { ok: false, message: `Enter a valid ${label} between ${MIN_PORT} and ${MAX_PORT}.` }
      : { ok: true, value: null };
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return { ok: false, message: `Enter a valid ${label} between ${MIN_PORT} and ${MAX_PORT}.` };
  }

  return { ok: true, value: port };
}

export function validateTunnelForm(input: TunnelFormInput): TunnelFormValidation {
  const remotePort = parsePort(input.remotePort, "remote port", true);
  if (!remotePort.ok) return remotePort;

  const localPort = parsePort(input.localPort, "local port", false);
  if (!localPort.ok) return localPort;

  const remoteHost = input.remoteHost.trim();
  return {
    ok: true,
    value: {
      remotePort: remotePort.value ?? MIN_PORT,
      remoteHost: remoteHost ? remoteHost : null,
      localPort: localPort.value,
    },
  };
}

export function buildPortForwardInvokeArgs(context: TunnelContext, tunnel: ValidatedTunnelForm): PortForwardInvokeArgs {
  return {
    request: {
      profile: context.profile,
      region: context.region,
      instanceId: context.instanceId,
      remotePort: tunnel.remotePort,
      localPort: tunnel.localPort,
      remoteHost: tunnel.remoteHost,
    },
  };
}
