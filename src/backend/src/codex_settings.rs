// Read the same user configuration and model catalog used by native Codex.
// Only model metadata is exposed; credentials, prompts and other settings stay local.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

#[derive(Clone, Deserialize, Serialize, TS)]
#[ts(export)]
pub struct ReasoningOption {
    pub effort: String,
    pub description: String,
}

#[derive(Clone, Deserialize, Serialize, TS)]
#[ts(export)]
pub struct ModelOption {
    pub slug: String,
    pub display_name: String,
    pub visibility: String,
    pub default_reasoning_level: String,
    pub supported_reasoning_levels: Vec<ReasoningOption>,
}

#[derive(Deserialize)]
struct Cache {
    models: Vec<ModelOption>,
    fetched_at: Option<String>,
}

#[derive(Deserialize, Serialize, TS)]
#[ts(export)]
pub struct CodexSettings {
    pub model: String,
    pub reasoning: String,
    pub models: Vec<ModelOption>,
    pub fetched_at: Option<String>,
}

pub fn home() -> Result<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|h| PathBuf::from(h).join(".codex"))
        })
        .context("Cannot locate your Codex settings directory")
}

pub fn read() -> Result<CodexSettings> {
    let home = home()?;
    let config = crate::security::read_optional(&home.join("config.toml"))?;
    let cache = std::fs::read_to_string(home.join("models_cache.json"))
        .context("Codex model catalog is unavailable. Open the signed-in Codex CLI once, then refresh models.")?;
    parse(&config, &cache)
}

pub(crate) fn parse(config: &str, cache: &str) -> Result<CodexSettings> {
    let config: toml::Value = toml::from_str(config).context("Cannot read Codex config.toml")?;
    let profile = config
        .get("profile")
        .and_then(toml::Value::as_str)
        .and_then(|name| config.get("profiles")?.get(name));
    let setting = |key| {
        profile
            .and_then(|p| p.get(key))
            .or_else(|| config.get(key))
            .and_then(toml::Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let mut catalog: Cache =
        serde_json::from_str(cache).context("Cannot read Codex model catalog")?;
    let configured_model = setting("model");
    catalog
        .models
        .retain(|m| m.visibility == "list" || m.slug == configured_model);
    ensure!(
        !catalog.models.is_empty(),
        "Codex has no available models. Open Codex and refresh its model catalog."
    );
    let model = if configured_model.is_empty() {
        catalog.models[0].slug.clone()
    } else {
        configured_model
    };
    let selected = catalog.models.iter().find(|m| m.slug == model).context(
        "Your configured Codex model is absent from its catalog. Refresh the catalog in Codex.",
    )?;
    let configured_reasoning = setting("model_reasoning_effort");
    let reasoning = if configured_reasoning.is_empty() {
        selected.default_reasoning_level.clone()
    } else {
        configured_reasoning
    };
    Ok(CodexSettings {
        model,
        reasoning,
        models: catalog.models,
        fetched_at: catalog.fetched_at,
    })
}

impl CodexSettings {
    pub fn resolve(&self, model: &str, reasoning: &str) -> Result<(String, String)> {
        let model = if model.is_empty() { &self.model } else { model };
        let selected = self.models.iter().find(|m| m.slug == model)
            .context("This model is not in the selected harness catalog. Refresh models and choose an available model.")?;
        let effort = if !reasoning.is_empty() {
            reasoning
        } else if model == self.model {
            &self.reasoning
        } else {
            &selected.default_reasoning_level
        };
        ensure!(
            (effort.is_empty() && selected.default_reasoning_level.is_empty())
                || selected
                    .supported_reasoning_levels
                    .iter()
                    .any(|r| r.effort == effort),
            "Reasoning effort '{effort}' is not supported by {model}. Choose a supported effort."
        );
        Ok((model.to_owned(), effort.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn respects_profile_defaults_and_model_specific_efforts() {
        let catalog = r#"{"models":[{"slug":"a","display_name":"A","visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low","description":"Fast"},{"effort":"max","description":"Deep"}]},{"slug":"hidden","display_name":"Hidden","visibility":"hide","default_reasoning_level":"low","supported_reasoning_levels":[]}]}"#;
        let settings = super::parse("model = 'wrong'\nprofile = 'work'\n[profiles.work]\nmodel = 'a'\nmodel_reasoning_effort = 'max'", catalog).unwrap();
        assert_eq!(settings.models.len(), 1);
        assert_eq!(
            settings.resolve("", "").unwrap(),
            ("a".into(), "max".into())
        );
        assert!(settings.resolve("a", "ultra").is_err());
        assert!(settings.resolve("hidden", "low").is_err());
    }
}
