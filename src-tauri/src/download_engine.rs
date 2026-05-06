#![allow(dead_code)]

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, ACCEPT_RANGES, CONTENT_DISPOSITION, RANGE},
    Client, StatusCode, Url,
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::models::DownloadJob;

#[derive(Default)]
pub struct DownloadEngine;

impl DownloadEngine {
    pub fn new() -> Self {
        Self
    }

    pub fn prepare(&self, job: &DownloadJob) -> DownloadJob {
        job.clone()
    }
}

pub async fn download_to_disk(
    job: DownloadJob,
    control: Arc<DownloadControl>,
    mut report_output: impl FnMut(String, String, Option<u64>, bool) -> Result<(), String>,
    mut report_progress: impl FnMut(u64, Option<u64>, u64) -> Result<(), String>,
) -> Result<(), DownloadError> {
    let client = Client::new();
    let is_restartable = matches!(job.state, crate::models::DownloadState::Paused)
        && job.is_resumable
        && job.downloaded_bytes > 0;
    let initial_output_path = PathBuf::from(&job.output_path);
    let initial_temp_path = temp_path_for(&initial_output_path);
    let existing_partial_bytes = if is_restartable && initial_temp_path.exists() {
        tokio::fs::metadata(&initial_temp_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    } else {
        0
    };

    let mut request = client.get(&job.url);
    if existing_partial_bytes > 0 {
        request = request.header(RANGE, format!("bytes={existing_partial_bytes}-"));
    }

    let response = request
        .send()
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;

    let status = response.status();
    let resume_accepted = existing_partial_bytes > 0 && status == StatusCode::PARTIAL_CONTENT;
    let start_bytes = if resume_accepted {
        existing_partial_bytes
    } else {
        0
    };

    if existing_partial_bytes > 0 && !resume_accepted {
        tokio::fs::remove_file(&initial_temp_path)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    } else if !status.is_success() {
        return Err(DownloadError::Failed(format!(
            "Server returned HTTP {}",
            response.status()
        )));
    }

    let is_resuming = resume_accepted;
    let file_name = if is_resuming {
        job.file_name.clone()
    } else {
        resolve_file_name(response.headers(), response.url(), &job.file_name)
    };
    let output_path = if is_resuming {
        initial_output_path
    } else {
        unique_output_path(Path::new(&job.output_folder).join(&file_name))
    };
    let temp_path = temp_path_for(&output_path);
    let output_path_text = output_path.to_string_lossy().to_string();

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    }

    if !is_resuming && temp_path.exists() {
        tokio::fs::remove_file(&temp_path)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    }

    let content_length = response.content_length();
    let total_bytes = if is_resuming {
        content_length.map(|length| start_bytes + length)
    } else {
        content_length
    };
    let is_resumable = response
        .headers()
        .get(ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("bytes"))
        .unwrap_or(false)
        || status == StatusCode::PARTIAL_CONTENT;

    report_output(file_name, output_path_text, total_bytes, is_resumable)
        .map_err(DownloadError::Failed)?;
    report_progress(start_bytes, total_bytes, 0).map_err(DownloadError::Failed)?;

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(&temp_path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    if is_resuming {
        file.seek(std::io::SeekFrom::End(0))
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    } else {
        file.set_len(0)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    }

    let mut downloaded_bytes = start_bytes;
    let mut last_reported_bytes = start_bytes;
    let mut last_reported_at = Instant::now();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if control.cancel_requested.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(DownloadError::Canceled);
        }

        if control.pause_requested.load(Ordering::Relaxed) {
            file.flush()
                .await
                .map_err(|error| DownloadError::Failed(error.to_string()))?;
            return Err(DownloadError::Paused);
        }

        let chunk = chunk.map_err(|error| DownloadError::Failed(error.to_string()))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
        downloaded_bytes += chunk.len() as u64;

        let elapsed_seconds = last_reported_at.elapsed().as_secs_f64();
        let speed_bps = if elapsed_seconds > 0.0 {
            ((downloaded_bytes - last_reported_bytes) as f64 / elapsed_seconds) as u64
        } else {
            0
        };
        last_reported_at = Instant::now();
        last_reported_bytes = downloaded_bytes;

        report_progress(downloaded_bytes, total_bytes, speed_bps).map_err(DownloadError::Failed)?;
    }

    file.flush()
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    drop(file);

    tokio::fs::rename(&temp_path, &output_path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;

    Ok(())
}

pub enum DownloadError {
    Canceled,
    Paused,
    Failed(String),
}

#[derive(Default)]
pub struct DownloadControl {
    pub cancel_requested: AtomicBool,
    pub pause_requested: AtomicBool,
}

fn temp_path_for(output_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.trinitydownload", output_path.to_string_lossy()))
}

fn resolve_file_name(headers: &HeaderMap, final_url: &Url, fallback: &str) -> String {
    filename_from_content_disposition(headers)
        .or_else(|| filename_from_url(final_url))
        .map(|name| sanitize_file_name(&name))
        .filter(|name| !is_weak_file_name(name))
        .or_else(|| {
            let fallback = sanitize_file_name(fallback);
            (!is_weak_file_name(&fallback)).then_some(fallback)
        })
        .unwrap_or_else(|| "download.bin".to_string())
}

fn filename_from_content_disposition(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(CONTENT_DISPOSITION)?.to_str().ok()?;

    for part in value.split(';') {
        let part = part.trim();
        if let Some(filename) = part.strip_prefix("filename*=") {
            return filename
                .split_once("''")
                .map(|(_, encoded)| percent_decode(encoded))
                .or_else(|| Some(strip_quotes(filename).to_string()));
        }
    }

    for part in value.split(';') {
        let part = part.trim();
        if let Some(filename) = part.strip_prefix("filename=") {
            return Some(strip_quotes(filename).to_string());
        }
    }

    None
}

fn filename_from_url(url: &Url) -> Option<String> {
    url.path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.trim().is_empty())
        .map(percent_decode)
}

fn strip_quotes(value: &str) -> &str {
    value.trim().trim_matches('"')
}

fn percent_decode(value: &str) -> String {
    let mut output = String::new();
    let bytes = value.as_bytes();
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
                if let Ok(decoded) = u8::from_str_radix(hex, 16) {
                    output.push(decoded as char);
                    index += 3;
                    continue;
                }
            }
        }

        output.push(bytes[index] as char);
        index += 1;
    }

    output
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => character,
        })
        .collect::<String>();

    let trimmed = sanitized.trim_matches('.').trim();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_weak_file_name(value: &str) -> bool {
    matches!(value, "download" | "latest" | "app") || !value.contains('.')
}

fn unique_output_path(output_path: PathBuf) -> PathBuf {
    if !output_path.exists() {
        return output_path;
    }

    let parent = output_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = output_path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("download");
    let extension = output_path.extension().and_then(OsStr::to_str);

    for index in 1..1000 {
        let file_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    output_path
}
