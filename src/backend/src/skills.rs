// Discovery and frontmatter parsing belong to Codex; reuse skills/list instead of a second scanner.
use crate::{App, runtime, security, terminal};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{io::Read, path::PathBuf};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SkillError {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SkillList {
    pub cwd: String,
    pub skills: Vec<Skill>,
    pub errors: Vec<SkillError>,
    pub text: Option<String>,
}

#[derive(Deserialize)]
struct Response {
    data: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    skills: Vec<Skill>,
    errors: Vec<SkillError>,
}
#[derive(Deserialize)]
pub struct SkillQuery {
    path: Option<String>,
}

pub async fn list(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<SkillQuery>,
) -> security::ApiResult<SkillList> {
    Ok(Json(
        tokio::task::spawn_blocking(move || read(&app, &id, query.path.as_deref()))
            .await
            .context("Skill discovery task failed")??,
    ))
}

fn read(app: &App, id: &str, selected: Option<&str>) -> Result<SkillList> {
    let agent = terminal::agent(app, id)?;
    let workspace = agent.workdir.context("Attach a workdir first")?;
    if let Some(host) = &workspace.ssh_host {
        let mut request = crate::remote::request(&workspace, "skills");
        request["reference"] = selected.into();
        return Ok(serde_json::from_value(crate::remote::call(host, request)?)?);
    }
    let home = runtime::runtime_home(app, id);
    std::fs::create_dir_all(&home)?;
    let value = crate::codex_rpc::request(
        app,
        &home,
        std::path::Path::new(&workspace.path),
        "skills/list",
        json!({"cwds":[workspace.path],"forceReload":true}),
    )?;
    let response: Response = serde_json::from_value(value)
        .context("Installed Codex returned an unsupported skills format")?;
    let mut result = SkillList {
        cwd: workspace.path.clone(),
        skills: Vec::new(),
        errors: Vec::new(),
        text: None,
    };
    let root =
        PathBuf::from(workspace.git_root.as_deref().unwrap_or(&workspace.path)).canonicalize()?;
    for entry in response.data {
        // The requested list is project skills, including inherited skills in the Git root.
        result
            .skills
            .extend(entry.skills.into_iter().filter(|s| s.scope == "repo"));
        result.errors.extend(entry.errors);
    }
    result
        .skills
        .sort_by_key(|s| (s.name.to_lowercase(), s.path.clone()));
    if let Some(path) = selected {
        let skill = result
            .skills
            .iter()
            .find(|s| s.path == path)
            .context("Skill is no longer installed in this workdir; refresh the list")?;
        let resolved = PathBuf::from(&skill.path)
            .canonicalize()
            .context("Cannot open skill instructions")?;
        ensure!(
            resolved.file_name().is_some_and(|n| n == "SKILL.md"),
            "Only SKILL.md instructions can be previewed"
        );
        let relative = resolved
            .strip_prefix(&root)
            .context("Skill links outside this codebase; inspect it with Terminal")?;
        let safe = crate::api::contained(&root, &relative.to_string_lossy())?;
        let mut bytes = Vec::new();
        std::fs::File::open(safe)?
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 256 * 1024,
            "Skill exceeds 256 KiB preview limit"
        );
        result.text =
            Some(String::from_utf8(bytes).context("Skill instructions are not UTF-8 text")?);
    }
    Ok(result)
}
