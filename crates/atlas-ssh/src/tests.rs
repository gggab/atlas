use super::*;
use russh::{server, Channel, ChannelId};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
use zeroize::Zeroizing;

#[derive(Default)]
struct Secrets(parking_lot::Mutex<HashMap<(String, bool), String>>);
impl CredentialStore for Secrets {
    fn get(&self, id: &str, sudo: bool) -> Result<Zeroizing<String>> {
        self.0
            .lock()
            .get(&(id.into(), sudo))
            .cloned()
            .map(Zeroizing::new)
            .ok_or("missing".into())
    }
    fn set(&self, id: &str, sudo: bool, password: &str) -> Result<()> {
        self.0.lock().insert((id.into(), sudo), password.into());
        Ok(())
    }
    fn delete(&self, id: &str, sudo: bool) -> Result<()> {
        self.0.lock().remove(&(id.into(), sudo));
        Ok(())
    }
}

struct Server;
impl server::Handler for Server {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> std::result::Result<server::Auth, Self::Error> {
        Ok(if user == "deploy" && password == "native-test-pass" {
            server::Auth::Accept
        } else {
            server::Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            }
        })
    }
    async fn channel_open_session(
        &mut self,
        _channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        session.channel_success(channel)?;
        if data == b"hang" {
            return Ok(());
        }
        session.data(channel, b"hello native-test-".to_vec())?;
        session.data(channel, "pass 你好\n".as_bytes().to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

async fn fixture() -> (Arc<Runtime>, Connection, tokio::task::JoinHandle<()>) {
    let key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let fingerprint = key
        .public_key()
        .fingerprint(russh::keys::HashAlg::Sha256)
        .to_string();
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, stream, Server).await {
                    let _ = session.await;
                }
            });
        }
    });
    let store = Arc::new(Store::open(Path::new(":memory:")).unwrap());
    let credentials = Arc::new(Secrets::default());
    let mut c = store
        .prepare(ConnectionInput {
            id: None,
            name: "Test".into(),
            purpose: "Loopback fixture".into(),
            host: "127.0.0.1".into(),
            port,
            username: "deploy".into(),
        })
        .unwrap();
    c.fingerprint = Some(fingerprint);
    c.has_password = true;
    store.put(&c).unwrap();
    credentials.set(&c.id, false, "native-test-pass").unwrap();
    (
        Arc::new(Runtime::new(store, credentials, Arc::new(|| {}))),
        c,
        server,
    )
}

fn caller(id: &str) -> Identity {
    Identity {
        session_id: id.into(),
        agent: "test-agent".into(),
        project: "test-project".into(),
    }
}

async fn authorize(runtime: &Arc<Runtime>, caller: Identity, c: &Connection) -> String {
    let pending = runtime.connect(caller.clone(), &c.id).await.unwrap();
    assert_eq!(pending["status"], "authorization_required");
    runtime
        .decide(pending["approval_id"].as_str().unwrap(), true)
        .unwrap();
    let result = runtime.connect(caller, &c.id).await.unwrap();
    result["connection_handle"].as_str().unwrap().into()
}

#[tokio::test]
async fn authenticated_execution_is_scoped_redacted_and_revocable() {
    let (runtime, c, server) = fixture().await;
    // A management test never associates the server with a project.
    runtime.test(&c.id).await.unwrap();
    assert!(runtime
        .store
        .associations("test-project")
        .unwrap()
        .is_empty());
    let owner = caller("one");
    let handle = authorize(&runtime, owner.clone(), &c).await;
    assert_eq!(runtime.store.associations("test-project").unwrap().len(), 1);
    assert!(runtime
        .exec(&caller("two"), &handle, "echo hi".into(), false, 5)
        .await
        .is_err());
    let mut impostor = owner.clone();
    impostor.project = "other-project".into();
    assert!(!runtime.allowed(&impostor, &c));
    let job = runtime
        .exec(&owner, &handle, "echo hi".into(), false, 5)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if runtime.job(&owner, &job.id).unwrap().status != "running" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let result = runtime.job(&owner, &job.id).unwrap();
    assert_eq!(result.status, "succeeded");
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.output, "hello [REDACTED] 你好\n");
    assert!(!serde_json::to_string(&runtime.snapshot().unwrap())
        .unwrap()
        .contains("native-test-pass"));
    assert!(runtime.job(&caller("two"), &job.id).is_err());
    runtime.revoke("one", Some(&c.id), false).await;
    assert!(!runtime.allowed(&owner, &c));
    assert!(runtime
        .exec(&owner, &handle, "echo hi".into(), false, 5)
        .await
        .is_err());
    runtime.revoke("one", None, true).await;
    assert!(runtime.connect(owner.clone(), &c.id).await.is_err());
    runtime.session_started("one");
    assert!(!runtime.allowed(&owner, &c));
    assert_eq!(
        runtime.connect(owner, &c.id).await.unwrap()["status"],
        "authorization_required"
    );
    server.abort();
}

#[tokio::test]
async fn cancellation_timeout_host_mismatch_and_manual_exclusion() {
    let (runtime, c, server) = fixture().await;
    assert_eq!(probe(&c).await.unwrap(), c.fingerprint.clone().unwrap());
    let mut wrong = c.clone();
    wrong.fingerprint = Some("SHA256:wrong".into());
    runtime.store.put(&wrong).unwrap();
    assert!(runtime.test(&c.id).await.is_err());
    runtime.store.put(&c).unwrap();
    runtime
        .store
        .associate("test-project", &c.id, true, true)
        .unwrap();
    let owner = caller("one");
    let handle = authorize(&runtime, owner.clone(), &c).await;
    assert!(runtime.store.associations("test-project").unwrap()[0].excluded);
    let job = runtime
        .exec(&owner, &handle, "hang".into(), false, 10)
        .await
        .unwrap();
    runtime.cancel(Some(&owner), &job.id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if runtime.job(&owner, &job.id).unwrap().status != "running" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        runtime.job(&owner, &job.id).unwrap().status,
        "cancelled_unknown"
    );
    let job = runtime
        .exec(&owner, &handle, "hang".into(), false, 1)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(
        runtime.job(&owner, &job.id).unwrap().status,
        "timed_out_unknown"
    );
    runtime.disconnect(Some(&owner), &handle).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn denied_changed_and_projectless_connections_do_not_associate() {
    let (runtime, mut c, server) = fixture().await;
    let owner = caller("one");
    let pending = runtime.connect(owner.clone(), &c.id).await.unwrap();
    runtime
        .decide(pending["approval_id"].as_str().unwrap(), false)
        .unwrap();
    assert!(runtime.connect(owner.clone(), &c.id).await.is_err());
    assert!(runtime
        .store
        .associations("test-project")
        .unwrap()
        .is_empty());

    let next = caller("two");
    let pending = runtime.connect(next.clone(), &c.id).await.unwrap();
    c.revision = uuid::Uuid::new_v4().to_string();
    runtime.store.put(&c).unwrap();
    assert!(runtime
        .decide(pending["approval_id"].as_str().unwrap(), true)
        .is_err());
    assert!(!runtime.allowed(&next, &c));

    runtime
        .credentials
        .set(&c.id, false, "wrong-synthetic-password")
        .unwrap();
    let pending = runtime.connect(next.clone(), &c.id).await.unwrap();
    runtime
        .decide(pending["approval_id"].as_str().unwrap(), true)
        .unwrap();
    assert!(runtime.connect(next.clone(), &c.id).await.is_err());
    assert!(runtime
        .store
        .associations("test-project")
        .unwrap()
        .is_empty());
    runtime.invalidate(&c.id).await;
    assert!(!runtime.allowed(&next, &c));

    runtime
        .credentials
        .set(&c.id, false, "native-test-pass")
        .unwrap();
    let mut projectless = caller("three");
    projectless.project.clear();
    let handle = authorize(&runtime, projectless.clone(), &c).await;
    assert!(runtime.store.associations("").unwrap().is_empty());
    runtime
        .disconnect(Some(&projectless), &handle)
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().unwrap().authorizations.len(), 1);
    runtime.revoke("three", None, true).await;
    assert!(runtime.snapshot().unwrap().authorizations.is_empty());
    server.abort();
}

#[test]
fn revocation_from_a_ui_thread_does_not_require_a_tokio_context() {
    let executor = tokio::runtime::Runtime::new().unwrap();
    let (runtime, c, server, handle) = executor.block_on(async {
        let (runtime, c, server) = fixture().await;
        let handle = authorize(&runtime, caller("one"), &c).await;
        (runtime, c, server, handle)
    });
    let cleanup = runtime.revoke("one", Some(&c.id), false);
    assert!(!runtime.allowed(&caller("one"), &c));
    assert!(!runtime
        .snapshot()
        .unwrap()
        .sessions
        .iter()
        .any(|s| s.id == handle));
    executor.block_on(cleanup);
    server.abort();
}

#[tokio::test]
async fn connection_waiting_for_a_credential_edit_checks_the_revision_again() {
    let (runtime, mut c, server) = fixture().await;
    let owner = caller("one");
    let handle = authorize(&runtime, owner.clone(), &c).await;
    runtime.disconnect(Some(&owner), &handle).await.unwrap();
    let guard = runtime.management.lock().await;
    let task_runtime = runtime.clone();
    let id = c.id.clone();
    let task = tokio::spawn(async move { task_runtime.connect(owner, &id).await });
    tokio::task::yield_now().await;
    c.revision = uuid::Uuid::new_v4().to_string();
    c.host = "192.0.2.10".into();
    runtime.store.put(&c).unwrap();
    runtime.invalidate(&c.id).await;
    drop(guard);
    assert!(task.await.unwrap().is_err());
    assert!(runtime.snapshot().unwrap().sessions.is_empty());
    server.abort();
}
