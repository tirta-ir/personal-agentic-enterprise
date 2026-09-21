// Account RPC and wire fields follow the official openai/codex app-server protocol.
// Agent execution still uses exec. This short-lived process only reads rate limits.
use crate::{App, model::now, runtime};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UsageReport {
    pub checked_at: String,
    pub buckets: Vec<UsageBucket>,
    #[serde(default)]
    pub opencode_usage: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageBucket {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub plan_type: Option<String>,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageWindow {
    pub used_percent: Option<f64>,
    #[ts(type = "number | null")]
    pub window_duration_mins: Option<i64>,
    #[ts(type = "number | null")]
    pub resets_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    rate_limits: Option<UsageBucket>,
    rate_limits_by_limit_id: Option<BTreeMap<String, UsageBucket>>,
}

fn parse(value: Value) -> Result<UsageReport> {
    let response: Response =
        serde_json::from_value(value).context("Codex returned an unsupported usage format")?;
    let buckets = if let Some(map) = response.rate_limits_by_limit_id.filter(|m| !m.is_empty()) {
        map.into_iter()
            .map(|(id, mut bucket)| {
                if bucket.limit_id.is_none() {
                    bucket.limit_id = Some(id);
                }
                bucket
            })
            .collect()
    } else {
        response.rate_limits.into_iter().collect::<Vec<_>>()
    };
    ensure!(
        !buckets.is_empty(),
        "Codex has not reported usage limits for this account. Check that Codex is signed in with ChatGPT."
    );
    Ok(UsageReport {
        checked_at: now(),
        buckets,
        opencode_usage: None,
    })
}

pub fn read(app: &App) -> Result<UsageReport> {
    let parent = app.store.org.join(".state/runtime");
    std::fs::create_dir_all(&parent)?;
    let home = tempfile::Builder::new()
        .prefix("usage-")
        .tempdir_in(parent)?;
    let auth = runtime::seed_auth(home.path())?;
    let result = crate::codex_rpc::request(
        app,
        home.path(),
        home.path(),
        "account/rateLimits/read",
        json!({}),
    );
    auth.finish()?;
    parse(result?)
}

pub fn read_for_group(
    app: &App,
    group_id: &str,
    side_chat_id: Option<&str>,
) -> Result<UsageReport> {
    use crate::model::*;
    let (codex, opencode) = app.store.read(|conn| {
        let group: Group = crate::store::get(conn, "groups", group_id)?;
        let scope = crate::group_scope::access(conn, &group)?;
        let agents = crate::store::list::<Agent>(conn, "agents")?;
        let included: Vec<_> = agents
            .iter()
            .filter(|a| scope.delegate_ids.contains(&a.id))
            .collect();
        Ok((
            included.iter().any(|a| a.harness == Harness::Codex),
            included.iter().any(|a| a.harness == Harness::Opencode),
        ))
    })?;
    let mut report = if codex {
        read(app)?
    } else {
        UsageReport {
            checked_at: now(),
            buckets: vec![],
            opencode_usage: None,
        }
    };
    if opencode {
        let runs: Vec<_> = app
            .store
            .list::<Run>("runs")?
            .into_iter()
            .filter(|r| {
                r.group_id == group_id
                    && r.side_chat_id.as_deref() == side_chat_id
                    && r.profile.harness == Harness::Opencode
            })
            .collect();
        let measured: Vec<_> = runs.iter().filter_map(|r| r.usage.as_ref()).collect();
        let input: u64 = measured
            .iter()
            .filter_map(|v| v["input_tokens"].as_u64())
            .sum();
        let output: u64 = measured
            .iter()
            .filter_map(|v| v["output_tokens"].as_u64())
            .sum();
        let cost: f64 = measured.iter().filter_map(|v| v["cost_usd"].as_f64()).sum();
        let cost_label =
            if measured.is_empty() || measured.iter().any(|v| v["cost_usd"].as_f64().is_none()) {
                "not fully reported".to_owned()
            } else {
                format!("${cost:.6}")
            };
        report.opencode_usage = Some(format!(
            "OpenCode · this conversation: {} runs, {} with reported usage. {input} input / {output} output tokens; reported cost {cost_label}. Account quota and reset times are not exposed by this integration; missing usage is not zero usage.",
            runs.len(),
            measured.len()
        ));
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefers_all_buckets_and_preserves_unavailable_windows() {
        let report = parse(json!({"rateLimits":{"primary":{"usedPercent":99}},"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":15,"windowDurationMins":300,"resetsAt":1234}},"extra":{"secondary":null}}})).unwrap();
        assert_eq!(report.buckets.len(), 2);
        assert_eq!(
            report.buckets[0].primary.as_ref().unwrap().used_percent,
            Some(15.0)
        );
        assert!(report.buckets[1].primary.is_none());
        assert_eq!(
            parse(json!({"rateLimits":{"primary":{"usedPercent":0}}}))
                .unwrap()
                .buckets[0]
                .primary
                .as_ref()
                .unwrap()
                .used_percent,
            Some(0.0)
        );
        assert!(parse(json!({"rateLimits":null})).is_err());
    }
}
