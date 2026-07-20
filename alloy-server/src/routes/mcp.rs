//! `POST /api/mcp` — a minimal MCP-over-HTTP server exposing Alloy's built-in
//! tools to a headless Claude Code run (the `claude-cli` provider).
//!
//! This is how the subscription provider reaches **tool parity** with every
//! other provider: instead of Claude Code's native tools, it calls Alloy's
//! `builtin_tools()` here, which dispatch through the *same*
//! `ToolRegistry::execute` the normal tool loop uses — identical behavior,
//! vault scoping, and side effects.
//!
//! Transport: JSON-RPC 2.0 over a single POST endpoint (Streamable HTTP without
//! SSE). We implement just what Claude Code calls: `initialize`,
//! `notifications/initialized`, `tools/list`, `tools/call`. Each session passes
//! `?session=<id>&token=<secret>`; the token is verified against the session so
//! a stray local process can't drive tool execution.

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::streaming::SessionRegistry;
use crate::tools::{ToolContext, ToolRegistry};
use crate::types::{ToolCall, builtin_tools};

/// Protocol version we advertise if the client doesn't send one.
const DEFAULT_PROTOCOL: &str = "2025-06-18";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/mcp", post(handle))
}

#[derive(Deserialize)]
pub struct McpQuery {
    session: Option<String>,
    token: Option<String>,
}

async fn handle(
    State(state): State<AppState>,
    Query(q): Query<McpQuery>,
    body: String,
) -> Response {
    let req: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return rpc_error(Value::Null, -32700, "parse error"),
    };
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let id = req.get("id").cloned().unwrap_or(Value::Null);

    // Notifications (no id) don't get a JSON-RPC reply.
    if method.starts_with("notifications/") {
        return StatusCode::ACCEPTED.into_response();
    }

    match method {
        "initialize" => rpc_ok(id, initialize_result(req.get("params"))),
        "tools/list" => rpc_ok(id, json!({ "tools": tool_list() })),
        "tools/call" => {
            // Authenticate this session before doing any work.
            let Some(ctx) = authorize(&state.sessions, &q) else {
                return rpc_error(id, -32001, "unauthorized: bad session or token");
            };
            let params = req.get("params").cloned().unwrap_or(Value::Null);
            rpc_ok(id, execute_tool_call(&state.tools, &params, &ctx).await)
        }
        _ => rpc_error(id, -32601, "method not found"),
    }
}

/// Build the `initialize` result, echoing the client's protocol version.
fn initialize_result(params: Option<&Value>) -> Value {
    let protocol = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROTOCOL);
    json!({
        "protocolVersion": protocol,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "alloy", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// Execute a `tools/call` against the registry and map the `ToolResult` to the
/// MCP result shape (`content` array + `isError`). This is the same
/// `ToolRegistry::execute` the normal tool loop uses — identical behavior.
async fn execute_tool_call(
    tools: &Arc<ToolRegistry>,
    params: &Value,
    ctx: &ToolContext,
) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let tool_use_id = params
        .get("_meta")
        .and_then(|m| m.get("claudecode/toolUseId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("mcp-{}", uuid::Uuid::new_v4()));

    let call = ToolCall {
        id: tool_use_id,
        name: name.to_string(),
        input: arguments,
    };
    let result = tools.execute(&call, ctx).await;
    json!({
        "content": [{ "type": "text", "text": result.content }],
        "isError": result.is_error.unwrap_or(false),
    })
}

/// Verify the per-session token and rebuild the tool context for that session,
/// matching what `run_stream` builds for the normal tool loop. Returns `None`
/// (→ unauthorized) on a missing/unknown session or a token mismatch.
fn authorize(sessions: &SessionRegistry, q: &McpQuery) -> Option<ToolContext> {
    let session_id = q.session.as_deref()?;
    let token = q.token.as_deref()?;
    let session = sessions.get(session_id)?;
    let inner = session.inner.lock().unwrap();
    if inner.mcp_token != token {
        return None;
    }
    Some(ToolContext {
        message_id: Some(inner.assistant_message_id.clone()),
        conversation_id: Some(format!("conversations/{}", inner.conversation_id)),
        inside_subagent: false,
        // The MCP bridge serves the Claude Code CLI provider, which is cloud —
        // never grant it private-mount access.
        model_is_local: false,
    })
}

/// Map `builtin_tools()` to MCP tool descriptors (`inputSchema`, camelCase).
fn tool_list() -> Vec<Value> {
    builtin_tools()
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": serde_json::to_value(&t.input_schema).unwrap_or_else(|_| json!({
                    "type": "object", "properties": {}
                })),
            })
        })
        .collect()
}

fn rpc_ok(id: Value, result: Value) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

fn rpc_error(id: Value, code: i64, message: &str) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::providers::ProviderRegistry;
    use crate::skill_registry::SkillRegistry;
    use crate::tools::ToolRegistry;
    use crate::vault::Vault;

    fn registry_over(dir: &std::path::Path) -> Arc<ToolRegistry> {
        Arc::new(ToolRegistry::new(
            Arc::new(Config::default()),
            Arc::new(Vault::new(dir.to_path_buf()).unwrap()),
            ProviderRegistry::from_configs(&[]),
            Arc::new(SkillRegistry::new()),
        ))
    }

    fn query(session: Option<&str>, token: Option<&str>) -> McpQuery {
        McpQuery {
            session: session.map(str::to_string),
            token: token.map(str::to_string),
        }
    }

    #[test]
    fn authorize_accepts_matching_token_and_rebuilds_context() {
        let sessions = SessionRegistry::new();
        sessions.insert_test_session("s1", "conv-1", "msg-9", "secret");
        let ctx = authorize(&sessions, &query(Some("s1"), Some("secret"))).expect("authorized");
        // Context mirrors what run_stream builds for the normal tool loop.
        assert_eq!(ctx.conversation_id.as_deref(), Some("conversations/conv-1"));
        assert_eq!(ctx.message_id.as_deref(), Some("msg-9"));
    }

    #[test]
    fn authorize_rejects_bad_or_missing_token_and_unknown_session() {
        let sessions = SessionRegistry::new();
        sessions.insert_test_session("s1", "conv-1", "msg-9", "secret");
        assert!(authorize(&sessions, &query(Some("s1"), Some("wrong"))).is_none());
        assert!(authorize(&sessions, &query(Some("s1"), None)).is_none());
        assert!(authorize(&sessions, &query(Some("nope"), Some("secret"))).is_none());
        assert!(authorize(&sessions, &query(None, Some("secret"))).is_none());
    }

    #[tokio::test]
    async fn tools_call_executes_a_real_builtin_tool() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/x.md"), "hello mcp").unwrap();
        let tools = registry_over(dir.path());
        let ctx = ToolContext {
            message_id: Some("m".into()),
            conversation_id: Some("conversations/c".into()),
            inside_subagent: false,
            model_is_local: false,
        };
        let params = json!({ "name": "read_file", "arguments": { "path": "notes/x.md" } });
        let out = execute_tool_call(&tools, &params, &ctx).await;
        assert_eq!(out["isError"], false);
        assert_eq!(out["content"][0]["text"], "hello mcp");
    }

    #[tokio::test]
    async fn tools_call_maps_tool_errors_to_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let tools = registry_over(dir.path());
        let ctx = ToolContext {
            message_id: None,
            conversation_id: None,
            inside_subagent: false,
            model_is_local: false,
        };
        // Missing required `path` → the tool returns an error result.
        let params = json!({ "name": "read_file", "arguments": {} });
        let out = execute_tool_call(&tools, &params, &ctx).await;
        assert_eq!(out["isError"], true);
    }

    #[test]
    fn initialize_echoes_client_protocol_version() {
        let r = initialize_result(Some(&json!({ "protocolVersion": "2025-11-25" })));
        assert_eq!(r["protocolVersion"], "2025-11-25");
        assert!(r["capabilities"]["tools"].is_object());
        // Falls back to a default when the client omits it.
        let r2 = initialize_result(None);
        assert_eq!(r2["protocolVersion"], DEFAULT_PROTOCOL);
    }

    #[test]
    fn tool_list_exposes_builtins_as_mcp_schemas() {
        let tools = tool_list();
        assert_eq!(tools.len(), builtin_tools().len());
        // Every entry has the MCP shape: name, description, camelCase inputSchema.
        for t in &tools {
            assert!(t.get("name").and_then(Value::as_str).is_some());
            assert!(t.get("description").and_then(Value::as_str).is_some());
            let schema = t.get("inputSchema").expect("inputSchema");
            assert_eq!(schema.get("type").and_then(Value::as_str), Some("object"));
            assert!(schema.get("properties").is_some());
        }
        // Sanity: a known Alloy tool is present and reachable as mcp__alloy__read_file.
        assert!(
            tools
                .iter()
                .any(|t| t.get("name").and_then(Value::as_str) == Some("read_file"))
        );
        assert!(tools.iter().any(|t| {
            t.get("name").and_then(Value::as_str) == Some("update_scheduled_task")
        }));
    }
}
