//! `/api/path/join` — utility used by the SPA's `tauri-path.ts` mock.
//! Joins path segments using the host OS separator (mirrors Node `path.join`).

use std::path::PathBuf;

use axum::{Json, Router, routing::post};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/path/join", post(join))
}

#[derive(Deserialize)]
struct JoinReq {
    #[serde(default)]
    segments: Vec<String>,
}

async fn join(Json(req): Json<JoinReq>) -> Json<Value> {
    let mut p = PathBuf::new();
    for seg in &req.segments {
        p.push(seg);
    }
    Json(json!({ "path": p.to_string_lossy() }))
}
