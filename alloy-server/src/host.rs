//! Stable, human-readable identity for the machine running this Alloy server.
//!
//! Scheduled-task ownership is stored in the synced vault as a hostname. Each
//! server compares that shared assignment with its own local identity. Bonjour
//! commonly reports macOS hosts with a `.local` suffix while users refer to the
//! same machine without it, so matching deliberately normalizes that suffix.

/// Normalize a hostname for scheduler ownership comparisons and display.
pub fn normalize_hostname(value: &str) -> String {
    let normalized = value.trim().trim_end_matches('.').to_ascii_lowercase();
    normalized
        .strip_suffix(".local")
        .unwrap_or(&normalized)
        .to_string()
}

/// Best-effort hostname for this server process. Always returns a non-empty
/// value so task history and failure reports can identify their runner.
pub fn current_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|value| value.into_string().ok())
        .map(|value| normalize_hostname(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown-host".into())
}

pub fn is_current_host(configured: &str, current: &str) -> bool {
    let configured = normalize_hostname(configured);
    !configured.is_empty() && configured == normalize_hostname(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bonjour_suffix_case_and_trailing_dot() {
        assert_eq!(normalize_hostname(" Legomenon.LOCAL. "), "legomenon");
        assert_eq!(normalize_hostname("smusmini"), "smusmini");
    }

    #[test]
    fn compares_short_and_bonjour_names() {
        assert!(is_current_host("legomenon", "legomenon.local"));
        assert!(is_current_host("SMUSMINI.local", "smusmini"));
        assert!(!is_current_host("smusmini", "legomenon.local"));
        assert!(!is_current_host("", "legomenon"));
    }
}
