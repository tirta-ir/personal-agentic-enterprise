// Question/answer shapes follow openai/codex request_user_input.rs (see UPSTREAM.md).
// The existing exec adapter transports them through its native MCP client.
use crate::{App, group_scope, model::*, security::ApiResult, store};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, State},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    sync::atomic::Ordering,
    time::Duration,
};
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Answer {
    pub answers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct QuestionRequest {
    pub id: String,
    pub request_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub group_id: String,
    pub side_chat_id: Option<String>,
    pub questions: Vec<Question>,
    pub answers: BTreeMap<String, Answer>,
    pub status: String,
    #[serde(default)]
    pub delivered: bool,
    pub created_at: String,
    pub answered_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AskInput {
    request_id: String,
    questions: Vec<Question>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnswerInput {
    answers: BTreeMap<String, Answer>,
}

pub fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"required":["request_id","questions"],"properties":{
        "request_id":{"type":"string","maxLength":128},
        "questions":{"type":"array","minItems":1,"maxItems":3,"items":{
            "type":"object","additionalProperties":false,"required":["id","header","question","options"],"properties":{
                "id":{"type":"string"},"header":{"type":"string"},"question":{"type":"string"},
                "options":{"type":"array","maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["label","description"],"properties":{"label":{"type":"string"},"description":{"type":"string"}}}}
            }
        }}
    }})
}

fn bounded(value: &str, max: usize, name: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.len() <= max,
        "{name} must contain 1–{max} bytes"
    );
    Ok(())
}

fn create(conn: &Connection, run: &Run, input: AskInput) -> Result<QuestionRequest> {
    ensure!(
        run.kind != RunKind::Summary,
        "Summary turns must report the existing result, not repeat the original work or ask new questions. The assigned worker owns clarification."
    );
    bounded(&input.request_id, 128, "Request ID")?;
    ensure!(
        (1..=3).contains(&input.questions.len()),
        "Ask one to three questions at a time"
    );
    let mut ids = HashSet::new();
    for q in &input.questions {
        bounded(&q.id, 64, "Question ID")?;
        ensure!(ids.insert(&q.id), "Question IDs must be unique");
        bounded(&q.header, 100, "Question header")?;
        bounded(&q.question, 4000, "Question")?;
        ensure!(q.options.len() <= 8, "At most eight choices per question");
        let mut labels = HashSet::new();
        for option in &q.options {
            bounded(&option.label, 200, "Choice")?;
            ensure!(
                option.description.len() <= 1000 && labels.insert(&option.label),
                "Choices must be unique, with descriptions up to 1000 bytes"
            );
        }
    }
    let current: Run = store::get(conn, "runs", &run.id)?;
    ensure!(
        ["starting", "running"].contains(&current.status.as_str()),
        "Run is no longer active"
    );
    let group: Group = store::get(conn, "groups", &run.group_id)?;
    group.ensure_active()?;
    group_scope::access(conn, &group)?.ensure_allowed(&run.agent_id, run.kind)?;
    let existing: Option<String> = conn.query_row("SELECT data FROM questions WHERE json_extract(data,'$.run_id')=? AND json_extract(data,'$.request_id')=?", params![run.id,input.request_id], |r|r.get(0)).optional()?;
    if let Some(existing) = existing {
        let existing: QuestionRequest = serde_json::from_str(&existing)?;
        ensure!(
            existing.questions == input.questions,
            "Request ID was already used for different questions"
        );
        return Ok(existing);
    }
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM questions WHERE json_extract(data,'$.run_id')=?",
        [&run.id],
        |r| r.get(0),
    )?;
    ensure!(count < 20, "Maximum twenty question requests per run");
    ensure!(
        !pending(conn, &run.id)?,
        "Wait for the current answer before asking another question"
    );
    let request = QuestionRequest {
        id: id(),
        request_id: input.request_id,
        run_id: run.id.clone(),
        agent_id: run.agent_id.clone(),
        agent_name: run.profile.name.clone(),
        group_id: run.group_id.clone(),
        side_chat_id: run.side_chat_id.clone(),
        questions: input.questions,
        answers: BTreeMap::new(),
        status: "pending".into(),
        delivered: false,
        created_at: now(),
        answered_at: None,
        error: None,
    };
    store::put(conn, "questions", &request.id, &request)?;
    // A system card lets the owner answer private delegates without giving them chat participation.
    let message = Message {
        id: request.id.clone(),
        group_id: run.group_id.clone(),
        side_chat_id: run.side_chat_id.clone(),
        sender: "system".into(),
        body: format!(
            "{} needs your answer{}.",
            run.profile.name,
            if run.kind == RunKind::Delegate {
                " on delegated work"
            } else {
                ""
            }
        ),
        recipients: vec![],
        reply_to: Some(run.message_id.clone()),
        artifacts: vec![],
        run_id: Some(run.id.clone()),
        created_at: request.created_at.clone(),
        auto_routed: false,
        schedule_id: None,
        command: Some("question".into()),
        usage_report: None,
    };
    store::put(conn, "messages", &message.id, &message)?;
    store::event(
        conn,
        "question.created",
        &json!({"id":request.id,"run_id":run.id}),
    )?;
    Ok(request)
}

pub fn pending(conn: &Connection, run_id: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM questions WHERE json_extract(data,'$.run_id')=? AND json_extract(data,'$.status')='pending')",[run_id],|r|r.get(0))?)
}

pub fn unresolved(app: &App, run_id: &str) -> Result<Vec<QuestionRequest>> {
    app.store.read(|conn| {
        conn.prepare("SELECT data FROM questions WHERE json_extract(data,'$.run_id')=? AND (json_extract(data,'$.status')='pending' OR (json_extract(data,'$.status')='answered' AND COALESCE(json_extract(data,'$.delivered'),0)=0)) ORDER BY rowid")?
            .query_map([run_id],|r|r.get::<_,String>(0))?.map(|r|Ok(serde_json::from_str(&r?)?)).collect()
    })
}

pub fn delivered(app: &App, run_id: &str, request_id: &str) -> Result<()> {
    app.store.write(|conn| {
        let item: Option<String> = conn.query_row("SELECT data FROM questions WHERE json_extract(data,'$.run_id')=? AND json_extract(data,'$.request_id')=? AND json_extract(data,'$.status')='answered' AND COALESCE(json_extract(data,'$.delivered'),0)=0",params![run_id,request_id],|r|r.get(0)).optional()?;
        if let Some(item) = item {
            let mut item: QuestionRequest = serde_json::from_str(&item)?;
            item.delivered=true;
            store::put(conn,"questions",&item.id,&item)?;
            store::event(conn,"question.delivered",&json!({"id":item.id,"run_id":run_id}))?;
        }
        Ok(())
    })
}

pub fn wait_for_answers(
    app: &App,
    run: &mut Run,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<QuestionRequest>> {
    loop {
        if cancelled.load(Ordering::SeqCst) {
            run.status = "cancelled".into();
            run.ended_at = Some(now());
            app.store.put("runs", &run.id, run)?;
            app.store.event("run.changed", json!({"run_id":run.id}))?;
            return Ok(vec![]);
        }
        let items = unresolved(app, &run.id)?;
        if items.iter().all(|q| q.status == "answered") {
            return Ok(items);
        }
        if items.iter().any(|q| {
            chrono::DateTime::parse_from_rfc3339(&q.created_at)
                .is_ok_and(|at| chrono::Utc::now().signed_duration_since(at).num_hours() >= 24)
        }) {
            cancelled.store(true, Ordering::SeqCst);
            close(
                app,
                &run.id,
                "expired",
                "No answer received within 24 hours. The run was stopped without assuming an answer.",
            )?;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

pub fn ask(app: &App, run: &Run, args: Value) -> Result<Value> {
    let request = app
        .store
        .write(|conn| create(conn, run, serde_json::from_value(args)?))?;
    loop {
        let question: QuestionRequest = app.store.get("questions", &request.id)?;
        if question.status == "answered" {
            return Ok(json!({"answers":question.answers}));
        }
        ensure!(
            question.status == "pending",
            "{}",
            question
                .error
                .as_deref()
                .unwrap_or("Question is no longer waiting for an answer")
        );
        let cancelled = app
            .cancellations
            .lock()
            .map_err(|_| anyhow::anyhow!("Cancellation registry unavailable"))?
            .get(&run.id)
            .cloned();
        let current: Run = app.store.get("runs", &run.id)?;
        if cancelled
            .as_ref()
            .is_none_or(|flag| flag.load(Ordering::SeqCst))
            || !["starting", "running"].contains(&current.status.as_str())
        {
            if cancelled
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                close(
                    app,
                    &run.id,
                    "cancelled",
                    "This run was stopped before receiving your answer.",
                )?;
            } else {
                finish(app, &current)?;
            }
            anyhow::bail!("Run ended before the owner answered; do not assume an answer");
        }
        if chrono::Utc::now()
            .signed_duration_since(chrono::DateTime::parse_from_rfc3339(&question.created_at)?)
            .num_hours()
            >= 24
        {
            cancelled
                .context("Run ownership unavailable")?
                .store(true, Ordering::SeqCst);
            close(
                app,
                &run.id,
                "expired",
                "No answer received within 24 hours. The run was stopped without assuming an answer.",
            )?;
            anyhow::bail!("Question expired without an answer");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn save_answer(conn: &Connection, id: &str, input: AnswerInput) -> Result<QuestionRequest> {
    let mut question: QuestionRequest = store::get(conn, "questions", id)?;
    if question.status == "answered" {
        ensure!(
            question.answers == input.answers,
            "This question was already answered differently"
        );
        return Ok(question);
    }
    ensure!(
        question.status == "pending",
        "This question is no longer awaiting an answer"
    );
    let run: Run = store::get(conn, "runs", &question.run_id)?;
    ensure!(
        ["starting", "running"].contains(&run.status.as_str()),
        "Run is no longer active"
    );
    let group: Group = store::get(conn, "groups", &question.group_id)?;
    group.ensure_active()?;
    group_scope::access(conn, &group)?.ensure_allowed(&run.agent_id, run.kind)?;
    ensure!(
        input.answers.len() == question.questions.len(),
        "Answer every question exactly once"
    );
    for q in &question.questions {
        let answer = input
            .answers
            .get(&q.id)
            .context("A question has no answer")?;
        ensure!(
            answer.answers.len() == 1,
            "Provide one choice or written answer per question"
        );
        bounded(&answer.answers[0], 16000, "Answer")?;
    }
    question.answers = input.answers;
    question.status = "answered".into();
    question.answered_at = Some(now());
    store::put(conn, "questions", &question.id, &question)?;
    store::event(
        conn,
        "question.answered",
        &json!({"id":question.id,"run_id":question.run_id}),
    )?;
    Ok(question)
}

pub async fn answer(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<AnswerInput>,
) -> ApiResult<QuestionRequest> {
    let question: QuestionRequest = app.store.get("questions", &id)?;
    if question.status == "pending" {
        let flags = app
            .cancellations
            .lock()
            .map_err(|_| anyhow::anyhow!("Cancellation registry unavailable"))?;
        if !flags
            .get(&question.run_id)
            .is_some_and(|flag| !flag.load(Ordering::SeqCst))
        {
            return Err(anyhow::anyhow!("Run is stopping or no longer available").into());
        }
    }
    Ok(Json(app.store.write(|conn| save_answer(conn, &id, input))?))
}

pub async fn get(State(app): State<App>, Path(id): Path<String>) -> ApiResult<QuestionRequest> {
    Ok(Json(app.store.get("questions", &id)?))
}

pub fn recent(app: &App) -> Result<Vec<QuestionRequest>> {
    app.store.read(|conn| {
        let mut query = conn.prepare("SELECT data FROM questions WHERE json_extract(data,'$.status')='pending' OR id IN (SELECT id FROM questions ORDER BY rowid DESC LIMIT 100) ORDER BY rowid")?;
        query.query_map([],|r|r.get::<_,String>(0))?.map(|r|Ok(serde_json::from_str(&r?)?)).collect()
    })
}

fn close(app: &App, run_id: &str, status: &str, error: &str) -> Result<()> {
    app.store.write(|conn| {
        let items=conn.prepare("SELECT data FROM questions WHERE json_extract(data,'$.run_id')=? AND (json_extract(data,'$.status')='pending' OR (json_extract(data,'$.status')='answered' AND COALESCE(json_extract(data,'$.delivered'),0)=0))")?.query_map([run_id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for item in items {
            let mut item: QuestionRequest = serde_json::from_str(&item)?;
            item.status=status.into(); item.error=Some(error.into());
            store::put(conn,"questions",&item.id,&item)?;
            store::event(conn,"question.closed",&json!({"id":item.id,"run_id":run_id}))?;
        }
        Ok(())
    })
}

pub fn finish(app: &App, run: &Run) -> Result<()> {
    close(
        app,
        &run.id,
        if run.status == "cancelled" {
            "cancelled"
        } else {
            "interrupted"
        },
        "This run stopped before receiving your answer. Send a new message to continue.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_validated_idempotent_and_invalidated_on_restart() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let db = store::Store::open(temp.path().join("org"))?;
        let mut agent: Agent = db.get("agents", "ceo")?;
        agent.workdir = Some(crate::security::validate_workspace(
            temp.path().to_str().unwrap(),
        )?);
        db.put("agents", &agent.id, &agent)?;
        db.write(|conn| {
            crate::api::submit_message(
                conn,
                crate::api::SendInput {
                    id: id(),
                    group_id: "general".into(),
                    side_chat_id: None,
                    body: "Ask a question".into(),
                    recipients: vec![agent.id.clone()],
                    reply_to: None,
                    artifacts: vec![],
                },
                None,
            )
        })?;
        let mut run = db.list::<Run>("runs")?.remove(0);
        run.status = "running".into();
        db.put("runs", &run.id, &run)?;
        let input = |request: &str| AskInput {
            request_id: request.into(),
            questions: vec![Question {
                id: "choice".into(),
                header: "Format".into(),
                question: "Which format?".into(),
                options: vec![QuestionOption {
                    label: "Markdown".into(),
                    description: "Readable text".into(),
                }],
            }],
        };
        let mut summary = run.clone();
        summary.kind = RunKind::Summary;
        assert!(
            db.write(|conn| create(conn, &summary, input("summary")))
                .is_err()
        );
        let request = db.write(|conn| create(conn, &run, input("first")))?;
        assert!(db.read(|conn| pending(conn, &run.id))?);
        assert_eq!(
            db.write(|conn| create(conn, &run, input("first")))?.id,
            request.id
        );
        let mut changed = input("first");
        changed.questions[0].question = "Different question".into();
        assert!(db.write(|conn| create(conn, &run, changed)).is_err());
        assert!(
            db.write(|conn| create(conn, &run, input("second")))
                .is_err()
        );
        assert!(
            db.write(|conn| save_answer(
                conn,
                &request.id,
                AnswerInput {
                    answers: BTreeMap::new()
                }
            ))
            .is_err()
        );
        let answer = |text: &str| AnswerInput {
            answers: BTreeMap::from([(
                "choice".into(),
                Answer {
                    answers: vec![text.into()],
                },
            )]),
        };
        assert!(
            db.write(|conn| save_answer(conn, &request.id, answer(" ")))
                .is_err()
        );
        let saved = db.write(|conn| save_answer(conn, &request.id, answer("My own format")))?;
        assert_eq!(saved.status, "answered");
        assert!(!db.read(|conn| pending(conn, &run.id))?);
        assert_eq!(
            db.write(|conn| save_answer(conn, &request.id, answer("My own format")))?
                .answered_at,
            saved.answered_at
        );
        assert!(
            db.write(|conn| save_answer(conn, &request.id, answer("Changed answer")))
                .is_err()
        );
        let pending = db.write(|conn| create(conn, &run, input("second")))?;
        let message: Message = db.get("messages", &pending.id)?;
        assert_eq!(message.sender, "system");
        assert_eq!(message.run_id.as_deref(), Some(run.id.as_str()));
        drop(db);
        let reopened = store::Store::open(temp.path().join("org"))?;
        assert_eq!(
            reopened
                .get::<QuestionRequest>("questions", &request.id)?
                .status,
            "interrupted"
        );
        assert_eq!(
            reopened
                .get::<QuestionRequest>("questions", &pending.id)?
                .status,
            "interrupted"
        );
        assert_eq!(
            reopened
                .get::<QuestionRequest>("questions", &request.id)?
                .answers["choice"]
                .answers,
            ["My own format"]
        );
        assert!(
            reopened
                .write(|conn| save_answer(conn, &pending.id, answer("Too late")))
                .is_err()
        );
        Ok(())
    }
}
