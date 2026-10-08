//! App-level bootstrap channel. It carries no CDP or model credentials.
use crate::browser_native::{self, Descriptor, MAX_MESSAGE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, Notify},
};

async fn read_message<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    bytes: &mut Vec<u8>,
) -> Result<Option<Value>, String> {
    use tokio::io::AsyncReadExt;
    let remaining = MAX_MESSAGE.saturating_sub(bytes.len()) + 1;
    let count = (&mut *reader)
        .take(remaining as u64)
        .read_until(b'\n', bytes)
        .await
        .map_err(|e| e.to_string())?;
    if count == 0 && bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_MESSAGE || !bytes.ends_with(b"\n") {
        return Err("Invalid native broker message length".into());
    }
    let result = serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|_| "Invalid native broker JSON".into());
    bytes.clear();
    result
}

fn validate_identity(secret: &str, hello: &Value) -> Result<Binding, String> {
    if hello["secret"].as_str() != Some(secret) {
        return Err("Invalid native host authentication".into());
    }
    let client_id = hello["clientId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("Invalid browser profile identity")?
        .to_owned();
    let browser = hello["browser"]
        .as_str()
        .filter(|b| ["chrome", "edge"].contains(b))
        .ok_or("Unsupported browser")?
        .to_owned();
    Ok(Binding { client_id, browser })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    client_id: String,
    browser: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    paused: bool,
    browser: Option<String>,
}
impl Preferences {
    fn load(path: &std::path::Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let preferences: Self =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|_| "Invalid browser control preferences")?;
        if preferences
            .browser
            .as_deref()
            .is_some_and(|browser| !["chrome", "edge"].contains(&browser))
        {
            return Err("Unsupported selected browser in browser control preferences".into());
        }
        Ok(preferences)
    }
    fn save(&self, path: &std::path::Path) -> Result<(), String> {
        browser_native::write_private(
            path,
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )
    }
}
struct Client {
    generation: String,
    sender: mpsc::Sender<Value>,
    version: Option<String>,
}
pub struct BrowserBridge {
    app: AppHandle,
    secret: String,
    binding: parking_lot::Mutex<Option<Binding>>,
    client: parking_lot::Mutex<Option<Client>>,
    pending: parking_lot::Mutex<HashMap<String, oneshot::Sender<Value>>>,
    error: parking_lot::Mutex<Option<String>>,
    ready: Notify,
    preferences: parking_lot::Mutex<Preferences>,
}
impl BrowserBridge {
    pub fn new(app: &AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app: app.clone(),
            secret: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            binding: Default::default(),
            client: Default::default(),
            pending: Default::default(),
            error: Default::default(),
            ready: Notify::new(),
            preferences: Default::default(),
        })
    }
    fn binding_path(&self) -> Result<PathBuf, String> {
        Ok(
            browser_native::descriptor_path(&self.app.config().identifier)?
                .with_file_name("browser-profile-binding.json"),
        )
    }
    fn changed(&self) {
        let _ = self.app.emit("atlas:browser-use-changed", ());
    }
    pub fn report_error(&self, error: &str) {
        *self.error.lock() = Some(error.into());
        self.changed();
    }
    pub fn snapshot(&self) -> Value {
        let connected = self.client.lock().is_some();
        let browser = self.binding.lock().as_ref().map(|b| b.browser.clone());
        let error = self.error.lock().clone();
        let version = self.client.lock().as_ref().and_then(|c| c.version.clone());
        let selected = self.preferences.lock().browser.clone();
        json!({"connected":connected,"browser":browser,"selectedBrowser":selected,"version":version,"hostName":browser_native::host_name(),"error":error,
            "browsers":[{"id":"chrome","available":browser_executable("chrome").is_some(),"storeInstall":!atlas_profile::is_dev()},{"id":"edge","available":browser_executable("edge").is_some(),"storeInstall":!atlas_profile::is_dev()}]})
    }
    fn preferences_path(&self) -> Result<PathBuf, String> {
        Ok(self
            .binding_path()?
            .with_file_name("browser-control-preferences.json"))
    }
    pub fn paused(&self) -> bool {
        self.preferences.lock().paused
    }
    pub fn set_paused(&self, paused: bool) -> Result<(), String> {
        let mut preferences = self.preferences.lock();
        let next = Preferences {
            paused,
            browser: preferences.browser.clone(),
        };
        next.save(&self.preferences_path()?)?;
        *preferences = next;
        self.changed();
        Ok(())
    }
    pub fn extension_path(&self) -> Result<PathBuf, String> {
        Ok(self.binding_path()?.with_file_name("browser-extension"))
    }
    pub fn prepare_extension(&self, source: &std::path::Path) -> Result<(), String> {
        let destination = self.extension_path()?;
        for name in [
            "manifest.json",
            "background.js",
            "controller.js",
            "native-connection.js",
            "popup.html",
            "popup.css",
            "popup.js",
            "icons/icon-16.png",
            "icons/icon-32.png",
            "icons/icon-48.png",
            "icons/icon-128.png",
            "icons/icon.svg",
        ] {
            let target = destination.join(name);
            std::fs::create_dir_all(target.parent().ok_or("Missing extension directory")?)
                .map_err(|e| e.to_string())?;
            std::fs::copy(source.join(name), target)
                .map_err(|e| format!("Could not prepare Atlas Browser {name}: {e}"))?;
        }
        std::fs::write(
            destination.join("config.js"),
            format!(
                "export const HOST_NAME = {:?};\nexport const APP_NAME = {:?};\n",
                browser_native::host_name(),
                atlas_profile::current().product_name()
            ),
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn start(self: &Arc<Self>) {
        if let Err(error) = self.listen() {
            *self.error.lock() = Some(error);
            self.changed();
        }
    }
    fn listen(self: &Arc<Self>) -> Result<(), String> {
        *self.preferences.lock() = Preferences::load(&self.preferences_path()?)?;
        let path = self.binding_path()?;
        if path.exists() {
            let binding = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|_| "Invalid browser profile binding")?;
            *self.binding.lock() = Some(binding);
        }
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let descriptor = Descriptor {
            address: listener.local_addr().map_err(|e| e.to_string())?,
            secret: self.secret.clone(),
        };
        browser_native::write_private(
            &browser_native::descriptor_path(&self.app.config().identifier)?,
            &serde_json::to_value(descriptor).map_err(|e| e.to_string())?,
        )?;
        self.register()?;
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                return;
            };
            while let Ok((stream, _)) = listener.accept().await {
                let state = state.clone();
                tokio::spawn(async move {
                    let _ = state.serve(stream).await;
                });
            }
        });
        Ok(())
    }
    async fn serve(self: Arc<Self>, stream: tokio::net::TcpStream) -> Result<(), String> {
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut bytes = Vec::new();
        let hello = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            read_message(&mut reader, &mut bytes),
        )
        .await
        .map_err(|_| "Native handshake timed out")??
        .ok_or("Missing handshake")?;
        let selected = validate_identity(&self.secret, &hello)?;
        let version = hello["version"]
            .as_str()
            .filter(|v| v.len() <= 64)
            .map(str::to_owned);
        let (sender, mut messages) = mpsc::channel(16);
        let generation = uuid::Uuid::new_v4().to_string();
        let admission: Result<(), String> = (|| {
            let mut binding = self.binding.lock();
            let mut client = self.client.lock();
            if self
                .preferences
                .lock()
                .browser
                .as_ref()
                .is_some_and(|browser| browser != &selected.browser)
            {
                return Err(
                    "Another browser is selected in Atlas Settings > Browser control".into(),
                );
            }
            if binding
                .as_ref()
                .is_some_and(|bound| bound.client_id != selected.client_id)
            {
                return Err("Another browser profile is selected. Forget it in Atlas Settings > Browser control first.".into());
            }
            if client.is_some() {
                return Err("This browser profile is already connected".into());
            }
            browser_native::write_private(
                &self.binding_path()?,
                &serde_json::to_value(&selected).map_err(|e| e.to_string())?,
            )?;
            *binding = Some(selected);
            *client = Some(Client {
                generation: generation.clone(),
                sender,
                version,
            });
            *self.error.lock() = None;
            Ok(())
        })();
        if let Err(error) = admission {
            write
                .write_all(format!("{}\n", json!({"type":"error","error":error})).as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        self.ready.notify_waiters();
        self.changed();
        let result: Result<(), String> = async {
            write.write_all(b"{\"type\":\"bridgeReady\"}\n").await.map_err(|e|e.to_string())?;
            loop {
                tokio::select! {
                    message = messages.recv() => {
                        let Some(message) = message else { break; };
                        write.write_all(format!("{message}\n").as_bytes()).await.map_err(|e|e.to_string())?;
                        if message["type"] == "unbound" { break; }
                    },
                    message = read_message(&mut reader, &mut bytes) => {
                        let Some(message) = message? else { break; };
                        if let Some(id) = message["id"].as_str() {
                            if let Some(answer) = self.pending.lock().remove(id) { let _ = answer.send(message); }
                        }
                    }
                }
            }
            Ok(())
        }.await;
        if self
            .client
            .lock()
            .as_ref()
            .is_some_and(|c| c.generation == generation)
        {
            self.client.lock().take();
            self.pending.lock().clear();
            self.changed();
        }
        result
    }
    pub async fn open_task(
        &self,
        endpoint: &str,
        title: &str,
        session_id: &str,
    ) -> Result<(), String> {
        let sender = self
            .client
            .lock()
            .as_ref()
            .map(|client| client.sender.clone());
        let sender = if let Some(sender) = sender {
            sender
        } else {
            let browser = self
                .binding
                .lock()
                .as_ref()
                .map(|bound| bound.browser.clone())
                .ok_or("Install Atlas Browser from Settings > Browser control first")?;
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            self.launch_browser(&browser, None)?;
            tokio::time::timeout(std::time::Duration::from_secs(35), ready).await.map_err(|_|"The selected browser profile is offline. Open that profile and enable Atlas Browser.")?;
            self.client
                .lock()
                .as_ref()
                .map(|client| client.sender.clone())
                .ok_or("Browser profile disconnected")?
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (answer, result) = oneshot::channel();
        self.pending.lock().insert(id.clone(), answer);
        let outcome = async {
            sender
                .send(json!({"id":id,"type":"start","endpoint":endpoint,"title":title,"sessionId":session_id}))
                .await
                .map_err(|_| "Browser profile disconnected")?;
            let value = tokio::time::timeout(std::time::Duration::from_secs(20), result)
                .await
                .map_err(|_| "Browser task connection timed out")?
                .map_err(|_| "Browser profile disconnected")?;
            if let Some(error) = value["error"].as_str() {
                return Err(error.to_owned());
            }
            Ok(())
        }
        .await;
        self.pending.lock().remove(&id);
        if outcome.is_ok() {
            *self.error.lock() = None;
            self.changed();
        }
        outcome
    }
    fn launch_browser(&self, browser: &str, url: Option<String>) -> Result<(), String> {
        // Ordinary browser startup: no automation flags, profile copies or CDP port.
        #[cfg(windows)]
        {
            let executable =
                browser_executable(browser).ok_or("Selected browser executable is missing")?;
            let mut command = atlas_process::command(executable);
            if let Some(url) = url {
                command.arg(url);
            }
            command.spawn().map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "macos")]
        {
            let mut command = atlas_process::command("open");
            command.args([
                "-a",
                if browser == "edge" {
                    "Microsoft Edge"
                } else {
                    "Google Chrome"
                },
            ]);
            if let Some(url) = url {
                command.arg(url);
            }
            command.spawn().map_err(|e| e.to_string())?;
        }
        #[cfg(target_os = "linux")]
        {
            let executable =
                browser_executable(browser).ok_or("Selected browser executable is missing")?;
            let mut command = atlas_process::command(executable);
            if let Some(url) = url {
                command.arg(url);
            }
            command.spawn().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn manage(&self, browser: &str, action: &str) -> Result<(), String> {
        if !["chrome", "edge"].contains(&browser)
            || !["install", "manage", "reconnect"].contains(&action)
        {
            return Err("Unsupported browser management action".into());
        }
        if browser_executable(browser).is_none() {
            return Err("Selected browser is not installed".into());
        }
        self.register()?;
        if action != "manage" {
            let mut preferences = self.preferences.lock();
            let next = Preferences {
                paused: preferences.paused,
                browser: Some(browser.into()),
            };
            next.save(&self.preferences_path()?)?;
            *preferences = next;
            drop(preferences);
            self.forget()?;
        }
        self.launch_browser(
            browser,
            browser_management_url(browser, action, atlas_profile::is_dev()),
        )?;
        *self.error.lock() = None;
        self.changed();
        Ok(())
    }
    pub fn forget(&self) -> Result<(), String> {
        if let Some(client) = self.client.lock().take() {
            let _ = client.sender.try_send(json!({"type":"unbound"}));
        }
        self.pending.lock().clear();
        let path = self.binding_path()?;
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        self.binding.lock().take();
        self.changed();
        Ok(())
    }
    pub fn register(&self) -> Result<(), String> {
        let manifest = json!({"name":browser_native::host_name(),"description":"Atlas Browser local connection","path":std::env::current_exe().map_err(|e|e.to_string())?,"type":"stdio","allowed_origins":browser_native::extension_origins()});
        let path = self
            .binding_path()?
            .with_file_name("browser-native-host.json");
        browser_native::write_private(&path, &manifest)?;
        #[cfg(windows)]
        for browser in ["Google\\Chrome", "Microsoft\\Edge"] {
            let key = format!(
                "HKCU\\Software\\{browser}\\NativeMessagingHosts\\{}",
                browser_native::host_name()
            );
            let result = atlas_process::command("reg.exe")
                .args(["ADD", &key, "/ve", "/t", "REG_SZ", "/d"])
                .arg(&path)
                .arg("/f")
                .output()
                .map_err(|e| e.to_string())?;
            if !result.status.success() {
                return Err("Could not register the per-user browser native host".into());
            }
        }
        #[cfg(not(windows))]
        {
            let home = dirs::home_dir().ok_or("Missing home directory")?;
            let roots: Vec<PathBuf> = if cfg!(target_os = "macos") {
                vec![
                    home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"),
                    home.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
                ]
            } else {
                vec![
                    home.join(".config/google-chrome/NativeMessagingHosts"),
                    home.join(".config/microsoft-edge/NativeMessagingHosts"),
                ]
            };
            for root in roots {
                browser_native::write_private(
                    &root.join(format!("{}.json", browser_native::host_name())),
                    &manifest,
                )?;
            }
        }
        Ok(())
    }
}

fn browser_management_url(browser: &str, action: &str, dev: bool) -> Option<String> {
    if action == "reconnect" {
        return None;
    }
    if browser == "chrome" && action == "install" && !dev {
        return Some(format!(
            "https://chromewebstore.google.com/detail/{}",
            browser_native::EXTENSION_ID
        ));
    }
    if browser == "edge" && action == "install" && !dev {
        return Some(format!(
            "https://microsoftedge.microsoft.com/addons/detail/{}",
            browser_native::EDGE_EXTENSION_ID
        ));
    }
    Some(
        if browser == "edge" {
            "edge://extensions/"
        } else {
            "chrome://extensions/"
        }
        .into(),
    )
}

fn browser_executable(browser: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let suffix = if browser == "edge" {
            "Microsoft/Edge/Application/msedge.exe"
        } else {
            "Google/Chrome/Application/chrome.exe"
        };
        ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(|root| PathBuf::from(root).join(suffix))
            .find(|p| p.is_file())
    }
    #[cfg(target_os = "macos")]
    {
        let name = if browser == "edge" {
            "Microsoft Edge.app"
        } else {
            "Google Chrome.app"
        };
        [
            Some(PathBuf::from("/Applications")),
            dirs::home_dir().map(|h| h.join("Applications")),
        ]
        .into_iter()
        .flatten()
        .map(|root| root.join(name))
        .find(|p| p.is_dir())
    }
    #[cfg(target_os = "linux")]
    {
        let name = if browser == "edge" {
            "microsoft-edge"
        } else {
            "google-chrome"
        };
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .map(|root| root.join(name))
            .find(|p| p.is_file())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_installation_uses_both_assigned_store_items_and_dev_loading() {
        assert_eq!(
            browser_management_url("chrome", "install", false).as_deref(),
            Some("https://chromewebstore.google.com/detail/falkhmhmbghdjcabgojjooddbhjpmmfd")
        );
        assert_eq!(
            browser_management_url("chrome", "install", true).as_deref(),
            Some("chrome://extensions/")
        );
        assert_eq!(
            browser_management_url("chrome", "manage", false).as_deref(),
            Some("chrome://extensions/")
        );
        assert_eq!(
            browser_management_url("edge", "install", false).as_deref(),
            Some("https://microsoftedge.microsoft.com/addons/detail/dpjekhhlbnbbpcjampjnmffnpnndpcci")
        );
        assert_eq!(
            browser_management_url("edge", "install", true).as_deref(),
            Some("edge://extensions/")
        );
        assert_eq!(
            browser_management_url("edge", "manage", false).as_deref(),
            Some("edge://extensions/")
        );
        assert_eq!(browser_management_url("chrome", "reconnect", false), None);
        assert_eq!(browser_management_url("edge", "reconnect", false), None);
    }
    #[test]
    fn browser_pause_and_selection_survive_restart_and_invalid_files_are_reported() {
        let path = std::env::temp_dir().join(format!(
            "atlas-browser-preferences-{}.json",
            uuid::Uuid::new_v4()
        ));
        assert!(!Preferences::load(&path).unwrap().paused);
        Preferences {
            paused: true,
            browser: Some("edge".into()),
        }
        .save(&path)
        .unwrap();
        let restarted = Preferences::load(&path).unwrap();
        assert!(restarted.paused);
        assert_eq!(restarted.browser.as_deref(), Some("edge"));
        std::fs::write(&path, "{broken").unwrap();
        assert!(Preferences::load(&path).is_err());
        std::fs::write(&path, r#"{"paused":true,"browser":"unknown"}"#).unwrap();
        assert!(Preferences::load(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn native_handshake_rejects_wrong_secrets_and_invalid_profile_identities() {
        let hello = json!({"secret":"expected","clientId":uuid::Uuid::new_v4().to_string(),"browser":"edge"});
        assert_eq!(
            validate_identity("expected", &hello).unwrap().browser,
            "edge"
        );
        assert!(validate_identity("wrong", &hello).is_err());
        assert!(validate_identity(
            "expected",
            &json!({"secret":"expected","clientId":"page","browser":"edge"})
        )
        .is_err());
    }
    #[tokio::test]
    async fn a_cancelled_read_keeps_partial_native_messages_and_enforces_the_limit() {
        let (mut writer, reader) = tokio::io::duplex(MAX_MESSAGE * 2);
        let mut reader = BufReader::new(reader);
        let mut bytes = Vec::new();
        writer.write_all(b"{\"id\":").await.unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(10),
            read_message(&mut reader, &mut bytes)
        )
        .await
        .is_err());
        writer.write_all(b"\"task\"}\n").await.unwrap();
        assert_eq!(
            read_message(&mut reader, &mut bytes).await.unwrap(),
            Some(json!({"id":"task"}))
        );
        writer
            .write_all(&vec![b'x'; MAX_MESSAGE + 1])
            .await
            .unwrap();
        assert!(read_message(&mut reader, &mut bytes).await.is_err());
    }
}
