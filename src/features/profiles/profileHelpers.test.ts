import { describe, expect, it } from "vitest";
import {
  buildProfileStatusLabel,
  buildProfileStatusMessage,
  buildProfileOverview,
  getAddableProfiles,
  getInstancePowerAvailability,
  normalizeSavedProfiles,
  resolveActiveProfileRegion,
  resolveActiveProfile,
  shouldAutoExpandProfileDetails,
  summarizeRegionChips,
  type SavedProfileState,
} from "./profileHelpers";

const discoveredProfiles = [
  { name: "sample-alpha", source: "awsCli" as const, defaultRegion: "us-west-2" },
  { name: "sample-bravo", source: "awsCli" as const, defaultRegion: "us-east-1" },
  { name: "sample-charlie", source: "awsCli" as const, defaultRegion: "us-west-2" },
];

function createProfileState(overrides: Partial<SavedProfileState> = {}): SavedProfileState {
  return {
    profileName: "sample-alpha",
    authStatus: "unknown",
    busy: null,
    ssoStarted: false,
    ssoAttemptId: null,
    isAutoRevalidating: false,
    identityAccount: null,
    validationMessage: "",
    capabilities: [],
    ...overrides,
  };
}

describe("saved profile helpers", () => {
  it("keeps only discovered and unique saved profiles", () => {
    expect(normalizeSavedProfiles(discoveredProfiles, ["sample-alpha", "missing", "sample-alpha"])).toEqual(["sample-alpha"]);
  });

  it("falls back to the legacy last profile when no saved list exists", () => {
    expect(normalizeSavedProfiles(discoveredProfiles, null, "sample-bravo")).toEqual(["sample-bravo"]);
  });

  it("resolves the first saved profile when the active profile is missing", () => {
    expect(resolveActiveProfile(["sample-alpha", "sample-bravo"], "missing")).toBe("sample-alpha");
  });

  it("derives the active profile region from the AWS profile instead of stale region state", () => {
    expect(resolveActiveProfileRegion(discoveredProfiles, "sample-bravo")).toBe("us-east-1");
    expect(resolveActiveProfileRegion(discoveredProfiles, "missing")).toBe("");
  });

  it("filters out already-saved profiles from the add list", () => {
    expect(getAddableProfiles(discoveredProfiles, ["sample-alpha"]).map((profile) => profile.name)).toEqual([
      "sample-bravo",
      "sample-charlie",
    ]);
  });
});

describe("profile card status helpers", () => {
  it("reports a ready profile after validation", () => {
    const state = createProfileState({ authStatus: "valid", identityAccount: "demo-account" });
    expect(buildProfileStatusLabel(state)).toBe("ready");
    expect(buildProfileStatusMessage(state)).toBe("Profile access verified.");
  });

  it("reports the SSO reminder state", () => {
    const state = createProfileState({ authStatus: "expired", ssoStarted: true });
    expect(buildProfileStatusLabel(state)).toBe("sso started");
    expect(buildProfileStatusMessage(state)).toContain("re-validate automatically");
  });

  it("reports the waiting SSO state while login is in progress", () => {
    const state = createProfileState({ authStatus: "expired", busy: "sso", ssoStarted: true });
    expect(buildProfileStatusLabel(state)).toBe("sso started");
    expect(buildProfileStatusMessage(state)).toContain("Waiting for AWS SSO");
  });

  it("reports the automatic revalidation state after SSO succeeds", () => {
    const state = createProfileState({ busy: "validating", isAutoRevalidating: true });
    expect(buildProfileStatusLabel(state)).toBe("checking");
    expect(buildProfileStatusMessage(state)).toContain("Re-validating");
  });

  it("builds a compact profile overview from structured capability data", () => {
    const state = createProfileState({
      capabilities: [
        { id: "auth", label: "Authenticated identity", status: "available", message: "", account: "demo-account" },
        { id: "regions", label: "Region discovery", status: "available", message: "", regions: ["us-east-1", "us-west-2"] },
        { id: "ec2", label: "EC2 discovery", status: "available", message: "", regionName: "us-west-2", visibleInstanceCount: 4 },
        { id: "ssm", label: "SSM managed nodes", status: "available", message: "", regionName: "us-west-2", managedNodeCount: 2 },
      ],
    });
    expect(buildProfileOverview(state)).toEqual([
      "Account demo-account",
      "2 regions",
      "4 EC2 in us-west-2",
      "2 SSM in us-west-2",
    ]);
  });

  it("summarizes region chips with overflow", () => {
    expect(summarizeRegionChips(["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"], 3)).toEqual({
      visibleRegions: ["us-east-1", "us-west-2", "eu-west-1"],
      hiddenCount: 1,
    });
  });

  it("auto-expands details for expired profiles", () => {
    expect(shouldAutoExpandProfileDetails(createProfileState({ authStatus: "expired" }))).toBe(true);
    expect(shouldAutoExpandProfileDetails(createProfileState({ authStatus: "valid" }))).toBe(false);
  });
});

describe("instance power availability", () => {
  it("allows starting stopped instances", () => {
    expect(getInstancePowerAvailability({
      instanceId: "demo-node-1",
      state: "stopped",
      platform: "linux",
      tags: [],
      ssmStatus: "offline",
    })).toMatchObject({ canStart: true, canStop: false });
  });

  it("allows stopping running instances", () => {
    expect(getInstancePowerAvailability({
      instanceId: "demo-node-2",
      state: "running",
      platform: "linux",
      tags: [],
      ssmStatus: "ready",
    })).toMatchObject({ canStart: false, canStop: true });
  });

  it("disables actions for transitional states", () => {
    const availability = getInstancePowerAvailability({
      instanceId: "demo-node-3",
      state: "pending",
      platform: "windows",
      tags: [],
      ssmStatus: "unknown",
    });
    expect(availability.canStart).toBe(false);
    expect(availability.canStop).toBe(false);
    expect(availability.startDisabledReason).toContain("pending");
  });
});
