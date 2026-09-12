//! Shared logging setup and per-turn diagnostics.
//!
//! Both entry points — the Tauri desktop shell and the standalone `alloy-serve`
//! binary — install the subscriber from here, so a diagnostic exists regardless
//! of how Alloy was started. Previously both wrote only to stderr, which is
//! discarded for a Finder-launched app: a production failure left no record
//! anywhere.
//!
//! # Privacy
//!
//! These files sit unencrypted next to a private vault, so they carry
//! **metadata only**: model and provider ids, counts, sizes, durations, token
//! usage, stop reasons, and tool *names*. Never message text, prompts, tool
//! arguments or results, note contents, URLs, provider reasoning, or
//! credentials. Where the *shape* of output matters — the historical incident
//! where a model emitted literal tool-call markup as its answer — log a
//! classification from [`classify_content`] rather than the text itself.

use std::path::PathBuf;

use tracing_subscriber::fmt::writer::MakeWriterExt;

/// Daily files, keeping a bounded window. Metadata-only lines are small, so a
/// week is both cheap and long enough to explain "it broke overnight".
const MAX_LOG_FILES: usize = 7;
const FILENAME_PREFIX: &str = "alloy";
const FILENAME_SUFFIX: &str = "log";

/// Where rotating logs are written. `ALLOY_LOG_DIR` overrides (also used by
/// tests); otherwise the platform's conventional location.
pub fn log_directory() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("ALLOY_LOG_DIR") {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            return Some(dir);
        }
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        Some(home.join("Library/Logs/Alloy"))
    } else {
        Some(
            std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/state"))
                .join("alloy"),
        )
    }
}

/// Install the process-wide subscriber: stderr (for a terminal launch) plus a
/// rotating file (for every other launch). `component` distinguishes the
/// desktop shell from the standalone server in a shared vault's logs.
///
/// `version` must be the *caller's* `CARGO_PKG_VERSION`. Reading it here would
/// report this library's version (0.1.0) rather than the product's, which is
/// worse than useless in a log whose job is to identify the running build.
///
/// Safe to call more than once; later calls are ignored rather than panicking.
/// A log directory that cannot be created degrades to stderr only — logging
/// must never prevent Alloy from starting.
pub fn init(component: &str, version: &str) {
    let filter = tracing_subscriber::EnvFilter::try_from_env("ALLOY_LOG")
        .or_else(|_| tracing_subscriber::EnvFilter::try_from_default_env())
        .or_else(|_| tracing_subscriber::EnvFilter::try_new("info,tower_http=warn"))
        .unwrap_or_default();

    let appender = log_directory().and_then(|dir| {
        if let Err(error) = std::fs::create_dir_all(&dir) {
            eprintln!("[alloy] log directory {} unusable: {error}", dir.display());
            return None;
        }
        match tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(FILENAME_PREFIX)
            .filename_suffix(FILENAME_SUFFIX)
            .max_log_files(MAX_LOG_FILES)
            .build(&dir)
        {
            Ok(appender) => Some((appender, dir)),
            Err(error) => {
                eprintln!("[alloy] file logging disabled: {error}");
                None
            }
        }
    });

    let installed = match appender {
        Some((appender, dir)) => {
            // Written synchronously on purpose: a non-blocking writer needs a
            // guard held for the process lifetime and can drop buffered lines
            // on a hard exit — exactly when the log matters most.
            let ok = tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_writer(appender.and(std::io::stderr))
                .try_init()
                .is_ok();
            if ok {
                tracing::info!(
                    component,
                    version,
                    directory = %dir.display(),
                    retained_days = MAX_LOG_FILES,
                    "logging started"
                );
            }
            ok
        }
        None => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::io::stderr)
            .try_init()
            .is_ok(),
    };
    let _ = installed;
}

/// Coarse shape of a model's final answer. Lets a log say *what kind* of output
/// arrived without recording the output. `ToolCallMarkup` exists because a real
/// turn once persisted literal `<tool_call><function=web_fetch>` text as its
/// answer, and the run's logs could not distinguish that from ordinary prose.
pub fn classify_content(content: &str) -> &'static str {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return "empty";
    }
    let lowered = trimmed.to_lowercase();
    if lowered.contains("<tool_call>")
        || lowered.contains("<function=")
        || lowered.contains("<|tool_call")
        || lowered.contains("</tool_call>")
    {
        return "tool_call_markup";
    }
    if (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
    {
        return "json_only";
    }
    if lowered.starts_with("<think") || lowered.contains("</think>") {
        return "reasoning_markup";
    }
    "prose"
}

/// Metadata describing one completed model turn. Every field is a count, an id,
/// a duration, or a classification — see the privacy note above. Deliberately
/// owns no message, prompt, or tool-argument text so it cannot leak by being
/// formatted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnSummary {
    pub outcome: &'static str,
    pub provider: String,
    pub model: String,
    pub messages: usize,
    pub tool_calls: usize,
    /// Unique tool names in call order. Names only — never their arguments.
    pub tool_names: Vec<String>,
    pub stop_reason: String,
    pub incomplete_reason: Option<String>,
    pub content_chars: usize,
    pub content_shape: &'static str,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub connection_retries: u32,
    pub duration_ms: u64,
}

impl TurnSummary {
    /// Split `provider/model` for filtering by provider without parsing lines.
    pub fn split_model(model: &str) -> (String, String) {
        match model.split_once('/') {
            Some((provider, rest)) => (provider.to_string(), rest.to_string()),
            None => ("default".to_string(), model.to_string()),
        }
    }

    pub fn record(&self) {
        tracing::info!(
            outcome = self.outcome,
            provider = %self.provider,
            model = %self.model,
            messages = self.messages,
            tool_calls = self.tool_calls,
            tools = %self.tool_names.join(","),
            stop_reason = %self.stop_reason,
            incomplete_reason = self.incomplete_reason.as_deref().unwrap_or("-"),
            content_chars = self.content_chars,
            content_shape = self.content_shape,
            input_tokens = self.input_tokens,
            output_tokens = self.output_tokens,
            connection_retries = self.connection_retries,
            duration_ms = self.duration_ms,
            "turn finished"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_directory_prefers_an_explicit_override() {
        temp_env("ALLOY_LOG_DIR", Some("/tmp/alloy-logs-test"), || {
            assert_eq!(
                log_directory(),
                Some(PathBuf::from("/tmp/alloy-logs-test"))
            );
        });
        // An empty override is ignored rather than writing to the process CWD.
        temp_env("ALLOY_LOG_DIR", Some(""), || {
            assert_ne!(log_directory(), Some(PathBuf::new()));
        });
    }

    #[test]
    fn default_log_directory_is_the_platform_convention() {
        temp_env("ALLOY_LOG_DIR", None, || {
            let dir = log_directory().expect("HOME is set in tests");
            if cfg!(target_os = "macos") {
                assert!(dir.ends_with("Library/Logs/Alloy"), "got {}", dir.display());
            } else {
                assert!(dir.ends_with("alloy"), "got {}", dir.display());
            }
        });
    }

    /// The rotating appender must actually produce a file on disk — the whole
    /// point of the change is that a Finder-launched app leaves a record.
    #[test]
    fn the_rolling_appender_writes_a_dated_file() {
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let mut appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix(FILENAME_PREFIX)
            .filename_suffix(FILENAME_SUFFIX)
            .max_log_files(MAX_LOG_FILES)
            .build(dir.path())
            .unwrap();
        write!(appender, "turn finished outcome=complete").unwrap();
        appender.flush().unwrap();

        let written: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(written.len(), 1);
        let name = written[0].file_name().to_string_lossy().to_string();
        assert!(name.starts_with("alloy."), "{name}");
        assert!(name.ends_with(".log"), "{name}");
        let body = std::fs::read_to_string(written[0].path()).unwrap();
        assert!(body.contains("outcome=complete"));
    }

    #[test]
    fn content_is_classified_by_shape_not_recorded() {
        assert_eq!(classify_content("   "), "empty");
        assert_eq!(
            classify_content("<tool_call><function=web_fetch>{\"url\":\"x\"}"),
            "tool_call_markup"
        );
        assert_eq!(classify_content("{\"triggered\": false}"), "json_only");
        assert_eq!(classify_content("<think>hmm</think>"), "reasoning_markup");
        assert_eq!(classify_content("Here is the answer."), "prose");
    }

    #[test]
    fn split_model_separates_provider_without_losing_bare_ids() {
        assert_eq!(
            TurnSummary::split_model("mlx/Qwen3.8-27B-MLX-4bit"),
            ("mlx".into(), "Qwen3.8-27B-MLX-4bit".into())
        );
        assert_eq!(
            TurnSummary::split_model("claude-sonnet"),
            ("default".into(), "claude-sonnet".into())
        );
    }

    /// Guard rail for the privacy rule: a summary must be formattable without
    /// exposing anything from the conversation it describes.
    #[test]
    fn a_summary_carries_no_conversation_content() {
        let summary = TurnSummary {
            outcome: "complete",
            provider: "mlx".into(),
            model: "Qwen".into(),
            messages: 4,
            tool_calls: 2,
            tool_names: vec!["read_file".into(), "web_search".into()],
            stop_reason: "end_turn".into(),
            incomplete_reason: None,
            content_chars: 512,
            content_shape: classify_content("my bank balance is 12345"),
            input_tokens: 100,
            output_tokens: 20,
            connection_retries: 0,
            duration_ms: 1234,
        };
        let rendered = format!("{summary:?}");
        for secret in [
            "bank balance",
            "12345",
            "/Users/",
            "notes/",
            "sk-",
            "https://",
        ] {
            assert!(
                !rendered.contains(secret),
                "summary leaked {secret}: {rendered}"
            );
        }
        assert!(rendered.contains("read_file"), "tool names are metadata");
    }

    /// `std::env::set_var` is process-global; keep mutation contained.
    fn temp_env(key: &str, value: Option<&str>, body: impl FnOnce()) {
        let previous = std::env::var_os(key);
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        body();
        match previous {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}
