use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use thiserror::Error;

/// Errors returned from route handlers. Each variant maps to a status code
/// and JSON body matching the shape today's Node server produces, so the
/// existing SPA error paths keep working unchanged.
///
/// All variants display the message verbatim — callers supply the full
/// human-readable string (e.g. `"File not found: conversations/foo.yaml"`).
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),

    #[error("Path traversal not allowed")]
    PathTraversal,

    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::PathTraversal => StatusCode::FORBIDDEN,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        // Map ENOENT to NotFound so the SPA's existing 404 handling works.
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(e.to_string())
        } else {
            AppError::Internal(e.to_string())
        }
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

/// Flatten an error and its `source()` chain into one line. `reqwest` hides the
/// real failure (connection refused, timed out, DNS, TLS) behind a generic
/// "error sending request for url (...)" Display — the useful cause lives in the
/// source chain, so surface it in errors shown to the user or the model.
pub fn error_chain(err: &dyn std::error::Error) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(e) = source {
        let msg = e.to_string();
        // Skip links that just repeat the previous message (reqwest/hyper often
        // nest near-identical wrappers).
        if !out.ends_with(&msg) {
            out.push_str(": ");
            out.push_str(&msg);
        }
        source = e.source();
    }
    out
}
