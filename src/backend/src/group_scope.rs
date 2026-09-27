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

#[cfg(test)]
mod tests {
    use super::*;

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
