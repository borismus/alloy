//! `http_get` and `http_post` tools.
//!
//! Plain pass-through HTTP requests. No `${{SECRET_NAME}}` resolution
//! (we don't ship `get_secret` server-side — the only secret in practice
//! was SERPER_API_KEY which the dedicated `web_search` tool reads directly).

use std::time::Duration;

use serde_json::Value;

use crate::tools::{ToolRegistry, input_string};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024; // 2 MB cap to avoid blowing context

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

    format_response(response).await
}

pub async fn execute_post(_registry: &ToolRegistry, input: &Value) -> Result<String, String> {
    let url = input_string(input, "url").unwrap_or("").trim();
    if url.is_empty() {
        return Err("Missing required parameter: url".into());
    }
    let body = input_string(input, "body").unwrap_or("");

    let mut req = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client init: {}", e))?
        .post(url);

    // Headers param is a JSON-encoded object per the tool schema.
    if let Some(headers_str) = input_string(input, "headers") {
        if !headers_str.trim().is_empty() {
            let parsed: Value = serde_json::from_str(headers_str)
                .map_err(|e| format!("headers JSON parse failed: {}", e))?;
            if let Some(obj) = parsed.as_object() {
                for (k, v) in obj {
                    let v_str = v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string());
                    req = req.header(k, v_str);
                }
            }
        }
    }

    // Default Content-Type to application/json if a body is present and the
    // model didn't specify one.
    let response = req
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("HTTP POST failed: {}", e))?;

    format_response(response).await
}

async fn format_response(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("response read failed: {}", e))?;

    let body = if bytes.len() > MAX_BODY_BYTES {
        let truncated = &bytes[..MAX_BODY_BYTES];
        let preview = String::from_utf8_lossy(truncated).into_owned();
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
