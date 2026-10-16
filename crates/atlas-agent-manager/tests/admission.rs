mod support;
use agent_client_protocol::schema::v1 as acp;
use std::sync::atomic::Ordering;
use support::{custom, manager, wait_for, TestCatalog, TestServer};

#[tokio::test]
async fn idle_only_submission_cannot_append_or_cancel_an_existing_turn() {
    let server = TestServer::new("test-agent");
    let manager = manager(TestCatalog::new(&[]), server.clone());
    let thread = manager
        .new_session(custom("test-agent"), vec![])
        .await
        .unwrap();
    let id = thread.lock().unwrap().session_id().clone();
    let answer = server.queue_prompt();
    let running = {
        let (manager, id) = (manager.clone(), id.clone());
        tokio::spawn(async move { manager.send_if_idle(&id, vec!["human".into()]).await })
    };
    wait_for(|| (server.prompts_started() == 1).then_some(()))
        .await
        .unwrap();
    let before = thread.lock().unwrap().entries().len();
    assert!(manager
        .send_if_idle(&id, vec!["scheduled".into()])
        .await
        .is_err());
    assert_eq!(thread.lock().unwrap().entries().len(), before);
    assert!(thread.lock().unwrap().is_generating());
    assert_eq!(server.cancellations.load(Ordering::SeqCst), 0);
    assert_eq!(server.prompts_started(), 1);
    answer.send(Ok(acp::StopReason::EndTurn)).unwrap();
    assert_eq!(running.await.unwrap().unwrap(), acp::StopReason::EndTurn);
}
