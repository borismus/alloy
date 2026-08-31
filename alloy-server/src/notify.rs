//! Outbound notifications for scheduled tasks.
//!
//! Today this is email via [Resend](https://resend.com). A task with
//! `email: true` gets delivered results and first-failure alerts emailed *after*
//! the run is persisted to `tasks/*.yaml` — email is a best-effort fan-out
//! channel, never part of the task's own success/failure. A send failure is
//! logged and swallowed so it can't change the recorded run outcome.

use std::time::Duration;

use serde_json::json;

use crate::config::EmailConfig;

const RESEND_URL: &str = "https://api.resend.com/emails";
const SEND_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskEmailKind {
    Result,
    Error,
}

/// One task notification to email. Borrowed so the caller doesn't clone the body.
pub struct TaskEmail<'a> {
    pub kind: TaskEmailKind,
    pub task_title: &'a str,
    pub model: &'a str,
    pub content_markdown: &'a str,
    /// ISO timestamp the result or failure occurred.
    pub occurred_at: &'a str,
    /// Stable key so a retry (or a second Alloy racing the same cron slot)
    /// doesn't send a duplicate. Resend honors the `Idempotency-Key` header.
    pub idempotency_key: &'a str,
}

/// Send a task result email via Resend. Best-effort: returns `Err` only so the
/// caller can log it; callers must not propagate it into task state.
pub async fn send_task_email(cfg: &EmailConfig, email: TaskEmail<'_>) -> anyhow::Result<()> {
    let subject = subject(&email);
    let html = render_html(&email);
    let text = render_text(&email);

    let body = json!({
        "from": cfg.from,
        "to": cfg.to,
        "subject": subject,
        "html": html,
        "text": text,
    });

    let client = reqwest::Client::builder().timeout(SEND_TIMEOUT).build()?;
    let response = client
        .post(RESEND_URL)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .header("Content-Type", "application/json")
        .header("Idempotency-Key", email.idempotency_key)
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        anyhow::bail!("Resend returned {}: {}", status, detail);
    }
    tracing::info!(
        "emailed task notification \"{}\" to {} recipient(s)",
        email.task_title,
        cfg.to.len()
    );
    Ok(())
}

/// Render the Markdown result into a minimal, email-safe HTML document. Inline
/// styles only (email clients strip <style>/<head>), kept intentionally plain.
fn render_html(email: &TaskEmail<'_>) -> String {
    use pulldown_cmark::{html, Options, Parser};

    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    let parser = Parser::new_ext(email.content_markdown, options);
    let mut rendered = String::new();
    html::push_html(&mut rendered, parser);

    let footer = format!(
        "{} &middot; {}",
        escape_html(email.model),
        escape_html(email.occurred_at)
    );
    let status = match email.kind {
        TaskEmailKind::Result => String::new(),
        TaskEmailKind::Error => {
            "<div style=\"padding:10px 12px;margin-bottom:16px;border-radius:6px;\
             background:#fef2f2;color:#b91c1c;font-weight:700;\">Scheduled task failed</div>"
                .to_string()
        }
    };
    format!(
        "<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;\
         font-size:15px;line-height:1.55;color:#222;max-width:640px;margin:0 auto;\">\
         {status}{body}\
         <hr style=\"border:none;border-top:1px solid #e0e0e0;margin:24px 0 12px;\">\
         <div style=\"font-size:12px;color:#888;\">{footer}</div>\
         </div>",
        status = status,
        body = rendered,
        footer = footer,
    )
}

/// Plain-text fallback: the raw Markdown plus a short footer.
fn render_text(email: &TaskEmail<'_>) -> String {
    let heading = match email.kind {
        TaskEmailKind::Result => "",
        TaskEmailKind::Error => "SCHEDULED TASK FAILED\n\n",
    };
    format!(
        "{}{}\n\n---\n{} · {}\n",
        heading, email.content_markdown, email.model, email.occurred_at
    )
}

fn subject(email: &TaskEmail<'_>) -> String {
    match email.kind {
        TaskEmailKind::Result => format!("[Alloy] {}", email.task_title),
        TaskEmailKind::Error => format!("[Alloy] Task failed: {}", email.task_title),
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> TaskEmail<'static> {
        TaskEmail {
            kind: TaskEmailKind::Result,
            task_title: "Nightly Digest",
            model: "mlx/Qwen",
            content_markdown: "# Interests\n\n- **local-first** software\n",
            occurred_at: "2026-07-20T09:00:00Z",
            idempotency_key: "task-abc-2026-07-20T02:00:00Z",
        }
    }

    #[test]
    fn html_renders_markdown_and_footer() {
        let html = render_html(&sample());
        assert!(html.contains("<h1>Interests</h1>"));
        assert!(html.contains("<strong>local-first</strong>"));
        assert!(html.contains("mlx/Qwen"));
        assert!(html.contains("2026-07-20T09:00:00Z"));
    }

    #[test]
    fn text_fallback_keeps_markdown_and_footer() {
        let text = render_text(&sample());
        assert!(text.contains("# Interests"));
        assert!(text.ends_with("mlx/Qwen · 2026-07-20T09:00:00Z\n"));
    }

    #[test]
    fn error_notification_is_unmistakable() {
        let mut email = sample();
        email.kind = TaskEmailKind::Error;
        email.content_markdown = "The model host is offline.";
        assert_eq!(subject(&email), "[Alloy] Task failed: Nightly Digest");
        assert!(render_html(&email).contains("Scheduled task failed"));
        assert!(render_text(&email).starts_with("SCHEDULED TASK FAILED"));
    }

    #[test]
    fn escape_html_neutralizes_markup() {
        assert_eq!(escape_html("a <b> & c"), "a &lt;b&gt; &amp; c");
    }
}
