use super::protocol::Endpoint;
use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub desktop: PathBuf,
    pub executable: PathBuf,
    pub resources: PathBuf,
    pub login: bool,
}

pub fn directory(profile: &str) -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|p| p.join(profile).join("background"))
        .ok_or("Application configuration directory unavailable".into())
}

pub fn config(dir: &Path) -> Result<Config, String> {
    match std::fs::read(dir.join("config.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Background configuration is invalid: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn endpoint(dir: &Path) -> Result<Endpoint, String> {
    let bytes = std::fs::read(dir.join("endpoint.json"))
        .map_err(|e| format!("Background endpoint unavailable: {e}"))?;
    if bytes.len() > 4096 {
        return Err("Invalid background endpoint".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid background endpoint".into())
}

pub fn private_directory(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        let sid = user_sid()?;
        let output = atlas_process::command(system_tool("icacls.exe"))
            .arg(dir)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("*{sid}:(OI)(CI)(F)"),
                "*S-1-5-18:(OI)(CI)(F)",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not restrict background data to the current Windows user".into());
        }
    }
    Ok(())
}

pub fn atomic_json(dir: &Path, name: &str, value: &impl Serialize) -> Result<(), String> {
    let temporary = dir.join(format!(".{name}.{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temporary, dir.join(name)).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

pub fn lock(dir: &Path, name: &str) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(name))
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|error| format!("Could not acquire background {name}: {error}"))?;
    Ok(file)
}

pub fn held(dir: &Path, name: &str) -> bool {
    lock(dir, name).is_err()
}

pub fn lock_owner(dir: &Path) -> Result<File, String> {
    lock_wait(dir, "owner.lock")
}

pub fn lock_wait(dir: &Path, name: &str) -> Result<File, String> {
    let start = std::time::Instant::now();
    loop {
        match lock(dir, name) {
            Ok(file) => return Ok(file),
            Err(error) if start.elapsed() >= std::time::Duration::from_secs(3) => {
                return Err(error)
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
}

#[cfg(windows)]
pub fn system_tool(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join(name)
}

#[cfg(windows)]
pub fn user_sid() -> Result<String, String> {
    let output = atlas_process::command(system_tool("whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8(output.stdout)
        .map_err(|_| "Could not read current user identity".to_string())?;
    text.split([',', '"', '\r', '\n'])
        .find(|s| {
            s.starts_with("S-1-")
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || c == b'-' || c == b'S')
        })
        .map(str::to_owned)
        .ok_or("Could not read current user SID".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_one_backend_can_hold_a_profile_and_drop_releases_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let owner = lock(dir.path(), "owner.lock").unwrap();
        assert!(lock(dir.path(), "owner.lock").is_err());
        drop(owner);
        assert!(lock(dir.path(), "owner.lock").is_ok());
    }
    #[test]
    fn configuration_is_durable_and_corruption_is_not_defaulted_away() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!config(dir.path()).unwrap().enabled);
        atomic_json(
            dir.path(),
            "config.json",
            &Config {
                enabled: true,
                ..Config::default()
            },
        )
        .unwrap();
        assert!(config(dir.path()).unwrap().enabled);
        std::fs::write(dir.path().join("config.json"), "{").unwrap();
        assert!(config(dir.path()).is_err());
    }
    #[test]
    fn interface_restart_waits_for_the_previous_gui_lock_to_release() {
        let dir = tempfile::tempdir().unwrap();
        let previous = lock(dir.path(), "gui.lock").unwrap();
        let path = dir.path().to_owned();
        let next = std::thread::spawn(move || lock_wait(&path, "gui.lock"));
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(previous);
        assert!(next.join().unwrap().is_ok());
    }
}
