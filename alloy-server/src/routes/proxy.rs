//! `POST /api/proxy` — passthrough HTTP proxy.
//!
//! Used by the SPA's `tauri-http.ts` mock when the still-living client-side
//! code paths (orchestrator, triggers, sub-agents that haven't been
//! migrated to executeViaServer yet) need to make external HTTP calls.
//! Phase 3 deletes those callers; until then this endpoint bridges them
//! through the embedded server so they avoid browser CORS restrictions.
//!
//! Wire format mirrors [server/index.ts:237-306](server/index.ts#L237-L306).

use std::collections::HashMap;

use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use futures_util::StreamExt;
use serde::Deserialize;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/proxy", post(proxy))
}

#[derive(Deserialize)]
struct ProxyReq {
    url: String,
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

async fn proxy(Json(req): Json<ProxyReq>) -> Response {
    if req.url.is_empty() || req.method.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Missing url or method" })),
        )
            .into_response();
    }

    let method = match Method::from_bytes(req.method.as_bytes()) {
        Ok(m) => m,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": format!("Invalid method: {}", req.method) })),
            )
                .into_response();
        }
    };

    let client = reqwest::Client::builder()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut request = client.request(method, &req.url);
    for (k, v) in &req.headers {
        request = request.header(k, v);
    }
    if let Some(body) = req.body {
        request = request.body(body);
    }

    let upstream = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": format!("Proxy error: {}", e) })),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let upstream_headers = upstream.headers().clone();

    // Forward response headers as x-proxied-* (matches the Node server's
    // shape so the SPA's tauri-http.ts mock can reconstruct them).
    let mut out_headers = HeaderMap::new();
    for (k, v) in upstream_headers.iter() {
        let prefixed = format!("x-proxied-{}", k.as_str());
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(prefixed.as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            out_headers.insert(name, value);
        }
    }
    // Also set content-type directly so the browser can interpret the
    // stream.
    if let Some(ct) = upstream_headers.get(header::CONTENT_TYPE) {
        out_headers.insert(header::CONTENT_TYPE, ct.clone());
    }

    // Stream the body through.
    let stream = upstream.bytes_stream().map(|res| {
        res.map_err(|e| std::io::Error::other(e.to_string()))
    });
    let body = Body::from_stream(stream);

    (status, out_headers, body).into_response()
}
