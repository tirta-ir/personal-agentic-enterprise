// Reuses Paperclip-style transactional claims and this app's persisted run queue.
use crate::{App, coordination, group_scope, model::*, security::ApiResult, store};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionInput {
    pub id: String,
    pub revision: u64,
    pub group_id: String,
    pub title: String,
    pub body: String,
    pub assignee_id: String,
    pub planned_start: Option<String>,
}

pub fn can_see(conn: &Connection, item: &ActionItem, actor: &str) -> Result<bool> {
    if item.status == "deleted" {
        return Ok(false);
    }
    if actor == "owner" {
        return Ok(true);
    }
    let group: Group = store::get(conn, "groups", &item.group_id)?;
    if group.ensure_active().is_err() {
        return Ok(false);
    }
    let access = group_scope::access(conn, &group)?;
    Ok(access.participant_ids.iter().any(|id| id == actor)
        || (item.assignee_id == actor && access.delegate_ids.iter().any(|id| id == actor)))
}

fn authorize(conn: &Connection, item: &ActionItem, actor: &str) -> Result<()> {
    ensure!(
        can_see(conn, item, actor)?,
        "Action is outside your group membership"
    );
    ensure!(
        actor == "owner" || item.created_by == actor,
        "Only the owner or assigning agent may change or invoke this action"
    );
    Ok(())
}

pub fn save_item(conn: &Connection, input: ActionInput, actor: &str) -> Result<ActionItem> {
    crate::security::validate_id(&input.id)?;
    ensure!(
        !input.title.trim().is_empty() && input.title.len() <= 160,
        "Title must contain 1–160 bytes"
    );
    ensure!(
        !input.body.trim().is_empty() && input.body.len() <= 64000,
        "Task must contain 1–64000 bytes"
    );
    let group: Group = store::get(conn, "groups", &input.group_id)?;
    group.ensure_active()?;
    let scope = group_scope::access(conn, &group)?;
    if actor != "owner" {
        scope.ensure_allowed(actor, RunKind::Direct)?;
    }
    scope.ensure_allowed(&input.assignee_id, RunKind::Delegate)?;
    let assignee: Agent = store::get(conn, "agents", &input.assignee_id)?;
    ensure!(
        assignee.enabled && assignee.deleted_at.is_none(),
        "Choose an enabled PIC"
    );
    let planned_start = input
        .planned_start
        .map(|value| -> Result<String> {
            let date = DateTime::parse_from_rfc3339(&value)?.with_timezone(&Utc);
            ensure!(
                date > Utc::now() && date < Utc::now() + chrono::Duration::days(3650),
                "Choose a future planned start within ten years; use Run now for immediate work"
            );
            Ok(date.to_rfc3339())
        })
        .transpose()?;
    let old: Option<String> = conn
        .query_row(
            "SELECT data FROM action_items WHERE id=?",
            [&input.id],
            |r| r.get(0),
        )
        .optional()?;
    let old: Option<ActionItem> = old.map(|v| serde_json::from_str(&v)).transpose()?;
    if let Some(old) = &old {
        authorize(conn, old, actor)?;
        ensure!(
            old.revision == input.revision,
            "Action changed; reopen it before saving"
        );
        ensure!(
            !["queued", "running"].contains(&old.status.as_str()),
            "Stop or wait for this action before editing"
        );
    } else {
        ensure!(input.revision == 0, "Action not found");
    }
    let item = ActionItem {
        id: input.id,
        group_id: input.group_id,
        title: input.title.trim().into(),
        body: input.body,
        assignee_id: input.assignee_id,
        status: if planned_start.is_some() {
            "scheduled"
        } else {
            "backlog"
        }
        .into(),
        planned_start,
        created_by: old
            .as_ref()
            .map(|i| i.created_by.clone())
            .unwrap_or_else(|| actor.into()),
        created_at: old
            .as_ref()
            .map(|i| i.created_at.clone())
            .unwrap_or_else(now),
        updated_at: now(),
        revision: input.revision + 1,
        run_id: None,
        error: None,
    };
    store::put(conn, "action_items", &item.id, &item)?;
    store::event(
        conn,
        "action.saved",
        &json!({"action_id":item.id,"actor":actor}),
    )?;
    Ok(item)
}

pub fn dispatch_item(conn: &Connection, id: &str, actor: &str) -> Result<ActionItem> {
    let mut item: ActionItem = store::get(conn, "action_items", id)?;
    authorize(conn, &item, actor)?;
    if ["queued", "running"].contains(&item.status.as_str()) {
        return Ok(item);
    }
    ensure!(
        item.status != "completed",
        "This action is completed; edit it to plan a new invocation"
    );
    let group: Group = store::get(conn, "groups", &item.group_id)?;
    group.ensure_active()?;
    crate::agent_tools::ensure_no_reset(conn, &group.id, None)?;
    let scope = group_scope::access(conn, &group)?;
    let agent: Agent = store::get(conn, "agents", &item.assignee_id)?;
    scope.ensure_allowed(&agent.id, RunKind::Delegate)?;
    let message = Message {
        id: crate::model::id(),
        group_id: group.id,
        side_chat_id: None,
        sender: actor.into(),
        body: format!("Action: {}\n\n{}", item.title, item.body),
        recipients: vec![agent.id.clone()],
        reply_to: None,
        artifacts: vec![],
        run_id: None,
        created_at: now(),
        auto_routed: false,
        schedule_id: None,
        command: None,
        usage_report: None,
    };
    // Action is an explicit assignment. PICs below the chat scope return privately
    // to the assigning lead through the existing delegation/summary path.
    let run = if scope.participant_ids.contains(&agent.id) {
        coordination::enqueue(conn, &message, agent, RunKind::Direct, None, None)?
    } else {
        let lead_id = scope
            .chat_lead_id
            .context("Choose a chat lead to receive this PIC's private result")?;
        let lead: Agent = store::get(conn, "agents", &lead_id)?;
        let mut root =
            coordination::enqueue(conn, &message, lead, RunKind::Coordinator, None, None)?;
        root.status = "waiting".into();
        store::put(conn, "runs", &root.id, &root)?;
        coordination::enqueue(
            conn,
            &message,
            agent,
            RunKind::Delegate,
            Some(root.id.clone()),
            Some(item.body.clone()),
        )?;
        root
    };
    store::put(conn, "messages", &message.id, &message)?;
    item.status = "queued".into();
    item.run_id = Some(run.id);
    item.error = None;
    item.updated_at = now();
    item.revision += 1;
    store::put(conn, "action_items", id, &item)?;
    store::event(
        conn,
        "action.dispatched",
        &json!({"action_id":id,"group_id":item.group_id,"message_id":message.id,"actor":actor}),
    )?;
    Ok(item)
}

pub async fn save(State(app): State<App>, Json(input): Json<ActionInput>) -> ApiResult<ActionItem> {
    let item = app.store.write(|conn| save_item(conn, input, "owner"))?;
    app.wake.notify_one();
    Ok(Json(item))
}
pub async fn invoke(State(app): State<App>, Path(id): Path<String>) -> ApiResult<ActionItem> {
    let item = app.store.write(|conn| dispatch_item(conn, &id, "owner"))?;
    app.wake.notify_one();
    Ok(Json(item))
}
pub async fn cancel(State(app): State<App>, Path(id): Path<String>) -> ApiResult<ActionItem> {
    let item: ActionItem = app.store.get("action_items", &id)?;
    app.store.read(|conn| authorize(conn, &item, "owner"))?;
    if let Some(run) = &item.run_id {
        let root: Run = app.store.get("runs", run)?;
        for child in app
            .store
            .list::<Run>("runs")?
            .into_iter()
            .filter(|r| r.message_id == root.message_id)
        {
            if coordination::active(&app.store.get("runs", &child.id)?) {
                crate::runtime::cancel(&app, &child.id)?;
            }
        }
    }
    let item = app.store.write(|conn| {
        let mut item: ActionItem = store::get(conn, "action_items", &id)?;
        authorize(conn, &item, "owner")?;
        if !["queued", "running"].contains(&item.status.as_str()) {
            item.status = "cancelled".into();
            item.revision += 1;
            item.updated_at = now();
            store::put(conn, "action_items", &id, &item)?;
        }
        store::event(conn, "action.cancel_requested", &json!({"action_id":id}))?;
        Ok(item)
    })?;
    app.wake.notify_one();
    Ok(Json(item))
}

pub fn delete_item(conn: &Connection, id: &str) -> Result<ActionItem> {
    let mut item: ActionItem = store::get(conn, "action_items", id)?;
    authorize(conn, &item, "owner")?;
    ensure!(
        !["queued", "running"].contains(&item.status.as_str()),
        "Stop or wait for this action before deleting"
    );
    if let Some(run_id) = &item.run_id {
        let root: Run = store::get(conn, "runs", run_id)?;
        ensure!(
            !store::list::<Run>(conn, "runs")?
                .iter()
                .any(|r| r.message_id == root.message_id && coordination::active(r)),
            "Stop or wait for this action's runs before deleting"
        );
    }
    item.status = "deleted".into();
    item.planned_start = None;
    item.updated_at = now();
    item.revision += 1;
    store::put(conn, "action_items", id, &item)?;
    store::event(conn, "action.deleted", &json!({"action_id":id}))?;
    Ok(item)
}

pub async fn delete(State(app): State<App>, Path(id): Path<String>) -> ApiResult<ActionItem> {
    Ok(Json(app.store.write(|conn| delete_item(conn, &id))?))
}

pub fn tick(app: &App) -> Result<()> {
    app.store.write(|conn| {
        let runs = store::list::<Run>(conn, "runs")?;
        for mut item in store::list::<ActionItem>(conn, "action_items")? {
            if item.status == "scheduled"
                && item.planned_start.as_ref().is_some_and(|d| d <= &now())
            {
                // Transactional claim: restart cannot enqueue a claimed action twice.
                if crate::agent_tools::ensure_no_reset(conn, &item.group_id, None).is_err() {
                    continue;
                }
                conn.execute_batch("SAVEPOINT action_dispatch")?;
                match dispatch_item(conn, &item.id, &item.created_by) {
                    Ok(_) => {
                        conn.execute_batch("RELEASE action_dispatch")?;
                        continue;
                    }
                    Err(error) => {
                        conn.execute_batch("ROLLBACK TO action_dispatch; RELEASE action_dispatch")?;
                        item.status = "failed".into();
                        item.error = Some(error.to_string());
                    }
                }
            } else if ["queued", "running"].contains(&item.status.as_str()) {
                let Some(run) = runs.iter().find(|r| Some(&r.id) == item.run_id.as_ref()) else {
                    continue;
                };
                let result = if run.status == "delegated" {
                    runs.iter()
                        .find(|r| {
                            r.parent_run_id.as_deref() == Some(&run.id)
                                && r.kind == RunKind::Summary
                        })
                        .unwrap_or(run)
                } else {
                    run
                };
                let failed_worker = runs.iter().find(|r| {
                    r.parent_run_id.as_deref() == Some(&run.id)
                        && r.kind == RunKind::Delegate
                        && !coordination::active(r)
                        && r.status != "succeeded"
                });
                let status = match result.status.as_str() {
                    "queued" => "queued",
                    "starting" | "running" | "waiting" | "delegated" => "running",
                    "succeeded" if failed_worker.is_some() => "failed",
                    "succeeded" => "completed",
                    "cancelled" => "cancelled",
                    _ => "failed",
                };
                if item.status == status {
                    continue;
                }
                item.status = status.into();
                item.error = failed_worker
                    .map(|r| {
                        r.error
                            .clone()
                            .unwrap_or_else(|| format!("PIC run {}", r.status))
                    })
                    .or_else(|| result.error.clone());
            } else {
                continue;
            }
            item.updated_at = now();
            item.revision += 1;
            store::put(conn, "action_items", &item.id, &item)?;
            store::event(conn, "action.changed", &json!({"action_id":item.id}))?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_actions_validate_membership_revision_workspace_and_claims() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = store::Store::open(directory.path().join("org"))?;
        let ceo: Agent = db.get("agents", "ceo")?;
        let mut worker = ceo.clone();
        worker.id = "worker".into();
        db.put("agents", &worker.id, &worker)?;
        let workspace = crate::security::validate_workspace(directory.path().to_str().unwrap())?;
        let mut project: Group = db.get("groups", "general")?;
        project.id = "project".into();
        project.project = Some(Project {
            workdir: workspace.clone(),
            members: vec![
                ProjectMember {
                    agent_id: ceo.id.clone(),
                    manager_id: None,
                },
                ProjectMember {
                    agent_id: worker.id.clone(),
                    manager_id: Some(ceo.id.clone()),
                },
            ],
        });
        db.put("groups", &project.id, &project)?;
        let input = |revision| ActionInput {
            id: "action".into(),
            revision,
            group_id: project.id.clone(),
            title: "Proof".into(),
            body: "Do work".into(),
            assignee_id: worker.id.clone(),
            planned_start: None,
        };
        let backlog = db.write(|conn| save_item(conn, input(0), &ceo.id))?;
        assert_eq!(backlog.status, "backlog");
        assert!(db.list::<Run>("runs")?.is_empty());
        assert!(db.write(|conn| save_item(conn, input(0), &ceo.id)).is_err());
        assert!(
            db.write(|conn| dispatch_item(conn, "action", &worker.id))
                .is_err()
        );
        assert!(db.read(|conn| can_see(conn, &backlog, "outsider"))? == false);
        let first = db.write(|conn| dispatch_item(conn, "action", &ceo.id))?;
        let again = db.write(|conn| dispatch_item(conn, "action", &ceo.id))?;
        assert_eq!(first.run_id, again.run_id);
        assert_eq!(db.list::<Run>("runs")?.len(), 1);
        let run: Run = db.get("runs", first.run_id.as_deref().unwrap())?;
        assert_eq!(run.cwd, workspace.path);
        assert!(worker.workdir.is_none());
        assert!(
            db.write(|conn| save_item(conn, input(first.revision), "owner"))
                .is_err()
        );
        let mut restricted = project.clone();
        restricted.id = "private".into();
        restricted
            .project
            .as_mut()
            .unwrap()
            .members
            .retain(|m| m.agent_id == worker.id);
        restricted.project.as_mut().unwrap().members[0].manager_id = None;
        db.put("groups", &restricted.id, &restricted)?;
        let mut private = input(0);
        private.id = "private-action".into();
        private.group_id = restricted.id;
        assert!(db.write(|conn| save_item(conn, private, &ceo.id)).is_err());
        let legacy = json!({"id":"legacy","group_id":"general","title":"Previous Work feature","owner":"owner","status":"in-progress","message_id":null});
        db.put("work_items", "legacy", &legacy)?;
        drop(db);
        let reopened = store::Store::open(directory.path().join("org"))?;
        assert_eq!(
            reopened.get::<serde_json::Value>("work_items", "legacy")?,
            legacy
        );
        assert_eq!(reopened.list::<ActionItem>("action_items")?.len(), 1);
        assert!(reopened.write(|conn| delete_item(conn, "action")).is_err());
        let mut scheduled = input(0);
        scheduled.id = "delete-me".into();
        scheduled.planned_start = Some((Utc::now() + chrono::Duration::days(1)).to_rfc3339());
        reopened.write(|conn| save_item(conn, scheduled, "owner"))?;
        let deleted = reopened.write(|conn| delete_item(conn, "delete-me"))?;
        assert_eq!(deleted.status, "deleted");
        assert!(deleted.planned_start.is_none());
        assert!(!reopened.read(|conn| can_see(conn, &deleted, "owner"))?);
        assert!(
            reopened
                .write(|conn| dispatch_item(conn, "delete-me", "owner"))
                .is_err()
        );
        let mut stale = input(deleted.revision);
        stale.id = "delete-me".into();
        assert!(
            reopened
                .write(|conn| save_item(conn, stale, "owner"))
                .is_err()
        );
        drop(reopened);
        let reopened = store::Store::open(directory.path().join("org"))?;
        assert_eq!(
            reopened
                .get::<ActionItem>("action_items", "delete-me")?
                .status,
            "deleted"
        );
        Ok(())
    }
}
