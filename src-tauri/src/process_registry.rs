use crate::diagnostics::Diagnostics;
use crate::models::{DiagnosticArea, DiagnosticSeverity, SessionRecord, SessionStatus};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::thread;

pub struct ManagedProcess {
    child: Option<Child>,
    record: SessionRecord,
}

#[derive(Default)]
pub struct ProcessRegistry {
    sessions: HashMap<String, ManagedProcess>,
}

impl ProcessRegistry {
    pub fn start_process(
        &mut self,
        command: &str,
        args: &[String],
        mut record: SessionRecord,
        diagnostics: &Diagnostics,
    ) -> Result<SessionRecord, String> {
        let mut child = Command::new(command)
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start {command}: {error}"))?;

        record.process_id = Some(child.id());
        record.status = SessionStatus::Active;

        if let Some(stdout) = child.stdout.take() {
            let diagnostics = diagnostics.clone();
            let session_id = record.id.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    diagnostics.push(
                        DiagnosticSeverity::Info,
                        DiagnosticArea::Process,
                        format!("{session_id}: {line}"),
                        None,
                    );
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let diagnostics = diagnostics.clone();
            let session_id = record.id.clone();
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    diagnostics.push(
                        DiagnosticSeverity::Warning,
                        DiagnosticArea::Process,
                        format!("{session_id}: {line}"),
                        None,
                    );
                }
            });
        }

        self.sessions.insert(
            record.id.clone(),
            ManagedProcess {
                child: Some(child),
                record: record.clone(),
            },
        );
        diagnostics.info(
            DiagnosticArea::Process,
            format!("Started session {}", record.id),
        );
        Ok(record)
    }

    pub fn record_external(
        &mut self,
        mut record: SessionRecord,
        diagnostics: &Diagnostics,
    ) -> SessionRecord {
        record.status = SessionStatus::Active;
        self.sessions.insert(
            record.id.clone(),
            ManagedProcess {
                child: None,
                record: record.clone(),
            },
        );
        diagnostics.info(
            DiagnosticArea::Launcher,
            format!("Recorded external session {}", record.id),
        );
        record
    }

    pub fn stop_session(
        &mut self,
        session_id: &str,
        diagnostics: &Diagnostics,
    ) -> Result<SessionRecord, String> {
        let mut managed = self
            .sessions
            .remove(session_id)
            .ok_or_else(|| format!("No active session found for {session_id}"))?;

        managed.record.status = SessionStatus::Stopping;

        if let Some(mut child) = managed.child.take() {
            match child.kill() {
                Ok(()) => {
                    let _ = child.wait();
                    managed.record.status = SessionStatus::Stopped;
                    diagnostics.info(
                        DiagnosticArea::Process,
                        format!("Stopped session {session_id}"),
                    );
                }
                Err(error) => {
                    managed.record.status = SessionStatus::Failed;
                    diagnostics.error(
                        DiagnosticArea::Process,
                        format!("Could not stop session {session_id}: {error}"),
                    );
                }
            }
        } else {
            managed.record.status = SessionStatus::Stopped;
            diagnostics.warning(
                DiagnosticArea::Launcher,
                format!("Session {session_id} was launched in an external terminal or client; close that client if it is still open."),
            );
        }

        Ok(managed.record)
    }

    pub fn list_active_sessions(&mut self) -> Vec<SessionRecord> {
        let mut finished = Vec::new();
        for (id, managed) in &mut self.sessions {
            if let Some(child) = &mut managed.child {
                if let Ok(Some(status)) = child.try_wait() {
                    managed.record.status = if status.success() {
                        SessionStatus::Stopped
                    } else {
                        SessionStatus::Failed
                    };
                    finished.push(id.clone());
                }
            }
        }

        for id in finished {
            self.sessions.remove(&id);
        }

        self.sessions
            .values()
            .map(|managed| managed.record.clone())
            .collect()
    }

    pub fn stop_all(&mut self, diagnostics: &Diagnostics) {
        let ids = self.sessions.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let _ = self.stop_session(&id, diagnostics);
        }
    }
}
