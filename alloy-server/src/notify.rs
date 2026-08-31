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
const ALLOY_ISSUES_URL: &str = "https://github.com/borismus/alloy/issues/new";
const SEND_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskEmailKind {
    Result,
    Error,
}

/// One task notification to email. Borrowed so the caller doesn't clone the body.
pub struct TaskEmail<'a> {
    pub kind: TaskEmailKind,
    pub task_id: &'a str,
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

fn failure_report(email: &TaskEmail<'_>) -> String {
    format!(
        "ALLOY SCHEDULED TASK FAILURE\n\nTask: {}\nTask ID: {}\nModel: {}\nTime: {}\n\n{}",
        email.task_title,
        email.task_id,
        email.model,
        email.occurred_at,
        email.content_markdown.trim(),
    )
}

fn render_result_markdown(markdown: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};

    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    let parser = Parser::new_ext(markdown, options);
    let mut rendered = String::new();
    html::push_html(&mut rendered, parser);
    rendered
}

/// Render a minimal email-safe HTML document. Results retain Markdown; errors
/// are deliberately one plaintext <pre> block so the whole diagnostic can be
/// selected and pasted into feedback without copying surrounding email chrome.
fn render_html(email: &TaskEmail<'_>) -> String {
    let footer = format!(
        "{} &middot; {}",
        escape_html(email.model),
        escape_html(email.occurred_at)
    );
    let (status, body) = match email.kind {
        TaskEmailKind::Result => (
            String::new(),
            render_result_markdown(email.content_markdown),
        ),
        TaskEmailKind::Error => {
            let report = escape_html(&failure_report(email));
            (
                "<div style=\"padding:10px 12px;margin-bottom:16px;border-radius:6px;\
                 background:#fef2f2;color:#b91c1c;font-weight:700;\">Scheduled task failed</div>"
                    .to_string(),
                format!(
                    "<p>Copy this report when sending feedback:</p>\
                     <pre style=\"margin:0;padding:14px;border:1px solid #d0d7de;border-radius:6px;\
                     background:#f6f8fa;color:#1f2328;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;\
                     white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;\">{report}</pre>\
                     <p style=\"font-size:13px;color:#57606a;\">Review the report for private details, then paste it into \
                     <a href=\"{issues}\">a new Alloy GitHub issue</a>.</p>",
                    report = report,
                    issues = ALLOY_ISSUES_URL,
                ),
            )
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
        body = body,
        footer = footer,
    )
}

fn render_text(email: &TaskEmail<'_>) -> String {
    match email.kind {
        TaskEmailKind::Result => format!(
            "{}\n\n---\n{} · {}\n",
            email.content_markdown, email.model, email.occurred_at
        ),
        TaskEmailKind::Error => format!(
            "{}\n\n---\nReview the report for private details, then paste it into a new Alloy GitHub issue:\n{}\n",
            failure_report(email),
            ALLOY_ISSUES_URL,
        ),
    }
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
            task_id: "task-nightly-digest",
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
    fn error_notification_is_unmistakable_and_copyable() {
        let mut email = sample();
        email.kind = TaskEmailKind::Error;
        email.content_markdown = "Error:\nThe model returned <invalid> output.";
        assert_eq!(subject(&email), "[Alloy] Task failed: Nightly Digest");

        let html = render_html(&email);
        assert!(html.contains("Scheduled task failed"));
        assert!(html.contains("Copy this report"));
        assert!(html.contains("<pre style="));
        assert!(html.contains("Task ID: task-nightly-digest"));
        assert!(html.contains("&lt;invalid&gt;"));
        assert!(html.contains(ALLOY_ISSUES_URL));

        let text = render_text(&email);
        assert!(text.starts_with("ALLOY SCHEDULED TASK FAILURE"));
        assert!(text.contains("Task: Nightly Digest"));
        assert!(text.contains("Task ID: task-nightly-digest"));
        assert!(text.contains(ALLOY_ISSUES_URL));
    }

    #[test]
    fn escape_html_neutralizes_markup() {
        assert_eq!(escape_html("a <b> & c"), "a &lt;b&gt; &amp; c");
    }
}
