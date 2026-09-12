//! `web_fetch` tool. Downloads a bounded HTTP(S) response and returns readable
//! text rather than raw HTML. HTML pages go through Readability and are emitted
//! as Markdown; text/Markdown/JSON responses pass through after charset
//! decoding. `http_get` remains an unadvertised dispatch alias for compatibility.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use dom_smoothie::{Config as ReadabilityConfig, Readability, TextMode};
use encoding_rs::{Encoding, UTF_8};
use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, LOCATION},
    redirect::Policy,
    StatusCode, Url,
};
use serde_json::Value;

use crate::tools::{input_string, input_usize, ToolContext};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REDIRECTS: usize = 5;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_OUTPUT_CHARS: usize = 50_000;
const MAX_OUTPUT_CHARS: usize = 100_000;
const MAX_ERROR_CHARS: usize = 2_000;
const MAX_HTML_ELEMENTS: usize = 100_000;
const USER_AGENT: &str = "Alloy web_fetch/1.0 (+https://github.com/borismus/alloy)";

struct Downloaded {
    final_url: Url,
    status: StatusCode,
    content_type: Option<String>,
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Default)]
struct ExtractedContent {
    title: Option<String>,
    byline: Option<String>,
    site_name: Option<String>,
    published_time: Option<String>,
    content: String,
}

/// Fetch a URL as model-readable content. Cloud models cannot use Alloy as a
/// bridge into loopback/private networks; explicitly trusted local models can.
pub async fn execute_fetch(ctx: &ToolContext, input: &Value) -> Result<String, String> {
    let raw_url = input_string(input, "url").unwrap_or("").trim();
    if raw_url.is_empty() {
        return Err("Missing required parameter: url".into());
    }
    let url = Url::parse(raw_url).map_err(|e| format!("Invalid URL: {e}"))?;
    validate_url_shape(&url)?;

    let start_index = input_usize(input, "start_index").unwrap_or(0);
    let max_chars = input_usize(input, "max_chars")
        .unwrap_or(DEFAULT_OUTPUT_CHARS)
        .clamp(1, MAX_OUTPUT_CHARS);

    let downloaded = download(url, ctx.model_is_local).await?;
    let content_type = downloaded.content_type.as_deref();
    let media_type = media_type(content_type);

    if is_explicitly_binary(&media_type) {
        return Err(format!(
            "web_fetch does not support binary content ({}) at {}",
            display_content_type(content_type),
            downloaded.final_url
        ));
    }

    let text = decode_body(&downloaded.bytes, content_type);
    let html = is_html(&media_type) || (media_type.is_empty() && looks_like_html(&text));
    if !html && media_type.is_empty() && looks_binary(&downloaded.bytes) {
        return Err(format!(
            "web_fetch received binary content without a usable Content-Type at {}",
            downloaded.final_url
        ));
    }
    if !html && !media_type.is_empty() && !is_textual(&media_type) {
        return Err(format!(
            "web_fetch does not support content type {} at {}",
            display_content_type(content_type),
            downloaded.final_url
        ));
    }

    let final_url = downloaded.final_url.to_string();
    let extracted = if html {
        let html_text = text;
        let parse_url = final_url.clone();
        tokio::task::spawn_blocking(move || extract_html(&html_text, &parse_url))
            .await
            .map_err(|e| format!("web page extraction task failed: {e}"))??
    } else {
        ExtractedContent {
            content: text.trim().to_string(),
            ..Default::default()
        }
    };

    if !downloaded.status.is_success() {
        let preview = take_chars(extracted.content.trim(), 0, MAX_ERROR_CHARS).0;
        let suffix = if preview.is_empty() {
            String::new()
        } else {
            format!(" — {preview}")
        };
        return Err(format!(
            "HTTP {} from {}{}",
            downloaded.status, final_url, suffix
        ));
    }
    if extracted.content.trim().is_empty() {
        return Err(
            "No readable content found. The page may require JavaScript or authentication.".into(),
        );
    }

    render_output(
        extracted,
        &final_url,
        content_type,
        start_index,
        max_chars,
        downloaded.truncated,
    )
}

async fn download(mut url: Url, allow_private_network: bool) -> Result<Downloaded, String> {
    for redirect_count in 0..=MAX_REDIRECTS {
        validate_url_shape(&url)?;
        let client = client_for_url(&url, allow_private_network).await?;
        let response = client
            .get(url.clone())
            .header(
                ACCEPT,
                "text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.1",
            )
            .send()
            .await
            .map_err(|e| format!("web_fetch request failed: {e}"))?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(format!(
                    "web_fetch exceeded the redirect limit ({MAX_REDIRECTS})"
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| {
                    format!("HTTP {} redirect had no Location header", response.status())
                })?
                .to_str()
                .map_err(|_| "Redirect Location header was not valid text".to_string())?;
            url = url
                .join(location)
                .map_err(|e| format!("Invalid redirect URL: {e}"))?;
            continue;
        }

        let status = response.status();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let announced_too_large = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .is_some_and(|length| length > MAX_BODY_BYTES);
        let (bytes, stream_truncated) = read_bounded(response).await?;

        return Ok(Downloaded {
            final_url: url,
            status,
            content_type,
            bytes,
            truncated: announced_too_large || stream_truncated,
        });
    }
    unreachable!("redirect loop returns or continues within its fixed bound")
}

async fn client_for_url(url: &Url, allow_private_network: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(HTTP_TIMEOUT)
        .user_agent(USER_AGENT);

    if !allow_private_network {
        let host = url
            .host_str()
            .ok_or_else(|| "URL must include a host".to_string())?;
        let normalized = host
            .trim_end_matches('.')
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        if is_private_hostname(&normalized) {
            return Err(private_network_error());
        }

        let port = url
            .port_or_known_default()
            .ok_or_else(|| "URL uses an unknown port".to_string())?;
        let addresses = if let Ok(ip) = normalized.parse::<IpAddr>() {
            vec![SocketAddr::new(ip, port)]
        } else {
            let lookup = tokio::time::timeout(
                DNS_TIMEOUT,
                tokio::net::lookup_host((normalized.as_str(), port)),
            )
            .await
            .map_err(|_| "DNS lookup timed out".to_string())?
            .map_err(|e| format!("DNS lookup failed: {e}"))?;
            lookup.collect::<Vec<_>>()
        };
        if addresses.is_empty() {
            return Err("DNS lookup returned no addresses".into());
        }
        if addresses.iter().any(|address| !is_public_ip(address.ip())) {
            return Err(private_network_error());
        }

        // Pin the exact addresses that passed validation so a second DNS lookup
        // cannot rebind the request to a private host between check and connect.
        if normalized.parse::<IpAddr>().is_err() {
            builder = builder.resolve_to_addrs(host, &addresses);
        }
    }

    builder
        .build()
        .map_err(|e| format!("HTTP client init failed: {e}"))
}

async fn read_bounded(response: reqwest::Response) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("response read failed: {e}"))?;
        let remaining = MAX_BODY_BYTES.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() == MAX_BODY_BYTES {
            // Poll once more to distinguish an exact-size response from a larger
            // one without ever retaining more than the cap.
            if let Some(next) = stream.next().await {
                next.map_err(|e| format!("response read failed: {e}"))?;
                truncated = true;
            }
            break;
        }
    }

    Ok((bytes, truncated))
}

fn extract_html(html: &str, url: &str) -> Result<ExtractedContent, String> {
    let config = ReadabilityConfig {
        text_mode: TextMode::Markdown,
        max_elements_to_parse: MAX_HTML_ELEMENTS,
        ..Default::default()
    };
    let mut readability = Readability::new(html, Some(url), Some(config.clone()))
        .map_err(|e| format!("HTML parse failed: {e}"))?;
    remove_page_chrome(&readability);

    if let Ok(article) = readability.parse() {
        let content = article.text_content.trim().to_string();
        if !content.is_empty() {
            return Ok(ExtractedContent {
                title: nonempty(article.title),
                byline: article.byline.and_then(nonempty),
                site_name: article.site_name.and_then(nonempty),
                published_time: article.published_time.and_then(nonempty),
                content,
            });
        }
    }

    // Readability intentionally rejects some index/docs pages. Preserve a useful
    // fallback, but still remove scripts, navigation, forms, and other chrome;
    // raw HTML is never returned to the model.
    let fallback = Readability::new(html, Some(url), Some(config))
        .map_err(|e| format!("HTML parse failed: {e}"))?;
    remove_page_chrome(&fallback);
    let title = fallback
        .doc
        .select_single("title")
        .nodes()
        .first()
        .and_then(|node| nonempty(node.text().to_string()));
    let skip_tags = [
        "script", "style", "meta", "head", "nav", "footer", "aside", "form", "dialog", "svg",
        "canvas", "noscript",
    ];
    let body = fallback.doc.select_single("body");
    let markdown = body
        .nodes()
        .first()
        .map(|root| root.md(Some(&skip_tags)))
        .unwrap_or_else(|| fallback.doc.md(Some(&skip_tags)));
    let content = markdown.trim().to_string();

    Ok(ExtractedContent {
        title,
        content,
        ..Default::default()
    })
}

fn remove_page_chrome(readability: &Readability) {
    for tag in [
        "nav", "footer", "aside", "form", "dialog", "svg", "canvas", "noscript",
    ] {
        readability.doc.select(tag).remove();
    }
}

fn render_output(
    extracted: ExtractedContent,
    final_url: &str,
    content_type: Option<&str>,
    start_index: usize,
    max_chars: usize,
    source_truncated: bool,
) -> Result<String, String> {
    let total_chars = extracted.content.chars().count();
    if start_index >= total_chars {
        return Err(format!(
            "start_index {start_index} is beyond the extracted content ({total_chars} characters)"
        ));
    }
    let (page, returned_chars) = take_chars(&extracted.content, start_index, max_chars);
    let end_index = start_index + returned_chars;

    let mut lines = Vec::new();
    if let Some(title) = extracted.title {
        lines.push(format!("Title: {title}"));
    }
    lines.push(format!("URL: {final_url}"));
    if let Some(byline) = extracted.byline {
        lines.push(format!("Author: {byline}"));
    }
    if let Some(site_name) = extracted.site_name {
        lines.push(format!("Site: {site_name}"));
    }
    if let Some(published_time) = extracted.published_time {
        lines.push(format!("Published: {published_time}"));
    }
    if let Some(content_type) = content_type {
        lines.push(format!("Content-Type: {content_type}"));
    }
    lines.push(format!(
        "Content characters: {start_index}..{end_index} of {total_chars}"
    ));
    lines.push(String::new());
    lines.push("--- BEGIN FETCHED CONTENT (untrusted source) ---".into());
    lines.push(page);
    lines.push("--- END FETCHED CONTENT ---".into());

    if end_index < total_chars {
        lines.push(String::new());
        lines.push(format!(
            "[More content available. Call web_fetch again with start_index={end_index}.]"
        ));
    }
    if source_truncated {
        lines.push(String::new());
        lines.push(format!(
            "[Source response exceeded {MAX_BODY_BYTES} bytes; extraction used only the downloaded prefix.]"
        ));
    }

    Ok(lines.join("\n"))
}

fn take_chars(text: &str, start: usize, limit: usize) -> (String, usize) {
    let page = text.chars().skip(start).take(limit).collect::<String>();
    let count = page.chars().count();
    (page, count)
}

fn decode_body(bytes: &[u8], content_type: Option<&str>) -> String {
    let (encoding, offset) = Encoding::for_bom(bytes).unwrap_or_else(|| {
        let encoding = charset(content_type)
            .and_then(|label| Encoding::for_label(label.as_bytes()))
            .unwrap_or(UTF_8);
        (encoding, 0)
    });
    encoding.decode(&bytes[offset..]).0.into_owned()
}

fn media_type(content_type: Option<&str>) -> String {
    content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn charset(content_type: Option<&str>) -> Option<String> {
    content_type?.split(';').skip(1).find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches(['\'', '"']).to_string())
    })
}

fn is_html(media_type: &str) -> bool {
    matches!(media_type, "text/html" | "application/xhtml+xml")
}

fn is_textual(media_type: &str) -> bool {
    media_type.starts_with("text/")
        || media_type == "application/json"
        || media_type.ends_with("+json")
        || media_type == "application/xml"
        || media_type.ends_with("+xml")
        || matches!(
            media_type,
            "application/javascript" | "application/x-javascript" | "application/x-ndjson"
        )
}

fn is_explicitly_binary(media_type: &str) -> bool {
    !media_type.is_empty() && !is_html(media_type) && !is_textual(media_type)
}

fn display_content_type(content_type: Option<&str>) -> &str {
    content_type.unwrap_or("unknown content type")
}

fn looks_like_html(text: &str) -> bool {
    let prefix = text.trim_start().chars().take(512).collect::<String>();
    let lower = prefix.to_ascii_lowercase();
    lower.starts_with("<!doctype html") || lower.starts_with("<html") || lower.contains("<body")
}

fn looks_binary(bytes: &[u8]) -> bool {
    if Encoding::for_bom(bytes).is_some() {
        return false;
    }
    let sample = &bytes[..bytes.len().min(1024)];
    sample.contains(&0)
        || (!sample.is_empty()
            && sample
                .iter()
                .filter(|byte| **byte < 0x09 || (0x0e..0x20).contains(&**byte))
                .count()
                * 20
                > sample.len())
}

fn nonempty(value: impl Into<String>) -> Option<String> {
    let value = value
        .into()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!value.is_empty()).then_some(value)
}

fn validate_url_shape(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("web_fetch only supports http:// and https:// URLs".into());
    }
    if url.host_str().is_none() {
        return Err("URL must include a host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs containing credentials are not supported".into());
    }
    Ok(())
}

fn is_private_hostname(host: &str) -> bool {
    matches!(host, "localhost" | "localhost.localdomain")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".lan")
        || host.ends_with(".home")
        || host.ends_with(".internal")
}

fn private_network_error() -> String {
    "web_fetch cannot access local or private-network addresses from a cloud model".into()
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && matches!(b, 18 | 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(ipv4) = ip.to_ipv4() {
        return is_public_ipv4(ipv4);
    }
    let first = ip.segments()[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || first & 0xfe00 == 0xfc00 // unique-local fc00::/7
        || first & 0xffc0 == 0xfe80 // link-local fe80::/10
        || first & 0xffc0 == 0xfec0 // deprecated site-local fec0::/10
        || (first == 0x2001 && ip.segments()[1] == 0x0db8)) // documentation
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::Config, providers::ProviderRegistry, skill_registry::SkillRegistry,
        tools::ToolRegistry, types::ToolCall, vault::Vault,
    };
    use axum::{
        body::Body,
        http::{header, Response},
        routing::get,
        Router,
    };
    use serde_json::json;
    use std::{convert::Infallible, sync::Arc};

    fn ctx(model_is_local: bool) -> ToolContext {
        ToolContext {
            message_id: None,
            conversation_id: None,
            inside_subagent: false,
            model_is_local,
            execution_policy: crate::execution_policy::ExecutionPolicy::interactive(),
            memory_read_this_turn: Default::default(),
        }
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    #[test]
    fn article_html_becomes_readable_markdown() {
        let prose =
            "This is the main article sentence with enough detail for extraction. ".repeat(14);
        let html = format!(
            r#"<!doctype html><html><head>
              <title>A useful article</title>
              <meta name="author" content="Ada Writer">
              </head><body>
              <nav>Navigation Account Subscribe</nav>
              <article><h1>A useful article</h1><p>{prose}</p>
              <p>Second paragraph with <a href="/evidence">supporting evidence</a>.</p></article>
              <footer>Cookie settings and legal boilerplate</footer>
              </body></html>"#
        );

        let out = extract_html(&html, "https://example.com/story").unwrap();

        assert_eq!(out.title.as_deref(), Some("A useful article"));
        assert_eq!(out.byline.as_deref(), Some("Ada Writer"));
        assert!(out.content.contains("main article sentence"));
        assert!(out.content.contains("https://example.com/evidence"));
        assert!(!out.content.contains("Cookie settings"));
        assert!(!out.content.contains("Navigation Account"));
        assert!(!out.content.contains("<article>"));
    }

    #[test]
    fn non_article_html_falls_back_to_clean_markdown() {
        let html = r#"<html><head><title>Reference index</title></head><body>
            <nav>Global navigation</nav><main><h1>API methods</h1>
            <ul><li><code>open()</code> opens a resource.</li><li><code>close()</code> closes it.</li></ul>
            </main><footer>Legal links</footer></body></html>"#;

        let out = extract_html(html, "https://example.com/docs").unwrap();

        assert_eq!(out.title.as_deref(), Some("Reference index"));
        assert!(out.content.contains("API methods"));
        assert!(out.content.contains("open()"));
        assert!(!out.content.contains("Global navigation"));
        assert!(!out.content.contains("<li>"));
    }

    #[test]
    fn declared_charset_is_decoded() {
        let bytes = b"caf\xe9";
        assert_eq!(
            decode_body(bytes, Some("text/plain; charset=iso-8859-1")),
            "café"
        );
    }

    #[test]
    fn output_is_paged_by_unicode_characters() {
        let out = render_output(
            ExtractedContent {
                title: Some("Page".into()),
                content: "aé日bcdef".into(),
                ..Default::default()
            },
            "https://example.com/",
            Some("text/plain"),
            1,
            3,
            false,
        )
        .unwrap();

        assert!(out.contains("Content characters: 1..4 of 8"));
        assert!(out.contains("\né日b\n"));
        assert!(out.contains("start_index=4"));
    }

    #[test]
    fn url_validation_rejects_non_http_and_embedded_credentials() {
        assert!(validate_url_shape(&Url::parse("file:///etc/passwd").unwrap()).is_err());
        assert!(
            validate_url_shape(&Url::parse("https://user:secret@example.com/").unwrap()).is_err()
        );
        assert!(validate_url_shape(&Url::parse("https://example.com/").unwrap()).is_ok());
    }

    #[test]
    fn network_classification_blocks_non_public_ranges() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn cloud_model_cannot_fetch_loopback_but_local_model_can() {
        let app = Router::new().route(
            "/article",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                    "local service content",
                )
            }),
        );
        let base = serve(app).await;
        let input = json!({ "url": format!("{base}/article") });

        let error = execute_fetch(&ctx(false), &input).await.unwrap_err();
        assert!(error.contains("private-network"), "{error}");

        let output = execute_fetch(&ctx(true), &input).await.unwrap();
        assert!(output.contains("local service content"));
    }

    #[tokio::test]
    async fn legacy_http_get_dispatches_to_the_new_extractor() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(ToolRegistry::new(
            Arc::new(Config::default()),
            Arc::new(Vault::new(dir.path().to_path_buf()).unwrap()),
            ProviderRegistry::from_configs(&[]),
            Arc::new(SkillRegistry::new()),
        ));
        let app = Router::new().route(
            "/legacy",
            get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<html><head><title>Legacy</title></head><body><main><h1>Useful legacy content</h1></main></body></html>") }),
        );
        let base = serve(app).await;
        let call = ToolCall {
            id: "legacy-1".into(),
            name: "http_get".into(),
            input: json!({ "url": format!("{base}/legacy") }),
        };

        let result = registry.execute(&call, &ctx(true)).await;

        assert_eq!(result.is_error, None);
        assert!(result.content.contains("Useful legacy content"));
        assert!(!result.content.contains("<html>"));
    }

    #[tokio::test]
    async fn redirects_report_the_final_url() {
        let app = Router::new()
            .route(
                "/start",
                get(|| async { ([((header::LOCATION), "/final")], StatusCode::FOUND) }),
            )
            .route(
                "/final",
                get(|| async { ([(header::CONTENT_TYPE, "text/plain")], "arrived") }),
            );
        let base = serve(app).await;

        let output = execute_fetch(&ctx(true), &json!({ "url": format!("{base}/start") }))
            .await
            .unwrap();

        assert!(output.contains(&format!("URL: {base}/final")));
        assert!(output.contains("arrived"));
    }

    #[tokio::test]
    async fn download_cap_is_enforced_while_streaming() {
        let app = Router::new().route(
            "/large",
            get(|| async {
                let first = vec![b'a'; MAX_BODY_BYTES];
                let body = Body::from_stream(async_stream::stream! {
                    yield Ok::<_, Infallible>(first);
                    yield Ok::<_, Infallible>(b"tail that must not be downloaded".to_vec());
                });
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/plain")
                    .body(body)
                    .unwrap()
            }),
        );
        let base = serve(app).await;

        let output = execute_fetch(
            &ctx(true),
            &json!({ "url": format!("{base}/large"), "max_chars": 10 }),
        )
        .await
        .unwrap();

        assert!(output.contains("aaaaaaaaaa"));
        assert!(output.contains("Source response exceeded 2097152 bytes"));
        assert!(!output.contains("tail that must not be downloaded"));
    }

    #[tokio::test]
    async fn http_error_pages_are_cleaned_instead_of_returning_raw_html() {
        let app = Router::new().route(
            "/missing",
            get(|| async {
                (
                    StatusCode::NOT_FOUND,
                    [(header::CONTENT_TYPE, "text/html")],
                    "<html><head><title>Missing</title></head><body><main><h1>Not found</h1><p>The requested article does not exist.</p></main></body></html>",
                )
            }),
        );
        let base = serve(app).await;

        let error = execute_fetch(&ctx(true), &json!({ "url": format!("{base}/missing") }))
            .await
            .unwrap_err();

        assert!(error.contains("HTTP 404 Not Found"), "{error}");
        assert!(
            error.contains("requested article does not exist"),
            "{error}"
        );
        assert!(!error.contains("<html>"), "{error}");
    }

    #[tokio::test]
    async fn compressed_text_is_decompressed_before_extraction() {
        const GZIP_BODY: &[u8] = &[
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0x4b, 0xce, 0xcf, 0x2d,
            0x28, 0x4a, 0x2d, 0x2e, 0x4e, 0x4d, 0x51, 0x28, 0x4a, 0x4d, 0x4c, 0x49, 0x4c, 0xca,
            0x49, 0x55, 0x48, 0xce, 0xcf, 0x2b, 0x49, 0xcd, 0x2b, 0x01, 0x00, 0xea, 0x27, 0xab,
            0xe3, 0x1b, 0x00, 0x00, 0x00,
        ];
        let app = Router::new().route(
            "/compressed",
            get(|| async {
                (
                    [
                        (header::CONTENT_TYPE, "text/plain"),
                        (header::CONTENT_ENCODING, "gzip"),
                    ],
                    GZIP_BODY,
                )
            }),
        );
        let base = serve(app).await;

        let output = execute_fetch(&ctx(true), &json!({ "url": format!("{base}/compressed") }))
            .await
            .unwrap();

        assert!(output.contains("compressed readable content"));
    }

    #[tokio::test]
    async fn binary_responses_are_rejected() {
        let app = Router::new().route(
            "/file.pdf",
            get(|| async { ([(header::CONTENT_TYPE, "application/pdf")], "%PDF-1.7") }),
        );
        let base = serve(app).await;

        let error = execute_fetch(&ctx(true), &json!({ "url": format!("{base}/file.pdf") }))
            .await
            .unwrap_err();

        assert!(
            error.contains("binary content (application/pdf)"),
            "{error}"
        );
    }
}
