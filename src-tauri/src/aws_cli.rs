use crate::diagnostics::redact_message;
use crate::models::{
    AwsProfile, CallerIdentity, CallerIdentityRaw, CapabilityStatus, InstancePowerAction,
    InstancePowerActionResult, InstanceSummary, ProfileCapability, ProfileCapabilityId,
    ProfileCapabilityReport, ProfileSource, RegionOption, SsmStatus, SsoLoginAttemptStatus,
    TagPair,
};
use serde::Deserialize;
use std::{collections::BTreeMap, collections::HashMap, fs, path::PathBuf, process::Command};

#[derive(Debug)]
pub struct AwsCliOutput {
    pub stdout: String,
}

#[derive(Debug)]
pub struct SsoLoginResult {
    pub status: SsoLoginAttemptStatus,
    pub message: String,
}

const SSO_LOGIN_SUCCESS_PREFIX: &str = concat!("Successfully logged into ", "Start URL:");

const AWS_CLI_PATH_ENV: &str = "SSM_COMMANDER_AWS_CLI_PATH";

#[cfg(target_os = "macos")]
const MACOS_TOOL_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

fn run_aws(args: &[String]) -> Result<AwsCliOutput, String> {
    let output = aws_command()
        .args(args)
        .output()
        .map_err(|error| format!("Could not run AWS CLI: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(AwsCliOutput { stdout })
    } else {
        Err(if stderr.is_empty() {
            format!("AWS CLI exited with status {}", output.status)
        } else {
            redact_message(&stderr)
        })
    }
}

fn aws_command() -> Command {
    let mut command = Command::new(aws_executable());
    if let Some(path) = tool_path() {
        command.env("PATH", path);
    }
    command
}

pub fn aws_executable() -> String {
    if let Some(path) = std::env::var_os(AWS_CLI_PATH_ENV)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return path.to_string_lossy().to_string();
    }

    #[cfg(target_os = "macos")]
    {
        for directory in MACOS_TOOL_PATHS {
            let candidate = PathBuf::from(directory).join("aws");
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    "aws".to_string()
}

pub fn tool_path() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let existing = std::env::var_os("PATH").unwrap_or_default();
        let existing = existing.to_string_lossy();
        return Some(merge_path_entries(&existing, MACOS_TOOL_PATHS));
    }

    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn merge_path_entries(existing: &str, additions: &[&str]) -> String {
    let mut entries = Vec::new();
    for entry in existing.split(':').chain(additions.iter().copied()) {
        let trimmed = entry.trim();
        if !trimmed.is_empty() && !entries.iter().any(|candidate| candidate == trimmed) {
            entries.push(trimmed.to_string());
        }
    }
    entries.join(":")
}

pub fn build_aws_args(
    profile: Option<&str>,
    region: Option<&str>,
    service_args: &[&str],
) -> Vec<String> {
    let mut args = service_args
        .iter()
        .map(|part| part.to_string())
        .collect::<Vec<_>>();
    if let Some(profile) = profile.filter(|value| !value.trim().is_empty()) {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }
    if let Some(region) = region.filter(|value| !value.trim().is_empty()) {
        args.push("--region".to_string());
        args.push(region.to_string());
    }
    args.push("--output".to_string());
    args.push("json".to_string());
    args
}

pub fn list_profiles() -> Result<Vec<AwsProfile>, String> {
    Ok(load_profile_map()
        .into_iter()
        .map(|(name, default_region)| AwsProfile {
            name,
            source: ProfileSource::ConfigFile,
            default_region,
        })
        .collect())
}

fn profile_region(profile: &str) -> Option<String> {
    load_profile_map().remove(profile).flatten()
}

fn load_profile_map() -> BTreeMap<String, Option<String>> {
    let mut profiles = BTreeMap::new();
    for (path, format) in aws_profile_files() {
        let Ok(contents) = fs::read_to_string(path) else {
            continue;
        };
        merge_profile_map(&mut profiles, parse_profile_file(&contents, format));
    }
    profiles
}

fn aws_profile_files() -> Vec<(PathBuf, AwsProfileFileFormat)> {
    let mut files = Vec::new();
    if let Some(path) = std::env::var_os("AWS_CONFIG_FILE") {
        files.push((PathBuf::from(path), AwsProfileFileFormat::Config));
    } else if let Some(home) = dirs_next::home_dir() {
        files.push((
            home.join(".aws").join("config"),
            AwsProfileFileFormat::Config,
        ));
    }

    if let Some(path) = std::env::var_os("AWS_SHARED_CREDENTIALS_FILE") {
        files.push((PathBuf::from(path), AwsProfileFileFormat::Credentials));
    } else if let Some(home) = dirs_next::home_dir() {
        files.push((
            home.join(".aws").join("credentials"),
            AwsProfileFileFormat::Credentials,
        ));
    }

    files
}

#[derive(Clone, Copy)]
enum AwsProfileFileFormat {
    Config,
    Credentials,
}

fn merge_profile_map(
    target: &mut BTreeMap<String, Option<String>>,
    source: BTreeMap<String, Option<String>>,
) {
    for (name, region) in source {
        target
            .entry(name)
            .and_modify(|existing| {
                if existing.is_none() && region.is_some() {
                    *existing = region.clone();
                }
            })
            .or_insert(region);
    }
}

fn parse_profile_file(
    contents: &str,
    format: AwsProfileFileFormat,
) -> BTreeMap<String, Option<String>> {
    let mut profiles = BTreeMap::new();
    let mut current_profile: Option<String> = None;

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        if let Some(section) = line
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .map(str::trim)
        {
            current_profile = normalize_profile_section(section, format);
            if let Some(profile) = &current_profile {
                profiles.entry(profile.clone()).or_insert(None);
            }
            continue;
        }

        let Some(profile) = current_profile.as_ref() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "region" {
            let region = value.trim();
            if !region.is_empty() {
                profiles.insert(profile.clone(), Some(region.to_string()));
            }
        }
    }

    profiles
}

fn normalize_profile_section(section: &str, format: AwsProfileFileFormat) -> Option<String> {
    let name = match format {
        AwsProfileFileFormat::Config => {
            if section == "default" {
                "default"
            } else {
                section.strip_prefix("profile ")?.trim()
            }
        }
        AwsProfileFileFormat::Credentials => section,
    };

    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn run_sso_login(profile: &str) -> Result<SsoLoginResult, String> {
    let output = aws_command()
        .args(["sso", "login", "--profile", profile])
        .output()
        .map_err(|error| format!("Could not start AWS SSO login: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    Ok(parse_sso_login_result(
        output.status.success(),
        &stdout,
        &stderr,
    ))
}

pub fn validate_profile(profile: &str, _region: Option<&str>) -> Result<CallerIdentity, String> {
    let args = build_aws_args(Some(profile), None, &["sts", "get-caller-identity"]);
    let output = run_aws(&args)?;
    let raw = serde_json::from_str::<CallerIdentityRaw>(&output.stdout)
        .map_err(|error| format!("Could not parse caller identity JSON: {error}"))?;
    Ok(raw.into())
}

pub fn list_regions(profile: &str) -> Result<Vec<RegionOption>, String> {
    let args = build_aws_args(
        Some(profile),
        None,
        &[
            "ec2",
            "describe-regions",
            "--all-regions",
            "--query",
            "Regions[].RegionName",
        ],
    );
    let output = run_aws(&args)?;
    let names = serde_json::from_str::<Vec<String>>(&output.stdout)
        .map_err(|error| format!("Could not parse regions JSON: {error}"))?;
    Ok(names
        .into_iter()
        .map(|name| RegionOption { name })
        .collect())
}

pub fn probe_profile_capabilities(profile: &str, region: Option<&str>) -> ProfileCapabilityReport {
    let region = region
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| profile_region(profile));
    let region_ref = region.as_deref();

    let auth = match validate_profile(profile, region_ref) {
        Ok(caller) => ProfileCapability {
            id: ProfileCapabilityId::Auth,
            label: "Authenticated identity".to_string(),
            status: CapabilityStatus::Available,
            message: "AWS identity verified.".to_string(),
            account: Some(caller.account),
            regions: None,
            region_name: None,
            visible_instance_count: None,
            managed_node_count: None,
        },
        Err(error) => ProfileCapability {
            id: ProfileCapabilityId::Auth,
            label: "Authenticated identity".to_string(),
            status: CapabilityStatus::Unavailable,
            message: classify_capability_error(&error),
            account: None,
            regions: None,
            region_name: None,
            visible_instance_count: None,
            managed_node_count: None,
        },
    };

    let regions = match list_regions(profile) {
        Ok(discovered) => ProfileCapability {
            id: ProfileCapabilityId::Regions,
            label: "Region discovery".to_string(),
            status: CapabilityStatus::Available,
            message: format!("{} region(s) available.", discovered.len()),
            account: None,
            regions: Some(
                discovered
                    .into_iter()
                    .map(|option| option.name)
                    .collect::<Vec<_>>(),
            ),
            region_name: None,
            visible_instance_count: None,
            managed_node_count: None,
        },
        Err(error) => ProfileCapability {
            id: ProfileCapabilityId::Regions,
            label: "Region discovery".to_string(),
            status: CapabilityStatus::Unavailable,
            message: classify_capability_error(&error),
            account: None,
            regions: None,
            region_name: None,
            visible_instance_count: None,
            managed_node_count: None,
        },
    };

    let ec2 = match probe_ec2_discovery(profile, region_ref) {
        Ok(count) => ProfileCapability {
            id: ProfileCapabilityId::Ec2,
            label: "EC2 discovery".to_string(),
            status: CapabilityStatus::Available,
            message: format!(
                "{} EC2 instance(s) visible in {}.",
                count,
                region_label(region_ref)
            ),
            account: None,
            regions: None,
            region_name: Some(region_label(region_ref).to_string()),
            visible_instance_count: Some(u32::try_from(count).unwrap_or(u32::MAX)),
            managed_node_count: None,
        },
        Err(error) => ProfileCapability {
            id: ProfileCapabilityId::Ec2,
            label: "EC2 discovery".to_string(),
            status: CapabilityStatus::Unavailable,
            message: classify_capability_error(&error),
            account: None,
            regions: None,
            region_name: Some(region_label(region_ref).to_string()),
            visible_instance_count: None,
            managed_node_count: None,
        },
    };

    let ssm = match probe_ssm_visibility(profile, region_ref) {
        Ok(count) => ProfileCapability {
            id: ProfileCapabilityId::Ssm,
            label: "SSM managed nodes".to_string(),
            status: CapabilityStatus::Available,
            message: format!(
                "{} SSM managed node(s) visible in {}.",
                count,
                region_label(region_ref)
            ),
            account: None,
            regions: None,
            region_name: Some(region_label(region_ref).to_string()),
            visible_instance_count: None,
            managed_node_count: Some(u32::try_from(count).unwrap_or(u32::MAX)),
        },
        Err(error) => ProfileCapability {
            id: ProfileCapabilityId::Ssm,
            label: "SSM managed nodes".to_string(),
            status: CapabilityStatus::Unavailable,
            message: classify_capability_error(&error),
            account: None,
            regions: None,
            region_name: Some(region_label(region_ref).to_string()),
            visible_instance_count: None,
            managed_node_count: None,
        },
    };

    ProfileCapabilityReport {
        profile: profile.to_string(),
        region,
        capabilities: vec![auth, regions, ec2, ssm],
    }
}

pub fn discover_instances(profile: &str, region: &str) -> Result<Vec<InstanceSummary>, String> {
    let args = build_aws_args(
        Some(profile),
        Some(region),
        &[
            "ec2",
            "describe-instances",
            "--filters",
            "Name=instance-state-name,Values=pending,running,stopping,stopped",
        ],
    );
    let output = run_aws(&args)?;
    let response = serde_json::from_str::<DescribeInstancesResponse>(&output.stdout)
        .map_err(|error| format!("Could not parse EC2 instances JSON: {error}"))?;
    Ok(response.into_summaries())
}

pub fn discover_instances_with_ssm(
    profile: &str,
    region: &str,
    instance_ids: &[String],
) -> Result<Vec<InstanceSummary>, String> {
    let mut instances = discover_instances(profile, region)?;
    let readiness_ids = if instance_ids.is_empty() {
        instances
            .iter()
            .map(|instance| instance.instance_id.clone())
            .collect::<Vec<_>>()
    } else {
        instance_ids.to_vec()
    };
    let readiness = describe_ssm_readiness(profile, region, &readiness_ids)?;
    for instance in &mut instances {
        if !instance_ids.is_empty() && !instance_ids.contains(&instance.instance_id) {
            continue;
        }

        match readiness.get(&instance.instance_id) {
            Some(info) if info.ping_status == "Online" => {
                instance.ssm_status = SsmStatus::Ready;
                instance.ssm_ping_status = Some(info.ping_status.clone());
                instance.agent_version = info.agent_version.clone();
            }
            Some(info) => {
                instance.ssm_status = SsmStatus::Offline;
                instance.ssm_ping_status = Some(info.ping_status.clone());
                instance.agent_version = info.agent_version.clone();
            }
            None => {
                instance.ssm_status = SsmStatus::NotManaged;
            }
        }
    }
    Ok(instances)
}

pub fn start_instances(
    profile: &str,
    region: &str,
    instance_ids: &[String],
) -> Result<Vec<InstancePowerActionResult>, String> {
    run_instance_power_action(profile, region, instance_ids, InstancePowerAction::Start)
}

pub fn stop_instances(
    profile: &str,
    region: &str,
    instance_ids: &[String],
) -> Result<Vec<InstancePowerActionResult>, String> {
    run_instance_power_action(profile, region, instance_ids, InstancePowerAction::Stop)
}

fn run_instance_power_action(
    profile: &str,
    region: &str,
    instance_ids: &[String],
    action: InstancePowerAction,
) -> Result<Vec<InstancePowerActionResult>, String> {
    if instance_ids.is_empty() {
        return Ok(Vec::new());
    }

    let service_args = match action {
        InstancePowerAction::Start => "start-instances",
        InstancePowerAction::Stop => "stop-instances",
    };
    let mut args = vec![
        "ec2".to_string(),
        service_args.to_string(),
        "--instance-ids".to_string(),
    ];
    args.extend(instance_ids.iter().cloned());
    if !profile.trim().is_empty() {
        args.push("--profile".to_string());
        args.push(profile.to_string());
    }
    if !region.trim().is_empty() {
        args.push("--region".to_string());
        args.push(region.to_string());
    }
    args.push("--output".to_string());
    args.push("json".to_string());
    let output = run_aws(&args)?;
    let response = serde_json::from_str::<InstancePowerResponse>(&output.stdout)
        .map_err(|error| format!("Could not parse EC2 power action JSON: {error}"))?;

    Ok(response
        .into_results(action)
        .into_iter()
        .filter(|result| instance_ids.contains(&result.instance_id))
        .collect())
}

fn describe_ssm_readiness(
    profile: &str,
    region: &str,
    instance_ids: &[String],
) -> Result<HashMap<String, InstanceInformation>, String> {
    if instance_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let values = instance_ids.join(",");
    let filter = format!("Key=InstanceIds,Values={values}");
    let args = build_aws_args(
        Some(profile),
        Some(region),
        &["ssm", "describe-instance-information", "--filters", &filter],
    );
    let output = run_aws(&args)?;
    let response = serde_json::from_str::<DescribeInstanceInformationResponse>(&output.stdout)
        .map_err(|error| format!("Could not parse SSM readiness JSON: {error}"))?;

    Ok(response
        .instance_information_list
        .into_iter()
        .map(|info| (info.instance_id.clone(), info))
        .collect())
}

fn probe_ec2_discovery(profile: &str, region: Option<&str>) -> Result<usize, String> {
    let region = region.ok_or_else(|| "No AWS region selected or configured.".to_string())?;
    let args = build_aws_args(
        Some(profile),
        Some(region),
        &[
            "ec2",
            "describe-instances",
            "--max-results",
            "5",
            "--query",
            "Reservations[].Instances[].InstanceId",
        ],
    );
    let output = run_aws(&args)?;
    let ids = serde_json::from_str::<Vec<String>>(&output.stdout)
        .map_err(|error| format!("Could not parse EC2 capability JSON: {error}"))?;
    Ok(ids.len())
}

fn probe_ssm_visibility(profile: &str, region: Option<&str>) -> Result<usize, String> {
    let region = region.ok_or_else(|| "No AWS region selected or configured.".to_string())?;
    let args = build_aws_args(
        Some(profile),
        Some(region),
        &[
            "ssm",
            "describe-instance-information",
            "--max-results",
            "5",
            "--query",
            "InstanceInformationList[].InstanceId",
        ],
    );
    let output = run_aws(&args)?;
    let ids = serde_json::from_str::<Vec<String>>(&output.stdout)
        .map_err(|error| format!("Could not parse SSM capability JSON: {error}"))?;
    Ok(ids.len())
}

fn region_label(region: Option<&str>) -> &str {
    region.unwrap_or("the selected region")
}

fn classify_capability_error(error: &str) -> String {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("token has expired")
        || (normalized.contains("sso") && normalized.contains("login"))
    {
        return "AWS SSO sign-in is required.".to_string();
    }
    if normalized.contains("invalidclienttokenid")
        || normalized.contains("security token included in the request is invalid")
    {
        return "AWS credentials were issued, but this request likely used the wrong region for the selected profile.".to_string();
    }
    if normalized.contains("accessdenied") || normalized.contains("not authorized") {
        return "The profile is authenticated but missing permission for this check.".to_string();
    }
    if normalized.contains("could not connect")
        || normalized.contains("endpoint")
        || normalized.contains("network")
    {
        return "The check could not reach AWS.".to_string();
    }
    error.to_string()
}

fn parse_sso_login_result(is_success: bool, stdout: &str, stderr: &str) -> SsoLoginResult {
    let success_message = stdout
        .lines()
        .rev()
        .find(|line| line.contains(SSO_LOGIN_SUCCESS_PREFIX));

    if is_success || success_message.is_some() {
        return SsoLoginResult {
            status: SsoLoginAttemptStatus::Succeeded,
            message: "AWS SSO login completed successfully.".to_string(),
        };
    }

    let message = [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|value| !value.is_empty())
        .map(redact_message)
        .unwrap_or_else(|| "AWS SSO login failed.".to_string());

    SsoLoginResult {
        status: SsoLoginAttemptStatus::Failed,
        message,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DescribeInstancesResponse {
    reservations: Vec<Reservation>,
}

impl DescribeInstancesResponse {
    fn into_summaries(self) -> Vec<InstanceSummary> {
        self.reservations
            .into_iter()
            .flat_map(|reservation| reservation.instances)
            .map(Instance::into_summary)
            .collect()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Reservation {
    instances: Vec<Instance>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Instance {
    instance_id: String,
    #[serde(default)]
    state: Option<InstanceState>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    platform_details: Option<String>,
    #[serde(default)]
    private_ip_address: Option<String>,
    #[serde(default)]
    public_ip_address: Option<String>,
    #[serde(default)]
    vpc_id: Option<String>,
    #[serde(default)]
    subnet_id: Option<String>,
    #[serde(default)]
    launch_time: Option<String>,
    #[serde(default)]
    tags: Vec<RawTag>,
}

impl Instance {
    fn into_summary(self) -> InstanceSummary {
        let tags = self
            .tags
            .into_iter()
            .map(|tag| TagPair {
                key: tag.key,
                value: tag.value,
            })
            .collect::<Vec<_>>();
        let name = tags
            .iter()
            .find(|tag| tag.key == "Name")
            .map(|tag| tag.value.clone());
        let platform = self
            .platform
            .or(self.platform_details)
            .unwrap_or_else(|| "linux".to_string());

        InstanceSummary {
            instance_id: self.instance_id,
            name,
            state: self
                .state
                .and_then(|state| state.name)
                .unwrap_or_else(|| "unknown".to_string()),
            platform,
            private_ip: self.private_ip_address,
            public_ip: self.public_ip_address,
            vpc_id: self.vpc_id,
            subnet_id: self.subnet_id,
            launch_time: self.launch_time,
            tags,
            ssm_status: SsmStatus::Unknown,
            ssm_ping_status: None,
            agent_version: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InstanceState {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTag {
    key: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DescribeInstanceInformationResponse {
    instance_information_list: Vec<InstanceInformation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InstanceInformation {
    instance_id: String,
    ping_status: String,
    #[serde(default)]
    agent_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InstancePowerResponse {
    #[serde(default)]
    starting_instances: Vec<RawInstancePowerStateChange>,
    #[serde(default)]
    stopping_instances: Vec<RawInstancePowerStateChange>,
}

impl InstancePowerResponse {
    fn into_results(self, action: InstancePowerAction) -> Vec<InstancePowerActionResult> {
        let changes = match action {
            InstancePowerAction::Start => self.starting_instances,
            InstancePowerAction::Stop => self.stopping_instances,
        };

        changes
            .into_iter()
            .map(|change| InstancePowerActionResult {
                instance_id: change.instance_id,
                previous_state: change.previous_state.name,
                current_state: change.current_state.name,
                requested_action: action.clone(),
            })
            .collect()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawInstancePowerStateChange {
    instance_id: String,
    previous_state: RawInstanceStateName,
    current_state: RawInstanceStateName,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawInstanceStateName {
    name: String,
}

#[cfg(test)]
mod tests {
    use super::{
        build_aws_args, classify_capability_error, parse_profile_file, parse_sso_login_result,
        AwsProfileFileFormat,
    };
    use crate::models::SsoLoginAttemptStatus;

    #[test]
    fn builds_profile_region_json_args() {
        let args = build_aws_args(
            Some("dev"),
            Some("us-west-2"),
            &["ec2", "describe-instances"],
        );
        assert_eq!(
            args,
            vec![
                "ec2",
                "describe-instances",
                "--profile",
                "dev",
                "--region",
                "us-west-2",
                "--output",
                "json"
            ]
        );
    }

    #[test]
    fn parses_aws_config_profiles_without_cli() {
        let profiles = parse_profile_file(
            r#"
                [default]
                region = us-east-1

                [profile dev]
                sso_start_url = https://example.awsapps.com/start
                region = us-west-2

                [sso-session shared]
                sso_region = us-east-1
            "#,
            AwsProfileFileFormat::Config,
        );

        assert_eq!(
            profiles.get("default"),
            Some(&Some("us-east-1".to_string()))
        );
        assert_eq!(profiles.get("dev"), Some(&Some("us-west-2".to_string())));
        assert!(!profiles.contains_key("shared"));
    }

    #[test]
    fn parses_aws_credentials_profiles_without_regions() {
        let profiles = parse_profile_file(
            r#"
                [default]
                aws_access_key_id = redacted

                [prod]
                aws_secret_access_key = redacted
            "#,
            AwsProfileFileFormat::Credentials,
        );

        assert_eq!(profiles.get("default"), Some(&None));
        assert_eq!(profiles.get("prod"), Some(&None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn merges_macos_tool_path_entries_without_duplicates() {
        let path = super::merge_path_entries(
            "/usr/bin:/opt/homebrew/bin",
            &["/opt/homebrew/bin", "/usr/local/bin"],
        );
        assert_eq!(path, "/usr/bin:/opt/homebrew/bin:/usr/local/bin");
    }

    #[test]
    fn classifies_sso_errors_for_capabilities() {
        assert_eq!(
            classify_capability_error("The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login."),
            "AWS SSO sign-in is required."
        );
    }

    #[test]
    fn classifies_access_denied_for_capabilities() {
        assert_eq!(
            classify_capability_error(
                "AccessDeniedException: User is not authorized to perform this action"
            ),
            "The profile is authenticated but missing permission for this check."
        );
    }

    #[test]
    fn classifies_invalid_client_token_as_region_mismatch_hint() {
        assert_eq!(
            classify_capability_error(
                "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid"
            ),
            "AWS credentials were issued, but this request likely used the wrong region for the selected profile."
        );
    }

    #[test]
    fn builds_start_instances_args() {
        let mut args = vec![
            "ec2".to_string(),
            "start-instances".to_string(),
            "--instance-ids".to_string(),
            "i-123".to_string(),
            "i-456".to_string(),
        ];
        args.extend(build_aws_args(
            Some("sample-profile"),
            Some("us-west-2"),
            &[],
        ));
        assert_eq!(
            args,
            vec![
                "ec2",
                "start-instances",
                "--instance-ids",
                "i-123",
                "i-456",
                "--profile",
                "sample-profile",
                "--region",
                "us-west-2",
                "--output",
                "json"
            ]
        );
    }

    #[test]
    fn builds_stop_instances_args() {
        let mut args = vec![
            "ec2".to_string(),
            "stop-instances".to_string(),
            "--instance-ids".to_string(),
            "i-123".to_string(),
        ];
        args.extend(build_aws_args(
            Some("sample-profile"),
            Some("us-west-2"),
            &[],
        ));
        assert_eq!(
            args,
            vec![
                "ec2",
                "stop-instances",
                "--instance-ids",
                "i-123",
                "--profile",
                "sample-profile",
                "--region",
                "us-west-2",
                "--output",
                "json"
            ]
        );
    }

    #[test]
    fn parses_successful_sso_login_output() {
        let result = parse_sso_login_result(
            true,
            concat!(
                "Attempting browser login\n",
                "Successfully logged into ",
                "Start URL: [redacted]"
            ),
            "",
        );

        assert!(matches!(result.status, SsoLoginAttemptStatus::Succeeded));
        assert_eq!(result.message, "AWS SSO login completed successfully.");
    }

    #[test]
    fn parses_successful_sso_login_from_output_pattern_even_without_success_exit() {
        let result = parse_sso_login_result(
            false,
            concat!("Successfully logged into ", "Start URL: [redacted]"),
            "browser exited unexpectedly",
        );

        assert!(matches!(result.status, SsoLoginAttemptStatus::Succeeded));
    }

    #[test]
    fn parses_failed_sso_login_output() {
        let result =
            parse_sso_login_result(false, "", "The SSO authorization page could not be opened.");

        assert!(matches!(result.status, SsoLoginAttemptStatus::Failed));
        assert_eq!(
            result.message,
            "The SSO authorization page could not be opened."
        );
    }
}
