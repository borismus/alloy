//! External read-only mounts.
//!
//! Each `privateReadOnlyDirs` entry in config.yaml (an external absolute dir) is
//! exposed under a synthetic vault-relative prefix. The prefix encodes who may
//! read it, so the trust zone is visible in every path a model echoes back and
//! in every log line:
//!
//! - `private/<alias>/` — `audience: local` (the default). Local models only.
//! - `shared/<alias>/`  — `audience: all`. Cloud providers may read it too.
//!
//! The model always passes relative-looking paths; [`resolve_for`] translates
//! the prefix to the external root with canonicalize + containment safety, so
//! the vault sandbox is relaxed for *exactly* the configured roots.
//!
//! Three rules keep a cloud model away from local-only material:
//!
//! 1. **Deny before touching disk.** A caller that may not read the named mount
//!    is refused from config alone, so it cannot probe for a file's existence.
//! 2. **Audience belongs to the resolved file, not the requested path.** Mounts
//!    may nest (`~/Notes` local, `~/Notes/Public` shared), so the *longest*
//!    matching root governs, and the request must address that mount directly.
//!    One file therefore has exactly one address, and `private/` can never
//!    appear in a successful cloud turn.
//! 3. **Containment after symlink resolution.** `canonicalize` runs before the
//!    `starts_with(root)` check, so a symlink out of a shared mount into a
//!    local one is rejected rather than silently followed.

use std::path::{Path, PathBuf};

use crate::config::{Audience, PrivateDir};

/// Prefix for mounts only local models may read.
pub const PRIVATE_PREFIX: &str = "private/";
/// Prefix for mounts every model may read, including cloud providers.
pub const SHARED_PREFIX: &str = "shared/";

/// Non-committal error for any denied/failed access, so a probe can't
/// distinguish "exists but denied" from "doesn't exist".
const DENY: &str = "not accessible";

/// The prefix a mount is addressed by, derived from its audience.
pub fn prefix_for(audience: Audience) -> &'static str {
    match audience {
        Audience::Local => PRIVATE_PREFIX,
        Audience::All => SHARED_PREFIX,
    }
}

/// True when `request_path` addresses a local-only mount. Used to mark a turn
/// as having read material cloud models may not see; the prefix is authoritative
/// because [`resolve_for`] refuses any request whose prefix disagrees with its
/// mount's audience.
pub fn is_private_path(request_path: &str) -> bool {
    request_path
        .trim_start_matches('/')
        .starts_with(PRIVATE_PREFIX)
}

/// True when `request_path` addresses either mount prefix (ignoring a leading `/`).
pub fn is_mount_path(request_path: &str) -> bool {
    let rel = request_path.trim_start_matches('/');
    rel.starts_with(PRIVATE_PREFIX) || rel.starts_with(SHARED_PREFIX)
}

/// Split a request path into the audience its prefix claims and the remainder.
fn split_prefix(rel: &str) -> Option<(Audience, &str)> {
    if let Some(rest) = rel.strip_prefix(PRIVATE_PREFIX) {
        return Some((Audience::Local, rest));
    }
    rel.strip_prefix(SHARED_PREFIX).map(|rest| (Audience::All, rest))
}

/// Mounts a caller of this trust level may read, in config order.
pub fn visible_to(config: &crate::config::Config, caller_is_local: bool) -> Vec<&PrivateDir> {
    config
        .private_read_only_dirs
        .iter()
        .filter(|d| d.audience.allows(caller_is_local))
        .collect()
}

/// The mount governing `target` — the longest configured root containing it.
///
/// Nested mounts make this the deciding step: `~/Notes/Public/a.md` is governed
/// by the `Public` mount even though `~/Notes` also contains it.
fn governing_mount<'a>(
    config: &'a crate::config::Config,
    target: &Path,
) -> Option<&'a PrivateDir> {
    config
        .private_read_only_dirs
        .iter()
        .filter_map(|d| {
            let canon = d.path.canonicalize().ok()?;
            target.starts_with(&canon).then(|| (canon.as_os_str().len(), d))
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, d)| d)
}

/// Resolve a `private|shared/<alias>/<tail>` request for a caller of the given
/// trust level.
///
/// - `Ok(Some(abs))` — addressable, permitted, and safe; the caller reads `abs`
///   directly (bypassing `Vault`).
/// - `Ok(None)` — not a mount path; the caller uses `Vault::resolve` as usual.
/// - `Err(_)` — denied, unknown, unsafe, or missing, with one generic message.
pub fn resolve_for(
    config: &crate::config::Config,
    request_path: &str,
    caller_is_local: bool,
) -> Result<Option<PathBuf>, String> {
    let rel = request_path.trim_start_matches('/');
    let Some((claimed, rest)) = split_prefix(rel) else {
        return Ok(None);
    };
    if rest.split('/').any(|seg| seg == "..") {
        return Err(DENY.into());
    }
    let (alias, tail) = rest.split_once('/').unwrap_or((rest, ""));
    if alias.is_empty() {
        return Err(DENY.into());
    }
    let dir = config
        .private_read_only_dirs
        .iter()
        .find(|d| d.alias == alias)
        .ok_or_else(|| DENY.to_string())?;

    // The prefix must name the mount's real audience, so `shared/secrets/...`
    // can't be used to dress a local-only mount up as a public one.
    if dir.audience != claimed {
        return Err(DENY.into());
    }
    // The one authorization decision, made from config alone before any
    // filesystem call, so an unauthorized caller never causes I/O against a
    // local-only mount. Deliberately the *only* place audience is enforced: a
    // second, redundant check downstream would make neither individually
    // load-bearing, and would go untested precisely because the other one
    // covers for it.
    if !dir.audience.allows(caller_is_local) {
        return Err(DENY.into());
    }

    let root_canon = dir.path.canonicalize().map_err(|_| DENY.to_string())?;
    let target_canon = root_canon
        .join(tail)
        .canonicalize()
        .map_err(|_| DENY.to_string())?;
    if !target_canon.starts_with(&root_canon) {
        return Err(DENY.into());
    }

    // Judge the file by where it actually landed. A nested mount governs its own
    // subtree, so reaching those files through the parent's prefix is refused,
    // keeping one file to one address. Audience is settled above; this is purely
    // about identity, and the alias check subsumes it — a different governing
    // mount is rejected outright rather than re-authorized.
    let governing = governing_mount(config, &target_canon).ok_or_else(|| DENY.to_string())?;
    if governing.alias != dir.alias {
        return Err(DENY.into());
    }
    Ok(Some(target_canon))
}

/// Canonical absolute paths to skip when traversing the mount that
/// `request_path` addresses: the mount's configured `excludeDirs` plus any
/// other mount nested inside it.
///
/// Excluding nested mounts is what makes the carve-out real — listing
/// `private/obsidian_vault` must not walk into `shared/public`, or the same
/// files would appear under two addresses with two different audiences.
pub fn exclude_roots(config: &crate::config::Config, request_path: &str) -> Vec<PathBuf> {
    let rel = request_path.trim_start_matches('/');
    let Some((_, rest)) = split_prefix(rel) else {
        return Vec::new();
    };
    let (alias, _tail) = rest.split_once('/').unwrap_or((rest, ""));
    let Some(dir) = config.private_read_only_dirs.iter().find(|d| d.alias == alias) else {
        return Vec::new();
    };
    let Ok(root_canon) = dir.path.canonicalize() else {
        return Vec::new();
    };
    let mut excludes: Vec<PathBuf> = dir
        .exclude_dirs
        .iter()
        .filter_map(|ex| root_canon.join(ex).canonicalize().ok())
        .collect();
    for other in &config.private_read_only_dirs {
        if other.alias == dir.alias {
            continue;
        }
        if let Ok(other_canon) = other.path.canonicalize() {
            if other_canon.starts_with(&root_canon) && other_canon != root_canon {
                excludes.push(other_canon);
            }
        }
    }
    excludes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::fs;

    // Inline tempdir helper (matches vault.rs — avoids adding the `tempfile` dep).
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "alloy-mounts-test-{}-{}-{}",
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

    fn dir(alias: &str, root: &Path, audience: Audience) -> PrivateDir {
        PrivateDir {
            alias: alias.into(),
            path: root.to_path_buf(),
            exclude_dirs: Vec::new(),
            description: None,
            audience,
        }
    }

    fn config_with(dirs: Vec<PrivateDir>) -> Config {
        Config {
            private_read_only_dirs: dirs,
            ..Config::default()
        }
    }

    const LOCAL: bool = true;
    const CLOUD: bool = false;

    #[test]
    fn non_mount_path_returns_none() {
        let cfg = Config::default();
        assert_eq!(resolve_for(&cfg, "notes/x.md", CLOUD).unwrap(), None);
        assert_eq!(resolve_for(&cfg, "/notes/x.md", LOCAL).unwrap(), None);
    }

    #[test]
    fn local_only_mount_resolves_for_local_and_is_denied_for_cloud() {
        let d = TempDir::new("localonly");
        fs::write(d.0.join("a.md"), "hi").unwrap();
        let cfg = config_with(vec![dir("notes", &d.0, Audience::Local)]);

        assert_eq!(
            resolve_for(&cfg, "private/notes/a.md", LOCAL).unwrap().unwrap(),
            d.0.join("a.md")
        );
        assert!(resolve_for(&cfg, "private/notes/a.md", CLOUD).is_err());
    }

    #[test]
    fn shared_mount_resolves_for_cloud_too() {
        let d = TempDir::new("shared");
        fs::write(d.0.join("p.md"), "published").unwrap();
        let cfg = config_with(vec![dir("public", &d.0, Audience::All)]);

        for caller in [LOCAL, CLOUD] {
            assert_eq!(
                resolve_for(&cfg, "shared/public/p.md", caller).unwrap().unwrap(),
                d.0.join("p.md")
            );
        }
    }

    #[test]
    fn prefix_must_match_the_mounts_real_audience() {
        // Addressing a local-only mount through `shared/` must not launder it,
        // and a shared mount keeps its own prefix.
        let d = TempDir::new("prefix");
        fs::write(d.0.join("a.md"), "x").unwrap();
        let cfg = config_with(vec![dir("notes", &d.0, Audience::Local)]);
        assert!(resolve_for(&cfg, "shared/notes/a.md", CLOUD).is_err());
        assert!(resolve_for(&cfg, "shared/notes/a.md", LOCAL).is_err());

        let pubdir = TempDir::new("prefix-pub");
        fs::write(pubdir.0.join("a.md"), "x").unwrap();
        let cfg = config_with(vec![dir("public", &pubdir.0, Audience::All)]);
        assert!(resolve_for(&cfg, "private/public/a.md", LOCAL).is_err());
    }

    /// The headline case: `~/Notes` local-only with `~/Notes/Public` shared.
    #[test]
    fn nested_shared_mount_is_readable_by_cloud_while_its_parent_is_not() {
        let notes = TempDir::new("nest");
        let public = notes.0.join("Public");
        fs::create_dir_all(&public).unwrap();
        fs::write(notes.0.join("Journal.md"), "private thoughts").unwrap();
        fs::write(public.join("Essay.md"), "published").unwrap();

        let cfg = config_with(vec![
            dir("obsidian_vault", &notes.0, Audience::Local),
            dir("public", &public, Audience::All),
        ]);

        // Cloud reads the public subtree, and nothing else.
        assert!(resolve_for(&cfg, "shared/public/Essay.md", CLOUD).is_ok());
        assert!(resolve_for(&cfg, "private/obsidian_vault/Journal.md", CLOUD).is_err());
        // ...including through the parent mount's prefix, which would otherwise
        // give one file two addresses and leak the private alias to the cloud.
        assert!(resolve_for(&cfg, "private/obsidian_vault/Public/Essay.md", CLOUD).is_err());

        // Local reads both, each at its own canonical address.
        assert!(resolve_for(&cfg, "private/obsidian_vault/Journal.md", LOCAL).is_ok());
        assert!(resolve_for(&cfg, "shared/public/Essay.md", LOCAL).is_ok());
        // Even for a local model, the nested file belongs to the nested mount.
        assert!(resolve_for(&cfg, "private/obsidian_vault/Public/Essay.md", LOCAL).is_err());
    }

    #[test]
    fn symlink_out_of_a_shared_mount_into_its_private_parent_is_rejected() {
        // The attack this design has to survive: a link inside the published
        // folder pointing back at the private notes it lives under.
        #[cfg(unix)]
        {
            let notes = TempDir::new("symnest");
            let public = notes.0.join("Public");
            fs::create_dir_all(&public).unwrap();
            fs::write(notes.0.join("Secret.md"), "top secret").unwrap();
            std::os::unix::fs::symlink(notes.0.join("Secret.md"), public.join("leak.md")).unwrap();

            let cfg = config_with(vec![
                dir("obsidian_vault", &notes.0, Audience::Local),
                dir("public", &public, Audience::All),
            ]);
            assert!(resolve_for(&cfg, "shared/public/leak.md", CLOUD).is_err());
            assert!(resolve_for(&cfg, "shared/public/leak.md", LOCAL).is_err());
        }
    }

    #[test]
    fn dotdot_traversal_is_rejected() {
        let d = TempDir::new("dotdot");
        let cfg = config_with(vec![dir("notes", &d.0, Audience::Local)]);
        assert!(resolve_for(&cfg, "private/notes/../escape", LOCAL).is_err());
        let cfg = config_with(vec![dir("public", &d.0, Audience::All)]);
        assert!(resolve_for(&cfg, "shared/public/../escape", CLOUD).is_err());
    }

    #[test]
    fn unknown_alias_is_rejected() {
        let d = TempDir::new("unknown");
        let cfg = config_with(vec![dir("notes", &d.0, Audience::Local)]);
        assert!(resolve_for(&cfg, "private/other/a.md", LOCAL).is_err());
        assert!(resolve_for(&cfg, "shared/other/a.md", CLOUD).is_err());
    }

    #[test]
    fn symlink_escaping_root_is_rejected() {
        #[cfg(unix)]
        {
            let d = TempDir::new("symroot");
            let outside = TempDir::new("symoutside");
            fs::write(outside.0.join("secret.md"), "top secret").unwrap();
            std::os::unix::fs::symlink(&outside.0, d.0.join("link")).unwrap();
            let cfg = config_with(vec![dir("notes", &d.0, Audience::Local)]);
            assert!(resolve_for(&cfg, "private/notes/link/secret.md", LOCAL).is_err());
        }
    }

    #[test]
    fn denials_are_indistinguishable_from_missing_files() {
        // A cloud model must not be able to tell "exists but denied" from
        // "no such mount" — same string for both.
        let d = TempDir::new("deny");
        fs::write(d.0.join("a.md"), "x").unwrap();
        let cfg = config_with(vec![dir("notes", &d.0, Audience::Local)]);
        let denied = resolve_for(&cfg, "private/notes/a.md", CLOUD).unwrap_err();
        let missing = resolve_for(&cfg, "private/nope/a.md", CLOUD).unwrap_err();
        assert_eq!(denied, missing);
    }

    #[test]
    fn exclude_roots_cover_configured_dirs_and_nested_mounts() {
        let notes = TempDir::new("excl");
        let public = notes.0.join("Public");
        let vault = notes.0.join("PromptBox");
        fs::create_dir_all(&public).unwrap();
        fs::create_dir_all(&vault).unwrap();

        let mut parent = dir("obsidian_vault", &notes.0, Audience::Local);
        parent.exclude_dirs = vec!["PromptBox".into()];
        let cfg = config_with(vec![parent, dir("public", &public, Audience::All)]);

        let excludes = exclude_roots(&cfg, "private/obsidian_vault");
        assert!(excludes.contains(&vault.canonicalize().unwrap()), "{excludes:?}");
        assert!(
            excludes.contains(&public.canonicalize().unwrap()),
            "a nested mount must be carved out of its parent's listing: {excludes:?}"
        );

        // The nested mount itself excludes nothing.
        assert!(exclude_roots(&cfg, "shared/public").is_empty());
    }

    #[test]
    fn visible_to_filters_by_audience() {
        let a = TempDir::new("vis-a");
        let b = TempDir::new("vis-b");
        let cfg = config_with(vec![
            dir("obsidian_vault", &a.0, Audience::Local),
            dir("public", &b.0, Audience::All),
        ]);

        let cloud: Vec<_> = visible_to(&cfg, CLOUD).iter().map(|d| d.alias.clone()).collect();
        assert_eq!(cloud, vec!["public"], "cloud sees only shared mounts");

        let local: Vec<_> = visible_to(&cfg, LOCAL).iter().map(|d| d.alias.clone()).collect();
        assert_eq!(local, vec!["obsidian_vault", "public"]);
    }
}
