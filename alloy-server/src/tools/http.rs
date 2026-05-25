//! `http_get` tool. Plain pass-through HTTP GET. Bodies larger than
//! `MAX_BODY_BYTES` get truncated with a marker so the model gets a usable
//! preview without blowing the context window.

use std::time::Duration;

use serde_json::Value;

use crate::tools::{ToolRegistry, input_string};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

pub async fn execute_get(_registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let url = input_string(input, "url").unwrap_or("").trim();
    if url.is_empty() {
        return Err("Missing required parameter: url".into());
    }

    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP GET failed: {}", e))?;

    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("response read failed: {}", e))?;

    let body = if bytes.len() > MAX_BODY_BYTES {
        let preview = String::from_utf8_lossy(&bytes[..MAX_BODY_BYTES]).into_owned();
        format!(
            "{}\n\n[truncated — response was {} bytes, showing first {}]",
            preview,
            bytes.len(),
            MAX_BODY_BYTES
        )
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    if !status.is_success() {
        return Err(format!("HTTP {} — {}", status, body));
    }
    Ok(body)
}
