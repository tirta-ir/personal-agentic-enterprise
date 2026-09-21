use crate::{model::*, security, store};
use anyhow::{Context, Result, ensure};
use rusqlite::Connection;
use std::collections::HashSet;

pub fn workspace(conn: &Connection, agent: &Agent) -> Result<Option<Workspace>> {
    if let Some(id) = &agent.project_id {
        let group: Group = store::get(conn, "groups", id)?;
        group.ensure_active()?;
        return Ok(Some(
            group.project.context("Agent project is missing")?.workdir,
        ));
    }
    Ok(agent.workdir.clone())
}

// Projects reuse group messages, sessions, side chats, lifecycle and queues.
pub fn validate(conn: &Connection, group: &Group) -> Result<()> {
    let Some(project) = &group.project else {
        return Ok(());
    };
    ensure!(
        project.members.len() <= 1000,
        "Maximum 1000 project members"
    );
    let ids: HashSet<_> = project.members.iter().map(|m| &m.agent_id).collect();
    ensure!(
        ids.len() == project.members.len(),
        "Duplicate project member"
    );
    for member in &project.members {
        let agent: Agent = store::get(conn, "agents", &member.agent_id)?;
        ensure!(
            agent.deleted_at.is_none(),
            "Restore deleted project members first"
        );
        ensure!(
            agent.project_id.as_ref().is_none_or(|id| id == &group.id),
            "Agent belongs to another project"
        );
        if let Some(manager) = &member.manager_id {
            ensure!(
                ids.contains(manager),
                "Project manager must be a project member"
            );
        }
        level(project, &member.agent_id)?;
    }
    Ok(())
}

pub fn level(project: &Project, id: &str) -> Result<u32> {
    let mut cursor = Some(id);
    let mut seen = HashSet::new();
    while let Some(id) = cursor {
        ensure!(seen.insert(id), "Project reporting lines contain a cycle");
        cursor = project
            .members
            .iter()
            .find(|m| m.agent_id == id)
            .context("Project manager is not a member")?
            .manager_id
            .as_deref();
    }
    Ok(u32::try_from(seen.len())?)
}

pub fn validate_workdir(group: &mut Group, app: &crate::App) -> Result<()> {
    if let Some(project) = &mut group.project {
        if project.workdir.runtime_id.is_some() {
            project.workdir = crate::fleet::validate(app, &project.workdir)?;
            return Ok(());
        }
        project.workdir = match &project.workdir.ssh_host {
            Some(host) => crate::remote::validate_workspace(host, &project.workdir.path)?,
            None => security::validate_workspace(&project.workdir.path)?,
        };
        ensure!(
            project.workdir.ssh_host.is_some()
                || !std::path::Path::new(&project.workdir.canonical_path)
                    .starts_with(app.store.org.join(".state")),
            "Runtime state cannot be a project workdir"
        );
    }
    Ok(())
}

pub fn attach_agent(conn: &Connection, agent: &mut Agent) -> Result<()> {
    if let Some(project_id) = &agent.project_id {
        let mut group: Group = store::get(conn, "groups", project_id)?;
        group.ensure_active()?;
        let project = group
            .project
            .as_mut()
            .context("Choose a project for this agent")?;
        if !project.members.iter().any(|m| m.agent_id == agent.id) {
            project.members.push(ProjectMember {
                agent_id: agent.id.clone(),
                manager_id: None,
            });
        }
        let manager = project
            .members
            .iter()
            .find(|m| m.agent_id == agent.id)
            .and_then(|m| m.manager_id.clone());
        agent.reports_to = manager.filter(|id| {
            store::get::<Agent>(conn, "agents", id).is_ok_and(|a| a.project_id.is_none())
        });
        store::put(conn, "groups", &group.id, &group)?;
    }
    Ok(())
}

pub fn sync_reporting(conn: &Connection, group: &Group) -> Result<()> {
    if let Some(project) = &group.project {
        for member in &project.members {
            let mut agent: Agent = store::get(conn, "agents", &member.agent_id)?;
            if agent.project_id.as_deref() == Some(&group.id) {
                let manager = member.manager_id.clone().filter(|id| {
                    store::get::<Agent>(conn, "agents", id).is_ok_and(|a| a.project_id.is_none())
                });
                if agent.reports_to != manager {
                    agent.reports_to = manager;
                    crate::api::validate_reporting_line(conn, &agent)?;
                    crate::api::record_profile(conn, &mut agent)?;
                }
            }
        }
    }
    Ok(())
}
