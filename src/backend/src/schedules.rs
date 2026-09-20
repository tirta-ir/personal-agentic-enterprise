// Due-time claims and coalescing follow Paperclip's routine scheduler (MIT).
// Reuse the existing SQLite transaction and message queue; see UPSTREAM.md.
use crate::{
    App,
    api::{SendInput, submit_message},
    coordination,
    model::*,
    security::ApiResult,
    store,
};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
pub struct ScheduleInput {
    name: String,
    body: String,
    start_at: String,
    repeat_minutes: Option<i64>,
}

fn configure(schedule: &mut Schedule, input: ScheduleInput) -> Result<()> {
    ensure!(
        !input.name.trim().is_empty() && input.name.len() <= 80,
        "Task name must contain 1–80 bytes"
    );
    ensure!(
        !input.body.trim().is_empty() && input.body.len() <= 64000,
        "Message must contain 1–64000 bytes"
    );
    ensure!(
        input
            .repeat_minutes
            .is_none_or(|m| (1..=525600).contains(&m)),
        "Repeat interval must be 1–525600 minutes"
    );
    let start = DateTime::parse_from_rfc3339(&input.start_at)?.with_timezone(&Utc);
    ensure!(
        start > Utc::now() && start < Utc::now() + Duration::days(3650),
        "Choose a future time within ten years"
    );
    schedule.name = input.name.trim().into();
    schedule.body = input.body;
    schedule.start_at = start.to_rfc3339();
    schedule.next_run_at = Some(schedule.start_at.clone());
    schedule.repeat_minutes = input.repeat_minutes;
    schedule.last_error = None;
    Ok(())
}

pub async fn create(
    State(app): State<App>,
    Path(group_id): Path<String>,
    Json(input): Json<ScheduleInput>,
) -> ApiResult<Schedule> {
    let mut schedule = Schedule {
        id: id(),
        group_id,
        name: String::new(),
        body: String::new(),
        start_at: String::new(),
        repeat_minutes: None,
        next_run_at: None,
        enabled: true,
        last_sent_at: None,
        last_message_id: None,
        last_error: None,
    };
    configure(&mut schedule, input)?;
    app.store.write(|tx| {
        store::get::<Group>(tx, "groups", &schedule.group_id)?.ensure_active()?;
        store::put(tx, "schedules", &schedule.id, &schedule)?;
        store::event(
            tx,
            "schedule.saved",
            &json!({"schedule_id":schedule.id,"group_id":schedule.group_id}),
        )?;
        Ok(())
    })?;
    app.wake.notify_one();
    Ok(Json(schedule))
}

pub async fn update(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<ScheduleInput>,
) -> ApiResult<Schedule> {
    let schedule = app.store.write(|tx| {
        let mut schedule: Schedule = store::get(tx, "schedules", &id)?;
        store::get::<Group>(tx, "groups", &schedule.group_id)?.ensure_active()?;
        configure(&mut schedule, input)?;
        store::put(tx, "schedules", &id, &schedule)?;
        store::event(tx, "schedule.saved", &json!({"schedule_id":id}))?;
        Ok(schedule)
    })?;
    app.wake.notify_one();
    Ok(Json(schedule))
}

#[derive(Deserialize)]
pub struct Enabled {
    enabled: bool,
}

pub async fn set_enabled(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<Enabled>,
) -> ApiResult<Schedule> {
    let schedule = app.store.write(|tx| {
        let mut schedule: Schedule = store::get(tx, "schedules", &id)?;
        store::get::<Group>(tx, "groups", &schedule.group_id)?.ensure_active()?;
        if input.enabled && !schedule.enabled {
            let due = DateTime::parse_from_rfc3339(
                schedule
                    .next_run_at
                    .as_deref()
                    .context("Set a new time before resuming this completed task")?,
            )?
            .with_timezone(&Utc);
            if due <= Utc::now() {
                schedule.next_run_at = Some(
                    next_after(due, schedule.repeat_minutes, Utc::now())?
                        .context("Choose a future time before resuming this task")?,
                );
            }
            schedule.last_error = None;
        }
        schedule.enabled = input.enabled;
        store::put(tx, "schedules", &id, &schedule)?;
        store::event(tx, "schedule.saved", &json!({"schedule_id":id}))?;
        Ok(schedule)
    })?;
    app.wake.notify_one();
    Ok(Json(schedule))
}

pub async fn delete(State(app): State<App>, Path(id): Path<String>) -> ApiResult<Value> {
    app.store.write(|tx| {
        let schedule: Schedule = store::get(tx, "schedules", &id)?;
        store::get::<Group>(tx, "groups", &schedule.group_id)?.ensure_active()?;
        ensure!(
            tx.execute("DELETE FROM schedules WHERE id=?", [&id])? == 1,
            "Scheduled task not found"
        );
        store::event(tx, "schedule.deleted", &json!({"schedule_id":id}))?;
        Ok(())
    })?;
    Ok(Json(json!({"deleted":true})))
}

fn next_after(
    due: DateTime<Utc>,
    minutes: Option<i64>,
    current: DateTime<Utc>,
) -> Result<Option<String>> {
    minutes
        .map(|minutes| {
            ensure!((1..=525600).contains(&minutes), "Invalid repeat interval");
            let seconds = minutes * 60;
            let steps = (current - due).num_seconds().max(0) / seconds + 1;
            Ok(due
                .checked_add_signed(Duration::seconds(steps * seconds))
                .context("Schedule date out of range")?
                .to_rfc3339())
        })
        .transpose()
}

pub fn tick(app: &App) -> Result<()> {
    let current = Utc::now();
    let due_ids = app.store.read(|conn| {
        let mut query = conn.prepare("SELECT id FROM schedules WHERE json_extract(data,'$.enabled')=1 AND json_extract(data,'$.next_run_at')<=? ORDER BY json_extract(data,'$.next_run_at') LIMIT 100")?;
        Ok(query.query_map([current.to_rfc3339()], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    for id in due_ids {
        app.store.write(|tx| {
            // Recheck inside the claim transaction so edits, pause and deletion win safely.
            let data: Option<String> = {
                use rusqlite::OptionalExtension;
                tx.query_row("SELECT data FROM schedules WHERE id=?", [&id], |r| r.get(0)).optional()?
            };
            let Some(data) = data else { return Ok(()) };
            let mut schedule: Schedule = serde_json::from_str(&data)?;
            if !schedule.enabled { return Ok(()) }
            let Some(due) = &schedule.next_run_at else { return Ok(()) };
            let due = DateTime::parse_from_rfc3339(due)?.with_timezone(&Utc);
            if due > current { return Ok(()) }
            if let Some(message_id) = &schedule.last_message_id {
                let runs = store::list::<Run>(tx, "runs")?;
                let roots: Vec<_> = runs.iter().filter(|r| &r.message_id == message_id).map(|r| &r.id).collect();
                if runs.iter().any(|r| coordination::active(r) && (&r.message_id == message_id || r.parent_run_id.as_ref().is_some_and(|id| roots.contains(&id)))) {
                    return Ok(());
                }
            }
            if crate::agent_tools::ensure_no_reset(tx,&schedule.group_id,None).is_err() { return Ok(()) }
            tx.execute_batch("SAVEPOINT schedule_message")?;
            let result = submit_message(tx, SendInput { id: crate::model::id(), group_id: schedule.group_id.clone(), side_chat_id: None, body: schedule.body.clone(), recipients: vec![], reply_to: None, artifacts: vec![] }, Some(id.clone()));
            match result {
                Ok(message) => {
                    tx.execute_batch("RELEASE schedule_message")?;
                    schedule.next_run_at = next_after(due, schedule.repeat_minutes, current)?;
                    schedule.enabled = schedule.next_run_at.is_some();
                    schedule.last_sent_at = Some(message.created_at);
                    schedule.last_message_id = Some(message.id);
                    schedule.last_error = None;
                }
                Err(error) => {
                    tx.execute_batch("ROLLBACK TO schedule_message; RELEASE schedule_message")?;
                    schedule.enabled = false;
                    schedule.last_error = Some(error.to_string());
                }
            }
            store::put(tx, "schedules", &id, &schedule)?;
            store::event(tx, "schedule.dispatched", &json!({"schedule_id":id,"group_id":schedule.group_id,"message_id":schedule.last_message_id,"error":schedule.last_error}))?;
            Ok(())
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restored_organization_pauses_saved_schedules() {
        let directory = tempfile::tempdir().unwrap();
        let database = store::Store::open(directory.path().into()).unwrap();
        let schedule = Schedule {
            id: id(),
            group_id: "general".into(),
            name: "Restore proof".into(),
            body: "Keep this paused".into(),
            start_at: now(),
            repeat_minutes: Some(60),
            next_run_at: Some(now()),
            enabled: true,
            last_sent_at: None,
            last_message_id: None,
            last_error: None,
        };
        database.put("schedules", &schedule.id, &schedule).unwrap();
        std::fs::write(directory.path().join(".state/restore.pending"), "").unwrap();
        drop(database);
        let restored = store::Store::open(directory.path().into()).unwrap();
        let saved: Schedule = restored.get("schedules", &schedule.id).unwrap();
        assert!(!saved.enabled);
        assert!(saved.last_error.unwrap().contains("Restored from backup"));
        assert_eq!(saved.body, schedule.body);
    }
    #[test]
    fn repeat_coalesces_downtime_without_drifting_or_replaying() {
        let due = DateTime::parse_from_rfc3339("2026-09-19T10:00:00+07:00")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(next_after(due, None, due).unwrap(), None);
        assert_eq!(
            next_after(due, Some(60), due + Duration::hours(25)).unwrap(),
            Some("2026-09-20T05:00:00+00:00".into())
        );
        assert_eq!(
            next_after(due, Some(1), due).unwrap(),
            Some("2026-09-19T03:01:00+00:00".into())
        );
        assert!(next_after(due, Some(0), due).is_err());
    }
}
