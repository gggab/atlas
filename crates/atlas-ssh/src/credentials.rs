use crate::Result;
use zeroize::Zeroizing;

// The test seam is also the OS boundary. No plaintext fallback on unsupported OSes.
pub trait CredentialStore: Send + Sync {
    fn get(&self, id: &str, sudo: bool) -> Result<Zeroizing<String>>;
    fn set(&self, id: &str, sudo: bool, password: &str) -> Result<()>;
    fn delete(&self, id: &str, sudo: bool) -> Result<()>;
}

pub struct NativeCredentials {
    service: String,
    serial: parking_lot::Mutex<()>,
}

impl NativeCredentials {
    pub fn new(profile: &str) -> Self {
        Self {
            service: format!("{profile}/ssh"),
            serial: parking_lot::Mutex::new(()),
        }
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    fn entry(&self, id: &str, sudo: bool) -> Result<keyring::Entry> {
        let account = format!("{id}/{}", if sudo { "sudo" } else { "login" });
        keyring::Entry::new(&self.service, &account)
            .map_err(|_| "Cannot access the system credential store".into())
    }
}

impl CredentialStore for NativeCredentials {
    fn get(&self, id: &str, sudo: bool) -> Result<Zeroizing<String>> {
        let _guard = self.serial.lock();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            self.entry(id, sudo)?
                .get_password()
                .map(Zeroizing::new)
                .map_err(|_| {
                    "Credential missing, locked or access denied; update it in Remote connections"
                        .into()
                })
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = (&self.service, id, sudo);
            Err("SSH credential storage requires Windows or macOS".into())
        }
    }
    fn set(&self, id: &str, sudo: bool, password: &str) -> Result<()> {
        let _guard = self.serial.lock();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            self.entry(id, sudo)?
                .set_password(password)
                .map_err(|_| "Cannot save credential in the system credential store".into())
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = (&self.service, id, sudo, password);
            Err("SSH credential storage requires Windows or macOS".into())
        }
    }
    fn delete(&self, id: &str, sudo: bool) -> Result<()> {
        let _guard = self.serial.lock();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            match self.entry(id, sudo)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("Cannot delete system credential".into()),
            }
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = (&self.service, id, sudo);
            Err("SSH credential storage requires Windows or macOS".into())
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    #[test]
    fn native_vault_roundtrip_uses_a_disposable_namespace() {
        let vault = NativeCredentials::new(&format!("atlas-ssh-test-{}", uuid::Uuid::new_v4()));
        vault
            .set("fixture", false, "synthetic-login-value")
            .unwrap();
        vault.set("fixture", true, "synthetic-sudo-value").unwrap();
        let login = vault.get("fixture", false).unwrap();
        let sudo = vault.get("fixture", true).unwrap();
        vault.delete("fixture", false).unwrap();
        vault.delete("fixture", true).unwrap();
        assert_eq!(login.as_str(), "synthetic-login-value");
        assert_eq!(sudo.as_str(), "synthetic-sudo-value");
        assert!(vault.get("fixture", false).is_err());
    }
}
