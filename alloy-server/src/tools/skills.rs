//! `use_skill` tool. Returns the named skill's instructions, formatted the
//! same way as the SPA-side executor.

use serde_json::Value;
use std::sync::Arc;

use crate::skill_registry::SkillRegistry;
use crate::tools::input_string;

pub async fn execute(registry: &Arc<SkillRegistry>, input: &Value) -> Result<String, String> {
    let name = input_string(input, "name").unwrap_or("").trim();
    if name.is_empty() {
        return Err("Missing required parameter: name".into());
    }
    match registry.instructions(name) {
        Some(instructions) => Ok(format_skill(name, &instructions)),
        None => {
            let available = registry.available().join(", ");
            Err(format!(
                "Unknown skill: {}. Available skills: {}",
                name, available
            ))
        }
    }
}

/// Format a skill's instructions the way the model should receive them. Shared
/// by the `use_skill` tool and explicit `/skill_name` slash-command invocation.
pub fn format_skill(name: &str, instructions: &str) -> String {
    format!(
        "# Skill: {}\n\nFollow these instructions to complete the task:\n\n{}",
        name, instructions
    )
}

/// The formatted instruction block for a known skill, or `None` if unknown.
pub fn skill_block(registry: &SkillRegistry, name: &str) -> Option<String> {
    registry.instructions(name).map(|i| format_skill(name, &i))
}
