//! Tool types mirroring [src/types/tools.ts](src/types/tools.ts).
//!
//! These are the JSON shapes seen by the model. Schemas are kept identical to
//! the SPA-side definitions so behavior matches across the two implementations
//! during the dual-path phase.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A tool definition as sent to the model (OpenAI function-calling shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: InputSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputSchema {
    #[serde(rename = "type")]
    pub typ: String,
    pub properties: BTreeMap<String, PropertyDef>,
    pub required: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyDef {
    #[serde(rename = "type")]
    pub typ: String,
    pub description: String,
}

/// A single tool invocation from the model.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// Result of executing one tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_use_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

fn def(
    name: &str,
    desc: &str,
    props: &[(&str, &str, &str)],
    required: &[&str],
) -> ToolDefinition {
    let mut properties = BTreeMap::new();
    for (k, t, d) in props {
        properties.insert(
            k.to_string(),
            PropertyDef {
                typ: t.to_string(),
                description: d.to_string(),
            },
        );
    }
    ToolDefinition {
        name: name.into(),
        description: desc.into(),
        input_schema: InputSchema {
            typ: "object".into(),
            properties,
            required: required.iter().map(|s| s.to_string()).collect(),
        },
    }
}

/// All built-in tools. Mirrors `BUILTIN_TOOLS` in
/// [src/types/tools.ts](src/types/tools.ts) exactly.
pub fn builtin_tools() -> Vec<ToolDefinition> {
    vec![
        def(
            "read_file",
            "Read a file from allowed vault directories (notes/, skills/) or root files like memory.md. Cannot access conversations/.",
            &[(
                "path",
                "string",
                r#"Relative path within vault (e.g., "memory.md", "notes/todo.md", "skills/my-skill/SKILL.md")"#,
            )],
            &["path"],
        ),
        def(
            "write_file",
            "Write content to a file in allowed vault directories (notes/, skills/) or root files like memory.md. Cannot access conversations/.",
            &[
                ("path", "string", r#"Relative path within vault. Note filenames must be human-readable with spaces, not kebab-case (e.g., "notes/Investment strategy.md", not "notes/investment-strategy.md")"#),
                ("content", "string", "Content to write"),
            ],
            &["path", "content"],
        ),
        def(
            "http_get",
            "Fetch content from a URL.",
            &[("url", "string", "URL to fetch")],
            &["url"],
        ),
        def(
            "http_post",
            "Send POST request to a URL.",
            &[
                ("url", "string", "URL to post to"),
                ("body", "string", "Request body (JSON string)"),
                ("headers", "string", "Optional headers as JSON object"),
            ],
            &["url", "body"],
        ),
        def(
            "use_skill",
            "Load and use a skill. Call this tool when you want to use one of the available skills. The skill instructions will be returned and you should follow them to complete the task.",
            &[("name", "string", "Name of the skill to use")],
            &["name"],
        ),
        def(
            "list_directory",
            "List files in a vault directory. Allowed directories: notes/, skills/, conversations/, triggers/. Returns file names sorted with directories first.",
            &[(
                "path",
                "string",
                r#"Relative directory path within vault (e.g., "notes", "skills", "conversations", "triggers")"#,
            )],
            &["path"],
        ),
        def(
            "search_directory",
            "Search for files and content within vault directories (notes/, skills/, conversations/). Returns matching file paths and content snippets.",
            &[
                ("directory", "string", r#"Directory to search (e.g., "notes", "skills", "conversations")"#),
                ("query", "string", "Search query - text to find in file names or content"),
                ("search_content", "string", r#"Search file content ("true") or just names ("false"). Default: "true""#),
                ("max_results", "string", r#"Max results to return (default: "20", max: "50")"#),
                ("file_extension", "string", r#"Filter by file extension (e.g., "md", "yaml")"#),
            ],
            &["directory", "query"],
        ),
        def(
            "web_search",
            "Search the web using Serper API. Returns search results with titles, links, and snippets. Requires SERPER_API_KEY to be configured. When the query mentions a time frame (e.g., \"last 24 hours\", \"this week\", \"recent\"), use the recency parameter to filter results.",
            &[
                ("query", "string", r#"Search query (do not include time phrases like "last 24 hours" - use recency parameter instead)"#),
                ("num_results", "string", r#"Number of results to return (default: "10", max: "20")"#),
                ("recency", "string", r#"IMPORTANT: Use this when searching for recent content. Examples: "hour", "day", "24 hours", "3 days", "week", "month", "year""#),
            ],
            &["query"],
        ),
        def(
            "spawn_subagent",
            "Spawn 1-3 sub-agents to work on tasks in parallel. Each sub-agent runs independently with its own context and full tool access. Use when a task can be broken into independent subtasks that benefit from parallel execution (e.g., researching different topics, analyzing from multiple angles). Results from all sub-agents are returned when all complete. Sub-agents cannot spawn their own sub-agents.",
            &[(
                "agents",
                "string",
                r#"JSON array of 1-3 sub-agent configs. Each config: {"name": "short label", "prompt": "task description", "model": "optional provider/model-id", "system_prompt": "optional role"}. Example: [{"name": "Research", "prompt": "Find recent papers on X"}, {"name": "Analysis", "prompt": "Analyze the implications of Y", "model": "anthropic/claude-sonnet-4-5-20250929"}]"#,
            )],
            &["agents"],
        ),
        def(
            "append_to_note",
            "Append content to a note with provenance tracking. Content is automatically marked with a provenance ID linking it to this chat message. Use for capturing insights, ideas, to-dos as the user talks. Keep appends small and atomic (1-3 lines typically).",
            &[
                ("path", "string", r#"Relative path within vault notes/ directory. Use human-readable names with spaces (e.g., "notes/Project ideas.md", not "notes/project-ideas.md")"#),
                ("content", "string", "Content to append. Do NOT include provenance markers - they are added automatically."),
            ],
            &["path", "content"],
        ),
    ]
}

/// Convert our ToolDefinition list into the OpenAI function-calling wire shape:
/// `[{ type: "function", function: { name, description, parameters } }, ...]`
pub fn to_openai_tools(defs: &[ToolDefinition]) -> Vec<Value> {
    defs.iter()
        .map(|d| {
            json!({
                "type": "function",
                "function": {
                    "name": d.name,
                    "description": d.description,
                    "parameters": d.input_schema,
                }
            })
        })
        .collect()
}
