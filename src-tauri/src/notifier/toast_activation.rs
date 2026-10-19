//! Current-user COM activation keeps a task click routable after the service restarts.
use super::{Notification, NotificationResponse, ResponseSink};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use windows::core::{implement, IUnknown, Interface, GUID, PCWSTR};
use windows::Win32::{
    Foundation::{CLASS_E_NOAGGREGATION, E_POINTER},
    System::Com::{
        CoRegisterClassObject, CoRevokeClassObject, IClassFactory, IClassFactory_Impl,
        CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE,
    },
    UI::Notifications::{
        INotificationActivationCallback, INotificationActivationCallback_Impl,
        NOTIFICATION_USER_INPUT_DATA,
    },
};

const PREFIX: &str = "deskmate:";

pub fn encode(notification: &Notification, action_id: Option<&str>) -> String {
    let response = NotificationResponse {
        tag: notification.tag.clone(),
        action_id: action_id.map(str::to_owned),
        payload: notification.payload.clone(),
    };
    format!(
        "{PREFIX}{}",
        URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&response).expect("serialize notification activation"))
    )
}

pub fn decode(value: &str) -> Option<NotificationResponse> {
    if value.len() > 32 * 1024 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(value.strip_prefix(PREFIX)?).ok()?;
    let response: NotificationResponse = serde_json::from_slice(&bytes).ok()?;
    if response.tag.is_empty() || response.tag.len() > 1024 {
        return None;
    }
    Some(response)
}

pub fn clsid() -> GUID {
    if atlas_profile::current().is_dev() {
        GUID::from_u128(0x2d9c28a6_b233_4bbd_aaf5_8f068a66830e)
    } else {
        GUID::from_u128(0xb0b9fb3a_1600_4baf_980e_184b1e7ce460)
    }
}

pub fn register(profile: &str, executable: &std::path::Path) -> Result<(), String> {
    use windows::{
        core::HSTRING,
        Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ},
    };
    let class = format!("Software\\Classes\\CLSID\\{{{:?}}}\\LocalServer32", clsid());
    let app_id = format!("Software\\Classes\\AppUserModelId\\{profile}");
    let values = [
        (
            class,
            "",
            format!("\"{}\" --background-service", executable.display()),
        ),
        (app_id, "CustomActivator", format!("{{{:?}}}", clsid())),
    ];
    for (key, name, value) in values {
        let data: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(key),
                &HSTRING::from(name),
                REG_SZ.0,
                Some(data.as_ptr().cast()),
                (data.len() * 2) as u32,
            )
        }
        .ok()
        .map_err(|e| format!("Notification activation registration failed: {e}"))?;
    }
    Ok(())
}

pub fn unregister(profile: &str) -> Result<(), String> {
    use windows::{
        core::HSTRING,
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND},
            System::Registry::{RegDeleteKeyValueW, RegDeleteTreeW, HKEY_CURRENT_USER},
        },
    };
    let app_id = HSTRING::from(format!("Software\\Classes\\AppUserModelId\\{profile}"));
    let class = HSTRING::from(format!("Software\\Classes\\CLSID\\{{{:?}}}", clsid()));
    for result in [
        unsafe {
            RegDeleteKeyValueW(
                HKEY_CURRENT_USER,
                &app_id,
                windows::core::w!("CustomActivator"),
            )
        },
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &class) },
    ] {
        if result != ERROR_FILE_NOT_FOUND && result != ERROR_PATH_NOT_FOUND {
            result
                .ok()
                .map_err(|e| format!("Notification activation cleanup failed: {e}"))?;
        }
    }
    Ok(())
}

#[implement(INotificationActivationCallback)]
struct Activator {
    sink: ResponseSink,
}
impl INotificationActivationCallback_Impl for Activator_Impl {
    fn Activate(
        &self,
        _: &PCWSTR,
        arguments: &PCWSTR,
        _: *const NOTIFICATION_USER_INPUT_DATA,
        _: u32,
    ) -> windows::core::Result<()> {
        if !arguments.is_null() {
            // COM owns this null-terminated argument for the duration of Activate.
            let value = unsafe { arguments.to_string()? };
            if let Some(response) = decode(&value) {
                (self.sink)(response);
            }
        }
        Ok(())
    }
}

#[implement(IClassFactory)]
struct Factory {
    sink: ResponseSink,
}
impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: windows::core::Ref<'_, IUnknown>,
        iid: *const GUID,
        output: *mut *mut core::ffi::c_void,
    ) -> windows::core::Result<()> {
        if outer.as_ref().is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        if iid.is_null() || output.is_null() {
            return Err(E_POINTER.into());
        }
        let callback: INotificationActivationCallback = Activator {
            sink: self.sink.clone(),
        }
        .into();
        unsafe { callback.query(iid, output).ok() }
    }
    fn LockServer(&self, _: windows::core::BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}

pub struct Registration(u32);
impl Registration {
    pub fn new(sink: ResponseSink) -> Result<Self, String> {
        let factory: IClassFactory = Factory { sink }.into();
        unsafe {
            CoRegisterClassObject(&clsid(), &factory, CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE)
        }
        .map(Self)
        .map_err(|e| e.to_string())
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Err(error) = unsafe { CoRevokeClassObject(self.0) } {
            tracing::warn!("notification activator cleanup failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_activation_preserves_unicode_target_and_action_and_rejects_bad_arguments() {
        let note: Notification = serde_json::from_value(serde_json::json!({"tag":"task:1","group":"task","title":"提醒","body":"房租","payload":"{\"v\":1,\"target\":{\"type\":\"task\",\"taskId\":\"1\"}}"})).unwrap();
        let response = decode(&encode(&note, Some("confirm"))).unwrap();
        assert_eq!(response.payload, note.payload);
        assert_eq!(response.action_id.as_deref(), Some("confirm"));
        assert!(decode("open").is_none());
        assert!(decode("deskmate:!!!").is_none());
    }
}
