//! Real stdio round trips without a model, account, or paid API request.
use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{event_channel, AgentConnection, AgentId, SteeringOutcome};
use atlas_agent_servers::{AcpConnection, AcpConnectionDefaults, AgentServerCommand};
use std::{path::PathBuf, sync::Arc, time::Duration};

const SCRIPT: &str = r#"
const readline = require('node:readline');
let prompt;
const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') reply(m.id, {protocolVersion:1, agentCapabilities:{},
    authMethods:[], _meta:STEERING_META});
  else if (m.method === 'session/new') reply(m.id, {sessionId:'test-session'});
  else if (m.method === 'session/prompt') {
    if (prompt) process.exit(20);
    prompt = m;
  } else if (m.method === '_session/steering') {
    if (!prompt || m.params.sessionId !== 'test-session' ||
        m.params.prompt[0].text !== 'new guidance' ||
        m.params._meta.steering.idleBehavior !== 'promptRequired') process.exit(21);
    reply(m.id, {outcome:OUTCOME});
    reply(prompt.id, {stopReason:'end_turn'});
  } else if (m.method === 'session/cancel') process.exit(22);
});
"#;

fn node() -> PathBuf {
    std::env::var_os("ATLAS_TEST_NODE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::split_paths(&std::env::var_os("PATH")?)
                .flat_map(|dir| [dir.join("node"), dir.join("node.exe")])
                .find(|candidate| candidate.is_file())
        })
        .expect("Node.js is required for the steering wire tests (or set ATLAS_TEST_NODE)")
}

async fn connect(meta: serde_json::Value, outcome: &str) -> Arc<AcpConnection> {
    let script = SCRIPT
        .replace("STEERING_META", &meta.to_string())
        .replace("OUTCOME", &serde_json::to_string(outcome).unwrap());
    Arc::new(
        AcpConnection::stdio(
            AgentId::new("unrelated-agent-name"),
            AgentServerCommand {
                path: node(),
                args: vec!["-e".into(), script],
                env: None,
            },
            None,
            AcpConnectionDefaults::default(),
            Arc::new(|_| {
                let (tx, rx) = event_channel();
                Box::leak(Box::new(rx));
                tx
            }),
            Arc::new(|_| {
                let (tx, rx) = event_channel();
                Box::leak(Box::new(rx));
                tx
            }),
            "atlas-test",
            "0.0.0".into(),
        )
        .await
        .unwrap(),
    )
}

#[tokio::test]
async fn steering_requires_an_explicit_boolean_capability() {
    for meta in [
        serde_json::json!({}),
        serde_json::json!({"steering":{"supported":false}}),
        serde_json::json!({"steering":{"supported":"true"}}),
    ] {
        let connection = connect(meta, "injected").await;
        assert!(!connection.supports_steering());
        assert!(connection
            .steer(acp::PromptRequest::new("test-session", vec![]))
            .await
            .is_err());
    }
}

#[tokio::test]
async fn steering_reaches_the_active_prompt_without_cancelling_or_reprompting() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let connection = connect(
            serde_json::json!({"steering":{"supported":true}}),
            "injected",
        )
        .await;
        assert!(connection.supports_steering());
        let thread = connection
            .clone()
            .new_session(vec![std::env::current_dir().unwrap()])
            .await
            .unwrap();
        let id = thread.lock().unwrap().session_id().clone();
        let prompt =
            connection.prompt(acp::PromptRequest::new(id.clone(), vec!["original".into()]));
        let steer = connection.steer(acp::PromptRequest::new(id, vec!["new guidance".into()]));
        let (answer, outcome) = tokio::join!(prompt, steer);
        assert_eq!(outcome.unwrap(), SteeringOutcome::Injected);
        assert_eq!(answer.unwrap().stop_reason, acp::StopReason::EndTurn);
    })
    .await
    .expect("steering must not wait for the original prompt to finish");
}

#[tokio::test]
async fn idle_and_failed_outcomes_are_not_treated_as_injection() {
    for (wire, expected) in [
        ("promptRequired", Some(SteeringOutcome::PromptRequired)),
        ("startedNewTurn", Some(SteeringOutcome::StartedNewTurn)),
        ("failed", None),
        ("unknown", None),
    ] {
        let connection = connect(serde_json::json!({"steering":{"supported":true}}), wire).await;
        let thread = connection
            .clone()
            .new_session(vec![std::env::current_dir().unwrap()])
            .await
            .unwrap();
        let id = thread.lock().unwrap().session_id().clone();
        let prompt = connection.prompt(acp::PromptRequest::new(id.clone(), vec![]));
        let steer = connection.steer(acp::PromptRequest::new(id, vec!["new guidance".into()]));
        let (_, result) = tokio::join!(prompt, steer);
        match expected {
            Some(expected) => assert_eq!(result.unwrap(), expected),
            None => assert!(result.is_err()),
        }
    }
}
