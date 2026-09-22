use crate::{coordination, model::*, store};
use anyhow::{Result, ensure};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupAccess {
    pub levels: Option<Vec<u32>>,
    pub participant_ids: Vec<String>,
    pub delegate_ids: Vec<String>,
    pub chat_lead_id: Option<String>,
}

impl GroupAccess {
    pub fn ensure_allowed(&self, agent_id: &str, kind: RunKind) -> Result<()> {
        let allowed = if kind == RunKind::Delegate {
            &self.delegate_ids
        } else {
            &self.participant_ids
        };
        ensure!(
            allowed.iter().any(|id| id == agent_id),
            "Agent is outside this group's {} scope",
            if kind == RunKind::Delegate {
                "delegation"
            } else {
                "chat"
            }
        );
        Ok(())
    }
}

pub fn access(conn: &Connection, group: &Group) -> Result<GroupAccess> {
    let agents: Vec<Agent> = store::list::<Agent>(conn, "agents")?
        .into_iter()
        .filter(|agent| agent.deleted_at.is_none())
        .collect();
    let mut result = GroupAccess {
        levels: group.scope_levels.clone(),
        participant_ids: vec![],
        delegate_ids: vec![],
        chat_lead_id: None,
    };
    let mut candidates = vec![];
    if group.project.is_none() {
        if let Some(invited) = &group.member_ids {
            let mut included = std::collections::BTreeSet::new();
            for id in invited {
                let mut current = Some(id.as_str());
                let mut seen = std::collections::HashSet::new();
                while let Some(id) = current {
                    ensure!(
                        seen.insert(id),
                        "Reporting relationships cannot form a cycle"
                    );
                    let agent = agents.iter().find(|a| a.id == id && a.project_id.is_none());
                    let Some(agent) = agent else { break };
                    included.insert(agent.id.clone());
                    current = agent.reports_to.as_deref();
                }
            }
            result.participant_ids = included.into_iter().collect();
            result.delegate_ids = result.participant_ids.clone();
            return Ok(result);
        }
    }
    for agent in &agents {
        let level = if let Some(project) = &group.project {
            if !project.members.iter().any(|m| m.agent_id == agent.id) {
                continue;
            }
            crate::projects::level(project, &agent.id)?
        } else {
            if agent.project_id.is_some() {
                continue;
            }
            u32::try_from(coordination::reporting_chain(&agents, &agent.id)?.len())?
        };
        let participant = group
            .scope_levels
            .as_ref()
            .is_none_or(|levels| levels.contains(&level));
        // Any selected level and its descendants can receive delegated work.
        if group
            .scope_levels
            .as_ref()
            .is_none_or(|levels| levels.iter().any(|selected| *selected <= level))
        {
            result.delegate_ids.push(agent.id.clone());
        }
        if participant {
            result.participant_ids.push(agent.id.clone());
            if agent.enabled {
                candidates.push((level, agent.id.clone()));
            }
        }
    }
    candidates.sort();
    let preferred = group
        .chat_lead_id
        .clone()
        .or(coordination::lead(conn)?.map(|agent| agent.id));
    result.chat_lead_id =
        preferred.filter(|id| candidates.iter().any(|(_, candidate)| candidate == id));
    // An explicit selection never silently switches to another agent.
    if result.chat_lead_id.is_none()
        && group.chat_lead_id.is_none()
        && (group.scope_levels.is_some() || group.project.is_some())
    {
        result.chat_lead_id = candidates.first().map(|(_, id)| id.clone());
    }
    Ok(result)
}

pub fn validate(conn: &Connection, group: &mut Group) -> Result<()> {
    crate::projects::validate(conn, group)?;
    if let Some(ids) = &mut group.member_ids {
        ensure!(
            group.project.is_none(),
            "Project membership is managed in its structure"
        );
        ids.sort();
        ids.dedup();
        for id in ids {
            let agent: Agent = store::get(conn, "agents", id)?;
            ensure!(
                agent.deleted_at.is_none() && agent.project_id.is_none(),
                "Invite an active organization agent"
            );
        }
        group.scope_levels = None;
        group.chat_lead_id = None;
    }
    if let Some(levels) = &mut group.scope_levels {
        ensure!(
            !levels.is_empty() && levels.len() <= 1000 && levels.iter().all(|level| *level > 0),
            "Choose at least one organization level; Level 1 is directly under the owner"
        );
        levels.sort_unstable();
        ensure!(
            levels.windows(2).all(|pair| pair[0] != pair[1]),
            "Duplicate organization level"
        );
    }
    if let Some(id) = &group.chat_lead_id {
        let agent: Agent = store::get(conn, "agents", id)?;
        ensure!(
            agent.enabled && agent.deleted_at.is_none(),
            "Choose an enabled chat lead"
        );
        access(conn, group)?.ensure_allowed(id, RunKind::Coordinator)?;
    }
    Ok(())
}

/// Match complete mention tokens: @Ann must not invoke @Anna.
pub fn mentions(conn: &Connection, group: &Group, body: &str) -> Result<Vec<String>> {
    let allowed = access(conn, group)?;
    let text = body.to_lowercase();
    let matches = |name: &str| {
        let needle = format!("@{}", name.to_lowercase());
        text.match_indices(&needle).any(|(start, _)| {
            let before = text[..start].chars().next_back();
            let after = text[start + needle.len()..].chars().next();
            before.is_none_or(|c| c.is_whitespace() || "([{".contains(c))
                && after.is_none_or(|c| c.is_whitespace() || ",.!?:;)]}".contains(c))
        })
    };
    Ok(store::list::<Agent>(conn, "agents")?
        .into_iter()
        .filter(|a| {
            a.enabled
                && allowed.participant_ids.contains(&a.id)
                && (matches("all") || matches(&a.id) || matches(&a.name))
        })
        .map(|a| a.id)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_address_the_quoted_agent_once_and_preserve_scope() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = store::Store::open(directory.path().join("org"))?;
        let mut ceo: Agent = db.get("agents", "ceo")?;
        ceo.workdir = Some(crate::security::validate_workspace(
            directory.path().to_str().unwrap(),
        )?);
        db.put("agents", "ceo", &ceo)?;
        let mut other = ceo.clone();
        other.id = "other".into();
        other.name = "Other".into();
        db.put("agents", "other", &other)?;
        let send = |id: &str, reply: Option<&str>, body: &str| {
            db.write(|conn| {
                crate::api::submit_message(
                    conn,
                    crate::api::SendInput {
                        id: id.into(),
                        group_id: "general".into(),
                        side_chat_id: None,
                        body: body.into(),
                        recipients: vec![],
                        reply_to: reply.map(str::to_owned),
                        artifacts: vec![],
                    },
                    None,
                )
            })
        };
        let human = send("human", None, "Hello")?;
        assert!(
            send("human-reply", Some(&human.id), "Reply to human")?
                .recipients
                .is_empty()
        );
        let mut answer = human.clone();
        answer.id = "answer".into();
        answer.sender = "ceo".into();
        db.put("messages", &answer.id, &answer)?;
        let reply = send("follow-up", Some(&answer.id), "Continue")?;
        assert_eq!(reply.recipients, ["ceo"]);
        assert_eq!(
            send("follow-up", Some(&answer.id), "Continue")?.id,
            reply.id
        );
        assert_eq!(db.list::<Run>("runs")?.len(), 1);
        assert_eq!(
            send("override", Some(&answer.id), "@other check this")?.recipients,
            ["other"]
        );
        answer.group_id = "elsewhere".into();
        db.put("messages", &answer.id, &answer)?;
        assert!(send("cross-group", Some(&answer.id), "Continue").is_err());
        answer.group_id = "general".into();
        answer.side_chat_id = Some("private-side".into());
        db.put("messages", &answer.id, &answer)?;
        assert!(send("cross-side", Some(&answer.id), "Continue").is_err());
        answer.side_chat_id = None;
        db.put("messages", &answer.id, &answer)?;
        let mut group: Group = db.get("groups", "general")?;
        group.member_ids = Some(vec!["other".into()]);
        db.put("groups", "general", &group)?;
        assert!(send("excluded", Some(&answer.id), "Continue").is_err());
        assert_eq!(db.list::<Run>("runs")?.len(), 2);
        assert!(db.get::<Message>("messages", "excluded").is_err());
        Ok(())
    }

    #[test]
    fn explicit_team_excludes_siblings_and_room_posts_do_not_dispatch() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = store::Store::open(directory.path().join("org"))?;
        let ceo: Agent = db.get("agents", "ceo")?;
        for (id, parent) in [
            ("a", "ceo"),
            ("left", "a"),
            ("right", "a"),
            ("left-child", "left"),
            ("right-child", "right"),
        ] {
            let mut agent = ceo.clone();
            agent.id = id.into();
            agent.name = id.into();
            agent.reports_to = Some(parent.into());
            db.put("agents", id, &agent)?;
        }
        let mut group: Group = db.get("groups", "general")?;
        group.member_ids = Some(vec!["left-child".into()]);
        db.read(|conn| validate(conn, &mut group))?;
        db.put("groups", "general", &group)?;
        let allowed = db.read(|conn| access(conn, &group))?;
        assert_eq!(
            allowed.participant_ids,
            vec!["a", "ceo", "left", "left-child"]
        );
        assert!(allowed.ensure_allowed("right", RunKind::Delegate).is_err());
        assert_eq!(
            db.read(|conn| mentions(conn, &group, "@left-child, please check"))?,
            vec!["left-child"]
        );
        assert!(
            db.read(|conn| mentions(conn, &group, "email@left and @leftish"))?
                .is_empty()
        );
        let message = db.write(|conn| {
            crate::api::submit_message(
                conn,
                crate::api::SendInput {
                    id: crate::model::id(),
                    group_id: group.id.clone(),
                    side_chat_id: None,
                    body: "Hello team".into(),
                    recipients: vec![],
                    reply_to: None,
                    artifacts: vec![],
                },
                None,
            )
        })?;
        assert!(!message.auto_routed);
        assert!(message.recipients.is_empty());
        assert!(db.list::<Run>("runs")?.is_empty());
        Ok(())
    }

    #[test]
    fn hierarchy_separates_chat_participants_from_delegated_workers() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let db = store::Store::open(directory.path().join("org"))?;
        let ceo: Agent = db.get("agents", "ceo")?;
        let mut manager = ceo.clone();
        manager.id = "manager".into();
        manager.reports_to = Some(ceo.id.clone());
        let mut worker = manager.clone();
        worker.id = "worker".into();
        worker.reports_to = Some(manager.id.clone());
        db.put("agents", &manager.id, &manager)?;
        db.put("agents", &worker.id, &worker)?;
        let mut group: Group = db.get("groups", "general")?;
        let legacy: Group =
            serde_json::from_str(r#"{"id":"legacy","name":"Old group","description":""}"#)?;
        assert!(legacy.scope_levels.is_none());
        assert_eq!(
            db.read(|conn| access(conn, &legacy))?.participant_ids.len(),
            3
        );
        group.scope_levels = Some(vec![1]);
        let scope = db.read(|conn| access(conn, &group))?;
        assert_eq!(scope.participant_ids, ["ceo"]);
        assert_eq!(scope.delegate_ids, ["ceo", "manager", "worker"]);
        assert!(scope.ensure_allowed("worker", RunKind::Direct).is_err());
        assert!(scope.ensure_allowed("worker", RunKind::Summary).is_err());
        scope.ensure_allowed("worker", RunKind::Delegate)?;
        group.scope_levels = Some(vec![2]);
        let scope = db.read(|conn| access(conn, &group))?;
        assert_eq!(scope.participant_ids, ["manager"]);
        assert_eq!(scope.chat_lead_id.as_deref(), Some("manager"));
        assert!(scope.ensure_allowed("ceo", RunKind::Delegate).is_err());
        scope.ensure_allowed("worker", RunKind::Delegate)?;
        group.chat_lead_id = Some("ceo".into());
        assert!(db.read(|conn| validate(conn, &mut group)).is_err());
        group.chat_lead_id = None;
        for invalid in [vec![], vec![0], vec![1, 1]] {
            group.scope_levels = Some(invalid);
            assert!(db.read(|conn| validate(conn, &mut group)).is_err());
        }
        group.scope_levels = Some(vec![1, 3]);
        assert_eq!(
            db.read(|conn| access(conn, &group))?.participant_ids,
            ["ceo", "worker"]
        );
        worker.reports_to = None;
        db.put("agents", &worker.id, &worker)?;
        group.scope_levels = Some(vec![1]);
        assert_eq!(
            db.read(|conn| access(conn, &group))?.participant_ids,
            ["ceo", "worker"]
        );
        worker.deleted_at = Some(now());
        db.put("agents", &worker.id, &worker)?;
        assert!(
            !db.read(|conn| access(conn, &group))?
                .delegate_ids
                .contains(&worker.id)
        );
        Ok(())
    }
}
