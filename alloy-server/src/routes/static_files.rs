//! Embed and serve the SPA's built `dist-web/` static assets from inside
//! the binary. Phase 2: when the SPA is loaded over `shareOnNetwork`, the
//! mobile browser fetches index.html + bundled assets from the same axum
//! origin (no separate Vite needed in prod).
//!
//! Mounted as a **fallback** on the router, not as a wildcard route. That
//! means:
//!  - Requests to declared routes (e.g. POST `/api/fs/exists`) hit those
//!    handlers normally; CORS preflight (OPTIONS) on those paths is
//!    handled by the CORS layer.
//!  - Only requests with no matching route at all reach this fallback —
//!    typically GETs for SPA assets or SPA-routed client paths.
//!  - Stray POSTs to non-existent `/api/*` paths return 404 cleanly
//!    instead of getting a confusing 405 from the wildcard.

use axum::{
    body::Body,
    extract::Request,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../dist-web/"]
#[allow_missing = true]
struct SpaAssets;

/// Axum fallback handler. Only invoked when no declared route matches.
pub async fn fallback(request: Request) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().trim_start_matches('/').to_string();

    // Anything under /api/ that wasn't matched by a real route is a genuine
    // 404 — don't serve the SPA as a fallback there (would confuse callers).
    if path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, "endpoint not found\n").into_response();
    }

    // We only serve SPA assets via GET/HEAD. Other methods would 405.
    if method != axum::http::Method::GET && method != axum::http::Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }

    // SPA fallback: paths without a file extension are client-side routes →
    // serve index.html so the SPA's router can handle them.
    let target = if path.is_empty() || !has_file_extension(&path) {
        "index.html"
    } else {
        path.as_str()
    };
    serve_embedded(target)
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
            // dist-web/ wasn't built before this binary, OR the requested
            // file isn't in it. In dev that's expected — Vite serves the
            // SPA on a separate port.
            (StatusCode::NOT_FOUND, "asset not found\n").into_response()
        }
    }
}
