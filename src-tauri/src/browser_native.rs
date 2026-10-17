//! Browser-owned native messaging process; no GUI, model or browser launch.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};

// Derived from the assigned Chrome Web Store public key in manifest.json.
pub const EXTENSION_ID: &str = "falkhmhmbghdjcabgojjooddbhjpmmfd";
pub const EDGE_EXTENSION_ID: &str = "dpjekhhlbnbbpcjampjnmffnpnndpcci";
pub const MAX_MESSAGE: usize = 64 * 1024;

pub fn extension_origins() -> [String; 2] {
    [EXTENSION_ID, EDGE_EXTENSION_ID].map(|id| format!("chrome-extension://{id}/"))
}

#[derive(Serialize, Deserialize)]
pub struct Descriptor {
    pub address: SocketAddr,
    pub secret: String,
}
pub fn host_name() -> &'static str {
    if atlas_profile::is_dev() {
        "com.atlas.browser.dev"
    } else {
        "com.atlas.browser"
    }
}
pub fn descriptor_path(identifier: &str) -> Result<PathBuf, String> {
    Ok(dirs::config_dir()
        .ok_or("No user configuration directory")?
        .join(identifier)
        .join("browser-native-connection.json"))
}

#[cfg(all(windows, debug_assertions))]
pub fn prepare_dev_host(source: &Path, directory: &Path) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let host = directory.join(format!("atlas-browser-host-{:x}.exe", digest.finalize()));
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    if !host.exists() {
        let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result =
            std::fs::copy(source, &temporary).and_then(|_| std::fs::rename(&temporary, &host));
        if let Err(error) = result {
            if let Err(cleanup) = std::fs::remove_file(&temporary) {
                if cleanup.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("Could not remove incomplete browser host: {cleanup}");
                }
            }
            return Err(format!(
                "Could not prepare development browser host: {error}"
            ));
        }
    }
    // Chrome keeps its host mapped; never register Cargo's replaceable executable.
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let Some(hash) = name
            .strip_prefix("atlas-browser-host-")
            .and_then(|s| s.strip_suffix(".exe"))
        else {
            continue;
        };
        if path != host && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            if let Err(error) = std::fs::remove_file(&path) {
                // An older host may still be connected; retry cleanup on the next launch.
                tracing::warn!(
                    "Could not remove previous development browser host {}: {error}",
                    path.display()
                );
            }
        }
    }
    Ok(host)
}
pub fn write_private(path: &Path, value: &Value) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("Missing parent directory")?)
        .map_err(|e| e.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(value.to_string().as_bytes())
        .map_err(|e| e.to_string())
}
pub fn read_frame(reader: &mut impl Read) -> Result<Option<Value>, String> {
    let mut length = [0; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    let length = u32::from_ne_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE {
        return Err("Native message exceeds 64 KiB".into());
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Invalid native JSON".into())
}
pub fn write_frame(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MESSAGE {
        return Err("Native message exceeds 64 KiB".into());
    }
    writer
        .write_all(&(bytes.len() as u32).to_ne_bytes())
        .map_err(|e| e.to_string())?;
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}
fn serve(identifier: &str, origin: &str) -> Result<(), String> {
    if !extension_origins().iter().any(|allowed| allowed == origin) {
        return Err("Extension origin is not authorized".into());
    }
    let path = descriptor_path(identifier)?;
    // A debug-only fixture uses its own broker file, never app/user credentials.
    #[cfg(debug_assertions)]
    let path = std::env::var_os("ATLAS_BROWSER_NATIVE_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or(path);
    let descriptor: Descriptor = serde_json::from_slice(
        &std::fs::read(path)
            .map_err(|_| "Open DeskMate before connecting its browser extension")?,
    )
    .map_err(|_| "Invalid DeskMate native connection file")?;
    if !descriptor.address.ip().is_loopback()
        || !descriptor.address.is_ipv4()
        || descriptor.secret.len() != 64
    {
        return Err("Invalid local DeskMate connection".into());
    }
    let mut stream =
        TcpStream::connect_timeout(&descriptor.address, std::time::Duration::from_secs(3))
            .map_err(|_| "DeskMate is not running; open DeskMate and reconnect")?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    let hello = read_frame(&mut std::io::stdin())?.ok_or("Missing extension identity")?;
    let hello = json!({"secret":descriptor.secret,"clientId":hello["clientId"],"browser":hello["browser"],"version":hello["version"]});
    writeln!(stream, "{hello}").map_err(|e| e.to_string())?;
    let mut outgoing = stream.try_clone().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        while let Ok(Some(value)) = read_frame(&mut std::io::stdin()) {
            if writeln!(outgoing, "{value}").is_err() {
                break;
            }
        }
        let _ = outgoing.shutdown(std::net::Shutdown::Both);
    });
    let mut reader = BufReader::new(stream);
    loop {
        let mut bytes = Vec::new();
        if reader
            .by_ref()
            .take(MAX_MESSAGE as u64 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        if bytes.len() > MAX_MESSAGE || !bytes.ends_with(b"\n") {
            return Err("Invalid broker message length".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid broker response")?;
        write_frame(&mut std::io::stdout(), &value)?;
    }
    Ok(())
}
/// Native hosts receive their extension origin as argv[1]. Run before logging
/// and the single-instance plugin so native frames are never mixed with GUI IO.
pub fn run_if_requested(identifier: &str) -> bool {
    let Some(origin) = std::env::args()
        .nth(1)
        .filter(|arg| arg.starts_with("chrome-extension://"))
    else {
        return false;
    };
    if let Err(error) = serve(identifier, &origin) {
        let _ = write_frame(
            &mut std::io::stdout(),
            &json!({"type":"error","error":error}),
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(all(windows, debug_assertions))]
    #[test]
    fn dev_host_does_not_lock_the_build_output_and_replaces_old_versions() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("atlas.exe");
        let cache = root.path().join("hosts");
        std::fs::write(&source, b"first build").unwrap();
        let first = prepare_dev_host(&source, &cache).unwrap();
        assert_ne!(first, source);
        assert_eq!(std::fs::read(&first).unwrap(), b"first build");
        assert_eq!(prepare_dev_host(&source, &cache).unwrap(), first);
        let locked = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&first)
            .unwrap();
        std::fs::remove_file(&source).unwrap();
        std::fs::write(&source, b"next build").unwrap();
        std::fs::write(cache.join("unrelated.exe"), b"keep").unwrap();
        let second = prepare_dev_host(&source, &cache).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&second).unwrap(), b"next build");
        assert!(first.exists());
        drop(locked);
        assert_eq!(prepare_dev_host(&source, &cache).unwrap(), second);
        assert!(!first.exists());
        assert!(cache.join("unrelated.exe").exists());
    }
    #[test]
    fn native_host_accepts_both_assigned_store_origins() {
        let origins = extension_origins();
        assert_eq!(
            origins,
            [
                "chrome-extension://falkhmhmbghdjcabgojjooddbhjpmmfd/",
                "chrome-extension://dpjekhhlbnbbpcjampjnmffnpnndpcci/",
            ]
        );
        for origin in origins {
            let identifier = format!("atlas-origin-test-{}", uuid::Uuid::new_v4());
            assert_eq!(
                serve(&identifier, &origin).unwrap_err(),
                "Open DeskMate before connecting its browser extension"
            );
        }
    }
    #[test]
    fn native_host_rejects_the_retired_development_origin_and_other_extensions() {
        for origin in [
            "chrome-extension://mfppkokdebmgaigclpffjjafpicgapbj/",
            "chrome-extension://other/",
            "chrome-extension://falkhmhmbghdjcabgojjooddbhjpmmfd/extra",
            "chrome-extension://dpjekhhlbnbbpcjampjnmffnpnndpcci/extra",
            "chrome-extension://dpjekhhlbnbbpcjampjnmffnpnndpcci",
            "chrome-extension://0RDCKF6P54QV/",
        ] {
            assert_eq!(
                serve("atlas-origin-test", origin).unwrap_err(),
                "Extension origin is not authorized"
            );
        }
    }
    #[test]
    fn native_frames_are_bounded_and_preserve_split_utf8() {
        let value = json!({"title":"淘宝"});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &value).unwrap();
        assert_eq!(read_frame(&mut bytes.as_slice()).unwrap(), Some(value));
        assert!(read_frame(&mut ((MAX_MESSAGE + 1) as u32).to_ne_bytes().as_slice()).is_err());
        assert!(read_frame(&mut b"\0\0\0\0".as_slice()).is_err());
    }
}
