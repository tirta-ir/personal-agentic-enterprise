use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Workspace {
    #[serde(default)]
    pub ssh_host: Option<String>,
    pub path: String,
    pub canonical_path: String,
    pub git_root: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Agent {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub position: String,
    pub role: String,
    #[serde(default)]
    pub reports_to: Option<String>,
    pub color: String,
    pub model: String,
    pub reasoning: String,
    pub instructions: String,
    pub agents_md: String,
    pub workdir: Option<Workspace>,
    pub permission: String,
    #[ts(type = "number")]
    pub timeout_seconds: u64,
    pub enabled: bool,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[ts(type = "number")]
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub project: Option<Project>,
    #[serde(default)]
    pub scope_levels: Option<Vec<u32>>,
    #[serde(default)]
    pub chat_lead_id: Option<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectMember {
    pub agent_id: String,
    pub manager_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Project {
    pub workdir: Workspace,
    pub members: Vec<ProjectMember>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ActionItem {
    pub id: String,
    pub group_id: String,
    pub title: String,
    pub body: String,
    pub assignee_id: String,
    pub planned_start: Option<String>,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub run_id: Option<String>,
    pub error: Option<String>,
}

impl Group {
    pub fn ensure_active(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.archived_at.is_none() && self.deleted_at.is_none(),
            "Restore this archived or deleted group before making changes"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Message {
    pub id: String,
    pub group_id: String,
    #[serde(default)]
    pub side_chat_id: Option<String>,
    pub sender: String,
    pub body: String,
    pub recipients: Vec<String>,
    pub reply_to: Option<String>,
    pub artifacts: Vec<String>,
    pub run_id: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub auto_routed: bool,
    #[serde(default)]
    pub schedule_id: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub usage_report: Option<crate::codex_usage::UsageReport>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Run {
    pub id: String,
    pub group_id: String,
    pub message_id: String,
    #[serde(default)]
    pub side_chat_id: Option<String>,
    pub agent_id: String,
    pub session_id: String,
    pub native_session_id: Option<String>,
    pub status: String,
    pub cwd: String,
    pub profile: Agent,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub pid: Option<u32>,
    #[serde(default)]
    pub remote_pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub output: String,
    pub executable: String,
    pub arguments: Vec<String>,
    #[serde(default)]
    pub model_display_name: Option<String>,
    pub usage: Option<serde_json::Value>,
    #[serde(default)]
    pub kind: RunKind,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub organization_context: Option<crate::coordination::OrganizationContext>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RunKind {
    #[default]
    Direct,
    Coordinator,
    Delegate,
    Summary,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Artifact {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub media_type: String,
    #[ts(type = "number")]
    pub size: u64,
    pub sha256: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Event {
    #[ts(type = "number")]
    pub seq: i64,
    pub kind: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct StateView {
    pub workstations: Vec<crate::workstations::Workstation>,
    pub questions: Vec<crate::questions::QuestionRequest>,
    pub actions: Vec<ActionItem>,
    pub project_connections: std::collections::BTreeMap<String, crate::remote::Connection>,
    pub project_layouts:
        std::collections::BTreeMap<String, std::collections::BTreeMap<String, ChartCard>>,
    pub connections: std::collections::BTreeMap<String, crate::remote::Connection>,
    pub agents: Vec<Agent>,
    pub deleted_agents: Vec<Agent>,
    pub chat_lead_id: Option<String>,
    pub groups: Vec<Group>,
    pub group_access: std::collections::BTreeMap<String, crate::group_scope::GroupAccess>,
    pub group_preferences: GroupPreferences,
    pub schedules: Vec<Schedule>,
    pub runs: Vec<Run>,
    pub artifacts: Vec<Artifact>,
    #[ts(type = "number")]
    pub cursor: i64,
    pub org_path: String,
    pub codex_path: String,
    pub codex_version: String,
    pub organization_layout: std::collections::BTreeMap<String, ChartCard>,
    pub panel_sizes: std::collections::BTreeMap<String, f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChartCard {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupPreferences {
    pub sort: GroupSort,
    pub pinned: Vec<String>,
    pub order: Vec<String>,
    #[serde(default)]
    pub sections: Vec<GroupSection>,
    #[serde(default)]
    pub collapsed: Vec<String>,
}

impl Workspace {
    pub fn identity(&self) -> String {
        match &self.ssh_host {
            Some(host) => format!("ssh://{host}{}", self.canonical_path),
            None => self.canonical_path.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupSection {
    pub id: String,
    pub name: String,
    pub groups: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GroupSort {
    #[default]
    Custom,
    Ascending,
    Descending,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Schedule {
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub body: String,
    pub start_at: String,
    #[ts(type = "number | null")]
    pub repeat_minutes: Option<i64>,
    pub next_run_at: Option<String>,
    pub enabled: bool,
    pub last_sent_at: Option<String>,
    pub last_message_id: Option<String>,
    pub last_error: Option<String>,
}
