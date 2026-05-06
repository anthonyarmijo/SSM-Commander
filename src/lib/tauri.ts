import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type PreviewDesignVariant = "default" | "cool-ops" | "warm-ops";
type PreviewView = "home" | "initialize" | "credentials" | "instances" | "console" | "activity";

interface BrowserPreviewConfig {
  demoMode: boolean;
  designVariant: PreviewDesignVariant;
  initialView: PreviewView;
  instanceDelayMs: number;
}

interface PreviewSsoAttemptRecord {
  id: string;
  profile: string;
  startedAt: number;
}

const previewSsoAttempts = new Map<string, PreviewSsoAttemptRecord>();

const previewInstances = [
  {
    instanceId: "demo-node-alpha",
    name: "Demo Linux Alpha",
    state: "running",
    platform: "Linux",
    privateIp: "192.0.2.18",
    publicIp: null,
    vpcId: null,
    subnetId: null,
    launchTime: "2026-04-17T10:22:00Z",
    tags: [
      { key: "Environment", value: "demo" },
      { key: "Team", value: "sample" },
    ],
    ssmStatus: "ready",
    ssmPingStatus: "Online",
    agentVersion: "3.2.201.0",
  },
  {
    instanceId: "demo-node-bravo",
    name: "Example API Bravo",
    state: "running",
    platform: "Linux",
    privateIp: "192.0.2.41",
    publicIp: null,
    vpcId: null,
    subnetId: null,
    launchTime: "2026-04-17T08:40:00Z",
    tags: [
      { key: "Environment", value: "demo" },
      { key: "Service", value: "example" },
    ],
    ssmStatus: "ready",
    ssmPingStatus: "Online",
    agentVersion: "3.2.197.0",
  },
  {
    instanceId: "demo-node-charlie",
    name: "Sample Worker Charlie",
    state: "stopped",
    platform: "Linux",
    privateIp: "198.51.100.13",
    publicIp: null,
    vpcId: null,
    subnetId: null,
    launchTime: "2026-04-16T23:05:00Z",
    tags: [
      { key: "Environment", value: "sample" },
      { key: "Service", value: "demo" },
    ],
    ssmStatus: "offline",
    ssmPingStatus: "ConnectionLost",
    agentVersion: "3.2.180.0",
  },
  {
    instanceId: "demo-node-delta",
    name: "Demo Windows Delta",
    state: "running",
    platform: "Windows",
    privateIp: "203.0.113.27",
    publicIp: null,
    vpcId: null,
    subnetId: null,
    launchTime: "2026-04-17T09:55:00Z",
    tags: [
      { key: "Environment", value: "demo" },
      { key: "Team", value: "example" },
    ],
    ssmStatus: "ready",
    ssmPingStatus: "Online",
    agentVersion: "3.2.201.0",
  },
];

const previewSessions = [
  {
    id: "preview-session-1",
    kind: "ssh",
    profile: "demo-profile",
    region: "us-west-2",
    instanceId: "demo-node-alpha",
    processId: 28145,
    startedAt: "2026-04-17T16:12:00Z",
    status: "active",
    tunnel: {
      localPort: 2222,
      remoteHost: null,
      remotePort: 22,
      allocation: "requested",
      listenerStatus: "active",
      sessionId: "s-sshpreview",
    },
    note: "Preview SSH tunnel",
  },
  {
    id: "preview-session-2",
    kind: "rdp",
    profile: "demo-profile",
    region: "us-west-2",
    instanceId: "demo-node-delta",
    processId: 28162,
    startedAt: "2026-04-17T16:18:00Z",
    status: "active",
    tunnel: {
      localPort: 3390,
      remoteHost: null,
      remotePort: 3389,
      allocation: "auto",
      listenerStatus: "active",
      sessionId: "s-rdppreview",
    },
    note: "Preview RDP console",
  },
];

const previewConsoleSessions = [
  {
    id: "preview-console-ssh",
    kind: "ssh",
    renderer: "xterm",
    profile: "demo-profile",
    region: "us-west-2",
    instanceId: "demo-node-alpha",
    startedAt: "2026-04-17T16:12:00Z",
    status: "active",
    title: "SSH demo-node-alpha",
    tunnel: previewSessions[0].tunnel,
    bridgeUrl: null,
    connectionToken: null,
    message: "Preview SSH console",
  },
];

export function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

export function getBrowserPreviewConfig(): BrowserPreviewConfig {
  const params = new URLSearchParams(window.location.search);
  const variantParam = params.get("variant");
  const viewParam = params.get("view");
  const delayParam = Number(params.get("delayMs") ?? "0");

  return {
    demoMode: params.get("demo") === "1",
    designVariant:
      variantParam === "cool-ops" || variantParam === "warm-ops" ? variantParam : "default",
    initialView:
      viewParam === "initialize" || viewParam === "credentials" || viewParam === "instances" || viewParam === "console" || viewParam === "activity"
        ? viewParam
        : "home",
    instanceDelayMs: Number.isFinite(delayParam) ? Math.max(0, delayParam) : 0,
  };
}

async function browserPreviewValue<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const preview = getBrowserPreviewConfig();
  const values: Record<string, unknown> = {
    check_environment: preview.demoMode
      ? {
          status: "ready",
          platform: "browser",
          checks: [
            {
              name: "Desktop backend",
              command: "tauri",
              status: "present",
              version: "preview",
              required: true,
              message: "Browser preview scene loaded for design capture.",
              remediation: null,
              installUrl: null,
              installLabel: null,
            },
            {
              name: "AWS CLI",
              command: "aws",
              status: "present",
              version: "2.x preview",
              required: true,
              message: "Simulated preview dependency state.",
              remediation: null,
              installUrl: null,
              installLabel: null,
            },
          ],
        }
      : {
          status: "warning",
          platform: "browser",
          checks: [
            {
              name: "Desktop backend",
              command: "tauri",
              status: "warning",
              version: null,
              required: true,
              message: "Open with npm run tauri:dev to use AWS and SSM commands.",
              remediation: "The browser preview only renders the interface.",
              installUrl: null,
              installLabel: null,
            },
          ],
        },
    load_preferences: preview.demoMode
      ? {
          savedProfiles: ["demo-profile"],
          activeProfile: "demo-profile",
          lastProfile: "demo-profile",
          lastRegion: "us-west-2",
          defaultSshUser: "ec2-user",
          sshKeyPath: null,
          preferredRdpClient: null,
          themeMode: "light",
          sidebarWidth: 286,
        }
      : {},
    credential_store_status: {
      exists: preview.demoMode,
      unlocked: preview.demoMode,
      credentialCount: preview.demoMode ? 2 : 0,
      defaultSshCredentialId: preview.demoMode ? "preview-ssh" : null,
      defaultRdpCredentialId: preview.demoMode ? "preview-rdp" : null,
    },
    unlock_credentials: {
      exists: true,
      unlocked: true,
      credentialCount: preview.demoMode ? 2 : 0,
      defaultSshCredentialId: preview.demoMode ? "preview-ssh" : null,
      defaultRdpCredentialId: preview.demoMode ? "preview-rdp" : null,
    },
    lock_credentials: {
      exists: preview.demoMode,
      unlocked: false,
      credentialCount: 0,
      defaultSshCredentialId: null,
      defaultRdpCredentialId: null,
    },
    list_credentials: preview.demoMode
      ? [
          {
            id: "preview-ssh",
            label: "Demo SSH",
            kind: "ssh",
            username: "ec2-user",
            domain: null,
            sshAuthMode: "privateKeyPath",
            rdpSecurityMode: null,
            isDefault: true,
            updatedAt: new Date().toISOString(),
          },
          {
            id: "preview-rdp",
            label: "Demo RDP",
            kind: "rdp",
            username: "Administrator",
            domain: "DEMO",
            sshAuthMode: null,
            rdpSecurityMode: "auto",
            isDefault: true,
            updatedAt: new Date().toISOString(),
          },
        ]
      : [],
    get_credential: {
      id: "preview-ssh",
      label: "Demo SSH",
      kind: "ssh",
      username: "ec2-user",
      password: null,
      domain: null,
      sshAuthMode: "privateKeyPath",
      sshKeyPath: "/Users/demo/.ssh/id_rsa",
      sshPrivateKeyContent: null,
      rdpSecurityMode: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    upsert_credential: {
      id: `preview-credential-${Date.now()}`,
      label: "Preview credential",
      kind: "ssh",
      username: null,
      domain: null,
      sshAuthMode: "password",
      rdpSecurityMode: null,
      isDefault: false,
      updatedAt: new Date().toISOString(),
    },
    delete_credential: null,
    set_default_credential: {
      exists: true,
      unlocked: true,
      credentialCount: preview.demoMode ? 2 : 0,
      defaultSshCredentialId: preview.demoMode ? "preview-ssh" : null,
      defaultRdpCredentialId: preview.demoMode ? "preview-rdp" : null,
    },
    list_profiles: [
      { name: "demo-profile", source: "unknown", defaultRegion: "us-west-2" },
      { name: "sample-lab", source: "unknown", defaultRegion: "us-east-1" },
      { name: "example-sandbox", source: "unknown", defaultRegion: "eu-west-1" },
    ],
    list_regions: [{ name: "us-west-2" }, { name: "us-east-1" }, { name: "eu-west-1" }],
    probe_profile_capabilities: {
      profile: "demo-profile",
      region: "us-west-2",
      capabilities: [
        {
          id: "auth",
          label: "Authenticated identity",
          status: "available",
          message: "Demo identity verified.",
          account: "demo-account",
        },
        {
          id: "regions",
          label: "Region discovery",
          status: "available",
          message: "3 region(s) available.",
          regions: ["us-west-2", "us-east-1", "eu-west-1"],
        },
        {
          id: "ec2",
          label: "EC2 discovery",
          status: "available",
          message: "4 EC2 instance(s) visible in us-west-2.",
          regionName: "us-west-2",
          visibleInstanceCount: 4,
        },
        {
          id: "ssm",
          label: "SSM managed nodes",
          status: "available",
          message: "4 SSM managed node(s) visible in us-west-2.",
          regionName: "us-west-2",
          managedNodeCount: 4,
        },
      ],
    },
    list_active_sessions: preview.demoMode ? previewSessions : [],
    list_console_sessions: preview.demoMode ? previewConsoleSessions : [],
    write_console_input: null,
    resize_console_terminal: null,
    stop_console_session: preview.demoMode ? previewConsoleSessions[0] : null,
    save_preferences: null,
    validate_profile: {
      account: preview.demoMode ? "demo-account" : "preview",
      arn: preview.demoMode ? "demo-identity" : "Open the desktop app to validate AWS identity.",
      userId: "demo-user",
    },
    start_instances: preview.demoMode
      ? [{ instanceId: "demo-node-charlie", previousState: "stopped", currentState: "pending", requestedAction: "start" }]
      : [],
    stop_instances: preview.demoMode
      ? [{ instanceId: "demo-node-alpha", previousState: "running", currentState: "stopping", requestedAction: "stop" }]
      : [],
    discover_instances: preview.demoMode ? previewInstances : [],
    get_diagnostics: [
      {
        id: "browser-preview",
        timestamp: new Date().toISOString(),
        severity: preview.demoMode ? "info" : "warning",
        area: "launcher",
        message: preview.demoMode
          ? "Browser preview scene loaded for screenshot capture."
          : "Browser preview is running without the Tauri desktop backend.",
        command: null,
      },
    ],
  };

  if (command === "get_ssm_readiness") {
    if (preview.instanceDelayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, preview.instanceDelayMs));
    }
    return (preview.demoMode ? previewInstances : []) as T;
  }

  if (command === "start_sso_login") {
    const profile = typeof args?.profile === "string" ? args.profile : "demo-profile";
    const id = `preview-sso-${Date.now()}`;
    previewSsoAttempts.set(id, { id, profile, startedAt: Date.now() });
    return {
      id,
      profile,
      status: "waiting",
      message: "Waiting for AWS SSO browser sign-in to finish...",
    } as T;
  }

  if (command === "start_console_session") {
    const request = args?.request as Record<string, unknown> | undefined;
    const kind = request?.kind === "rdp" || request?.kind === "ssh" || request?.kind === "shell" ? request.kind : "shell";
    const instanceId = typeof request?.instanceId === "string" ? request.instanceId : "demo-node-alpha";
    return {
      id: `preview-console-${kind}-${Date.now()}`,
      kind,
      renderer: kind === "rdp" ? "guacamole" : "xterm",
      profile: "demo-profile",
      region: "us-west-2",
      instanceId,
      startedAt: new Date().toISOString(),
      status: kind === "rdp" ? "failed" : "active",
      title: kind === "shell" ? `SSM ${instanceId}` : `${kind.toUpperCase()} ${instanceId}`,
      tunnel: kind === "shell" ? null : kind === "rdp" ? previewSessions[1].tunnel : previewSessions[0].tunnel,
      bridgeUrl: null,
      connectionToken: null,
      message:
        kind === "rdp"
          ? "Preview RDP requires the desktop backend bridge."
          : kind === "shell"
            ? "Preview SSM shell"
            : "Preview SSH console",
    } as T;
  }

  if (command === "start_port_forward") {
    const request = args?.request as Record<string, unknown> | undefined;
    const remotePort = typeof request?.remotePort === "number" ? request.remotePort : 8080;
    const localPort = typeof request?.localPort === "number" ? request.localPort : 54901;
    const remoteHost = typeof request?.remoteHost === "string" ? request.remoteHost : null;
    return {
      id: `preview-tunnel-${Date.now()}`,
      kind: "tunnel",
      profile: "demo-profile",
      region: "us-west-2",
      instanceId: typeof request?.instanceId === "string" ? request.instanceId : "demo-node-alpha",
      processId: 28170,
      startedAt: new Date().toISOString(),
      status: "active",
      tunnel: {
        localPort,
        remoteHost,
        remotePort,
        allocation: typeof request?.localPort === "number" ? "requested" : "auto",
        listenerStatus: "active",
        sessionId: "s-tunnelpreview",
      },
      note: "Preview port-forward tunnel",
    } as T;
  }

  if (command === "get_sso_login_attempt") {
    const attemptId = typeof args?.attemptId === "string" ? args.attemptId : "";
    const attempt = previewSsoAttempts.get(attemptId);
    if (!attempt) {
      throw new Error(`No AWS SSO login attempt was found for id ${attemptId}.`);
    }

    const isComplete = Date.now() - attempt.startedAt >= 1200;
    return {
      id: attempt.id,
      profile: attempt.profile,
      status: isComplete ? "succeeded" : "waiting",
      message: isComplete
        ? "Demo SSO login completed."
        : "Waiting for AWS SSO browser sign-in to finish...",
    } as T;
  }

  if (command in values) {
    return values[command] as T;
  }

  throw new Error("Open the desktop preview with npm run tauri:dev to use this action.");
}

export async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    return browserPreviewValue<T>(command, args);
  }

  return invoke<T>(command, args);
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    await openUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}
