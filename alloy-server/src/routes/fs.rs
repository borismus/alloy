//! `/api/fs/*` endpoints.
//!
//! Wire formats mirror [server/index.ts](server/index.ts) exactly so the
//! existing SPA mock at `src/mocks/tauri-fs-http.ts` works unchanged.

use std::time::SystemTime;

use axum::{
    Json, Router,
    extract::State,
    routing::post,
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::fs;

use crate::{AppState, error::AppError};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/fs/readTextFile", post(read_text_file))
        .route("/api/fs/writeTextFile", post(write_text_file))
        .route("/api/fs/readFile", post(read_file))
        .route("/api/fs/writeFile", post(write_file))
        .route("/api/fs/readDir", post(read_dir))
        .route("/api/fs/readDirHeaders", post(read_dir_headers))
        .route("/api/fs/mkdir", post(mkdir))
        .route("/api/fs/remove", post(remove))
        .route("/api/fs/exists", post(exists))
        .route("/api/fs/stat", post(stat))
}

#[derive(Deserialize)]
struct PathReq {
    path: String,
}

async fn read_text_file(
    State(state): State<AppState>,
    Json(req): Json<PathReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    let content = fs::read_to_string(&resolved)
        .await
        .map_err(|_| AppError::NotFound(format!("File not found: {}", req.path)))?;
    Ok(Json(json!({ "content": content })))
}

#[derive(Deserialize)]
struct WriteTextReq {
    path: String,
    content: String,
}

async fn write_text_file(
    State(state): State<AppState>,
    Json(req): Json<WriteTextReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    fs::write(&resolved, req.content.as_bytes())
        .await
        .map_err(|_| AppError::Internal(format!("Failed to write: {}", req.path)))?;
    Ok(Json(json!({})))
}

async fn read_file(
    State(state): State<AppState>,
    Json(req): Json<PathReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    let bytes = fs::read(&resolved)
        .await
        .map_err(|_| AppError::NotFound(format!("File not found: {}", req.path)))?;
    Ok(Json(json!({ "data": B64.encode(&bytes) })))
}

#[derive(Deserialize)]
struct WriteBinaryReq {
    path: String,
    data: String,
}

async fn write_file(
    State(state): State<AppState>,
    Json(req): Json<WriteBinaryReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    let bytes = B64
        .decode(req.data.as_bytes())
        .map_err(|e| AppError::BadRequest(format!("Invalid base64: {e}")))?;
    // Downscale oversized images before storing (keeps the vault and the
    // provider payload bounded); non-images pass through untouched.
    let bytes = maybe_downscale_image(bytes);
    fs::write(&resolved, &bytes)
        .await
        .map_err(|_| AppError::Internal(format!("Failed to write: {}", req.path)))?;
    Ok(Json(json!({})))
}

/// Largest dimension we keep for stored images. 1568px is Anthropic's
/// recommended max (they downscale to roughly this anyway), and it keeps a
/// re-encoded image comfortably under the providers' 5MB per-image limit.
const MAX_IMAGE_DIM: u32 = 1568;

/// If `bytes` is a PNG/JPEG/WebP larger than [`MAX_IMAGE_DIM`] on its longest
/// side, decode, resize to fit (preserving aspect ratio), and re-encode in the
/// SAME format so the caller's recorded extension/mime stay correct. Anything
/// else — small images, GIFs (avoid flattening animation), non-images, or any
/// decode/encode failure — is returned unchanged. Image processing must never
/// fail a write.
fn maybe_downscale_image(bytes: Vec<u8>) -> Vec<u8> {
    use image::ImageFormat;

    let format = match image::guess_format(&bytes) {
        Ok(f @ (ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)) => f,
        _ => return bytes, // unknown, GIF, or non-image → store as-is
    };

    let img = match image::load_from_memory(&bytes) {
        Ok(img) => img,
        Err(_) => return bytes,
    };

    if img.width().max(img.height()) <= MAX_IMAGE_DIM {
        return bytes; // already within bounds
    }

    let resized = img.resize(MAX_IMAGE_DIM, MAX_IMAGE_DIM, image::imageops::FilterType::Lanczos3);
    let mut out = std::io::Cursor::new(Vec::new());
    match resized.write_to(&mut out, format) {
        Ok(()) => out.into_inner(),
        Err(_) => bytes, // re-encode failed → fall back to the original
    }
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(rename = "isFile")]
    is_file: bool,
    #[serde(rename = "isSymlink")]
    is_symlink: bool,
}

async fn read_dir(
    State(state): State<AppState>,
    Json(req): Json<PathReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    let mut entries = fs::read_dir(&resolved)
        .await
        .map_err(|_| AppError::NotFound(format!("Directory not found: {}", req.path)))?;

    let mut out = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    {
        let file_type = entry
            .file_type()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: file_type.is_dir(),
            is_file: file_type.is_file(),
            is_symlink: file_type.is_symlink(),
        });
    }
    Ok(Json(json!({ "entries": out })))
}

#[derive(Deserialize)]
struct ReadDirHeadersReq {
    path: String,
    #[serde(default)]
    ext: Option<String>,
    #[serde(default)]
    bytes: Option<usize>,
}

#[derive(Serialize)]
struct FileHeader {
    content: String,
    mtime: f64,
}

async fn read_dir_headers(
    State(state): State<AppState>,
    Json(req): Json<ReadDirHeadersReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    let max_bytes = req.bytes.unwrap_or(512);
    let ext_filter = req.ext.unwrap_or_default();

    let mut entries = fs::read_dir(&resolved)
        .await
        .map_err(|_| AppError::NotFound(format!("Directory not found: {}", req.path)))?;

    let mut files = serde_json::Map::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
    {
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !ext_filter.is_empty() && !name.ends_with(&ext_filter) {
            continue;
        }

        let file_path = entry.path();
        // Read up to max_bytes from the start of the file.
        let mut buf = vec![0u8; max_bytes];
        let read_len = match tokio::fs::File::open(&file_path).await {
            Ok(mut f) => {
                use tokio::io::AsyncReadExt;
                f.read(&mut buf).await.unwrap_or(0)
            }
            Err(_) => continue,
        };
        buf.truncate(read_len);

        let metadata = match fs::metadata(&file_path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);

        let content = String::from_utf8_lossy(&buf).into_owned();
        files.insert(
            name,
            serde_json::to_value(FileHeader {
                content,
                mtime: mtime_ms,
            })
            .unwrap(),
        );
    }

    Ok(Json(json!({ "files": files })))
}

#[derive(Deserialize)]
struct MkdirReq {
    path: String,
    #[serde(default)]
    options: Option<MkdirOptions>,
}

#[derive(Deserialize)]
struct MkdirOptions {
    #[serde(default = "default_true")]
    recursive: bool,
}

fn default_true() -> bool {
    true
}

async fn mkdir(
    State(state): State<AppState>,
    Json(req): Json<MkdirReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    let recursive = req.options.map(|o| o.recursive).unwrap_or(true);
    let result = if recursive {
        fs::create_dir_all(&resolved).await
    } else {
        fs::create_dir(&resolved).await
    };
    result.map_err(|_| AppError::Internal(format!("Failed to create directory: {}", req.path)))?;
    Ok(Json(json!({})))
}

async fn remove(
    State(state): State<AppState>,
    Json(req): Json<PathReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    // Mirror Node's `fs.rm(target, { recursive: true, force: true })` —
    // recursive remove that doesn't error if the target is missing.
    let metadata = match fs::symlink_metadata(&resolved).await {
        Ok(m) => m,
        Err(_) => return Ok(Json(json!({}))), // force: true
    };
    let result = if metadata.is_dir() {
        fs::remove_dir_all(&resolved).await
    } else {
        fs::remove_file(&resolved).await
    };
    result.map_err(|_| AppError::Internal(format!("Failed to remove: {}", req.path)))?;
    Ok(Json(json!({})))
}

async fn exists(
    State(state): State<AppState>,
    Json(req): Json<PathReq>,
) -> Json<Value> {
    let exists = match state.vault.resolve(&req.path) {
        Ok(resolved) => tokio::fs::try_exists(&resolved).await.unwrap_or(false),
        Err(_) => false,
    };
    Json(json!({ "exists": exists }))
}

async fn stat(
    State(state): State<AppState>,
    Json(req): Json<PathReq>,
) -> Result<Json<Value>, AppError> {
    let resolved = state.vault.resolve(&req.path)?;
    let metadata = fs::metadata(&resolved)
        .await
        .map_err(|_| AppError::NotFound(format!("Path not found: {}", req.path)))?;

    // Match Node's `stats.mtime.toISOString()` shape so the SPA's
    // `new Date(result.mtime)` call works.
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| {
            chrono::DateTime::<chrono::Utc>::from(SystemTime::UNIX_EPOCH + d)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });

    Ok(Json(json!({
        "mtime": mtime,
        "size": metadata.len(),
        "isDirectory": metadata.is_dir(),
        "isFile": metadata.is_file(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, RgbImage};

    fn encode(img: &DynamicImage, fmt: ImageFormat) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, fmt).unwrap();
        buf.into_inner()
    }

    fn solid(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, image::Rgb([120, 80, 200])))
    }

    #[test]
    fn downscales_large_png_preserving_format() {
        let big = encode(&solid(4000, 3000), ImageFormat::Png);
        let out = maybe_downscale_image(big.clone());
        assert_ne!(out, big, "large image should be rewritten");
        assert_eq!(image::guess_format(&out).unwrap(), ImageFormat::Png, "format preserved");
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!(decoded.width().max(decoded.height()), MAX_IMAGE_DIM);
        assert!(out.len() <= big.len());
    }

    #[test]
    fn downscales_large_jpeg_preserving_format() {
        let big = encode(&solid(4000, 2000), ImageFormat::Jpeg);
        let out = maybe_downscale_image(big.clone());
        assert_eq!(image::guess_format(&out).unwrap(), ImageFormat::Jpeg, "format preserved");
        let decoded = image::load_from_memory(&out).unwrap();
        assert_eq!(decoded.width().max(decoded.height()), MAX_IMAGE_DIM);
    }

    #[test]
    fn small_image_returned_unchanged() {
        let small = encode(&solid(800, 600), ImageFormat::Png);
        assert_eq!(maybe_downscale_image(small.clone()), small);
    }

    #[test]
    fn non_image_returned_unchanged() {
        let junk = b"this is definitely not an image, just bytes".to_vec();
        assert_eq!(maybe_downscale_image(junk.clone()), junk);
    }

    #[test]
    fn gif_passed_through_even_when_large() {
        // GIFs are deliberately not resized (would flatten animation).
        let gif = encode(&solid(2000, 2000), ImageFormat::Gif);
        assert_eq!(image::guess_format(&gif).unwrap(), ImageFormat::Gif);
        assert_eq!(maybe_downscale_image(gif.clone()), gif);
    }
}
