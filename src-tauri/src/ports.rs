use std::net::TcpListener;

pub fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn choose_local_port(requested: Option<u16>) -> Result<(u16, bool), String> {
    if let Some(port) = requested {
        if port == 0 {
            return Err("Local port must be between 1 and 65535".to_string());
        }
        if is_port_available(port) {
            return Ok((port, true));
        }
        return Err(format!("Local port {port} is already in use"));
    }

    for port in 54000..55000 {
        if is_port_available(port) {
            return Ok((port, false));
        }
    }

    Err("Could not find an available local port in 54000-54999".to_string())
}

#[cfg(test)]
mod tests {
    use super::{choose_local_port, is_port_available};
    use std::net::TcpListener;

    #[test]
    fn rejects_ports_that_are_in_use() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test port");
        let port = listener.local_addr().expect("local addr").port();
        assert!(!is_port_available(port));
        assert!(choose_local_port(Some(port)).is_err());
    }
}
