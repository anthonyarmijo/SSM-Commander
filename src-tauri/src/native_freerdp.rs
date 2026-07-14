//! macOS-native FreeRDP embedding for the RDP console workspace.
//!
//! The HTML console area remains responsible for layout.  On macOS we place the upstream
//! FreeRDP `MRDPView` above the WKWebView at that exact rectangle, which keeps the Windows
//! PC/SC smart-card channel local to the user's machine instead of trying to tunnel a USB
//! device through a browser renderer.

#[cfg(target_os = "macos")]
mod macos {
    use serde::Serialize;
    use std::collections::HashMap;
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_void};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, WebviewWindow};

    #[repr(C)]
    struct SsmFreerdpSession {
        _private: [u8; 0],
    }

    unsafe extern "C" {
        fn ssm_freerdp_create(
            parent_view: *mut c_void,
            host: *const c_char,
            port: u16,
            username: *const c_char,
            password: *const c_char,
            security_mode: *const c_char,
            share_smartcard: bool,
            desktop_width: u32,
            desktop_height: u32,
            error_message: *mut *mut c_char,
        ) -> *mut SsmFreerdpSession;
        fn ssm_freerdp_set_frame(
            session: *mut SsmFreerdpSession,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            visible: bool,
        );
        fn ssm_freerdp_connection_state(session: *mut SsmFreerdpSession) -> i32;
        fn ssm_freerdp_connection_error(session: *mut SsmFreerdpSession) -> *const c_char;
        fn ssm_freerdp_smartcard_reader_count() -> i32;
        fn ssm_freerdp_destroy(session: *mut SsmFreerdpSession);
        fn ssm_freerdp_free_string(value: *mut c_char);
    }

    #[derive(Clone)]
    pub struct NativeRdpConfig {
        pub host: String,
        pub port: u16,
        pub username: Option<String>,
        pub password: Option<String>,
        pub security_mode: Option<String>,
        pub share_smartcard: bool,
        pub desktop_width: u32,
        pub desktop_height: u32,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct NativeRdpConnectionStatus {
        pub state: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub error: Option<String>,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct NativeSmartcardStatus {
        pub reader_count: i32,
        pub available: bool,
    }

    struct Session(*mut SsmFreerdpSession);
    unsafe impl Send for Session {}

    #[derive(Default)]
    pub struct NativeRdpManager {
        sessions: std::sync::Mutex<HashMap<String, (NativeRdpConfig, Option<Session>)>>,
    }

    impl NativeRdpManager {
        pub fn register(&self, session_id: String, config: NativeRdpConfig) {
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.insert(session_id, (config, None));
            }
        }

        pub fn mount(
            &self,
            window: WebviewWindow,
            session_id: &str,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
            visible: bool,
        ) -> Result<(), String> {
            let parent_view = window.ns_view().map_err(|error| error.to_string())? as usize;
            // ResizeObserver can queue several IPC calls before an earlier call
            // returns. Keep this lock through the UI-thread round trip so only
            // one call can take/create the native session at a time.
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Native RDP sessions are unavailable".to_string())?;
            let (config, existing) = sessions
                .get_mut(session_id)
                .ok_or_else(|| format!("No native RDP session found for {session_id}"))
                .map(|(config, session)| (config.clone(), session.take()))?;
            let (sender, receiver) = mpsc::sync_channel(1);
            window
                .run_on_main_thread(move || {
                    let result: Result<Session, String> = (|| unsafe {
                        let session = match existing {
                            Some(session) => session.0,
                            None => create_session(parent_view as *mut c_void, &config)?,
                        };
                        ssm_freerdp_set_frame(session, x, y, width, height, visible);
                        Ok(Session(session))
                    })();
                    let _ = sender.send(result);
                })
                .map_err(|error| error.to_string())?;
            let session = receiver
                .recv_timeout(Duration::from_secs(20))
                .map_err(|_| "Timed out while mounting the native RDP display.".to_string())??;
            sessions
                .get_mut(session_id)
                .expect("native RDP session was removed while its manager lock was held")
                .1 = Some(session);
            Ok(())
        }

        pub fn remove(&self, app: &AppHandle, session_id: &str) {
            let session = self.sessions.lock().ok().and_then(|mut sessions| {
                sessions.remove(session_id).and_then(|(_, session)| session)
            });
            if let Some(session) = session {
                self.destroy_on_main_thread(app, session);
            }
        }

        pub fn connection_status(
            &self,
            window: WebviewWindow,
            session_id: &str,
        ) -> Result<NativeRdpConnectionStatus, String> {
            // Keep the session registry locked through the main-thread read so
            // stop_console_session cannot free the native pointer underneath it.
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Native RDP sessions are unavailable".to_string())?;
            let session = sessions
                .get(session_id)
                .and_then(|(_, session)| session.as_ref())
                .map(|session| session.0 as usize)
                .ok_or_else(|| format!("No mounted native RDP session found for {session_id}"))?;
            let (sender, receiver) = mpsc::sync_channel(1);
            window
                .run_on_main_thread(move || {
                    let (state, error) = unsafe {
                        let state =
                            match ssm_freerdp_connection_state(session as *mut SsmFreerdpSession) {
                                1 => "connected",
                                0 => "connecting",
                                _ => "disconnected",
                            };
                        let error = if state == "disconnected" {
                            let error =
                                ssm_freerdp_connection_error(session as *mut SsmFreerdpSession);
                            (!error.is_null())
                                .then(|| CStr::from_ptr(error).to_string_lossy().into_owned())
                        } else {
                            None
                        };
                        (state, error)
                    };
                    let _ = sender.send((state, error));
                })
                .map_err(|error| error.to_string())?;
            let (state, error) = receiver.recv_timeout(Duration::from_secs(2)).map_err(|_| {
                "Timed out while reading the native RDP connection state.".to_string()
            })?;
            Ok(NativeRdpConnectionStatus { state, error })
        }

        pub fn smartcard_status(&self) -> NativeSmartcardStatus {
            let reader_count = unsafe { ssm_freerdp_smartcard_reader_count() };
            NativeSmartcardStatus {
                reader_count,
                available: reader_count > 0,
            }
        }

        pub fn clear(&self, app: &AppHandle) {
            let sessions = self
                .sessions
                .lock()
                .map(|mut entries| {
                    entries
                        .drain()
                        .filter_map(|(_, (_, session))| session)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for session in sessions {
                self.destroy_on_main_thread(app, session);
            }
        }

        fn destroy_on_main_thread(&self, app: &AppHandle, session: Session) {
            let pointer = session.0 as usize;
            let _ = app.run_on_main_thread(move || unsafe {
                ssm_freerdp_destroy(pointer as *mut SsmFreerdpSession)
            });
        }
    }

    unsafe fn create_session(
        parent_view: *mut c_void,
        config: &NativeRdpConfig,
    ) -> Result<*mut SsmFreerdpSession, String> {
        let host = c_string(&config.host)?;
        let username = c_string(config.username.as_deref().unwrap_or(""))?;
        let password = c_string(config.password.as_deref().unwrap_or(""))?;
        let security_mode = c_string(config.security_mode.as_deref().unwrap_or("auto"))?;
        let mut error_message = std::ptr::null_mut();
        let session = ssm_freerdp_create(
            parent_view,
            host.as_ptr(),
            config.port,
            username.as_ptr(),
            password.as_ptr(),
            security_mode.as_ptr(),
            config.share_smartcard,
            config.desktop_width,
            config.desktop_height,
            &mut error_message,
        );
        if session.is_null() {
            let error = if error_message.is_null() {
                "Could not create the embedded FreeRDP session.".to_string()
            } else {
                CStr::from_ptr(error_message).to_string_lossy().into_owned()
            };
            if !error_message.is_null() {
                ssm_freerdp_free_string(error_message);
            }
            return Err(error);
        }
        Ok(session)
    }

    fn c_string(value: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| "RDP settings cannot contain a NUL character.".to_string())
    }
}

#[cfg(target_os = "macos")]
pub use macos::{
    NativeRdpConfig, NativeRdpConnectionStatus, NativeRdpManager, NativeSmartcardStatus,
};

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct NativeRdpManager;

#[cfg(not(target_os = "macos"))]
impl NativeRdpManager {
    pub fn remove(&self, _app: &tauri::AppHandle, _session_id: &str) {}

    pub fn clear(&self, _app: &tauri::AppHandle) {}
}

#[cfg(not(target_os = "macos"))]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRdpConnectionStatus {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(not(target_os = "macos"))]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSmartcardStatus {
    pub reader_count: i32,
    pub available: bool,
}
