//! Private read-only mounts for local models.
//!
//! Each `privateReadOnlyDirs` entry in config.yaml (an external absolute dir) is
//! exposed to **local** models under a synthetic vault-relative prefix
//! `private/<alias>/`. The model always passes relative-looking paths
//! (`private/notes/foo.md`); [`resolve_private_path`] translates the prefix to
//! the external root with canonicalize + containment safety, so the vault
//! sandbox is relaxed for *exactly* the configured roots and nothing else.
//!
//! Cloud models never reach this path: callers short-circuit on
//! [`is_private_path`] with a generic "not found" before touching disk, so a
//! cloud model can't read the dir or learn it exists.

use std::path::{Path, PathBuf};

use crate::config::Config;

/// Synthetic mount prefix a model uses to address private dirs.
pub const MOUNT_PREFIX: &str = "private/";

/// Non-committal error for any denied/failed private access, so a probe can't
/// distinguish "exists but denied" from "doesn't exist".
const DENY: &str = "not accessible";

/// True when `request_path` addresses the private mount (ignoring a leading `/`).
pub fn is_private_path(request_path: &str) -> bool {
    request_path.trim_start_matches('/').starts_with(MOUNT_PREFIX)
}

/// `(alias, external-root)` for each configured private dir.
pub fn mounts(config: &Config) -> Vec<(&str, &Path)> {
    config
        .private_read_only_dirs
        .iter()
        .map(|d| (d.alias.as_str(), d.path.as_path()))
        .collect()
}

/// Resolve a `private/<alias>/<tail>` request to a safe absolute path.
///
/// - `Ok(Some(abs))` — private + safe; caller reads `abs` directly (bypassing `Vault`).
/// - `Ok(None)` — not a private path; caller uses `Vault::resolve` as usual.
/// - `Err(_)` — private but unsafe/unknown/missing (generic message).
///
/// Safety: `..` is rejected textually, and `canonicalize` resolves every symlink
/// before the `starts_with(root)` containment check — so a symlink inside the
/// mount pointing outside the root canonicalizes out of range and is rejected.
pub fn resolve_private_path(config: &Config, request_path: &str) -> Result<Option<PathBuf>, String> {
    let rel = request_path.trim_start_matches('/');
    let Some(rest) = rel.strip_prefix(MOUNT_PREFIX) else {
        return Ok(None);
    };
    if rest.split('/').any(|seg| seg == "..") {
        return Err(DENY.into());
    }
    let (alias, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if alias.is_empty() {
        return Err(DENY.into());
    }
    let root = mounts(config)
        .into_iter()
        .find(|(a, _)| *a == alias)
        .map(|(_, p)| p)
        .ok_or_else(|| DENY.to_string())?;

    let root_canon = root.canonicalize().map_err(|_| DENY.to_string())?;
    let target_canon = root_canon
        .join(tail)
        .canonicalize()
        .map_err(|_| DENY.to_string())?;
    if !target_canon.starts_with(&root_canon) {
        return Err(DENY.into());
    }
    Ok(Some(target_canon))
}

/// Canonical absolute paths to skip when traversing the private mount that
/// `request_path` addresses (from the mount's `excludeDirs`). Empty for
/// non-private paths, unknown aliases, or mounts without exclusions. Used by
/// `list_directory`/`search_directory` to keep e.g. the nested Alloy vault out
/// of results. This is a convenience filter, not a security boundary (that's
/// [`resolve_private_path`]), so entry paths are prefix-matched as-is.
pub fn private_exclude_roots(config: &Config, request_path: &str) -> Vec<PathBuf> {
    let rel = request_path.trim_start_matches('/');
    let Some(rest) = rel.strip_prefix(MOUNT_PREFIX) else {
        return Vec::new();
    };
    let (alias, _tail) = rest.split_once('/').unwrap_or((rest, ""));
    let Some(dir) = config.private_read_only_dirs.iter().find(|d| d.alias == alias) else {
        return Vec::new();
    };
    let Ok(root_canon) = dir.path.canonicalize() else {
        return Vec::new();
    };
    dir.exclude_dirs
        .iter()
        .filter_map(|ex| root_canon.join(ex).canonicalize().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PrivateDir;
    use std::fs;

    // Inline tempdir helper (matches vault.rs — avoids adding the `tempfile` dep).
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "alloy-private-test-{}-{}-{}",
                tag,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            // canonicalize so comparisons match (macOS temp is a symlink).
            TempDir(p.canonicalize().unwrap())
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn config_with_mount(alias: &str, root: &Path) -> Config {
        Config {
            private_read_only_dirs: vec![PrivateDir {
                alias: alias.into(),
                path: root.to_path_buf(),
                exclude_dirs: Vec::new(),
                description: None,
            }],
            ..Config::default()
        }
    }

    #[test]
    fn non_private_path_returns_none() {
        let cfg = Config::default();
        assert_eq!(resolve_private_path(&cfg, "notes/x.md").unwrap(), None);
        assert_eq!(resolve_private_path(&cfg, "/notes/x.md").unwrap(), None);
    }

    #[test]
    fn valid_mount_resolves_to_external_file() {
        let dir = TempDir::new("ok");
        fs::write(dir.0.join("a.md"), "hi").unwrap();
        let cfg = config_with_mount("notes", &dir.0);
        let resolved = resolve_private_path(&cfg, "private/notes/a.md")
            .unwrap()
            .unwrap();
        assert_eq!(resolved, dir.0.join("a.md"));
    }

    #[test]
    fn dotdot_traversal_is_rejected() {
        let dir = TempDir::new("dotdot");
        let cfg = config_with_mount("notes", &dir.0);
        assert!(resolve_private_path(&cfg, "private/notes/../escape").is_err());
    }

    #[test]
    fn unknown_alias_is_rejected() {
        let dir = TempDir::new("unknown");
        let cfg = config_with_mount("notes", &dir.0);
        assert!(resolve_private_path(&cfg, "private/other/a.md").is_err());
    }

    #[test]
    fn symlink_escaping_root_is_rejected() {
        let dir = TempDir::new("symroot");
        let outside = TempDir::new("symoutside");
        fs::write(outside.0.join("secret.md"), "top secret").unwrap();
        // A symlink INSIDE the mount pointing OUTSIDE it must not grant access.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside.0, dir.0.join("link")).unwrap();
            let cfg = config_with_mount("notes", &dir.0);
            assert!(resolve_private_path(&cfg, "private/notes/link/secret.md").is_err());
        }
        let _ = &outside; // keep alive on non-unix
    }
}
