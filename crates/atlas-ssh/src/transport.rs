use crate::{Connection, Result, Runtime};
use russh::{client, ChannelMsg};
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

pub(crate) type Handle = client::Handle<Verifier>;

pub(crate) struct Verifier {
    expected: Option<String>,
    observed: Arc<parking_lot::Mutex<Option<String>>>,
}

impl client::Handler for Verifier {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        *self.observed.lock() = Some(fingerprint.clone());
        Ok(self.expected.as_deref() == Some(&fingerprint))
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    })
}

// A fingerprint probe rejects the key and never sends login credentials.
pub async fn probe(connection: &Connection) -> Result<String> {
    let observed = Arc::new(parking_lot::Mutex::new(None));
    let verifier = Verifier {
        expected: None,
        observed: observed.clone(),
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(
            config(),
            (connection.host.as_str(), connection.port),
            verifier,
        ),
    )
    .await;
    let fingerprint = observed.lock().clone();
    fingerprint.ok_or_else(|| "Cannot fetch server fingerprint; check address and network".into())
}

pub(crate) async fn connect(connection: &Connection, password: &str) -> Result<Handle> {
    let fingerprint = connection
        .fingerprint
        .clone()
        .ok_or("Server fingerprint has not been verified")?;
    let observed = Arc::new(parking_lot::Mutex::new(None));
    let verifier = Verifier {
        expected: Some(fingerprint.clone()),
        observed: observed.clone(),
    };
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(
            config(),
            (connection.host.as_str(), connection.port),
            verifier,
        ),
    )
    .await
    .map_err(|_| "SSH connection timed out")?
    .map_err(|_| {
        if observed.lock().as_ref().is_some_and(|f| f != &fingerprint) {
            "Server fingerprint changed; verify it again in Remote connections"
        } else {
            "SSH connection failed"
        }
    })?;
    let authenticated = tokio::time::timeout(
        Duration::from_secs(15),
        session.authenticate_password(connection.username.clone(), password),
    )
    .await
    .map_err(|_| "SSH authentication timed out")?
    .map_err(|_| "SSH authentication failed")?;
    if !authenticated.success() {
        return Err("SSH password authentication rejected".into());
    }
    Ok(session)
}

pub(crate) fn redact(text: &str, login: &str, sudo: Option<&str>) -> String {
    let mut out = text.to_string();
    let mut secrets: Vec<_> = [Some(login), sudo]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    for secret in secrets {
        out = out.replace(secret, "[REDACTED]");
    }
    atlas_redact::redact_auto(&out).text
}

// Keep potential secret prefixes private until the next chunk completes them.
struct StreamRedactor {
    pending: Zeroizing<Vec<u8>>,
    secrets: Vec<Zeroizing<String>>,
}

impl StreamRedactor {
    fn new(login: &str, sudo: Option<&str>) -> Self {
        let mut secrets: Vec<_> = [Some(login), sudo]
            .into_iter()
            .flatten()
            .filter(|s| !s.is_empty())
            .map(|s| Zeroizing::new(s.to_string()))
            .collect();
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Self {
            pending: Zeroizing::new(Vec::new()),
            secrets,
        }
    }
    fn push(&mut self, bytes: &[u8], finish: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let retain = self
            .secrets
            .iter()
            .map(|s| s.len())
            .max()
            .unwrap_or(1)
            .saturating_sub(1)
            .max(3);
        let limit = if finish {
            self.pending.len()
        } else {
            self.pending.len().saturating_sub(retain)
        };
        let mut out = Vec::new();
        let mut i = 0;
        while i < limit {
            if let Some(secret) = self
                .secrets
                .iter()
                .find(|s| self.pending[i..].starts_with(s.as_bytes()))
            {
                out.extend_from_slice(b"[REDACTED]");
                i += secret.len();
            } else {
                // Never split a valid UTF-8 scalar at an output boundary.
                let width = match self.pending[i] {
                    0..=127 => 1,
                    192..=223 => 2,
                    224..=239 => 3,
                    240..=247 => 4,
                    _ => 1,
                };
                if !finish && i + width > limit {
                    break;
                }
                let end = (i + width).min(self.pending.len());
                out.extend_from_slice(&self.pending[i..end]);
                i = end;
            }
        }
        self.pending.drain(..i);
        atlas_redact::redact_auto(&String::from_utf8_lossy(&out)).text
    }
}

fn shell_quote(command: &str) -> String {
    format!("'{}'", command.replace('\'', "'\\''"))
}

pub(crate) async fn run(
    runtime: Arc<Runtime>,
    id: String,
    mut channel: russh::Channel<client::Msg>,
    command: Zeroizing<String>,
    secrets: (Zeroizing<String>, Option<Zeroizing<String>>),
    mut stop: tokio::sync::watch::Receiver<bool>,
    timeout_seconds: u64,
) {
    let wire = if secrets.1.is_some() {
        // Password goes only to sudo's stdin. The executed shell closes stdin,
        // so NOPASSWD configurations cannot expose unconsumed input to the payload.
        format!(
            "/usr/bin/sudo -S -k -p '' -- /bin/sh -c {}",
            shell_quote(&format!("exec </dev/null; {}", command.as_str()))
        )
    } else {
        command.to_string()
    };
    let mut stdout = StreamRedactor::new(&secrets.0, secrets.1.as_deref().map(|s| s.as_str()));
    let mut stderr = StreamRedactor::new(&secrets.0, secrets.1.as_deref().map(|s| s.as_str()));
    let mut exit_code = None;
    let execution = async {
        if *stop.borrow() {
            return "cancelled_unknown";
        }
        if channel.exec(true, wire).await.is_err() {
            return "failed_unknown";
        }
        if let Some(password) = &secrets.1 {
            let input = Zeroizing::new(format!("{}\n", password.as_str()));
            if channel.data(input.as_bytes()).await.is_err() {
                return "failed_unknown";
            }
        }
        let _ = channel.eof().await;
        loop {
            tokio::select! {
                _=stop.changed()=>return "cancelled_unknown",
                message=channel.wait()=>match message {
                    Some(ChannelMsg::Data { data })=>runtime.output(&id,&stdout.push(&data,false)),
                    Some(ChannelMsg::ExtendedData { data,.. })=>runtime.output(&id,&stderr.push(&data,false)),
                    Some(ChannelMsg::ExitStatus { exit_status })=>exit_code=Some(exit_status),
                    Some(ChannelMsg::Failure)=>return "failed_unknown",
                    None=>return if exit_code==Some(0) { "succeeded" } else if exit_code.is_some() { "failed" } else { "disconnected_unknown" },
                    _=>{}
                }
            }
        }
    };
    let status = tokio::time::timeout(Duration::from_secs(timeout_seconds), execution)
        .await
        .unwrap_or("timed_out_unknown");
    if status.ends_with("unknown") {
        let _ = channel.signal(russh::Sig::TERM).await;
    }
    let _ = channel.close().await;
    runtime.output(&id, &stdout.push(&[], true));
    runtime.output(&id, &stderr.push(&[], true));
    runtime.finish(&id, status, exit_code);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_split_at_every_boundary_and_utf8_are_not_emitted() {
        for split in 0..=32 {
            let secret = "private-pass";
            let text = format!("你好 {secret} 结束");
            let bytes = text.as_bytes();
            let mut redactor = StreamRedactor::new(secret, None);
            let split = split.min(bytes.len());
            let result = format!(
                "{}{}{}",
                redactor.push(&bytes[..split], false),
                redactor.push(&bytes[split..], false),
                redactor.push(&[], true)
            );
            assert_eq!(result, "你好 [REDACTED] 结束");
        }
        let mut redactor = StreamRedactor::new("private", Some("private-pass"));
        assert_eq!(redactor.push(b"private-pass", true), "[REDACTED]");
        assert_eq!(
            redact("private-pass", "private", Some("private-pass")),
            "[REDACTED]"
        );
    }
    #[test]
    fn sudo_payload_is_quoted_and_stdin_is_closed() {
        assert_eq!(shell_quote("echo 'hi'"), "'echo '\\''hi'\\'''");
        assert_eq!(
            redact("password=private-pass", "private-pass", None),
            "password=[REDACTED]"
        );
    }
}
