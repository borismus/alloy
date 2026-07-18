//! `spawn_subagent` tool. Runs 1-3 sub-agents in parallel via the same tool
//! loop used at the top level, with a reduced tool set (no nested
//! `spawn_subagent`, no writes).
//!
//! Mirrors the SPA-side `executeSubagentTool` in
//! [src/services/tools/executor.ts](src/services/tools/executor.ts).

use std::sync::Arc;

use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::providers::{wire_to_chat, ChatMessage, ProviderStreamEvent, WireMessage};
use crate::tool_loop::{execute_with_tools, LoopRequest};
use crate::tools::{input_string, ToolContext, ToolRegistry};
use crate::types::{builtin_tools, NullSink, ToolDefinition};

#[derive(Deserialize)]
struct AgentConfig {
    #[serde(default)]
    name: Option<String>,
    prompt: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    system_prompt: Option<String>,
}

/// Sub-agents get every builtin tool except `spawn_subagent` (no nesting),
/// `write_file` and `append_to_note` (no writes from sub-agents — matches
/// the SPA's subagentTools filter).
fn subagent_tools() -> Vec<ToolDefinition> {
    builtin_tools()
        .into_iter()
        .filter(|t| {
            t.name != "spawn_subagent" && t.name != "write_file" && t.name != "append_to_note"
        })
        .collect()
}

pub async fn execute(
    registry: Arc<ToolRegistry>,
    ctx: &ToolContext,
    input: &Value,
) -> Result<String, String> {
    if ctx.inside_subagent {
        return Err("spawn_subagent cannot be called from within a sub-agent (no nesting).".into());
    }

    let agents_raw = input_string(input, "agents").unwrap_or("");
    if agents_raw.is_empty() {
        return Err("Missing required parameter: agents".into());
    }
    let mut configs: Vec<AgentConfig> = serde_json::from_str(agents_raw)
        .map_err(|e| format!("Failed to parse agents config: {}", e))?;
    if configs.is_empty() {
        return Err("agents must be a non-empty array".into());
    }
    if configs.len() > 3 {
        configs.truncate(3);
    }

    let tools = subagent_tools();

    let mut futures = Vec::new();
    for (i, cfg) in configs.into_iter().enumerate() {
        let name = cfg
            .name
            .clone()
            .unwrap_or_else(|| format!("Agent {}", i + 1));
        let registry = registry.clone();
        let model = cfg
            .model
            .unwrap_or_else(|| "anthropic/claude-haiku-4-5".to_string());
        let prompt = cfg.prompt.clone();
        let system_prompt = cfg.system_prompt.clone();
        let tools = tools.clone();
        futures.push(run_one_agent(
            registry,
            model,
            prompt,
            system_prompt,
            tools,
            name,
        ));
    }

    let results = join_all(futures).await;

    // Combine outputs in the same `=== Name (model) ===\n...` format the SPA
    // executor produces, so downstream rendering matches.
    let parts: Vec<String> = results
        .into_iter()
        .map(|r| match r {
            Ok((name, model, content)) => format!("=== {} ({}) ===\n{}", name, model, content),
            Err((name, model, err)) => {
                format!("=== {} ({}) ===\nError: {}", name, model, err)
            }
        })
        .collect();

    Ok(parts.join("\n\n"))
}

async fn run_one_agent(
    parent_registry: Arc<ToolRegistry>,
    model: String,
    prompt: String,
    system_prompt: Option<String>,
    tools: Vec<ToolDefinition>,
    name: String,
) -> Result<(String, String, String), (String, String, String)> {
    let (provider, upstream_model) = match parent_registry.providers.resolve(&model) {
        Ok(r) => r,
        Err(msg) => return Err((name, model.clone(), msg)),
    };
    let upstream_model = upstream_model.to_string();

    let messages: Vec<ChatMessage> = wire_to_chat(
        &[WireMessage {
            id: None,
            role: "user".into(),
            content: prompt,
            attachments: Vec::new(),
        }],
        system_prompt.as_deref(),
        None,
    )
    .await;

    let (delta_tx, mut delta_rx) = mpsc::unbounded_channel::<ProviderStreamEvent>();
    // Drain deltas so the channel doesn't fill up — sub-agent output is
    // collected from the final result, not streamed to the client UI.
    tokio::spawn(async move { while delta_rx.recv().await.is_some() {} });

    let (_cancel_tx, cancel_rx) = watch::channel(false);

    // Sub-agents run with their own ToolRegistry that flags inside_subagent=true.
    // Re-use the parent's deps; we only need to gate spawn_subagent.
    let sub_registry = Arc::new(ToolRegistry {
        config: parent_registry.config.clone(),
        vault: parent_registry.vault.clone(),
        providers: parent_registry.providers.clone(),
        skills: parent_registry.skills.clone(),
    });

    let loop_req = LoopRequest {
        provider,
        model: upstream_model.clone(),
        messages,
        tools,
        delta_tx,
        cancel: cancel_rx,
        tool_ctx: ToolContext {
            message_id: None,
            conversation_id: None,
            inside_subagent: true,
            // Computed from the sub-agent's own model, so a cloud parent spawning
            // a local sub-agent (or vice versa) is classified correctly.
            model_is_local: crate::local::model_is_local(&parent_registry.config, &model),
        },
        // Sub-agents use whatever provider they're given via Alloy's own loop;
        // no Claude Code MCP bridge.
        mcp: None,
    };

    // Sub-agents don't emit tool events to the parent session — the parent's
    // pill should just show the spawn_subagent summary.
    let sink = Arc::new(NullSink);

    let result = execute_with_tools(loop_req, sub_registry, sink).await;
    match result {
        Ok(r) => Ok((name, model, r.content)),
        Err(e) => Err((name, model, e.to_string())),
    }
}
