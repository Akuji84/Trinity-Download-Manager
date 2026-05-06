#![allow(dead_code)]

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_RANGE, RANGE},
    Client, StatusCode, Url,
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::models::DownloadJob;

const MIN_SEGMENT_SIZE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEGMENT_CONNECTIONS: u32 = 16;

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
    mut resolve_speed_limit_kbps: impl FnMut() -> Result<Option<u64>, String>,
) -> Result<(), DownloadError> {
    let client = Client::new();
    let is_restartable = matches!(job.state, crate::models::DownloadState::Paused)
        && job.is_resumable
        && job.downloaded_bytes > 0;

    if is_restartable {
        return download_single_stream(
            &client,
            job,
            control,
            &mut report_output,
            &mut report_progress,
            &mut resolve_speed_limit_kbps,
        )
        .await;
    }

    let segmented_plan = if job.connection_count > 1 {
        probe_segmented_plan(&client, &job).await?
    } else {
        None
    };

    if let Some(plan) = segmented_plan {
        return download_segmented(
            &client,
            job,
            plan,
            control,
            &mut report_output,
            &mut report_progress,
            &mut resolve_speed_limit_kbps,
        )
        .await;
    }

    download_single_stream(
        &client,
        job,
        control,
        &mut report_output,
        &mut report_progress,
        &mut resolve_speed_limit_kbps,
    )
    .await
}

async fn download_single_stream(
    client: &Client,
    job: DownloadJob,
    control: Arc<DownloadControl>,
    report_output: &mut impl FnMut(String, String, Option<u64>, bool) -> Result<(), String>,
    report_progress: &mut impl FnMut(u64, Option<u64>, u64) -> Result<(), String>,
    resolve_speed_limit_kbps: &mut impl FnMut() -> Result<Option<u64>, String>,
) -> Result<(), DownloadError> {
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
    let mut session_downloaded_bytes = 0_u64;
    let session_started_at = Instant::now();
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
        session_downloaded_bytes += chunk.len() as u64;

        if let Some(limit_kbps) = resolve_speed_limit_kbps().map_err(DownloadError::Failed)? {
            maybe_throttle(limit_kbps, session_downloaded_bytes, session_started_at).await;
        }

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

async fn download_segmented(
    client: &Client,
    job: DownloadJob,
    plan: SegmentedPlan,
    control: Arc<DownloadControl>,
    report_output: &mut impl FnMut(String, String, Option<u64>, bool) -> Result<(), String>,
    report_progress: &mut impl FnMut(u64, Option<u64>, u64) -> Result<(), String>,
    resolve_speed_limit_kbps: &mut impl FnMut() -> Result<Option<u64>, String>,
) -> Result<(), DownloadError> {
    let output_path = unique_output_path(Path::new(&job.output_folder).join(&plan.file_name));
    let temp_path = temp_path_for(&output_path);
    let output_path_text = output_path.to_string_lossy().to_string();
    let part_paths = (0..plan.ranges.len())
        .map(|index| part_path_for(&temp_path, index))
        .collect::<Vec<_>>();

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    }

    cleanup_segment_artifacts(&temp_path, &part_paths).await;

    report_output(
        plan.file_name.clone(),
        output_path_text,
        Some(plan.total_bytes),
        false,
    )
    .map_err(DownloadError::Failed)?;
    report_progress(0, Some(plan.total_bytes), 0).map_err(DownloadError::Failed)?;

    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let session_downloaded_bytes = Arc::new(AtomicU64::new(0));
    let shared_limit_kbps = Arc::new(AtomicU64::new(
        resolve_speed_limit_kbps()
            .map_err(DownloadError::Failed)?
            .unwrap_or(0),
    ));
    let session_started_at = Instant::now();
    let mut worker_handles = Vec::with_capacity(plan.ranges.len());

    for (index, range) in plan.ranges.iter().copied().enumerate() {
        let client = client.clone();
        let url = job.url.clone();
        let control = Arc::clone(&control);
        let part_path = part_paths[index].clone();
        let downloaded_bytes = Arc::clone(&downloaded_bytes);
        let session_downloaded_bytes = Arc::clone(&session_downloaded_bytes);
        let shared_limit_kbps = Arc::clone(&shared_limit_kbps);

        worker_handles.push(tokio::spawn(async move {
            download_segment_range(
                client,
                url,
                range,
                part_path,
                control,
                downloaded_bytes,
                session_downloaded_bytes,
                shared_limit_kbps,
                session_started_at,
            )
            .await
        }));
    }

    let mut last_reported_bytes = 0_u64;
    let mut last_reported_at = Instant::now();

    while worker_handles.iter().any(|handle| !handle.is_finished()) {
        tokio::time::sleep(Duration::from_millis(250)).await;

        let current_downloaded = downloaded_bytes.load(Ordering::Relaxed);
        let current_limit = resolve_speed_limit_kbps()
            .map_err(DownloadError::Failed)?
            .unwrap_or(0);
        shared_limit_kbps.store(current_limit, Ordering::Relaxed);
        let elapsed_seconds = last_reported_at.elapsed().as_secs_f64();
        let speed_bps = if elapsed_seconds > 0.0 {
            ((current_downloaded - last_reported_bytes) as f64 / elapsed_seconds) as u64
        } else {
            0
        };
        last_reported_at = Instant::now();
        last_reported_bytes = current_downloaded;
        report_progress(current_downloaded, Some(plan.total_bytes), speed_bps)
            .map_err(DownloadError::Failed)?;
    }

    let result = async {
        for handle in worker_handles {
            let outcome = handle
                .await
                .map_err(|error| DownloadError::Failed(error.to_string()))?;
            outcome?;
        }

        Ok::<(), DownloadError>(())
    }
    .await;

    if let Err(error) = result {
        cleanup_segment_artifacts(&temp_path, &part_paths).await;
        return Err(error);
    }

    merge_segment_parts(&temp_path, &part_paths).await?;
    tokio::fs::rename(&temp_path, &output_path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    report_progress(plan.total_bytes, Some(plan.total_bytes), 0).map_err(DownloadError::Failed)?;

    Ok(())
}

async fn probe_segmented_plan(
    client: &Client,
    job: &DownloadJob,
) -> Result<Option<SegmentedPlan>, DownloadError> {
    let probe_response = client
        .get(&job.url)
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;

    if probe_response.status() != StatusCode::PARTIAL_CONTENT {
        return Ok(None);
    }

    let total_bytes = probe_response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_total_from_content_range);
    let Some(total_bytes) = total_bytes else {
        return Ok(None);
    };

    let requested_connections = job.connection_count.clamp(1, MAX_SEGMENT_CONNECTIONS);
    let segment_count = recommend_segment_count(total_bytes, requested_connections);
    if segment_count <= 1 {
        return Ok(None);
    }

    let file_name = resolve_file_name(probe_response.headers(), probe_response.url(), &job.file_name);
    let ranges = plan_ranges(total_bytes, segment_count);
    if ranges.len() <= 1 {
        return Ok(None);
    }

    Ok(Some(SegmentedPlan {
        file_name,
        total_bytes,
        ranges,
    }))
}

async fn download_segment_range(
    client: Client,
    url: String,
    range: ByteRange,
    part_path: PathBuf,
    control: Arc<DownloadControl>,
    downloaded_bytes: Arc<AtomicU64>,
    session_downloaded_bytes: Arc<AtomicU64>,
    shared_limit_kbps: Arc<AtomicU64>,
    session_started_at: Instant,
) -> Result<(), DownloadError> {
    let response = client
        .get(url)
        .header(RANGE, format!("bytes={}-{}", range.start, range.end))
        .send()
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;

    if response.status() != StatusCode::PARTIAL_CONTENT {
        return Err(DownloadError::Failed(format!(
            "Segment request returned HTTP {}",
            response.status()
        )));
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&part_path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if control.cancel_requested.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&part_path).await;
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

        let chunk_len = chunk.len() as u64;
        downloaded_bytes.fetch_add(chunk_len, Ordering::Relaxed);
        let total_session_bytes =
            session_downloaded_bytes.fetch_add(chunk_len, Ordering::Relaxed) + chunk_len;
        let limit_kbps = shared_limit_kbps.load(Ordering::Relaxed);
        if limit_kbps > 0 {
            maybe_throttle(limit_kbps, total_session_bytes, session_started_at).await;
        }
    }

    file.flush()
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    Ok(())
}

async fn merge_segment_parts(
    temp_path: &Path,
    part_paths: &[PathBuf],
) -> Result<(), DownloadError> {
    let mut output = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(temp_path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;

    for part_path in part_paths {
        let bytes = tokio::fs::read(part_path)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
        output
            .write_all(&bytes)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    }

    output
        .flush()
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;

    for part_path in part_paths {
        let _ = tokio::fs::remove_file(part_path).await;
    }

    Ok(())
}

async fn cleanup_segment_artifacts(temp_path: &Path, part_paths: &[PathBuf]) {
    let _ = tokio::fs::remove_file(temp_path).await;
    for part_path in part_paths {
        let _ = tokio::fs::remove_file(part_path).await;
    }
}

async fn maybe_throttle(limit_kbps: u64, transferred_bytes: u64, session_started_at: Instant) {
    let allowed_bytes_per_second = limit_kbps.saturating_mul(1024);
    if allowed_bytes_per_second == 0 {
        return;
    }

    let expected_seconds = transferred_bytes as f64 / allowed_bytes_per_second as f64;
    let actual_seconds = session_started_at.elapsed().as_secs_f64();
    if expected_seconds > actual_seconds {
        tokio::time::sleep(Duration::from_secs_f64(expected_seconds - actual_seconds)).await;
    }
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

#[derive(Clone)]
struct SegmentedPlan {
    file_name: String,
    total_bytes: u64,
    ranges: Vec<ByteRange>,
}

#[derive(Clone, Copy)]
struct ByteRange {
    start: u64,
    end: u64,
}

fn temp_path_for(output_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.trinitydownload", output_path.to_string_lossy()))
}

fn part_path_for(temp_path: &Path, index: usize) -> PathBuf {
    PathBuf::from(format!("{}.part{index}", temp_path.to_string_lossy()))
}

fn recommend_segment_count(total_bytes: u64, requested_connections: u32) -> u32 {
    let size_limited_segments = (total_bytes / MIN_SEGMENT_SIZE_BYTES).max(1) as u32;
    requested_connections
        .clamp(1, MAX_SEGMENT_CONNECTIONS)
        .min(size_limited_segments)
}

fn plan_ranges(total_bytes: u64, segment_count: u32) -> Vec<ByteRange> {
    let mut ranges = Vec::with_capacity(segment_count as usize);
    let base_size = total_bytes / segment_count as u64;
    let remainder = total_bytes % segment_count as u64;
    let mut start = 0_u64;

    for index in 0..segment_count {
        let extra_byte = u64::from(index < remainder as u32);
        let length = base_size + extra_byte;
        let end = start + length.saturating_sub(1);
        ranges.push(ByteRange { start, end });
        start = end.saturating_add(1);
    }

    ranges
}

fn parse_total_from_content_range(value: &str) -> Option<u64> {
    let (_, total) = value.split_once('/')?;
    total.parse::<u64>().ok()
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
