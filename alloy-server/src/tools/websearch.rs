//! `web_search` tool — calls Serper. Mirrors the SPA-side implementation in
//! [src/services/tools/builtin/search/serper.ts](src/services/tools/builtin/search/serper.ts).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::tools::{ToolRegistry, input_string};

const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
struct SerperRequest<'a> {
    q: &'a str,
    num: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tbs: Option<String>,
}

#[derive(Deserialize, Default)]
struct SerperResponse {
    #[serde(default)]
    organic: Vec<SerperResult>,
}

#[derive(Deserialize, Default)]
struct SerperResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    snippet: String,
}

pub async fn execute(registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let query = input_string(input, "query").unwrap_or("").trim();
    if query.is_empty() {
        return Err("Missing required parameter: query".into());
    }

    let api_key = registry.config.serper_api_key.as_deref().ok_or_else(|| {
        "SERPER_API_KEY not configured. Add it to your config.yaml file.".to_string()
    })?;

    let num_results = input
        .get("num_results")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(10)
        .clamp(1, 20);

    let tbs = input
        .get("recency")
        .and_then(|v| v.as_str())
        .and_then(parse_recency);

    let body = SerperRequest {
        q: query,
        num: num_results,
        tbs,
    };

    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;

    let response = client
        .post("https://google.serper.dev/search")
        .header("Content-Type", "application/json")
        .header("X-API-KEY", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Serper request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Serper API error: {} {}", status, text));
    }

    let data: SerperResponse = response
        .json()
        .await
        .map_err(|e| format!("Serper JSON parse failed: {}", e))?;

    if data.organic.is_empty() {
        return Ok(format!(r#"No results found for: "{}""#, query));
    }

    // Same shape the SPA's executor sees: { query, results: [{position, title, url, snippet}, ...] }
    let results: Vec<Value> = data
        .organic
        .into_iter()
        .take(num_results as usize)
        .enumerate()
        .map(|(idx, r)| {
            json!({
                "position": idx + 1,
                "title": r.title,
                "url": r.link,
                "snippet": r.snippet,
            })
        })
        .collect();

    serde_json::to_string_pretty(&json!({ "query": query, "results": results }))
        .map_err(|e| format!("Serialization failed: {}", e))
}

/// Parse recency like "3 days", "week", "2 hours" into Serper's `tbs` param.
/// Matches the SPA-side logic exactly.
fn parse_recency(recency: &str) -> Option<String> {
    let trimmed = recency.trim().to_lowercase();
    let unit_map = |u: &str| -> Option<&'static str> {
        match u {
            "hour" | "hours" => Some("h"),
            "day" | "days" => Some("d"),
            "week" | "weeks" => Some("w"),
            "month" | "months" => Some("m"),
            "year" | "years" => Some("y"),
            _ => None,
        }
    };

    // "<n> <unit>" pattern
    if let Some((num_str, unit_str)) = trimmed.split_once(char::is_whitespace) {
        if let (Ok(count), Some(u)) = (num_str.parse::<u32>(), unit_map(unit_str.trim())) {
            return Some(if count > 1 {
                format!("qdr:{}{}", u, count)
            } else {
                format!("qdr:{}", u)
            });
        }
    }
    // bare unit ("day", "week", ...)
    unit_map(&trimmed).map(|u| format!("qdr:{}", u))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recency() {
        assert_eq!(parse_recency("hour").as_deref(), Some("qdr:h"));
        assert_eq!(parse_recency("3 days").as_deref(), Some("qdr:d3"));
        assert_eq!(parse_recency("1 week").as_deref(), Some("qdr:w"));
        assert_eq!(parse_recency("week").as_deref(), Some("qdr:w"));
        assert_eq!(parse_recency("garbage").as_deref(), None);
    }
}
