//! Minimal server-side skill registry. Scans `<vault>/skills/*/SKILL.md` and
//! the older flat `<vault>/skills/*.md` layout once at startup, parses
//! frontmatter via `serde_yaml`, exposes `getSkillInstructions(name)`.
//!
//! Mirrors the SPA's [src/services/skills/registry.ts](src/services/skills/registry.ts)
//! contract: `name` from frontmatter, `description`, and full body (sans
//! frontmatter) returned as instructions.

use std::{collections::HashMap, sync::RwLock};

use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: Option<String>,
    pub instructions: String,
}

#[derive(Default)]
pub struct SkillRegistry {
    skills: RwLock<HashMap<String, Skill>>,
}

#[derive(Debug, Deserialize)]
struct Frontmatter {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scan `<vault>/skills/` and load all skill files. Quiet on missing dir.
    pub fn load(&self, vault_root: &std::path::Path) {
        let skills_dir = vault_root.join("skills");
        let mut map: HashMap<String, Skill> = HashMap::new();

        let entries = match std::fs::read_dir(&skills_dir) {
            Ok(e) => e,
            Err(_) => {
                tracing::info!("no skills/ directory in vault — skipping skill registry");
                return;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = entry.file_type().ok();

            if file_type.as_ref().is_some_and(|t| t.is_dir()) {
                let skill_md = path.join("SKILL.md");
                if let Ok(text) = std::fs::read_to_string(&skill_md) {
                    if let Some(skill) = parse_skill(&text) {
                        map.insert(skill.name.clone(), skill);
                    }
                }
            } else if file_type.as_ref().is_some_and(|t| t.is_file()) {
                let name = entry.file_name();
                if name.to_string_lossy().ends_with(".md") {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        if let Some(skill) = parse_skill(&text) {
                            map.insert(skill.name.clone(), skill);
                        }
                    }
                }
            }
        }

        tracing::info!("skill registry loaded {} skill(s)", map.len());
        *self.skills.write().unwrap() = map;
    }

    pub fn instructions(&self, name: &str) -> Option<String> {
        self.skills.read().unwrap().get(name).map(|s| s.instructions.clone())
    }

    pub fn available(&self) -> Vec<String> {
        self.skills.read().unwrap().keys().cloned().collect()
    }
}

/// Split frontmatter from body and parse name/description. Body is everything
/// after the closing `---`.
fn parse_skill(text: &str) -> Option<Skill> {
    if !text.starts_with("---") {
        return None;
    }
    let mut iter = text.splitn(3, "---");
    // First split: leading "" before the opening "---"
    let _leading = iter.next()?;
    let fm_text = iter.next()?;
    let body = iter.next().unwrap_or("").trim_start_matches('\n');

    let fm: Frontmatter = serde_yaml::from_str(fm_text).ok()?;
    let name = fm.name?;
    Some(Skill {
        name,
        description: fm.description,
        instructions: body.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let s = "---\nname: foo\ndescription: bar\n---\n\n# Body\n\nHello.\n";
        let skill = parse_skill(s).unwrap();
        assert_eq!(skill.name, "foo");
        assert_eq!(skill.description.as_deref(), Some("bar"));
        assert!(skill.instructions.contains("# Body"));
    }

    #[test]
    fn skill_without_frontmatter_is_skipped() {
        assert!(parse_skill("# Plain markdown\n").is_none());
    }
}
