mod support;
use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThreadEvent, AgentThreadEntry, SteeringOutcome};
use std::sync::atomic::Ordering;
use support::{custom, manager, wait_for, TestCatalog, TestServer};

#[tokio::test]
async fn injection_and_rejection_neither_cancel_nor_close_the_running_prompt() {
    let server = TestServer::new("test-agent");
    *server.steering.lock().unwrap() = Some(Ok(SteeringOutcome::Injected));
    let manager = manager(TestCatalog::new(&[]), server.clone());
    let thread = manager
        .new_session(custom("test-agent"), vec![])
        .await
        .unwrap();
    let id = thread.lock().unwrap().session_id().clone();
    assert_eq!(
        manager.steer(&id, vec!["idle input".into()]).await.unwrap(),
        SteeringOutcome::PromptRequired
    );
    assert_eq!(server.steering_calls.load(Ordering::SeqCst), 0);
    let answer = server.queue_prompt();
    let task = {
        let (manager, id) = (manager.clone(), id.clone());
        tokio::spawn(async move { manager.send(&id, vec!["original".into()]).await })
    };
    wait_for(|| (server.prompts_started() == 1).then_some(()))
        .await
        .unwrap();
    server.drain_events(&id);
    assert_eq!(
        manager.steer(&id, vec!["guidance".into()]).await.unwrap(),
        SteeringOutcome::Injected
    );
    assert!(thread.lock().unwrap().is_generating());
    assert_eq!(server.prompts_started(), 1);
    assert_eq!(server.cancellations.load(Ordering::SeqCst), 0);
    let events = server.drain_events(&id);
    assert!(!events.iter().any(|e| matches!(
        e,
        AcpThreadEvent::StatusChanged | AcpThreadEvent::Stopped(_)
    )));
    let entry_count = thread.lock().unwrap().entries().len();
    assert!(
        matches!(thread.lock().unwrap().entries().last(), Some(AgentThreadEntry::UserMessage(m)) if m.chunks == vec!["guidance".into()])
    );
    *server.steering.lock().unwrap() = Some(Err("refused".into()));
    assert!(manager
        .steer(&id, vec!["refused input".into()])
        .await
        .is_err());
    assert_eq!(thread.lock().unwrap().entries().len(), entry_count);
    assert!(thread.lock().unwrap().is_generating());
    answer.send(Ok(acp::StopReason::EndTurn)).unwrap();
    assert_eq!(task.await.unwrap().unwrap(), acp::StopReason::EndTurn);
    assert!(!thread.lock().unwrap().is_generating());
}

#[tokio::test]
async fn legacy_detached_turn_is_busy_and_stoppable_after_the_original_prompt_returns() {
    let server = TestServer::new("test-agent");
    *server.steering.lock().unwrap() = Some(Ok(SteeringOutcome::StartedNewTurn));
    let manager = manager(TestCatalog::new(&[]), server.clone());
    let thread = manager
        .new_session(custom("test-agent"), vec![])
        .await
        .unwrap();
    let id = thread.lock().unwrap().session_id().clone();
    let answer = server.queue_prompt();
    let task = {
        let (manager, id) = (manager.clone(), id.clone());
        tokio::spawn(async move { manager.send(&id, vec!["original".into()]).await })
    };
    wait_for(|| (server.prompts_started() == 1).then_some(()))
        .await
        .unwrap();
    manager.steer(&id, vec!["guidance".into()]).await.unwrap();
    answer.send(Ok(acp::StopReason::EndTurn)).unwrap();
    task.await.unwrap().unwrap();
    assert!(thread.lock().unwrap().is_generating());
    assert_eq!(server.cancellations.load(Ordering::SeqCst), 0);
    manager.cancel(&id);
    assert!(!thread.lock().unwrap().is_generating());
    assert_eq!(server.cancellations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn missing_capability_and_unknown_session_fail_without_sending() {
    let server = TestServer::new("test-agent");
    let manager = manager(TestCatalog::new(&[]), server.clone());
    let thread = manager
        .new_session(custom("test-agent"), vec![])
        .await
        .unwrap();
    let id = thread.lock().unwrap().session_id().clone();
    assert!(manager.steer(&id, vec!["guidance".into()]).await.is_err());
    assert!(manager
        .steer(&acp::SessionId::new("missing"), vec![])
        .await
        .is_err());
    assert_eq!(server.steering_calls.load(Ordering::SeqCst), 0);
    assert_eq!(server.prompts_started(), 0);
}
