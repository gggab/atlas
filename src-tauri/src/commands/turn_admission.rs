//! A reservation spans recording, asynchronous dispatch and the whole prompt.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct TurnAdmissions(Mutex<HashMap<String, Option<String>>>);

pub struct TurnPermit {
    owner: Arc<TurnAdmissions>,
    session: String,
}

impl TurnAdmissions {
    pub fn active_task_runs(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(Clone::clone)
            .collect()
    }
    pub fn reserve(
        self: &Arc<Self>,
        session: &str,
        run: Option<String>,
    ) -> Result<TurnPermit, String> {
        let mut active = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains_key(session) {
            return Err("Session is busy; wait for the current turn or explicitly stop it".into());
        }
        active.insert(session.into(), run);
        Ok(TurnPermit {
            owner: self.clone(),
            session: session.into(),
        })
    }

    pub fn scheduled(&self, session: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
            .is_some_and(Option::is_some)
    }
}

impl Drop for TurnPermit {
    fn drop(&mut self) {
        self.owner
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reservation_covers_the_window_before_begin_turn_and_releases_on_drop() {
        let admission = Arc::new(TurnAdmissions::default());
        let scheduled = admission.reserve("s", Some("run".into())).unwrap();
        assert_eq!(admission.active_task_runs(), vec!["run"]);
        let another = admission.clone();
        assert!(
            std::thread::spawn(move || another.reserve("s", None).is_err())
                .join()
                .unwrap()
        );
        assert!(admission.scheduled("s"));
        assert!(admission.reserve("other", None).is_ok());
        drop(scheduled);
        assert!(admission.active_task_runs().is_empty());
        let human = admission.reserve("s", None).unwrap();
        assert!(!admission.scheduled("s"));
        assert!(admission.reserve("s", Some("another-run".into())).is_err());
        drop(human);
        assert!(admission.reserve("s", None).is_ok());
    }
}
