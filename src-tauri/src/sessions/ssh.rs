use crate::models::PortForwardRequest;

pub fn request(
    profile: &str,
    region: &str,
    instance_id: &str,
    local_port: Option<u16>,
) -> PortForwardRequest {
    PortForwardRequest {
        profile: profile.to_string(),
        region: region.to_string(),
        instance_id: instance_id.to_string(),
        remote_port: 22,
        local_port,
        remote_host: None,
    }
}
