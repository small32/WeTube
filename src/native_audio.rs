//! macOS-only Core Audio control bridge. Objective-C owns the serial control queue
//! and realtime callback; the page receives state through the existing event loop.
use crate::Command;
use serde_json::Value;
use std::ffi::{CStr, CString, c_char, c_void};
use tao::event_loop::EventLoopProxy;

const GAIN_DB: f64 = 5.;

unsafe extern "C" {
    fn wetube_audio_create(
        web: *mut c_void,
        notify: extern "C" fn(*mut c_void, *const c_char),
        context: *mut c_void,
    ) -> *mut c_void;
    fn wetube_audio_update(engine: *mut c_void, enabled: bool, db: f64, request: *const c_char);
    fn wetube_audio_destroy(engine: *mut c_void);
    fn wetube_audio_shutdown(engine: *mut c_void);
}

extern "C" fn notify(context: *mut c_void, json: *const c_char) {
    // The context outlives every callback: destroy drains the native queue first.
    let proxy = unsafe { &*(context as *const EventLoopProxy<Command>) };
    let text = unsafe { CStr::from_ptr(json) }.to_bytes();
    if let Ok(payload) = serde_json::from_slice::<Value>(text) {
        let _ = proxy.send_event(Command::NativeAudioEvent(payload));
    }
}

pub struct NativeAudio {
    engine: *mut c_void,
    proxy: Box<EventLoopProxy<Command>>,
}

impl NativeAudio {
    pub fn new(web: *mut c_void, proxy: EventLoopProxy<Command>) -> Self {
        let mut proxy = Box::new(proxy);
        let context = (&mut *proxy as *mut EventLoopProxy<Command>).cast();
        let engine = unsafe { wetube_audio_create(web, notify, context) };
        Self { engine, proxy }
    }

    pub fn set(&self, payload: &Value) {
        let Some((enabled, db, request)) = parse_request(payload) else {
            return;
        };
        if let Ok(request) = CString::new(request) {
            unsafe {
                wetube_audio_update(self.engine, enabled, db, request.as_ptr());
            }
        }
    }

    pub fn stop(&self) {
        let request = c"";
        unsafe {
            wetube_audio_update(self.engine, false, 0., request.as_ptr());
        }
    }

    pub fn shutdown(&self) {
        unsafe {
            wetube_audio_shutdown(self.engine);
        }
    }
}

impl Drop for NativeAudio {
    fn drop(&mut self) {
        unsafe {
            wetube_audio_destroy(self.engine);
        }
        // Keep this box alive until the native serial queue has drained.
        let _ = &self.proxy;
    }
}

fn parse_request(payload: &Value) -> Option<(bool, f64, &str)> {
    let enabled = payload.get("enabled")?.as_bool()?;
    let db = payload.get("amount")?.as_f64()?;
    let request = payload.get("request")?.as_str()?;
    if !db.is_finite()
        || !(0.0..=20.0).contains(&db)
        || request.is_empty()
        || request.len() > 160
        || request.contains('\0')
    {
        return None;
    }
    // The player button only toggles boost; persisted or incoming gain values
    // cannot change the fixed application gain.
    Some((enabled, GAIN_DB, request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_invalid_native_audio_requests() {
        for payload in [
            json!({"enabled":true,"amount":21,"request":"page-1"}),
            json!({"enabled":true,"amount":-1,"request":"page-1"}),
            json!({"enabled":"true","amount":5,"request":"page-1"}),
            json!({"enabled":true,"amount":5,"request":""}),
            json!({"enabled":true,"amount":5,"request":"a\0b"}),
            json!({"enabled":true,"amount":5,"request":"x".repeat(161)}),
        ] {
            assert!(parse_request(&payload).is_none());
        }
        assert_eq!(
            parse_request(&json!({"enabled":true,"amount":5,"request":"page-1"})),
            Some((true, 5., "page-1"))
        );
        assert_eq!(
            parse_request(&json!({"enabled":true,"amount":20,"request":"page-1"})),
            Some((true, 5., "page-1"))
        );
    }
}
