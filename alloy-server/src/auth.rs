use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, atomic::{AtomicBool, Ordering}},
};

use axum::{
    extract::{ConnectInfo, State},
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};

/// IP allowlist matching today's Node server behavior: allow loopback and
/// Tailscale (100.64.0.0/10) addresses, refuse everything else.
///
/// Phase 1 deliberately ships no bearer-token UX (see the resolved-decisions
/// section of the plan). When auth lands in Phase 2 this middleware can be
/// extended or composed with a token-check middleware.
pub async fn ip_allowlist(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if is_allowed(addr.ip()) {
        Ok(next.run(request).await)
    } else {
        tracing::warn!("Rejected request from disallowed IP: {}", addr.ip());
        Err(StatusCode::FORBIDDEN)
    }
}

/// Gate requests that arrived via `tailscale serve`'s reverse proxy when the
/// "Share on Network" toggle is off.
///
/// Why this exists: the `ip_allowlist` and the listener's bind-interface both
/// look at the TCP-level source IP. `tailscale serve` proxies external HTTPS
/// to the embedded server over loopback, so its requests *look* like they
/// came from the same machine. Without a header-level check, the toggle
/// would silently let Tailscale-fronted devices through even when off.
///
/// `Tailscale-User-Login` is set by Tailscale's reverse proxy on every
/// request it forwards; the Tauri webview and direct loopback `curl`s never
/// set it, so this only rejects the proxy path.
pub async fn tailscale_share_gate(
    State(share_on): State<Arc<AtomicBool>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let proxied_by_tailscale = request.headers().contains_key("tailscale-user-login");
    if proxied_by_tailscale && !share_on.load(Ordering::Relaxed) {
        tracing::warn!(
            "Rejected Tailscale-proxied request: share-on-network is off"
        );
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
}

fn is_allowed(ip: IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    match ip {
        // Tailscale CGNAT range: 100.64.0.0/10 (covers 100.64.0.0 - 100.127.255.255).
        // Node server allowed any "100." prefix — slightly broader. We mirror that
        // broader behavior so existing Tailscale setups keep working.
        IpAddr::V4(v4) => v4.octets()[0] == 100,
        IpAddr::V6(v6) => {
            // IPv4-mapped IPv6 (::ffff:100.x.x.x)
            if let Some(v4) = v6.to_ipv4_mapped() {
                v4.octets()[0] == 100
            } else {
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn allows_loopback_v4() {
        assert!(is_allowed(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
    }

    #[test]
    fn allows_loopback_v6() {
        assert!(is_allowed(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    }

    #[test]
    fn allows_tailscale() {
        assert!(is_allowed(IpAddr::V4(Ipv4Addr::new(100, 64, 1, 2))));
        assert!(is_allowed(IpAddr::V4(Ipv4Addr::new(100, 127, 255, 255))));
    }

    #[test]
    fn allows_ipv4_mapped_tailscale() {
        let mapped = Ipv4Addr::new(100, 64, 1, 2).to_ipv6_mapped();
        assert!(is_allowed(IpAddr::V6(mapped)));
    }

    #[test]
    fn rejects_public_v4() {
        assert!(!is_allowed(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_allowed(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
    }

    mod share_gate {
        use super::*;
        use axum::{
            Router,
            body::Body,
            http::{Request, StatusCode},
            middleware::from_fn_with_state,
            routing::get,
        };
        use tower::util::ServiceExt;

        fn app(share_on: bool) -> Router {
            let flag = Arc::new(AtomicBool::new(share_on));
            Router::new()
                .route("/api/models", get(|| async { "ok" }))
                .layer(from_fn_with_state(flag, tailscale_share_gate))
        }

        async fn status(router: Router, req: Request<Body>) -> StatusCode {
            router.oneshot(req).await.unwrap().status()
        }

        #[tokio::test]
        async fn allows_unproxied_request_when_share_off() {
            // No `Tailscale-User-Login` header → looks like the Tauri webview
            // or a direct loopback curl; let it through.
            let r = app(false);
            let req = Request::builder().uri("/api/models").body(Body::empty()).unwrap();
            assert_eq!(status(r, req).await, StatusCode::OK);
        }

        #[tokio::test]
        async fn rejects_tailscale_proxied_request_when_share_off() {
            let r = app(false);
            let req = Request::builder()
                .uri("/api/models")
                .header("Tailscale-User-Login", "boris@example.com")
                .body(Body::empty())
                .unwrap();
            assert_eq!(status(r, req).await, StatusCode::FORBIDDEN);
        }

        #[tokio::test]
        async fn allows_tailscale_proxied_request_when_share_on() {
            let r = app(true);
            let req = Request::builder()
                .uri("/api/models")
                .header("Tailscale-User-Login", "boris@example.com")
                .body(Body::empty())
                .unwrap();
            assert_eq!(status(r, req).await, StatusCode::OK);
        }
    }
}
