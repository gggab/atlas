use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

pub const PROTOCOL: u32 = 2;
const MAX_EVENTS: usize = 4096;
const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub protocol: u32,
    pub profile: String,
    pub version: String,
    pub build: String,
    pub boot: String,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub certificate: String,
}

impl Endpoint {
    pub fn compatible(&self, profile: &str) -> bool {
        self.protocol == PROTOCOL
            && self.profile == profile
            && self.version == env!("CARGO_PKG_VERSION")
            && self.build == env!("ATLAS_BACKGROUND_BUILD")
    }
    pub fn authenticates(&self, actual: &str) -> bool {
        if actual.len() != self.token.len() {
            return false;
        }
        actual
            .bytes()
            .zip(self.token.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub name: String,
    pub payload: Value,
}

#[derive(Serialize, Deserialize)]
pub struct Batch {
    pub boot: String,
    pub cursor: u64,
    pub gap: bool,
    pub events: Vec<Event>,
}

#[derive(Default)]
pub struct Events {
    seq: u64,
    bytes: usize,
    events: VecDeque<(Event, usize)>,
    pending: HashMap<String, Event>,
}

impl Events {
    pub fn push(&mut self, name: &str, payload: Value) {
        self.seq += 1;
        let event = Event {
            seq: self.seq,
            name: name.into(),
            payload,
        };
        if name == "atlas:agents" {
            let kind = event.payload["kind"].as_str().unwrap_or_default();
            let request = event.payload["request_id"].as_str().unwrap_or_default();
            match kind {
                "permission_request" | "elicitation_requested" => {
                    self.pending.insert(request.into(), event.clone());
                }
                "permission_resolved" => {
                    self.pending.remove(request);
                }
                "turn_finished" | "turn_failed" | "agent_disconnected" => {
                    let session = &event.payload["session_id"];
                    self.pending
                        .retain(|_, p| &p.payload["session_id"] != session);
                }
                _ => {}
            }
        } else if name == "atlas:agent-elicitation" {
            if let Some(id) = event.payload["requestId"].as_str() {
                self.pending.insert(id.into(), event.clone());
            }
        } else if name == "atlas:agent-elicitation-resolved" {
            if let Some(id) = event.payload["requestId"].as_str() {
                self.pending.remove(id);
            }
        }
        let bytes = event.payload.to_string().len();
        self.bytes += bytes;
        self.events.push_back((event, bytes));
        while self.events.len() > MAX_EVENTS || self.bytes > MAX_EVENT_BYTES {
            if let Some((_, bytes)) = self.events.pop_front() {
                self.bytes -= bytes;
            }
        }
    }
    pub fn resolve(&mut self, request: &str) {
        self.pending.remove(request);
    }
    pub fn pending(&self) -> Vec<Event> {
        let mut events: Vec<_> = self.pending.values().cloned().collect();
        events.sort_by_key(|event| event.seq);
        events
    }
    pub fn replay_pending(&mut self) -> usize {
        let events = self.pending();
        let count = events.len();
        for event in events {
            self.push(&event.name, event.payload);
        }
        count
    }
    pub fn batch(&self, boot: &str, after: u64) -> Batch {
        Batch {
            boot: boot.into(),
            cursor: self.seq,
            gap: after > self.seq
                || after.saturating_add(1)
                    < self
                        .events
                        .front()
                        .map_or(self.seq.saturating_add(1), |(event, _)| event.seq),
            events: self
                .events
                .iter()
                .filter(|(e, _)| e.seq > after)
                .map(|(e, _)| e.clone())
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reconnect_keeps_only_live_approval_requests() {
        let mut events = Events::default();
        events.push(
            "atlas:agents",
            json!({"kind":"permission_request","request_id":"old","session_id":"s"}),
        );
        events.push(
            "atlas:agents",
            json!({"kind":"permission_resolved","request_id":"old","session_id":"s"}),
        );
        events.push(
            "atlas:agents",
            json!({"kind":"permission_request","request_id":"live","session_id":"s"}),
        );
        assert_eq!(events.pending().len(), 1);
        events.push(
            "atlas:agents",
            json!({"kind":"turn_failed","session_id":"s"}),
        );
        assert!(events.pending().is_empty());
    }
    #[test]
    fn approval_replay_is_ordered_before_any_subsequent_resolution() {
        let mut events = Events::default();
        events.push(
            "atlas:agents",
            json!({"kind":"permission_request","request_id":"old","session_id":"s"}),
        );
        events.push(
            "atlas:agents",
            json!({"kind":"permission_resolved","request_id":"old","session_id":"s"}),
        );
        events.push(
            "atlas:agents",
            json!({"kind":"permission_request","request_id":"live","session_id":"s"}),
        );
        assert_eq!(events.replay_pending(), 1);
        events.push(
            "atlas:agents",
            json!({"kind":"permission_resolved","request_id":"live","session_id":"s"}),
        );
        let replay = events.batch("boot", 3);
        assert_eq!(replay.events[0].payload["request_id"], "live");
        assert_eq!(replay.events[1].payload["kind"], "permission_resolved");
        assert!(events.pending().is_empty());
    }
    #[test]
    fn bounded_stream_reports_a_gap_instead_of_silently_dropping_deltas() {
        let mut events = Events::default();
        for _ in 0..MAX_EVENTS + 1 {
            events.push("atlas:agents", json!({}));
        }
        assert!(events.batch("boot", 0).gap);
        assert!(!events.batch("boot", 1).gap);
        assert_eq!(events.batch("boot", 1).events.len(), MAX_EVENTS);
    }
    #[test]
    fn handshake_and_capability_are_bound_to_profile_and_version() {
        let endpoint = Endpoint {
            protocol: PROTOCOL,
            profile: "dev".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            build: env!("ATLAS_BACKGROUND_BUILD").into(),
            boot: "b".into(),
            pid: 1,
            port: 1,
            token: "a".repeat(64),
            certificate: "fixture".into(),
        };
        assert!(endpoint.compatible("dev"));
        assert!(!endpoint.compatible("release"));
        assert!(endpoint.authenticates(&"a".repeat(64)));
        assert!(!endpoint.authenticates(&"b".repeat(64)));
    }
    #[test]
    fn an_oversized_event_reports_a_gap_even_when_it_empties_the_ring() {
        let mut events = Events::default();
        events.push(
            "atlas:capture-changed",
            json!({"content":"x".repeat(MAX_EVENT_BYTES)}),
        );
        assert!(events.batch("boot", 0).gap);
        assert!(!events.batch("boot", 1).gap);
    }
}
