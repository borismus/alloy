//! `GET /api/startup`: everything the SPA reads before its first paint, in one
//! response.
//!
//! Startup used to be ~10 dependent `/api/fs/*` round trips (existence checks,
//! then config, then each folder). Over a phone's tunnel each round trip costs
//! 100ms or more, so they dominated time-to-list. This route reads the same
//! files and returns them raw; the SPA still does all the parsing, so the data
//! it ends up with is identical to the per-file path (`vault.ts` keeps that
//! path as the fallback for older servers and for vaults that need setup).

use std::path::Path;

use axum::{extract::State, routing::get, Json, Router};
use serde_json::{json, Map, Value};
use tokio::fs;

use crate::routes::{config::client_config, fs::read_headers};
use crate::{error::AppError, AppState};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/startup", get(get_startup))
}

/// Paths `vaultService.initializeVault` creates. When any is missing the SPA
/// takes the per-file path, which creates them.
const LAYOUT: [&str; 7] = [
    "conversations",
    "skills",
    "notes",
    "tasks",
    "conversations/attachments",
    "memory.md",
    "config.yaml",
];

/// Bytes of each conversation file the sidebar needs (its metadata block),
/// matching `loadConversationSummaries`.
const CONVERSATION_HEADER_BYTES: usize = 512;

async fn get_startup(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let mut files = read_startup_files(state.vault.root()).await;
    let config = serde_json::to_value(client_config(&state).await?)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    files.insert("config".into(), config);
    Ok(Json(Value::Object(files)))
}

/// The raw vault files startup needs. A missing folder reads as empty and an
/// unreadable file is skipped, so one bad file never fails startup.
async fn read_startup_files(root: &Path) -> Map<String, Value> {
    let complete = LAYOUT.iter().all(|path| root.join(path).exists());
    let [conversations_dir, notes_dir, tasks_dir, skills_dir, memory_path] =
        ["conversations", "notes", "tasks", "skills", "memory.md"].map(|name| root.join(name));
    let (conversations, notes, tasks, skills, memory) = tokio::join!(
        read_headers(&conversations_dir, ".yaml", Some(CONVERSATION_HEADER_BYTES)),
        read_headers(&notes_dir, ".md", Some(0)),
        read_headers(&tasks_dir, ".yaml", None),
        read_skills(&skills_dir),
        read_memory(&memory_path),
    );

    let mut out = Map::new();
    out.insert("complete".into(), json!(complete));
    out.insert("memory".into(), memory);
    out.insert(
        "conversations".into(),
        Value::Object(conversations.unwrap_or_default()),
    );
    out.insert("notes".into(), Value::Object(notes.unwrap_or_default()));
    out.insert("tasks".into(), Value::Object(tasks.unwrap_or_default()));
    out.insert("skills".into(), Value::Object(skills));
    out
}

/// `{ folder name: SKILL.md text }` for each skill folder that has one.
async fn read_skills(dir: &Path) -> Map<String, Value> {
    let mut skills = Map::new();
    let Ok(mut entries) = fs::read_dir(dir).await else {
        return skills;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if !entry.file_type().await.is_ok_and(|ft| ft.is_dir()) {
            continue;
        }
        if let Ok(content) = fs::read_to_string(entry.path().join("SKILL.md")).await {
            let name = entry.file_name().to_string_lossy().into_owned();
            skills.insert(name, json!(content));
        }
    }
    skills
}

/// `{ content, mtime }` for memory.md, or null when it's absent.
async fn read_memory(path: &Path) -> Value {
    let (Ok(content), Ok(metadata)) = (fs::read_to_string(path).await, fs::metadata(path).await)
    else {
        return Value::Null;
    };
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    json!({ "content": content, "mtime": mtime })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, path: &str, content: &[u8]) {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, content).unwrap();
    }

    fn full_vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for folder in ["conversations/attachments", "skills", "notes", "tasks"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        write(root, "config.yaml", b"version: 2\n");
        write(root, "memory.md", b"# Memory\n");
        dir
    }

    #[tokio::test]
    async fn reads_each_kind_of_file_the_way_its_loader_did() {
        let vault = full_vault();
        let root = vault.path();
        let long_conversation = format!("id: c1\ntitle: Trip\nmessages:\n{}", "- x\n".repeat(400));
        write(
            root,
            "conversations/c1-trip.yaml",
            long_conversation.as_bytes(),
        );
        write(root, "conversations/notes.txt", b"not a conversation");
        write(root, "notes/idea.md", b"note body the list doesn't need");
        let long_task = format!("id: t1\nprompt: |\n{}", "  line\n".repeat(200));
        write(root, "tasks/t1.yaml", long_task.as_bytes());
        write(
            root,
            "skills/writer/SKILL.md",
            b"---\nname: writer\n---\nbody",
        );
        std::fs::create_dir_all(root.join("skills/empty")).unwrap();
        write(root, "skills/loose.md", b"not a skill folder");

        let files = read_startup_files(root).await;

        assert_eq!(files["complete"], json!(true));
        assert_eq!(files["memory"]["content"], json!("# Memory\n"));
        assert!(files["memory"]["mtime"].as_f64().unwrap() > 0.0);

        let conversations = files["conversations"].as_object().unwrap();
        assert_eq!(conversations.keys().collect::<Vec<_>>(), ["c1-trip.yaml"]);
        let header = conversations["c1-trip.yaml"]["content"].as_str().unwrap();
        assert_eq!(header, &long_conversation[..CONVERSATION_HEADER_BYTES]);

        assert_eq!(files["notes"]["idea.md"]["content"], json!(""));
        assert!(files["notes"]["idea.md"]["mtime"].as_f64().unwrap() > 0.0);

        assert_eq!(files["tasks"]["t1.yaml"]["content"], json!(long_task));

        let skills = files["skills"].as_object().unwrap();
        assert_eq!(skills.keys().collect::<Vec<_>>(), ["writer"]);
        assert_eq!(skills["writer"], json!("---\nname: writer\n---\nbody"));
    }

    #[tokio::test]
    async fn reports_an_incomplete_vault_so_the_app_sets_it_up() {
        for missing in LAYOUT {
            let vault = full_vault();
            let path = vault.path().join(missing);
            if path.is_dir() {
                std::fs::remove_dir_all(&path).unwrap();
            } else {
                std::fs::remove_file(&path).unwrap();
            }
            let files = read_startup_files(vault.path()).await;
            assert_eq!(files["complete"], json!(false), "missing {missing}");
        }
    }

    #[tokio::test]
    async fn an_empty_folder_reads_as_empty_lists() {
        let vault = tempfile::tempdir().unwrap();
        let files = read_startup_files(vault.path()).await;
        assert_eq!(files["complete"], json!(false));
        assert_eq!(files["memory"], Value::Null);
        for kind in ["conversations", "notes", "tasks", "skills"] {
            assert_eq!(files[kind], json!({}), "{kind}");
        }
    }

    #[tokio::test]
    async fn a_file_that_is_not_utf8_does_not_fail_startup() {
        let vault = full_vault();
        write(vault.path(), "tasks/bad.yaml", &[0xff, 0xfe, b'x']);
        write(vault.path(), "tasks/good.yaml", b"id: t2\n");
        let files = read_startup_files(vault.path()).await;
        assert_eq!(files["tasks"]["good.yaml"]["content"], json!("id: t2\n"));
        // Read lossily; the SPA's YAML parse then drops it like any broken task.
        assert!(files["tasks"]["bad.yaml"]["content"].is_string());
    }
}
