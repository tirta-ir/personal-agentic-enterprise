// Read the same user configuration and model catalog used by native Codex.
// Only model metadata is exposed; credentials, prompts and other settings stay local.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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

// Honor the native catalog override instead of silently reverting to its refreshable cache.
fn custom_catalog(home: &Path, config: &str) -> Result<Option<PathBuf>> {
    let config: toml::Value = toml::from_str(config).context("Cannot read Codex config.toml")?;
    match config.get("model_catalog_json") {
        None => Ok(None),
        Some(value) => {
            let path = value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .context("model_catalog_json must be a nonempty path")?;
            Ok(Some(home.join(path)))
        }
    }
}

pub fn read() -> Result<CodexSettings> {
    read_from(&home()?)
}

fn read_from(home: &Path) -> Result<CodexSettings> {
    let config = crate::security::read_optional(&home.join("config.toml"))?;
    let path = custom_catalog(home, &config)?.unwrap_or_else(|| home.join("models_cache.json"));
    let cache = std::fs::read_to_string(&path)
        .with_context(|| format!("Codex model catalog is unavailable at {}. Check model_catalog_json or refresh the signed-in CLI catalog.", path.display()))?;
    parse(&config, &cache)
}

// Agent sessions ignore unrelated user config; pass only the catalog override explicitly.
pub fn catalog_argument() -> Result<Option<String>> {
    let home = home()?;
    let config = crate::security::read_optional(&home.join("config.toml"))?;
    custom_catalog(&home, &config)?
        .map(|path| {
            Ok(format!(
                "model_catalog_json={}",
                serde_json::to_string(&path)?
            ))
        })
        .transpose()
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
    let selected = catalog.models.iter().find(|m| m.slug == model);
    let configured_reasoning = setting("model_reasoning_effort");
    let reasoning = if configured_reasoning.is_empty() {
        selected
            .map(|m| m.default_reasoning_level.clone())
            .unwrap_or_default()
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
    fn custom_catalog_is_used_and_invalid_override_does_not_fall_back() -> anyhow::Result<()> {
        let home = tempfile::tempdir()?;
        let cache = r#"{"models":[{"slug":"cached","display_name":"Cached","visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low","description":"Fast"}]}]}"#;
        std::fs::write(home.path().join("models_cache.json"), cache)?;
        std::fs::write(
            home.path().join("custom.json"),
            cache.replace("cached", "custom"),
        )?;
        std::fs::write(
            home.path().join("config.toml"),
            "model_catalog_json = 'custom.json'\nmodel = 'custom'",
        )?;
        assert_eq!(super::read_from(home.path())?.resolve("", "")?.0, "custom");
        std::fs::remove_file(home.path().join("custom.json"))?;
        assert!(super::read_from(home.path()).is_err());
        assert!(super::custom_catalog(home.path(), "model_catalog_json = 5").is_err());
        std::fs::write(home.path().join("config.toml"), "")?;
        assert_eq!(super::read_from(home.path())?.models[0].slug, "cached");
        Ok(())
    }

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

    #[test]
    fn unavailable_default_does_not_hide_available_models() {
        let catalog = r#"{"models":[{"slug":"available","display_name":"Available","visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low","description":"Fast"}]}]}"#;
        let settings = super::parse("model = 'unavailable'", catalog).unwrap();
        assert_eq!(settings.model, "unavailable");
        assert!(settings.resolve("", "").is_err());
        assert_eq!(
            settings.resolve("available", "").unwrap(),
            ("available".into(), "low".into())
        );
    }
}
