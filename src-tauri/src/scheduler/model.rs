use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Reminder,
    AgentCheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    NeedsConfirmation,
    Active,
    WaitingInput,
    Paused,
    Blocked,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Claimed,
    Dispatching,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
    NeedsAttention,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskAction {
    Pause,
    Resume,
    Cancel,
    Complete,
    Snooze,
}

fn default_runs() -> u32 {
    20
}
fn default_timeout() -> u64 {
    300
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuietHours {
    pub start_minute: u16,
    pub end_minute: u16,
}
impl QuietHours {
    pub fn contains(&self, minute: u16) -> bool {
        if self.start_minute < self.end_minute {
            minute >= self.start_minute && minute < self.end_minute
        } else {
            minute >= self.start_minute || minute < self.end_minute
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInput {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    pub idempotency_key: String,
    pub title: String,
    pub prompt: String,
    pub kind: TaskKind,
    #[serde(default)]
    pub due_at: i64,
    #[serde(default)]
    pub calendar: Option<super::calendar::CalendarSpec>,
    #[serde(default)]
    pub interval_minutes: Option<u16>,
    #[serde(default)]
    pub scope_key: String,
    pub source_thread_id: Option<String>,
    pub execution_thread_id: Option<String>,
    pub cwd: Option<String>,
    pub agent: Option<String>,
    #[serde(default = "default_runs")]
    pub max_runs: u32,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    pub quiet_hours: Option<QuietHours>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub revision: u64,
    pub input: TaskInput,
    pub state: TaskState,
    pub next_check_at: Option<i64>,
    pub reason: Option<String>,
    pub run_count: u32,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub calendar_progress: Option<CalendarProgress>,
    #[serde(default)]
    pub calendar_issues: Vec<super::calendar::CalendarIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarProgress {
    pub cursor: u64,
    pub activated_at: i64,
    pub cutoff: Option<i64>,
    pub ready: bool,
    pub paused_at: Option<i64>,
    pub pause_windows: Vec<(i64, i64)>,
    pub timezone_version: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceState {
    Pending,
    Completed,
    Skipped,
    Elapsed,
    Superseded,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccurrenceAction {
    Complete,
    Skip,
    Snooze,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub id: String,
    pub task_id: String,
    pub period_index: u64,
    pub revision: u64,
    pub local_date: String,
    pub due_at: i64,
    pub state: OccurrenceState,
    pub track_completion: bool,
    pub started: bool,
    pub timezone: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub task_id: String,
    pub revision: u64,
    pub state: RunState,
    pub boot_id: String,
    pub due_at: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub session_id: Option<String>,
    pub turn_seq: Option<u64>,
    pub report: Option<RunReport>,
    pub reason: Option<String>,
    #[serde(default)]
    pub calendar: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunReport {
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub waiting_input: bool,
    pub next_check_at: Option<i64>,
    #[serde(default)]
    pub notify: bool,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotification {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub revision: u64,
    pub title: String,
    pub body: String,
    pub attention: bool,
    pub created_at: i64,
    pub native_state: String,
    pub native_error: Option<String>,
    pub attempts: u32,
    pub next_attempt_at: i64,
    pub read: bool,
    #[serde(default)]
    pub dismissed: bool,
    #[serde(default)]
    pub calendar: bool,
}
