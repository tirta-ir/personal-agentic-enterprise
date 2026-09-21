use crate::{
    App,
    api::{SendInput, existing_message, validate_message_input},
    codex_usage, coordination,
    model::*,
    store,
};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::Connection;
use serde_json::json;

pub fn parse(body: &str) -> Result<Option<&'static str>> {
    let body = body.trim();
    if !body.starts_with('/') {
        return Ok(None);
    }
    match body {
        "/reset" => Ok(Some("reset")),
        "/usage" => Ok(Some("usage")),
        _ if body.split_whitespace().next() == Some("/btw") => Ok(Some("btw")),
        _ => bail!("Unknown chat command. Use /btw [question], /reset or /usage."),
    }
}

pub async fn send(app: &App, mut input: SendInput) -> Result<Message> {
    validate_message_input(&mut input)?;
    let command = parse(&input.body)?.context("Chat command required")?;
    ensure!(
        input.recipients.is_empty() && input.artifacts.is_empty() && input.reply_to.is_none(),
        "Send chat commands without recipients, attachments or a quoted reply."
    );
    if let Some(old) = app.store.read(|conn| {
        store::get::<Group>(conn, "groups", &input.group_id)?.ensure_active()?;
        crate::api::validate_side_chat(conn, &input.group_id, input.side_chat_id.as_deref())?;
        existing_message(conn, &input, None)
    })? {
        return Ok(old);
    }
    let usage = if command == "usage" {
        let app = app.clone();
        let group = input.group_id.clone();
        let side = input.side_chat_id.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                codex_usage::read_for_group(&app, &group, side.as_deref())
            })
            .await??,
        )
    } else {
        None
    };
    app.store.write(|conn| record(conn, input, command, usage))
}

fn record(
    conn: &Connection,
    input: SendInput,
    command: &str,
    usage: Option<codex_usage::UsageReport>,
) -> Result<Message> {
    record_as(conn, input, command, usage, "owner")
}

pub(crate) fn record_as(
    conn: &Connection,
    input: SendInput,
    command: &str,
    usage: Option<codex_usage::UsageReport>,
    actor: &str,
) -> Result<Message> {
    if let Some(old) = existing_message(conn, &input, None)? {
        return Ok(old);
    }
    store::get::<Group>(conn, "groups", &input.group_id)?.ensure_active()?;
    crate::api::validate_side_chat(conn, &input.group_id, input.side_chat_id.as_deref())?;
    let body = if command == "reset" {
        ensure!(
            !store::list::<Run>(conn, "runs")?
                .iter()
                .any(|run| run.group_id == input.group_id
                    && (input.side_chat_id.is_none() || run.side_chat_id == input.side_chat_id)
                    && coordination::active(run)),
            "Stop or wait for active runs in this {} before /reset. No sessions have been changed.",
            if input.side_chat_id.is_some() {
                "side chat"
            } else {
                "group"
            }
        );
        conn.execute(
            "UPDATE sessions SET active=0 WHERE group_id=?1 AND (?2 IS NULL OR side_chat_id=?2) AND active=1",
            rusqlite::params![input.group_id, input.side_chat_id],
        )?;
        if input.side_chat_id.is_some() {
            "Fresh conversation started for every agent in this side chat. Main chat and other side chats are unchanged. Visible history, instructions and files are preserved."
        } else {
            "Fresh conversation started for every agent in this group, including your direct reports and all side chats. Your next message uses new sessions and fresh chat context. Visible history, agent instructions, files and scheduled tasks are preserved. Other groups are unchanged."
        }.to_owned()
    } else {
        "Harness usage".to_owned()
    };
    let message = Message {
        id: input.id,
        group_id: input.group_id,
        side_chat_id: input.side_chat_id,
        sender: actor.into(),
        body: input.body,
        recipients: vec![],
        reply_to: None,
        artifacts: vec![],
        run_id: None,
        created_at: now(),
        auto_routed: false,
        schedule_id: None,
        command: Some(command.into()),
        usage_report: None,
    };
    let response = Message {
        id: id(),
        sender: "system".into(),
        body,
        usage_report: usage,
        ..message.clone()
    };
    store::put(conn, "messages", &message.id, &message)?;
    store::put(conn, "messages", &response.id, &response)?;
    store::event(
        conn,
        "chat.command",
        &json!({"group_id":message.group_id,"message_id":message.id,"command":command}),
    )?;
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn side_chats_isolate_sessions_context_queues_and_reset() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = store::Store::open(directory.path().join("org"))?;
        let mut ceo: Agent = db.get("agents", "ceo")?;
        ceo.workdir = Some(crate::security::validate_workspace(
            directory.path().to_str().unwrap(),
        )?);
        db.put("agents", &ceo.id, &ceo)?;
        let mut other: Group = db.get("groups", "general")?;
        other.id = "other".into();
        db.put("groups", &other.id, &other)?;
        let input = |id: &str, body: &str, side: Option<&str>| SendInput {
            id: id.into(),
            group_id: "general".into(),
            body: body.into(),
            side_chat_id: side.map(str::to_owned),
            recipients: vec![],
            reply_to: None,
            artifacts: vec![],
        };
        let send = |value| db.write(|conn| crate::api::submit_message(conn, value, None));
        let root = send(input("side", "/btw", None))?;
        assert_eq!(root.side_chat_id.as_deref(), Some("side"));
        assert!(db.list::<Run>("runs")?.is_empty());
        assert_eq!(
            db.read(|c| Ok(
                c.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))?
            ))?,
            0
        );
        assert_eq!(send(input("side", "/btw", None))?.id, root.id);
        let main = send(input("main", "MAIN_CONTEXT", None))?;
        let side = send(input("question", "SIDE_CONTEXT", Some("side")))?;
        let runs = db.list::<Run>("runs")?;
        assert_eq!(runs.len(), 2);
        assert_ne!(runs[0].session_id, runs[1].session_id);
        assert!(!crate::runtime::conflicts(&runs[0], &runs[1]));
        assert_eq!(runs[1].side_chat_id.as_deref(), Some("side"));
        assert_eq!(
            db.read(|c| coordination::recent_messages(c, "general", &side.id))?
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            Vec::<&str>::new(),
        );
        let inline = send(input("inline", "/btw INLINE_CONTEXT", None))?;
        assert_eq!(
            db.list::<Run>("runs")?.last().unwrap().task.as_deref(),
            Some("INLINE_CONTEXT")
        );
        let after = send(input("after", "Follow up", None))?;
        assert_eq!(
            db.read(|c| coordination::recent_messages(c, "general", &after.id))?
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            [main.id.as_str()]
        );
        assert_eq!(
            db.read(|c| coordination::recent_messages(c, "general", &inline.id))?
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            [main.id.as_str()]
        );
        let followup = send(input("side-next", "Side follow up", Some("side")))?;
        let queued = db.list::<Run>("runs")?.last().unwrap().clone();
        assert_eq!(queued.session_id, runs[1].session_id);
        assert!(crate::runtime::conflicts(&queued, &runs[1]));
        assert_eq!(
            db.read(|c| coordination::recent_messages(c, "general", &followup.id))?
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            [side.id.as_str()]
        );
        // This side can reset while main and another side still have queued work.
        assert!(
            db.write(|c| record(
                c,
                input("side-reset", "/reset", Some("side")),
                "reset",
                None
            ))
            .is_err()
        );
        for mut run in db
            .list::<Run>("runs")?
            .into_iter()
            .filter(|r| r.side_chat_id.as_deref() == Some("side"))
        {
            run.status = "succeeded".into();
            db.put("runs", &run.id, &run)?;
        }
        db.write(|c| {
            record(
                c,
                input("side-reset", "/reset", Some("side")),
                "reset",
                None,
            )
        })?;
        assert!(db.read(|c| Ok(c.query_row(
            "SELECT active FROM sessions WHERE id=?",
            [&runs[0].session_id],
            |r| r.get::<_, bool>(0)
        )?))?);
        assert!(!db.read(|c| Ok(c.query_row(
            "SELECT active FROM sessions WHERE id=?",
            [&runs[1].session_id],
            |r| r.get::<_, bool>(0)
        )?))?);
        let fresh = send(input("fresh-side", "Fresh side", Some("side")))?;
        assert!(
            db.read(|c| coordination::recent_messages(c, "general", &fresh.id))?
                .is_empty()
        );
        assert_ne!(
            db.list::<Run>("runs")?.last().unwrap().session_id,
            runs[1].session_id
        );
        let mut cross_reply = input("cross-reply", "No side quote in main", None);
        cross_reply.reply_to = Some(side.id.clone());
        assert!(send(cross_reply).is_err());
        let mut cross_group = input("cross", "No cross-group side chat", Some("side"));
        cross_group.group_id = "other".into();
        assert!(send(cross_group).is_err());
        assert!(send(input("missing", "Missing side", Some("unknown"))).is_err());
        assert!(send(input("not-root", "Not a side root", Some("main"))).is_err());
        assert!(send(input("question", "SIDE_CONTEXT", None)).is_err());
        assert!(db.get::<Message>("messages", "cross").is_err());
        assert_eq!(parse("/btw question")?, Some("btw"));
        assert!(parse("/btwhat").is_err());
        Ok(())
    }
    #[test]
    fn legacy_mixed_sessions_migrate_once_without_retiring_unrelated_sessions() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = store::Store::open(directory.path().into())?;
        let mut ceo: Agent = db.get("agents", "ceo")?;
        ceo.workdir = Some(crate::security::validate_workspace(
            directory.path().to_str().unwrap(),
        )?);
        db.put("agents", &ceo.id, &ceo)?;
        let mut other: Group = db.get("groups", "general")?;
        other.id = "other".into();
        db.put("groups", &other.id, &other)?;
        let input = |id: &str, group: &str, body: &str| SendInput {
            id: id.into(),
            group_id: group.into(),
            body: body.into(),
            side_chat_id: None,
            recipients: vec![],
            reply_to: None,
            artifacts: vec![],
        };
        for value in [
            input("main", "general", "Main"),
            input("side", "general", "/btw"),
            input("other", "other", "Other"),
        ] {
            db.write(|c| crate::api::submit_message(c, value, None))?;
        }
        let runs = db.list::<Run>("runs")?;
        let mut legacy = runs[0].clone();
        legacy.side_chat_id = Some("side".into());
        legacy.status = "succeeded".into();
        db.put("runs", &legacy.id, &legacy)?;
        db.write(|c| {
            c.execute_batch("DROP INDEX session_context; ALTER TABLE sessions DROP COLUMN side_chat_id; CREATE UNIQUE INDEX session_context ON sessions(group_id,agent_id,workspace) WHERE active=1; UPDATE metadata SET value='1' WHERE key='schema_version'; UPDATE sessions SET native_id='retained-native-id';")?;
            Ok(())
        })?;
        drop(db);
        for _ in 0..2 {
            let db = store::Store::open(directory.path().into())?;
            assert!(!db.read(|c| Ok(c.query_row(
                "SELECT active FROM sessions WHERE id=?",
                [&legacy.session_id],
                |r| r.get::<_, bool>(0)
            )?))?);
            assert!(db.read(|c| Ok(c.query_row(
                "SELECT active FROM sessions WHERE id=?",
                [&runs[1].session_id],
                |r| r.get::<_, bool>(0)
            )?))?);
            assert_eq!(
                db.read(|c| Ok(c.query_row(
                    "SELECT native_id FROM sessions WHERE id=?",
                    [&runs[1].session_id],
                    |r| r.get::<_, String>(0)
                )?))?,
                "retained-native-id"
            );
            assert_eq!(db.list::<Message>("messages")?.len(), 3);
        }
        Ok(())
    }
    #[test]
    fn reset_is_atomic_idempotent_and_bounds_every_agents_context() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = store::Store::open(directory.path().into())?;
        let mut ceo: Agent = db.get("agents", "ceo")?;
        ceo.workdir = Some(crate::security::validate_workspace(
            directory.path().to_str().unwrap(),
        )?);
        db.put("agents", &ceo.id, &ceo)?;
        let mut worker = ceo.clone();
        worker.id = "worker".into();
        worker.reports_to = Some(ceo.id.clone());
        db.put("agents", &worker.id, &worker)?;
        let group = Group {
            project: None,
            scope_levels: None,
            chat_lead_id: None,
            archived_at: None,
            deleted_at: None,
            id: "other".into(),
            name: "Other".into(),
            description: String::new(),
        };
        db.put("groups", &group.id, &group)?;
        let input = |key: &str, group: &str, body: &str| SendInput {
            id: key.into(),
            group_id: group.into(),
            side_chat_id: None,
            body: body.into(),
            recipients: vec![],
            reply_to: None,
            artifacts: vec![],
        };
        let old = db.write(|conn| {
            crate::api::submit_message(conn, input("old", "general", "OLD_CONTEXT"), None)
        })?;
        db.write(|conn| {
            coordination::enqueue(conn, &old, worker.clone(), RunKind::Direct, None, None)?;
            Ok(())
        })?;
        db.write(|conn| {
            crate::api::submit_message(conn, input("outside", "other", "OTHER_CONTEXT"), None)
        })?;
        assert!(
            db.write(|conn| record(conn, input("reset", "general", "/reset"), "reset", None))
                .is_err()
        );
        assert!(db.get::<Message>("messages", "reset").is_err());
        for mut run in db.list::<Run>("runs")? {
            run.status = "waiting".into();
            db.put("runs", &run.id, &run)?;
        }
        assert!(
            db.write(|conn| record(conn, input("reset", "general", "/reset"), "reset", None))
                .is_err()
        );
        for mut run in db.list::<Run>("runs")? {
            run.status = "succeeded".into();
            db.put("runs", &run.id, &run)?;
        }
        db.write(|conn| record(conn, input("reset", "general", "/reset"), "reset", None))?;
        assert_eq!(
            db.read(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM sessions WHERE group_id='general' AND active=1",
                [],
                |r| r.get::<_, i64>(0)
            )?))?,
            0
        );
        assert_eq!(
            db.read(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM sessions WHERE group_id='other' AND active=1",
                [],
                |r| r.get::<_, i64>(0)
            )?))?,
            1
        );
        let after = db.write(|conn| {
            crate::api::submit_message(conn, input("after", "general", "NEW_CONTEXT"), None)
        })?;
        assert!(
            db.read(|c| coordination::recent_messages(c, "general", &after.id))?
                .is_empty()
        );
        // Retrying the same command must not reset the newly-created session again.
        let count = db.list::<Message>("messages")?.len();
        db.write(|conn| record(conn, input("reset", "general", "/reset"), "reset", None))?;
        assert_eq!(db.list::<Message>("messages")?.len(), count);
        assert_eq!(
            db.read(|c| Ok(c.query_row(
                "SELECT COUNT(*) FROM sessions WHERE group_id='general' AND active=1",
                [],
                |r| r.get::<_, i64>(0)
            )?))?,
            1
        );
        assert!(parse("/reset all").is_err());
        assert!(parse("/typo").is_err());
        assert_eq!(parse(" /usage ")?, Some("usage"));
        Ok(())
    }
}
