use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::ConnectInfo,
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
}
