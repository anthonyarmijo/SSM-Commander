import type {
  AuthStatus,
  AwsProfile,
  CapabilityStatus,
  InstanceSummary,
  ProfileCapability,
} from "../../types/models";

export interface SavedProfileState {
  profileName: string;
  authStatus: AuthStatus;
  busy: "validating" | "sso" | null;
  ssoStarted: boolean;
  ssoAttemptId?: string | null;
  isAutoRevalidating?: boolean;
  identityAccount?: string | null;
  validationMessage: string;
  capabilities: ProfileCapability[];
}

export interface InstancePowerAvailability {
  canStart: boolean;
  canStop: boolean;
  startDisabledReason: string | null;
  stopDisabledReason: string | null;
}

export interface RegionChipSummary {
  visibleRegions: string[];
  hiddenCount: number;
}

export function normalizeSavedProfiles(
  discoveredProfiles: AwsProfile[],
  savedProfiles: string[] | null | undefined,
  legacyLastProfile?: string | null,
): string[] {
  const discoveredNames = new Set(discoveredProfiles.map((profile) => profile.name));
  const seed = Array.isArray(savedProfiles) && savedProfiles.length > 0
    ? savedProfiles
    : legacyLastProfile
      ? [legacyLastProfile]
      : [];

  const normalized = seed
    .map((profileName) => profileName.trim())
    .filter((profileName, index, all) => profileName.length > 0 && all.indexOf(profileName) === index);

  return normalized.filter((profileName) => discoveredNames.has(profileName));
}

export function resolveActiveProfile(
  savedProfiles: string[],
  activeProfile: string | null | undefined,
): string {
  if (activeProfile && savedProfiles.includes(activeProfile)) {
    return activeProfile;
  }
  return savedProfiles[0] ?? "";
}

export function getAddableProfiles(discoveredProfiles: AwsProfile[], savedProfiles: string[]): AwsProfile[] {
  const saved = new Set(savedProfiles);
  return discoveredProfiles.filter((profile) => !saved.has(profile.name));
}

export function resolveActiveProfileRegion(discoveredProfiles: AwsProfile[], activeProfile: string): string {
  if (!activeProfile) return "";
  return discoveredProfiles.find((profile) => profile.name === activeProfile)?.defaultRegion ?? "";
}

export function buildProfileStatusLabel(profileState: SavedProfileState): string {
  if (profileState.isAutoRevalidating) return "checking";
  if (profileState.busy === "sso") return "sso started";
  if (profileState.busy === "validating") return "checking";
  if (profileState.authStatus === "valid") return "ready";
  if (profileState.authStatus === "expired" && profileState.ssoStarted) return "sso started";
  if (profileState.authStatus === "expired") return "sso required";
  if (profileState.authStatus === "error") return "error";
  return "not validated";
}

export function buildProfileStatusMessage(profileState: SavedProfileState): string {
  if (profileState.isAutoRevalidating) return "AWS SSO login completed. Re-validating profile access…";
  if (profileState.busy === "sso") return "Waiting for AWS SSO browser sign-in to finish…";
  if (profileState.busy === "validating") return "Checking caller identity and AWS access…";
  if (profileState.authStatus === "valid") {
    return "Profile access verified.";
  }
  if (profileState.authStatus === "expired" && profileState.ssoStarted) {
    return "AWS SSO login started. The app will re-validate automatically when it completes.";
  }
  if (profileState.authStatus === "expired") {
    return "AWS SSO sign-in is required.";
  }
  if (profileState.authStatus === "error") {
    return profileState.validationMessage || "Profile validation failed.";
  }
  return "Validate this profile to load its capability checklist.";
}

export function capabilityTone(status: CapabilityStatus): "good" | "warn" | "info" | "neutral" {
  if (status === "available") return "good";
  if (status === "unavailable") return "warn";
  if (status === "checking") return "info";
  return "neutral";
}

export function getProfileCapability(
  profileState: SavedProfileState,
  capabilityId: ProfileCapability["id"],
): ProfileCapability | undefined {
  return profileState.capabilities.find((capability) => capability.id === capabilityId);
}

export function buildProfileOverview(profileState: SavedProfileState): string[] {
  const identity = getProfileCapability(profileState, "auth");
  const regions = getProfileCapability(profileState, "regions");
  const ec2 = getProfileCapability(profileState, "ec2");
  const ssm = getProfileCapability(profileState, "ssm");
  const summary: string[] = [];

  if (identity?.account) {
    summary.push(`Account ${identity.account}`);
  }
  if (regions?.regions?.length) {
    summary.push(`${regions.regions.length} region${regions.regions.length === 1 ? "" : "s"}`);
  }
  if (typeof ec2?.visibleInstanceCount === "number" && ec2.regionName) {
    summary.push(`${ec2.visibleInstanceCount} EC2 in ${ec2.regionName}`);
  }
  if (typeof ssm?.managedNodeCount === "number" && ssm.regionName) {
    summary.push(`${ssm.managedNodeCount} SSM in ${ssm.regionName}`);
  }

  return summary;
}

export function summarizeRegionChips(regions: string[] | null | undefined, maxVisible = 3): RegionChipSummary {
  const normalized = Array.isArray(regions) ? regions : [];
  return {
    visibleRegions: normalized.slice(0, maxVisible),
    hiddenCount: Math.max(0, normalized.length - maxVisible),
  };
}

export function shouldAutoExpandProfileDetails(profileState: SavedProfileState): boolean {
  return profileState.authStatus === "expired" || profileState.authStatus === "error";
}

export function getInstancePowerAvailability(instance: InstanceSummary | null): InstancePowerAvailability {
  if (!instance) {
    return {
      canStart: false,
      canStop: false,
      startDisabledReason: "Select an instance first.",
      stopDisabledReason: "Select an instance first.",
    };
  }

  if (instance.state === "stopped") {
    return {
      canStart: true,
      canStop: false,
      startDisabledReason: null,
      stopDisabledReason: "Instance is not running.",
    };
  }

  if (instance.state === "running") {
    return {
      canStart: false,
      canStop: true,
      startDisabledReason: "Instance is already running.",
      stopDisabledReason: null,
    };
  }

  if (instance.state === "pending" || instance.state === "stopping") {
    return {
      canStart: false,
      canStop: false,
      startDisabledReason: `Instance is ${instance.state}.`,
      stopDisabledReason: `Instance is ${instance.state}.`,
    };
  }

  return {
    canStart: false,
    canStop: false,
    startDisabledReason: `Start is unavailable while instance is ${instance.state}.`,
    stopDisabledReason: `Stop is unavailable while instance is ${instance.state}.`,
  };
}
