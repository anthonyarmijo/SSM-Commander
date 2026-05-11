use crate::models::{DiagnosticArea, DiagnosticEvent, DiagnosticSeverity};
use chrono::Utc;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const REDACTED: &str = "[redacted]";

#[derive(Clone, Default)]
pub struct Diagnostics {
    events: Arc<Mutex<Vec<DiagnosticEvent>>>,
}

impl Diagnostics {
    pub fn push(
        &self,
        severity: DiagnosticSeverity,
        area: DiagnosticArea,
        message: impl Into<String>,
        command: Option<Vec<String>>,
    ) {
        let event = DiagnosticEvent {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            severity,
            area,
            message: redact_message(&message.into()),
            command: command.map(redact_command_parts),
        };

        if let Ok(mut events) = self.events.lock() {
            events.insert(0, event);
            events.truncate(500);
        }
    }

    pub fn info(&self, area: DiagnosticArea, message: impl Into<String>) {
        self.push(DiagnosticSeverity::Info, area, message, None);
    }

    pub fn warning(&self, area: DiagnosticArea, message: impl Into<String>) {
        self.push(DiagnosticSeverity::Warning, area, message, None);
    }

    pub fn error(&self, area: DiagnosticArea, message: impl Into<String>) {
        self.push(DiagnosticSeverity::Error, area, message, None);
    }

    pub fn list(&self) -> Vec<DiagnosticEvent> {
        self.events
            .lock()
            .map(|events| events.clone())
            .unwrap_or_default()
    }
}

pub fn redact_message(input: &str) -> String {
    let mut output = input.to_string();
    for marker in [
        "AWS_ACCESS_KEY_ID=",
        "AWS_SECRET_ACCESS_KEY=",
        "AWS_SESSION_TOKEN=",
        "aws_access_key_id=",
        "aws_secret_access_key=",
        "aws_session_token=",
        "sso_start_url=",
        "sso_start_url = ",
        "SSO Start URL: ",
        "Start URL: ",
        "password=",
        "/p:",
    ] {
        let mut search_from = 0;
        while let Some(relative_start) = output[search_from..].find(marker) {
            let start = search_from + relative_start;
            let value_start = start + marker.len();
            let value_end = output[value_start..]
                .find(|ch: char| ch.is_whitespace() || ch == ',' || ch == ';')
                .map(|offset| value_start + offset)
                .unwrap_or(output.len());
            output.replace_range(value_start..value_end, REDACTED);
            search_from = value_start + REDACTED.len();
        }
    }
    output = redact_delimited_marker(&output, concat!("arn:", "aws", ":"));
    output = redact_delimited_marker(&output, concat!("arn:", "aws-us-gov", ":"));
    output = redact_awsapps_start_urls(&output);
    output = redact_aws_instance_ids(&output);
    redact_account_ids(&output)
}

fn redact_command_parts(parts: Vec<String>) -> Vec<String> {
    let mut redacted = Vec::with_capacity(parts.len());
    let mut redact_single_value = false;
    let mut redact_until_next_flag = false;

    for part in parts {
        if part.starts_with("--") {
            redact_single_value = matches!(
                part.as_str(),
                "--profile" | "--target" | "--sso-start-url" | "--resource-arn"
            );
            redact_until_next_flag = part == "--instance-ids";
            redacted.push(redact_message(&part));
            continue;
        }

        if redact_single_value || redact_until_next_flag {
            redacted.push(REDACTED.to_string());
            redact_single_value = false;
        } else {
            redacted.push(redact_message(&part));
        }
    }

    redacted
}

fn redact_delimited_marker(input: &str, marker: &str) -> String {
    let mut output = input.to_string();
    let mut search_from = 0;
    while let Some(relative_start) = output[search_from..].find(marker) {
        let start = search_from + relative_start;
        let end = find_delimited_value_end(&output, start);
        output.replace_range(start..end, REDACTED);
        search_from = start + REDACTED.len();
    }
    output
}

fn redact_awsapps_start_urls(input: &str) -> String {
    let mut output = input.to_string();
    let mut search_from = 0;
    while let Some(relative_match) = output[search_from..].find(concat!("awsapps.com", "/start")) {
        let match_start = search_from + relative_match;
        let start = output[..match_start]
            .rfind(|ch: char| {
                ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '<' || ch == '('
            })
            .map(|index| index + 1)
            .unwrap_or(0);
        let end = find_delimited_value_end(&output, match_start);
        output.replace_range(start..end, REDACTED);
        search_from = start + REDACTED.len();
    }
    output
}

fn redact_account_ids(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            let end = index;
            if end - start == 12 && is_boundary(bytes, start, end) {
                output.push_str(REDACTED);
            } else {
                output.push_str(&input[start..end]);
            }
            continue;
        }

        let ch = input[index..].chars().next().unwrap_or_default();
        output.push(ch);
        index += ch.len_utf8();
    }

    output
}

fn redact_aws_instance_ids(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'i' && bytes.get(index + 1) == Some(&b'-') {
            let start = index;
            index += 2;
            while index < bytes.len() && bytes[index].is_ascii_hexdigit() {
                index += 1;
            }
            let hex_len = index - start - 2;
            if matches!(hex_len, 8 | 17) && is_boundary(bytes, start, index) {
                output.push_str(REDACTED);
                continue;
            }
            output.push_str(&input[start..index]);
            continue;
        }

        let ch = input[index..].chars().next().unwrap_or_default();
        output.push(ch);
        index += ch.len_utf8();
    }

    output
}

fn find_delimited_value_end(input: &str, start: usize) -> usize {
    input[start..]
        .find(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    ',' | ';' | '"' | '\'' | '<' | '>' | ')' | '(' | '[' | ']'
                )
        })
        .map(|offset| start + offset)
        .unwrap_or(input.len())
}

fn is_boundary(bytes: &[u8], start: usize, end: usize) -> bool {
    let before = start
        .checked_sub(1)
        .and_then(|index| bytes.get(index))
        .copied();
    let after = bytes.get(end).copied();
    !before.map(is_identifier_byte).unwrap_or(false)
        && !after.map(is_identifier_byte).unwrap_or(false)
}

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

#[cfg(test)]
mod tests {
    use super::{redact_message, REDACTED};

    #[test]
    fn redacts_known_secret_markers() {
        let redacted = redact_message("AWS_SECRET_ACCESS_KEY=abc password=hunter2 /p:secret");
        assert!(!redacted.contains("hunter2"));
        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("secret"));
        assert!(redacted.contains(REDACTED));
    }

    #[test]
    fn redacts_aws_runtime_metadata() {
        let account = ["1234", "5678", "9012"].join("");
        let arn = format!("arn:{}:sts::{}:assumed-role/Sample/demo", "aws", account);
        let start_url = format!("https://example.{}{}", "awsapps.com", "/start");
        let instance_id = format!("i-{}", "0abc1234def567890");
        let redacted = redact_message(&format!(
            "account {account} {arn} Start URL: {start_url} instance {instance_id}",
        ));

        assert!(!redacted.contains(&account));
        assert!(!redacted.contains(&arn));
        assert!(!redacted.contains(&start_url));
        assert!(!redacted.contains(&instance_id));
        assert!(redacted.contains(REDACTED));
    }
}
