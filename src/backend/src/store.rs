use crate::model::*;
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct Store {
    pub connection: Mutex<Connection>,
    pub org: PathBuf,
}

impl Store {
    pub fn open(org: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(org.join(".state"))?;
        let conn = Connection::open(org.join(".state/app.sqlite3"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(include_str!("../../migrations/001.sql"))?;
        if !conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='side_chat_id')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            conn.execute_batch(include_str!("../../migrations/002-side-chat-sessions.sql"))?;
        }
        let store = Self {
            connection: Mutex::new(conn),
            org,
        };
        let restored = store.org.join(".state/restore.pending");
        if restored.exists() {
            store.write(|tx| {
                tx.execute("UPDATE sessions SET active=0", [])?;
                for mut schedule in list::<Schedule>(tx, "schedules")? {
                    schedule.enabled = false;
                    schedule.last_error =
                        Some("Restored from backup. Review and resume this schedule.".into());
                    put(tx, "schedules", &schedule.id, &schedule)?;
                }
                for mut item in list::<ActionItem>(tx, "action_items")? {
                    if item.status == "scheduled" {
                        item.status = "backlog".into();
                        item.planned_start = None;
                        item.revision += 1;
                        item.error = Some("Restored from backup. Review before scheduling.".into());
                        put(tx, "action_items", &item.id, &item)?;
                    }
                }
                tx.execute("DELETE FROM metadata WHERE key LIKE 'reset_request:%'", [])?;
                Ok(())
            })?;
            for mut artifact in store.list::<Artifact>("artifacts")? {
                if artifact.status != "deleted" {
                    artifact.status = "stored".into();
                    artifact.error = None;
                    store.put("artifacts", &artifact.id, &artifact)?;
                }
            }
            std::fs::remove_file(restored)?;
        }
        if store.list::<Agent>("agents")?.is_empty() {
            let text = std::fs::read_to_string(store.org.join("ceo/AGENTS.md"));
            let agents_md = match text {
                Ok(s) => s,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(e.into()),
            };
            let agent = Agent { id: "ceo".into(), project_id: None, name: "CEO".into(), position: "Chief Executive Officer".into(), role: "Coordinate work and turn decisions into results.".into(), reports_to: None, color: "#52766a".into(), model: String::new(), reasoning: String::new(), instructions: "Work carefully in the attached codebase. Report what changed and provide verification evidence.".into(), agents_md, workdir: None, permission: "read-only".into(), timeout_seconds: 1800, enabled: true, deleted_at: None, revision: 1 };
            store.put("agents", &agent.id, &agent)?;
            store.put(
                "groups",
                "general",
                &Group {
                    id: "general".into(),
                    name: "General".into(),
                    description: "Your team's shared workspace.".into(),
                    project: None,
                    scope_levels: None,
                    chat_lead_id: None,
                    archived_at: None,
                    deleted_at: None,
                },
            )?;
            store.materialize(&agent)?;
        }
        // No native tool call survives a service restart; retain its question as history.
        for mut question in store.list::<crate::questions::QuestionRequest>("questions")? {
            if question.status == "pending"
                || (question.status == "answered" && !question.delivered)
            {
                question.status = "interrupted".into();
                question.error =
                    Some("Service restarted. Send a new message to continue this task.".into());
                store.put("questions", &question.id, &question)?;
            }
        }
        // Interrupted runs may have performed side effects. Never replay them automatically.
        for mut run in store.list::<crate::terminal::TerminalRun>("terminal_runs")? {
            if run.status == "running" {
                run.status = "interrupted".into();
                run.ended_at = Some(now());
                run.error = Some(
                    "Service restarted. Inspect the workdir before retrying this command.".into(),
                );
                store.put("terminal_runs", &run.id, &run)?;
            }
        }
        for mut run in store.list::<Run>("runs")? {
            if ["queued", "starting", "running"].contains(&run.status.as_str()) {
                run.status = "interrupted".into();
                run.ended_at = Some(now());
                run.error = Some("Service restarted before a confirmed result. Inspect the workspace before retrying.".into());
                store.put("runs", &run.id, &run)?;
            }
        }
        for mut artifact in store.list::<Artifact>("artifacts")? {
            if artifact.status == "indexing" {
                artifact.status = "failed".into();
                artifact.error = Some("Indexing was interrupted. Retry indexing this file.".into());
                store.put("artifacts", &artifact.id, &artifact)?;
            }
        }
        Ok(store)
    }
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("Database lock poisoned"))?;
        f(&conn)
    }
    pub fn write<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("Database lock poisoned"))?;
        let tx = conn.transaction()?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn list<T: DeserializeOwned>(&self, table: &str) -> Result<Vec<T>> {
        self.read(|c| list(c, table))
    }
    pub fn get<T: DeserializeOwned>(&self, table: &str, id: &str) -> Result<T> {
        self.read(|c| get(c, table, id))
    }
    pub fn put<T: Serialize>(&self, table: &str, id: &str, value: &T) -> Result<()> {
        self.write(|c| put(c, table, id, value))
    }
    pub fn event(&self, kind: &str, payload: serde_json::Value) -> Result<i64> {
        self.write(|c| event(c, kind, &payload))
    }
    pub fn events(&self, after: i64, limit: usize) -> Result<Vec<Event>> {
        self.read(|c| {
            let mut q = c.prepare(
                "SELECT seq,kind,payload,created_at FROM events WHERE seq>? ORDER BY seq LIMIT ?",
            )?;
            let rows = q.query_map(params![after, limit as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?;
            rows.map(|r| {
                let (seq, kind, payload, created_at) = r?;
                Ok(Event {
                    seq,
                    kind,
                    payload: serde_json::from_str(&payload)?,
                    created_at,
                })
            })
            .collect()
        })
    }
    pub fn materialize(&self, agent: &Agent) -> Result<()> {
        let directory = self.org.join(&agent.id);
        std::fs::create_dir_all(&directory)?;
        atomic_write(
            &directory.join("profile.json"),
            serde_json::to_vec_pretty(agent)?.as_slice(),
        )?;
        atomic_write(
            &directory.join("instructions.md"),
            agent.instructions.as_bytes(),
        )?;
        atomic_write(&directory.join("AGENTS.md"), agent.agents_md.as_bytes())?;
        Ok(())
    }
}

fn checked_table(table: &str) -> Result<&str> {
    if [
        "agents",
        "groups",
        "workstations",
        "schedules",
        "messages",
        "questions",
        "runs",
        "terminal_runs",
        "action_items",
        "work_items",
        "handoffs",
        "artifacts",
    ]
    .contains(&table)
    {
        Ok(table)
    } else {
        bail!("Unknown table")
    }
}
pub fn list<T: DeserializeOwned>(conn: &Connection, table: &str) -> Result<Vec<T>> {
    let mut q = conn.prepare(&format!(
        "SELECT data FROM {} ORDER BY rowid",
        checked_table(table)?
    ))?;
    let rows = q.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}
pub fn get<T: DeserializeOwned>(conn: &Connection, table: &str, id: &str) -> Result<T> {
    let data: Option<String> = conn
        .query_row(
            &format!("SELECT data FROM {} WHERE id=?", checked_table(table)?),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    serde_json::from_str(&data.context("Record not found")?).map_err(Into::into)
}
pub fn put<T: Serialize>(conn: &Connection, table: &str, id: &str, value: &T) -> Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO {}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            checked_table(table)?
        ),
        params![id, serde_json::to_string(value)?],
    )?;
    Ok(())
}
pub fn event(conn: &Connection, kind: &str, payload: &serde_json::Value) -> Result<i64> {
    conn.execute(
        "INSERT INTO events(kind,payload,created_at) VALUES(?,?,?)",
        params![kind, serde_json::to_string(payload)?, now()],
    )?;
    Ok(conn.last_insert_rowid())
}
pub fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().context("Missing parent directory")?;
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(content)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| anyhow::anyhow!(e.error))?;
    Ok(())
}
