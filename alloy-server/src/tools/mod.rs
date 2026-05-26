//! Tool registry + dispatch.
//!
//! Mirrors the surface of [src/services/tools/registry.ts](src/services/tools/registry.ts):
//! takes a ToolCall, dispatches to the right executor, returns a ToolResult.
//! Server-side equivalent — file I/O against the vault, no Tauri plugins.

pub mod files;
pub mod http;
pub mod search;
pub mod skills;
pub mod subagents;
pub mod triggers;
pub mod websearch;

use std::sync::Arc;

use serde_json::Value;

use crate::config::Config;
use crate::providers::ProviderRegistry;
use crate::skill_registry::SkillRegistry;
use crate::types::{ToolCall, ToolResult};
use crate::vault::Vault;

pub struct ToolContext {
    pub message_id: Option<String>,
    pub conversation_id: Option<String>,
    /// Sub-agent guard. When true (set on the recursive registry used inside
    /// `spawn_subagent`), nested `spawn_subagent` calls are rejected.
    pub inside_subagent: bool,
}

pub struct ToolRegistry {
    pub config: Arc<Config>,
    pub vault: Arc<Vault>,
    pub providers: ProviderRegistry,
    pub skills: Arc<SkillRegistry>,
}

impl ToolRegistry {
    pub fn new(
        config: Arc<Config>,
        vault: Arc<Vault>,
        providers: ProviderRegistry,
        skills: Arc<SkillRegistry>,
    ) -> Self {
        Self {
            config,
            vault,
            providers,
            skills,
        }
    }

    /// Execute a tool call against the registered builtin tools. Returns a
    /// ToolResult — never panics; errors become `is_error: true`.
    pub async fn execute(self: &Arc<Self>, call: &ToolCall, ctx: &ToolContext) -> ToolResult {
        let result = match call.name.as_str() {
            "web_search" => websearch::execute(self, &call.input).await,
            "http_get" => http::execute_get(self, &call.input).await,
            "read_file" => files::execute_read(self, &call.input).await,
            "write_file" => files::execute_write(self, &call.input).await,
            "list_directory" => files::execute_list_directory(self, &call.input).await,
            "append_to_note" => files::execute_append_to_note(self, ctx, &call.input).await,
            "search_directory" => search::execute(self, &call.input).await,
            "use_skill" => skills::execute(&self.skills, &call.input).await,
            "spawn_subagent" => {
                subagents::execute(self.clone(), ctx, &call.input).await
            }
            "create_trigger" => triggers::execute(self, &call.input).await,
            other => Err(format!("Tool not implemented: {}", other)),
        };
        match result {
            Ok(content) => ToolResult {
                tool_use_id: call.id.clone(),
                content,
                is_error: None,
            },
            Err(msg) => ToolResult {
                tool_use_id: call.id.clone(),
                content: msg,
                is_error: Some(true),
            },
        }
    }
}

/// Extract a string field from a tool input object.
pub(crate) fn input_string<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(|v| v.as_str())
}
