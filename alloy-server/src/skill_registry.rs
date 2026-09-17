//! Minimal server-side skill registry. Seeds the skills shipped with the app,
//! then scans `<vault>/skills/*/SKILL.md` and the older flat
//! `<vault>/skills/*.md` layout once at startup, parses frontmatter via
//! `serde_yaml`, exposes `getSkillInstructions(name)`.
//!
//! Mirrors the SPA's [src/services/skills/registry.ts](src/services/skills/registry.ts)
//! contract: `name` from frontmatter, `description`, and full body (sans
//! frontmatter) returned as instructions — including its bundled-plus-vault
//! composition, because the SPA builds the `# Available Skills` prompt from its
//! copy while this registry is what actually executes `use_skill`. When the two
//! disagree the model is offered skills that cannot run.

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

/// Skills shipped with the app, embedded at compile time.
///
/// The SPA compiles these same files into its bundle to build the
/// `# Available Skills` prompt. They are embedded rather than read from
/// `skills/` at runtime because that directory exists only in a dev checkout,
/// not inside a packaged app — a registry that merely pointed at the path would
/// work locally and silently ship empty.
///
/// `bundled_skills_match_the_directory` keeps this list honest when a skill is
/// added or renamed.
const BUNDLED_SKILLS: &[(&str, &str)] = &[
    (
        "create-scheduled-task",
        include_str!("../../skills/create-scheduled-task/SKILL.md"),
    ),
    (
        "note-capture",
        include_str!("../../skills/note-capture/SKILL.md"),
    ),
    (
        "note-linker",
        include_str!("../../skills/note-linker/SKILL.md"),
    ),
    (
        "note-query",
        include_str!("../../skills/note-query/SKILL.md"),
    ),
    ("read-url", include_str!("../../skills/read-url/SKILL.md")),
    (
        "save-memory",
        include_str!("../../skills/save-memory/SKILL.md"),
    ),
    (
        "summarize-note",
        include_str!("../../skills/summarize-note/SKILL.md"),
    ),
];

/// Parse the embedded skills into a name-keyed map.
fn bundled_skills() -> HashMap<String, Skill> {
    let mut map = HashMap::new();
    for (dir, text) in BUNDLED_SKILLS {
        match parse_skill(text) {
            Some(skill) => {
                map.insert(skill.name.clone(), skill);
            }
            // Compile-time content, so this means the file itself is malformed.
            None => tracing::warn!("bundled skill '{}' has no usable frontmatter", dir),
        }
    }
    map
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

    /// Seed the bundled skills, then let `<vault>/skills/` add to or override
    /// them by name. A vault without a `skills/` directory still gets the
    /// bundled set — returning early here is what left every shipped skill
    /// advertised by the SPA but unrunnable by the backend.
    pub fn load(&self, vault_root: &std::path::Path) {
        let mut map = bundled_skills();
        let bundled = map.len();
        let from_vault = self.load_vault_skills(vault_root, &mut map);

        tracing::info!(
            "skill registry loaded {} skill(s): {} bundled, {} from vault",
            map.len(),
            bundled,
            from_vault
        );
        *self.skills.write().unwrap() = map;
    }

    /// Merge `<vault>/skills/` into `map`, returning how many were read. Quiet
    /// on a missing directory: most vaults have no custom skills.
    fn load_vault_skills(
        &self,
        vault_root: &std::path::Path,
        map: &mut HashMap<String, Skill>,
    ) -> usize {
        let skills_dir = vault_root.join("skills");
        let mut count = 0;

        let entries = match std::fs::read_dir(&skills_dir) {
            Ok(e) => e,
            Err(_) => return 0,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = entry.file_type().ok();

            if file_type.as_ref().is_some_and(|t| t.is_dir()) {
                let skill_md = path.join("SKILL.md");
                if let Ok(text) = std::fs::read_to_string(&skill_md) {
                    if let Some(skill) = parse_skill(&text) {
                        map.insert(skill.name.clone(), skill);
                        count += 1;
                    }
                }
            } else if file_type.as_ref().is_some_and(|t| t.is_file()) {
                let name = entry.file_name();
                if name.to_string_lossy().ends_with(".md") {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        if let Some(skill) = parse_skill(&text) {
                            map.insert(skill.name.clone(), skill);
                            count += 1;
                        }
                    }
                }
            }
        }

        count
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

    /// THE DRIFT GUARD. The SPA advertises every skill in `skills/` via
    /// `import.meta.glob`; this registry is what can actually run them. When the
    /// two sets diverge the model is offered skills that error on use, which is
    /// exactly how all seven shipped skills came to be advertised and unrunnable
    /// for months. Adding a skill directory without embedding it here fails
    /// loudly instead.
    #[test]
    fn bundled_skills_match_the_directory() {
        use std::collections::BTreeSet;

        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills");
        let on_disk: BTreeSet<String> = std::fs::read_dir(&dir)
            .expect("repo skills/ directory")
            .flatten()
            .filter(|e| e.path().join("SKILL.md").is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        let embedded: BTreeSet<String> = BUNDLED_SKILLS
            .iter()
            .map(|(dir, _)| (*dir).to_string())
            .collect();

        assert_eq!(
            on_disk, embedded,
            "skills/ and BUNDLED_SKILLS disagree; the SPA advertises the directory, \
             so anything missing here is offered to the model but cannot run"
        );
    }

    #[test]
    fn bundled_skills_load_without_any_vault_skills_directory() {
        // Regression: `load` used to return early when the vault had no skills/,
        // leaving the registry empty while the SPA still advertised all seven.
        let reg = SkillRegistry::new();
        reg.load(std::path::Path::new("/nonexistent-vault-path"));

        let available = reg.available();
        for expected in ["note-query", "save-memory", "read-url"] {
            assert!(
                available.iter().any(|n| n == expected),
                "{expected} missing from {available:?}"
            );
        }
        assert!(reg.instructions("note-query").is_some_and(|i| !i.trim().is_empty()));
    }

    #[test]
    fn a_vault_skill_overrides_the_bundled_copy_of_the_same_name() {
        let mut root = std::env::temp_dir();
        root.push(format!(
            "alloy-skills-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let skill_dir = root.join("skills/note-query");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: note-query\ndescription: mine\n---\n\nCUSTOMIZED BODY\n",
        )
        .unwrap();

        let reg = SkillRegistry::new();
        reg.load(&root);
        assert!(reg
            .instructions("note-query")
            .is_some_and(|i| i.contains("CUSTOMIZED BODY")));
        // ...and the other bundled skills survive the override.
        assert!(reg.instructions("save-memory").is_some());

        let _ = std::fs::remove_dir_all(&root);
    }
}
