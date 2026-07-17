use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Vault root + path-safety helpers. Every handler that touches the filesystem
/// goes through `Vault::resolve` so we can't be tricked into escaping the
/// vault root via `..` segments.
pub struct Vault {
    root: PathBuf,
}

impl Vault {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        let root = root.canonicalize()?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a request-supplied relative path within the vault. Strips any
    /// leading `/` (the SPA sometimes sends absolute-looking paths), joins
    /// with the vault root, and confirms the result stays inside the root.
    ///
    /// Returns the resolved path; the path is not required to exist on disk
    /// (callers may be creating it).
    pub fn resolve(&self, request_path: &str) -> Result<PathBuf, AppError> {
        let trimmed = request_path.trim_start_matches('/');
        let candidate = self.root.join(trimmed);
        let normalized = normalize_path(&candidate);
        if !normalized.starts_with(&self.root) {
            return Err(AppError::PathTraversal);
        }
        Ok(normalized)
    }

    /// Compute a vault-relative path for use in WebSocket watcher events.
    /// Falls back to the absolute path if `child` is outside the vault
    /// (shouldn't happen since the watcher is rooted at `self.root`).
    pub fn relativize(&self, child: &Path) -> PathBuf {
        child
            .strip_prefix(&self.root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| child.to_path_buf())
    }
}

/// Lexical path normalization (no I/O). Resolves `.` and `..` segments so
/// `vault/../../etc/passwd` collapses before the `starts_with(root)` check.
/// Done lexically rather than via `canonicalize` so paths to non-existent
/// files still work (writeTextFile creates new files).
pub(crate) fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile_helper::TempDir;

    // Tiny inline tempdir helper so we don't pull in the `tempfile` crate for
    // a single test. Cleans up on drop.
    mod tempfile_helper {
        use std::path::PathBuf;
        pub struct TempDir(pub PathBuf);
        impl TempDir {
            pub fn new() -> Self {
                let mut p = std::env::temp_dir();
                p.push(format!(
                    "alloy-vault-test-{}-{}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                std::fs::create_dir_all(&p).unwrap();
                TempDir(p)
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn setup() -> (TempDir, Vault) {
        let dir = TempDir::new();
        fs::create_dir_all(dir.0.join("conversations")).unwrap();
        let vault = Vault::new(dir.0.clone()).unwrap();
        (dir, vault)
    }

    #[test]
    fn resolves_relative_path() {
        let (_dir, vault) = setup();
        let resolved = vault.resolve("conversations/foo.yaml").unwrap();
        assert!(resolved.starts_with(vault.root()));
        assert!(resolved.ends_with("conversations/foo.yaml"));
    }

    #[test]
    fn strips_leading_slash() {
        let (_dir, vault) = setup();
        let with_slash = vault.resolve("/conversations/foo.yaml").unwrap();
        let without = vault.resolve("conversations/foo.yaml").unwrap();
        assert_eq!(with_slash, without);
    }

    #[test]
    fn rejects_dotdot_escape() {
        let (_dir, vault) = setup();
        let result = vault.resolve("../../../etc/passwd");
        assert!(matches!(result, Err(AppError::PathTraversal)));
    }

    #[test]
    fn rejects_embedded_dotdot() {
        let (_dir, vault) = setup();
        let result = vault.resolve("conversations/../../etc/passwd");
        assert!(matches!(result, Err(AppError::PathTraversal)));
    }
}
