use crate::models::{
    PortAllocationSource, PortForwardRequest, SessionKind, SessionRecord, SessionStatus,
    TunnelListenerStatus, TunnelRecord,
};
use chrono::Utc;
use uuid::Uuid;

pub fn build_port_forward_args(request: &PortForwardRequest, local_port: u16) -> Vec<String> {
    let (document, parameters) = if let Some(remote_host) = request
        .remote_host
        .as_ref()
        .filter(|host| !host.trim().is_empty())
    {
        (
            "AWS-StartPortForwardingSessionToRemoteHost",
            serde_json::json!({
                "host": [remote_host],
                "portNumber": [request.remote_port.to_string()],
                "localPortNumber": [local_port.to_string()]
            }),
        )
    } else {
        (
            "AWS-StartPortForwardingSession",
            serde_json::json!({
                "portNumber": [request.remote_port.to_string()],
                "localPortNumber": [local_port.to_string()]
            }),
        )
    };

    vec![
        "ssm".to_string(),
        "start-session".to_string(),
        "--target".to_string(),
        request.instance_id.clone(),
        "--document-name".to_string(),
        document.to_string(),
        "--parameters".to_string(),
        parameters.to_string(),
        "--profile".to_string(),
        request.profile.clone(),
        "--region".to_string(),
        request.region.clone(),
    ]
}

pub fn build_shell_args(profile: &str, region: &str, instance_id: &str) -> Vec<String> {
    vec![
        "aws".to_string(),
        "ssm".to_string(),
        "start-session".to_string(),
        "--target".to_string(),
        instance_id.to_string(),
        "--profile".to_string(),
        profile.to_string(),
        "--region".to_string(),
        region.to_string(),
    ]
}

pub fn session_record(
    kind: SessionKind,
    request: &PortForwardRequest,
    local_port: u16,
    allocation_requested: bool,
) -> SessionRecord {
    let id = Uuid::new_v4().to_string();
    let tunnel = TunnelRecord {
        local_port,
        remote_host: request.remote_host.clone(),
        remote_port: request.remote_port,
        allocation: if allocation_requested {
            PortAllocationSource::Requested
        } else {
            PortAllocationSource::Auto
        },
        listener_status: TunnelListenerStatus::Starting,
        session_id: id.clone(),
    };

    SessionRecord {
        id,
        kind,
        profile: request.profile.clone(),
        region: request.region.clone(),
        instance_id: request.instance_id.clone(),
        process_id: None,
        started_at: Utc::now().to_rfc3339(),
        status: SessionStatus::Starting,
        tunnel: Some(tunnel),
        note: None,
    }
}

pub fn external_shell_record(profile: &str, region: &str, instance_id: &str) -> SessionRecord {
    SessionRecord {
        id: Uuid::new_v4().to_string(),
        kind: SessionKind::Shell,
        profile: profile.to_string(),
        region: region.to_string(),
        instance_id: instance_id.to_string(),
        process_id: None,
        started_at: Utc::now().to_rfc3339(),
        status: SessionStatus::Starting,
        tunnel: None,
        note: Some("Launched in an external terminal.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::build_port_forward_args;
    use crate::models::PortForwardRequest;

    #[test]
    fn builds_port_forward_args_without_shell_quoting() {
        let args = build_port_forward_args(
            &PortForwardRequest {
                profile: "dev".to_string(),
                region: "us-west-2".to_string(),
                instance_id: "i-123".to_string(),
                remote_port: 3389,
                local_port: None,
                remote_host: None,
            },
            54001,
        );

        assert!(args.contains(&"AWS-StartPortForwardingSession".to_string()));
        assert!(
            args.contains(&r#"{"localPortNumber":["54001"],"portNumber":["3389"]}"#.to_string())
        );
    }
}
