use std::path::PathBuf;

use clap::Parser;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "alloy-serve",
    version,
    about = "Alloy server backend (Phase 1: standalone CLI)",
    long_about = None,
)]
pub struct Args {
    /// Path to the Alloy vault directory.
    #[arg(long, value_name = "PATH")]
    pub vault: PathBuf,

    /// TCP port to bind on.
    #[arg(long, default_value_t = 3001)]
    pub port: u16,

    /// Interface address to bind on. Defaults to all interfaces so Tailscale
    /// clients can reach the server; pair with the loopback+Tailscale IP
    /// allowlist in `auth::ip_allowlist`.
    #[arg(long, default_value = "0.0.0.0")]
    pub host: String,

    /// Report which conversations hold private-mount material and exit without
    /// serving. Writes nothing unless `--write` is also given.
    ///
    /// Conversations written before the marker existed are invisible to this
    /// protection until they carry it, so this is how an existing vault catches
    /// up. Reporting is the default because it edits personal files.
    #[arg(long)]
    pub mark_private_conversations: bool,

    /// Apply the marks that `--mark-private-conversations` would report.
    #[arg(long, requires = "mark_private_conversations")]
    pub write: bool,
}
