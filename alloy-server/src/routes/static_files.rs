//! Embed and serve the SPA's built `dist-web/` static assets from inside
//! the binary. Phase 2: when the SPA is loaded over `shareOnNetwork`, the
//! mobile browser fetches index.html + bundled assets from the same axum
//! origin (no separate Vite needed in prod).
//!
//! In debug builds, rust-embed reads from disk at runtime (no need to
//! rebuild Rust when SPA changes). In release builds it embeds the files.
//! If `dist-web/` doesn't exist at build time, the handler returns 404
//! cleanly — that's fine in dev where Vite serves the SPA on :1420.

use axum::{
    Router,
    body::Body,
    extract::Path,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;

use crate::AppState;

#[derive(RustEmbed)]
#[folder = "../dist-web/"]
struct SpaAssets;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(serve_index))
        .route("/{*path}", get(serve_asset))
}

async fn serve_index() -> Response {
    serve_embedded("index.html")
}

async fn serve_asset(Path(path): Path<String>) -> Response {
    // SPA fallback: routes the client owns (no file extension, not under
    // /api/*) should serve index.html so client-side routing handles them.
    // /api/* is matched first by the router stack so it never reaches here.
    if has_file_extension(&path) {
        serve_embedded(&path)
    } else {
        serve_embedded("index.html")
    }
}

fn has_file_extension(path: &str) -> bool {
    path.rsplit_once('/')
        .map(|(_, last)| last.contains('.'))
        .unwrap_or_else(|| path.contains('.'))
}

fn serve_embedded(path: &str) -> Response {
    match SpaAssets::get(path) {
        Some(file) => {
            let mime = file.metadata.mimetype();
            Response::builder()
                .header(header::CONTENT_TYPE, mime)
                // SPA assets carry content hashes in their filenames; safe
                // to cache aggressively. index.html should NOT be cached
                // (it references the hashed assets and changes on every
                // build).
                .header(
                    header::CACHE_CONTROL,
                    if path == "index.html" {
                        "no-cache"
                    } else {
                        "public, max-age=31536000, immutable"
                    },
                )
                .body(Body::from(file.data.into_owned()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => {
            // No embedded SPA (dist-web/ wasn't built before this Rust
            // build). In dev that's expected — Vite serves the SPA on a
            // separate port. Return 404 quietly.
            (StatusCode::NOT_FOUND, "asset not found\n").into_response()
        }
    }
}
