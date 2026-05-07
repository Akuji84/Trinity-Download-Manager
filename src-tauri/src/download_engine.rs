#![allow(dead_code)]

use std::{
    collections::VecDeque,
    ffi::OsStr,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_RANGE, COOKIE, RANGE, REFERER, USER_AGENT},
    Client, Method, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::models::{DownloadJob, ExtensionDownloadRequest};

const MIN_SEGMENT_SIZE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEGMENT_CONNECTIONS: u32 = 16;
const TARGET_SEGMENTS_PER_CONNECTION: u32 = 3;
const MAX_TOTAL_SEGMENTS: u32 = 64;
const SEGMENT_MANIFEST_VERSION: u32 = 1;

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
    request_context: Option<ExtensionDownloadRequest>,
    manifest_root: PathBuf,
    control: Arc<DownloadControl>,
    mut report_output: impl FnMut(String, String, Option<u64>, bool) -> Result<(), String>,
    mut report_progress: impl FnMut(u64, Option<u64>, u64) -> Result<(), String>,
    mut resolve_speed_limit_kbps: impl FnMut() -> Result<Option<u64>, String>,
) -> Result<(), DownloadError> {
    let client = Client::new();
    let initial_output_path = PathBuf::from(&job.output_path);
    let temp_path = temp_path_for(&initial_output_path);
    let manifest_path = manifest_path_for(&manifest_root, &initial_output_path);
    let can_use_range_requests = can_use_range_requests(request_context.as_ref());

    if can_use_range_requests {
        if let Some(existing_manifest) = load_segment_manifest(&manifest_path).await? {
            if existing_manifest.url == job.url {
                return download_segmented(
                    &client,
                    job,
                    request_context.clone(),
                    manifest_path,
                    SegmentedMode::Resume(existing_manifest),
                    control,
                    &mut report_output,
                    &mut report_progress,
                    &mut resolve_speed_limit_kbps,
                )
                .await;
            }
        }
    } else if manifest_path.exists() {
        let _ = tokio::fs::remove_file(&manifest_path).await;
    }

    let is_restartable = can_use_range_requests
        && matches!(job.state, crate::models::DownloadState::Paused)
        && job.is_resumable
        && job.downloaded_bytes > 0;
    if is_restartable {
        return download_single_stream(
            &client,
            job,
            request_context.clone(),
            control,
            &mut report_output,
            &mut report_progress,
            &mut resolve_speed_limit_kbps,
        )
        .await;
    }

    let segmented_plan = if can_use_range_requests && job.connection_count > 1 {
        probe_segmented_plan(&client, &job, request_context.as_ref()).await?
    } else {
        None
    };

    if let Some(plan) = segmented_plan {
        return download_segmented(
            &client,
            job,
            request_context.clone(),
            manifest_path,
            SegmentedMode::Fresh(plan),
            control,
            &mut report_output,
            &mut report_progress,
            &mut resolve_speed_limit_kbps,
        )
        .await;
    }

    if temp_path.exists() {
        let _ = tokio::fs::remove_file(&temp_path).await;
    }

    download_single_stream(
        &client,
        job,
        request_context,
        control,
        &mut report_output,
        &mut report_progress,
        &mut resolve_speed_limit_kbps,
    )
    .await
}

pub fn cleanup_download_artifacts(output_path: &Path, manifest_root: &Path) -> Result<(), String> {
    let temp_path = temp_path_for(output_path);
    let manifest_path = manifest_path_for(manifest_root, output_path);

    if output_path.exists() {
        fs::remove_file(output_path).map_err(|error| error.to_string())?;
    }
    if temp_path.exists() {
        fs::remove_file(&temp_path).map_err(|error| error.to_string())?;
    }
    if manifest_path.exists() {
        fs::remove_file(&manifest_path).map_err(|error| error.to_string())?;
    }

    Ok(())
}

async fn download_single_stream(
    client: &Client,
    job: DownloadJob,
    request_context: Option<ExtensionDownloadRequest>,
    control: Arc<DownloadControl>,
    report_output: &mut impl FnMut(String, String, Option<u64>, bool) -> Result<(), String>,
    report_progress: &mut impl FnMut(u64, Option<u64>, u64) -> Result<(), String>,
    resolve_speed_limit_kbps: &mut impl FnMut() -> Result<Option<u64>, String>,
) -> Result<(), DownloadError> {
    let can_use_range_requests = can_use_range_requests(request_context.as_ref());
    let is_restartable = can_use_range_requests
        && matches!(job.state, crate::models::DownloadState::Paused)
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

    let mut request = build_download_request(client, &job.url, request_context.as_ref());
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

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if content_type.starts_with("text/html") {
        return Err(DownloadError::Failed(
            "URL returned a web page, not a downloadable file. Use the direct file URL.".to_string(),
        ));
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
    let is_resumable = can_use_range_requests
        && (response
            .headers()
            .get(ACCEPT_RANGES)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.eq_ignore_ascii_case("bytes"))
            .unwrap_or(false)
            || status == StatusCode::PARTIAL_CONTENT);

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
    request_context: Option<ExtensionDownloadRequest>,
    manifest_path: PathBuf,
    mode: SegmentedMode,
    control: Arc<DownloadControl>,
    report_output: &mut impl FnMut(String, String, Option<u64>, bool) -> Result<(), String>,
    report_progress: &mut impl FnMut(u64, Option<u64>, u64) -> Result<(), String>,
    resolve_speed_limit_kbps: &mut impl FnMut() -> Result<Option<u64>, String>,
) -> Result<(), DownloadError> {
    let manifest = match mode {
        SegmentedMode::Fresh(plan) => {
            let output_path = unique_output_path(Path::new(&job.output_folder).join(&plan.file_name));
            build_segment_manifest(&job.url, output_path, plan)
        }
        SegmentedMode::Resume(existing_manifest) => existing_manifest,
    };

    let output_path = PathBuf::from(&manifest.output_path);
    let temp_path = temp_path_for(&output_path);
    if !PathBuf::from(&manifest.output_path).starts_with(&job.output_folder) {
        let _ = tokio::fs::remove_file(&manifest_path).await;
    }

    if let Some(parent) = output_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| DownloadError::Failed(error.to_string()))?;
    }

    let manifest = reconcile_manifest_with_disk(manifest).await?;
    ensure_segment_temp_file(&temp_path, manifest.total_bytes).await?;
    save_segment_manifest(&manifest_path, &manifest).await?;
    let queue = manifest
        .segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let remaining_start = segment.start + segment.downloaded_bytes;
            (remaining_start <= segment.end).then_some(index)
        })
        .collect::<VecDeque<_>>();
    let runtime = Arc::new(SegmentRuntime {
        manifest: Mutex::new(manifest),
        available_segments: Mutex::new(queue),
        temp_path: temp_path.clone(),
    });

    let initial_manifest = runtime
        .manifest
        .lock()
        .map_err(|_| DownloadError::Failed("Segment manifest lock is unavailable.".to_string()))?
        .clone();
    let initial_downloaded = initial_manifest
        .segments
        .iter()
        .map(|segment| segment.downloaded_bytes)
        .sum::<u64>();

    report_output(
        initial_manifest.file_name.clone(),
        initial_manifest.output_path.clone(),
        Some(initial_manifest.total_bytes),
        true,
    )
    .map_err(DownloadError::Failed)?;
    report_progress(initial_downloaded, Some(initial_manifest.total_bytes), 0)
        .map_err(DownloadError::Failed)?;

    let downloaded_bytes = Arc::new(AtomicU64::new(initial_downloaded));
    let session_downloaded_bytes = Arc::new(AtomicU64::new(0));
    let shared_limit_kbps = Arc::new(AtomicU64::new(
        resolve_speed_limit_kbps()
            .map_err(DownloadError::Failed)?
            .unwrap_or(0),
    ));
    let session_started_at = Instant::now();
    let total_bytes = initial_manifest.total_bytes;
    let worker_count = job
        .connection_count
        .clamp(1, MAX_SEGMENT_CONNECTIONS)
        .min(initial_manifest.segments.len().max(1) as u32);
    let mut worker_handles = Vec::new();

    for _ in 0..worker_count {
        let client = client.clone();
        let url = job.url.clone();
        let request_context = request_context.clone();
        let control = Arc::clone(&control);
        let downloaded_bytes = Arc::clone(&downloaded_bytes);
        let session_downloaded_bytes = Arc::clone(&session_downloaded_bytes);
        let shared_limit_kbps = Arc::clone(&shared_limit_kbps);
        let runtime = Arc::clone(&runtime);

        worker_handles.push(tokio::spawn(async move {
            run_segment_worker(
                client,
                url,
                request_context,
                control,
                downloaded_bytes,
                session_downloaded_bytes,
                shared_limit_kbps,
                runtime,
                session_started_at,
            )
            .await
        }));
    }

    let mut last_reported_bytes = initial_downloaded;
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
        report_progress(current_downloaded, Some(total_bytes), speed_bps)
            .map_err(DownloadError::Failed)?;

        let manifest_snapshot = runtime
            .manifest
            .lock()
            .map_err(|_| DownloadError::Failed("Segment manifest lock is unavailable.".to_string()))?
            .clone();
        save_segment_manifest(&manifest_path, &manifest_snapshot).await?;
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

    match result {
        Ok(()) => {
            let manifest_snapshot = runtime
                .manifest
                .lock()
                .map_err(|_| DownloadError::Failed("Segment manifest lock is unavailable.".to_string()))?
                .clone();
            save_segment_manifest(&manifest_path, &manifest_snapshot).await?;
            tokio::fs::rename(&temp_path, &output_path)
                .await
                .map_err(|error| DownloadError::Failed(error.to_string()))?;
            let _ = tokio::fs::remove_file(&manifest_path).await;
            report_progress(total_bytes, Some(total_bytes), 0).map_err(DownloadError::Failed)?;
            Ok(())
        }
        Err(DownloadError::Canceled) => {
            cleanup_segment_artifacts(&output_path, &manifest_path).await;
            Err(DownloadError::Canceled)
        }
        Err(error) => {
            let manifest_snapshot = runtime
                .manifest
                .lock()
                .map_err(|_| DownloadError::Failed("Segment manifest lock is unavailable.".to_string()))?
                .clone();
            save_segment_manifest(&manifest_path, &manifest_snapshot).await?;
            Err(error)
        }
    }
}

async fn probe_segmented_plan(
    client: &Client,
    job: &DownloadJob,
    request_context: Option<&ExtensionDownloadRequest>,
) -> Result<Option<SegmentedPlan>, DownloadError> {
    let probe_response = build_download_request(client, &job.url, request_context)
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

async fn run_segment_worker(
    client: Client,
    url: String,
    request_context: Option<ExtensionDownloadRequest>,
    control: Arc<DownloadControl>,
    downloaded_bytes: Arc<AtomicU64>,
    session_downloaded_bytes: Arc<AtomicU64>,
    shared_limit_kbps: Arc<AtomicU64>,
    runtime: Arc<SegmentRuntime>,
    session_started_at: Instant,
) -> Result<(), DownloadError> {
    loop {
        let Some(segment_assignment) = claim_next_segment(&runtime)? else {
            return Ok(());
        };

        download_segment_range(
            client.clone(),
            url.clone(),
            request_context.clone(),
            segment_assignment.index,
            segment_assignment.range,
            control.clone(),
            downloaded_bytes.clone(),
            session_downloaded_bytes.clone(),
            shared_limit_kbps.clone(),
            runtime.clone(),
            session_started_at,
        )
        .await?;
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_segment_range(
    client: Client,
    url: String,
    request_context: Option<ExtensionDownloadRequest>,
    segment_index: usize,
    range: ByteRange,
    control: Arc<DownloadControl>,
    downloaded_bytes: Arc<AtomicU64>,
    session_downloaded_bytes: Arc<AtomicU64>,
    shared_limit_kbps: Arc<AtomicU64>,
    runtime: Arc<SegmentRuntime>,
    session_started_at: Instant,
) -> Result<(), DownloadError> {
    let segment_snapshot = {
        let manifest = runtime
            .manifest
            .lock()
            .map_err(|_| DownloadError::Failed("Segment manifest lock is unavailable.".to_string()))?;
        manifest
            .segments
            .get(segment_index)
            .cloned()
            .ok_or_else(|| DownloadError::Failed("Segment assignment is out of range.".to_string()))?
    };
    let request_start = range.start + segment_snapshot.downloaded_bytes;
    if request_start > range.end {
        return Ok(());
    }

    let response = build_download_request(&client, &url, request_context.as_ref())
        .header(RANGE, format!("bytes={request_start}-{}", range.end))
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
        .open(&runtime.temp_path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    file.seek(std::io::SeekFrom::Start(request_start))
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if control.cancel_requested.load(Ordering::Relaxed) {
            file.flush()
                .await
                .map_err(|error| DownloadError::Failed(error.to_string()))?;
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
        if let Ok(mut manifest) = runtime.manifest.lock() {
            manifest.segments[segment_index].downloaded_bytes =
                (manifest.segments[segment_index].downloaded_bytes + chunk_len)
                    .min(range.end.saturating_sub(range.start).saturating_add(1));
        }
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

async fn ensure_segment_temp_file(temp_path: &Path, total_bytes: u64) -> Result<(), DownloadError> {
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(temp_path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    file.set_len(total_bytes)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    Ok(())
}

async fn cleanup_segment_artifacts(output_path: &Path, manifest_path: &Path) {
    let temp_path = temp_path_for(output_path);
    let _ = tokio::fs::remove_file(output_path).await;
    let _ = tokio::fs::remove_file(&temp_path).await;
    let _ = tokio::fs::remove_file(manifest_path).await;
}

fn claim_next_segment(runtime: &SegmentRuntime) -> Result<Option<SegmentAssignment>, DownloadError> {
    let next_index = runtime
        .available_segments
        .lock()
        .map_err(|_| DownloadError::Failed("Segment queue lock is unavailable.".to_string()))?
        .pop_front();
    let Some(index) = next_index else {
        return Ok(None);
    };

    let manifest = runtime
        .manifest
        .lock()
        .map_err(|_| DownloadError::Failed("Segment manifest lock is unavailable.".to_string()))?;
    let segment = manifest
        .segments
        .get(index)
        .ok_or_else(|| DownloadError::Failed("Segment assignment is out of range.".to_string()))?;

    Ok(Some(SegmentAssignment {
        index,
        range: ByteRange {
            start: segment.start,
            end: segment.end,
        },
    }))
}

fn build_segment_manifest(url: &str, output_path: PathBuf, plan: SegmentedPlan) -> SegmentManifest {
    let segments = plan
        .ranges
        .iter()
        .map(|range| SegmentState {
            start: range.start,
            end: range.end,
            downloaded_bytes: 0,
        })
        .collect::<Vec<_>>();

    SegmentManifest {
        version: SEGMENT_MANIFEST_VERSION,
        url: url.to_string(),
        file_name: plan.file_name,
        output_path: output_path.to_string_lossy().to_string(),
        total_bytes: plan.total_bytes,
        segments,
    }
}

async fn reconcile_manifest_with_disk(
    manifest: SegmentManifest,
) -> Result<SegmentManifest, DownloadError> {
    Ok(manifest)
}

async fn load_segment_manifest(path: &Path) -> Result<Option<SegmentManifest>, DownloadError> {
    if !path.exists() {
        return Ok(None);
    }

    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))?;
    serde_json::from_slice::<SegmentManifest>(&bytes)
        .map(Some)
        .map_err(|error| DownloadError::Failed(error.to_string()))
}

async fn save_segment_manifest(
    path: &Path,
    manifest: &SegmentManifest,
) -> Result<(), DownloadError> {
    let bytes =
        serde_json::to_vec_pretty(manifest).map_err(|error| DownloadError::Failed(error.to_string()))?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|error| DownloadError::Failed(error.to_string()))
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

enum SegmentedMode {
    Fresh(SegmentedPlan),
    Resume(SegmentManifest),
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

struct SegmentRuntime {
    manifest: Mutex<SegmentManifest>,
    available_segments: Mutex<VecDeque<usize>>,
    temp_path: PathBuf,
}

struct SegmentAssignment {
    index: usize,
    range: ByteRange,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SegmentManifest {
    version: u32,
    url: String,
    file_name: String,
    output_path: String,
    total_bytes: u64,
    segments: Vec<SegmentState>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SegmentState {
    start: u64,
    end: u64,
    downloaded_bytes: u64,
}

fn temp_path_for(output_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.trinitydownload", output_path.to_string_lossy()))
}

fn manifest_path_for(manifest_root: &Path, output_path: &Path) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    output_path.to_string_lossy().hash(&mut hasher);
    manifest_root.join(format!("{:016x}.segments.json", hasher.finish()))
}

fn recommend_segment_count(total_bytes: u64, requested_connections: u32) -> u32 {
    let size_limited_segments = (total_bytes / MIN_SEGMENT_SIZE_BYTES).max(1) as u32;
    requested_connections
        .clamp(1, MAX_SEGMENT_CONNECTIONS)
        .saturating_mul(TARGET_SEGMENTS_PER_CONNECTION)
        .min(MAX_TOTAL_SEGMENTS)
        .min(size_limited_segments)
        .max(1)
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

fn can_use_range_requests(context: Option<&ExtensionDownloadRequest>) -> bool {
    request_method_from_context(context) == Method::GET
}

fn build_download_request(
    client: &Client,
    url: &str,
    context: Option<&ExtensionDownloadRequest>,
) -> reqwest::RequestBuilder {
    let method = request_method_from_context(context);
    let mut request = client.request(method.clone(), url);

    if method != Method::GET {
        if let Some(body) = context
            .and_then(|value| value.request_body.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request = request.body(body.to_string());
        }
    }

    apply_extension_request_headers(request, context)
}

fn request_method_from_context(context: Option<&ExtensionDownloadRequest>) -> Method {
    context
        .and_then(|value| value.request_method.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Method::from_bytes(value.as_bytes()).ok())
        .unwrap_or(Method::GET)
}

fn apply_extension_request_headers(
    mut request: reqwest::RequestBuilder,
    context: Option<&ExtensionDownloadRequest>,
) -> reqwest::RequestBuilder {
    let Some(context) = context else {
        return request;
    };

    if let Some(referrer) = context
        .referrer
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header(REFERER, referrer);
    }

    if let Some(user_agent) = context
        .user_agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header(USER_AGENT, user_agent);
    }

    if let Some(cookies) = context.cookies.as_ref().filter(|values| !values.is_empty()) {
        let cookie_value = cookies
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        if !cookie_value.is_empty() {
            request = request.header(COOKIE, cookie_value);
        }
    }

    if let Some(headers) = context.request_headers.as_ref() {
        for (name, value) in headers {
            let header_name = name.trim();
            let header_value = value.trim();
            if header_name.is_empty() || header_value.is_empty() {
                continue;
            }

            let normalized_name = header_name.to_ascii_lowercase();
            if matches!(
                normalized_name.as_str(),
                "cookie" | "content-length" | "host" | "range" | "referer" | "user-agent"
            ) {
                continue;
            }

            request = request.header(header_name, header_value);
        }
    }

    request
}
