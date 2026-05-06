mod download_engine;
mod models;
mod storage;
mod task_manager;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use models::{
    AppSettings, AppStatus, CreateDownloadJobRequest, DownloadJob, DownloadState,
    DownloadUrlMetadata, ReorderDownloadJobRequest, UpdateAppSettingsRequest,
    UpdateDownloadPriorityRequest, UpdateDownloadSpeedLimitRequest,
};
use reqwest::{
    header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, RANGE},
    Client, StatusCode,
};
use storage::Storage;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;
use uuid::Uuid;
use chrono::Timelike;

struct AppState {
    storage: Mutex<Storage>,
    active_downloads: Mutex<HashMap<String, Arc<download_engine::DownloadControl>>>,
    file_watcher: Mutex<RecommendedWatcher>,
    watched_directories: Mutex<Vec<PathBuf>>,
    queue_running: AtomicBool,
}

#[tauri::command]
fn app_status() -> AppStatus {
    AppStatus::foundation_ready()
}

#[tauri::command]
fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;

    storage
        .get_app_settings()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_app_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    request: UpdateAppSettingsRequest,
) -> Result<AppSettings, String> {
    let settings = AppSettings {
        max_concurrent_downloads: request.max_concurrent_downloads.clamp(1, 10),
        retry_enabled: request.retry_enabled,
        retry_attempts: request.retry_attempts.clamp(0, 10),
        retry_delay_seconds: request.retry_delay_seconds.clamp(0, 3600),
        default_connection_count: request.default_connection_count.clamp(1, 16),
        default_download_speed_limit_kbps: request.default_download_speed_limit_kbps.min(1024 * 1024),
        bandwidth_schedule_enabled: request.bandwidth_schedule_enabled,
        bandwidth_schedule_start: normalize_time_setting(&request.bandwidth_schedule_start)?,
        bandwidth_schedule_end: normalize_time_setting(&request.bandwidth_schedule_end)?,
        bandwidth_schedule_limit_kbps: request.bandwidth_schedule_limit_kbps.min(1024 * 1024),
    };

    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    storage
        .update_app_settings(&settings)
        .map_err(|error| error.to_string())?;
    drop(storage);

    pump_queue(app)?;

    Ok(settings)
}

#[tauri::command]
fn get_default_download_folder(app: AppHandle) -> Result<String, String> {
    default_download_folder(&app).map(|folder| folder.to_string_lossy().to_string())
}

#[tauri::command]
async fn inspect_download_url(url: String) -> Result<DownloadUrlMetadata, String> {
    let parsed_url = Url::parse(url.trim()).map_err(|_| "Enter a valid URL.".to_string())?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        _ => return Err("Only HTTP and HTTPS URLs are supported right now.".to_string()),
    }

    let client = Client::new();
    let response = match client.head(parsed_url.clone()).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => client
            .get(parsed_url.clone())
            .header(RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|error| error.to_string())?,
    };

    if !response.status().is_success() && response.status() != StatusCode::PARTIAL_CONTENT {
        return Err(format!("Server returned HTTP {}", response.status()));
    }

    let file_name = file_name_from_content_disposition(response.headers())
        .or_else(|| file_name_from_url(response.url()))
        .map(|name| sanitize_file_name(&name))
        .unwrap_or_else(|| derive_file_name(response.url()));
    let total_bytes = response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(total_bytes_from_content_range)
        .or_else(|| {
            response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
        });

    Ok(DownloadUrlMetadata {
        file_name,
        total_bytes,
    })
}

#[tauri::command]
fn create_download_job(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CreateDownloadJobRequest,
) -> Result<DownloadJob, String> {
    let parsed_url =
        Url::parse(request.url.trim()).map_err(|_| "Enter a valid URL.".to_string())?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        _ => return Err("Only HTTP and HTTPS URLs are supported right now.".to_string()),
    }

    let file_name = derive_file_name(&parsed_url);
    let output_folder = match &request.output_folder {
        Some(folder) if !folder.trim().is_empty() => PathBuf::from(folder.trim()),
        _ => default_download_folder(&app)?,
    };
    let output_path = output_folder.join(&file_name);
    let (scheduler_enabled, schedule_days, schedule_from, schedule_to) =
        normalize_schedule_request(&request)?;
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    let queue_position = storage.next_queue_position().map_err(|error| error.to_string())?;
    let app_settings = storage.get_app_settings().map_err(|error| error.to_string())?;
    let connection_count = parsed_url
        .host_str()
        .map(|hostname| {
            storage
                .recommended_connection_count_for_host(
                    hostname,
                    app_settings.default_connection_count,
                )
                .map_err(|error| error.to_string())
        })
        .transpose()?
        .unwrap_or(app_settings.default_connection_count);

    let job = DownloadJob {
        id: Uuid::new_v4().to_string(),
        url: parsed_url.to_string(),
        file_name,
        output_folder: output_folder.to_string_lossy().to_string(),
        output_path: output_path.to_string_lossy().to_string(),
        state: DownloadState::Queued,
        queue_position,
        priority: 1,
        connection_count,
        speed_limit_kbps: app_settings.default_download_speed_limit_kbps,
        downloaded_bytes: 0,
        total_bytes: None,
        speed_bps: 0,
        is_resumable: false,
        scheduler_enabled,
        schedule_days,
        schedule_from,
        schedule_to,
        retry_count: 0,
        next_retry_at: None,
        error_message: None,
        created_at: String::new(),
        updated_at: String::new(),
    };

    storage
        .create_download_job(&job)
        .map_err(|error| error.to_string())?;

    let created_job = storage
        .list_download_jobs()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|candidate| candidate.id == job.id)
        .ok_or_else(|| "Created job could not be loaded.".to_string())?;

    drop(storage);
    pump_queue(app)?;

    Ok(created_job)
}

#[tauri::command]
fn move_download_job_up(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    let moved = storage
        .move_download_job_up(&id)
        .map_err(|error| error.to_string())?;
    drop(storage);

    if moved {
        pump_queue(app)?;
    }

    Ok(moved)
}

#[tauri::command]
fn move_download_job_down(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    let moved = storage
        .move_download_job_down(&id)
        .map_err(|error| error.to_string())?;
    drop(storage);

    if moved {
        pump_queue(app)?;
    }

    Ok(moved)
}

#[tauri::command]
fn reorder_download_job(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReorderDownloadJobRequest,
) -> Result<bool, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    let reordered = storage
        .reorder_download_job(&request.dragged_id, &request.target_id)
        .map_err(|error| error.to_string())?;
    drop(storage);

    if reordered {
        pump_queue(app)?;
    }

    Ok(reordered)
}

#[tauri::command]
fn update_download_priority(
    app: AppHandle,
    state: State<'_, AppState>,
    request: UpdateDownloadPriorityRequest,
) -> Result<bool, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    let updated = storage
        .update_download_priority(&request.id, request.priority)
        .map_err(|error| error.to_string())?;
    drop(storage);

    if updated {
        pump_queue(app)?;
    }

    Ok(updated)
}

#[tauri::command]
fn update_download_speed_limit(
    state: State<'_, AppState>,
    request: UpdateDownloadSpeedLimitRequest,
) -> Result<bool, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;

    storage
        .update_download_speed_limit(&request.id, request.speed_limit_kbps)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_download_jobs(state: State<'_, AppState>) -> Result<Vec<DownloadJob>, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    let jobs = load_jobs_with_cleanup(&storage).map_err(|error| error.to_string())?;
    sync_completed_file_watchers(&state, &jobs)?;
    Ok(jobs)
}

#[tauri::command]
fn delete_download_job(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    let existing_job = storage
        .get_download_job(&id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Download job could not be found.".to_string())?;

    let output_path = existing_job.output_path.trim().to_string();
    if !output_path.is_empty() {
        download_engine::cleanup_download_artifacts(PathBuf::from(&output_path).as_path())?;
    }

    storage.delete_download_job(&id).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_download_job(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.queue_running.store(true, Ordering::Relaxed);

    let storage = state
        .storage
        .lock()
        .map_err(|_| "Storage lock is unavailable.".to_string())?;
    storage
        .queue_download_job(&id)
        .map_err(|error| error.to_string())?;
    drop(storage);

    pump_queue(app)?;

    Ok(())
}

#[tauri::command]
fn cancel_download_job(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let control = state
        .active_downloads
        .lock()
        .map_err(|_| "Download registry is unavailable.".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Download is not currently running.".to_string())?;

    control.cancel_requested.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn pause_download_job(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let control = state
        .active_downloads
        .lock()
        .map_err(|_| "Download registry is unavailable.".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Download is not currently running.".to_string())?;

    control.pause_requested.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn stop_queue(state: State<'_, AppState>) -> Result<(), String> {
    state.queue_running.store(false, Ordering::Relaxed);

    let active_controls = state
        .active_downloads
        .lock()
        .map_err(|_| "Download registry is unavailable.".to_string())?
        .values()
        .cloned()
        .collect::<Vec<_>>();

    for control in active_controls {
        control.pause_requested.store(true, Ordering::Relaxed);
    }

    Ok(())
}

fn pump_queue(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if !state.queue_running.load(Ordering::Relaxed) {
        return Ok(());
    }

    let available_slots = {
        let active_downloads = state
            .active_downloads
            .lock()
            .map_err(|_| "Download registry is unavailable.".to_string())?;
        let max_concurrent_downloads = {
            let storage = state
                .storage
                .lock()
                .map_err(|_| "Storage lock is unavailable.".to_string())?;
            storage
                .get_app_settings()
                .map_err(|error| error.to_string())?
                .max_concurrent_downloads
        };
        max_concurrent_downloads.saturating_sub(active_downloads.len())
    };

    if available_slots == 0 {
        return Ok(());
    }

    let jobs = {
        let storage = state
            .storage
            .lock()
            .map_err(|_| "Storage lock is unavailable.".to_string())?;
        storage
            .list_queued_download_jobs(available_slots)
            .map_err(|error| error.to_string())?
    };

    for job in jobs {
        spawn_download(app.clone(), job)?;
    }

    Ok(())
}

fn spawn_download(app: AppHandle, job: DownloadJob) -> Result<(), String> {
    let state = app.state::<AppState>();
    let control = Arc::new(download_engine::DownloadControl::default());
    let id = job.id.clone();
    let hostname = Url::parse(&job.url)
        .ok()
        .and_then(|url| url.host_str().map(|value| value.to_string()));
    let connection_count = job.connection_count;

    {
        let mut active_downloads = state
            .active_downloads
            .lock()
            .map_err(|_| "Download registry is unavailable.".to_string())?;
        if active_downloads.contains_key(&id) {
            return Ok(());
        }
        active_downloads.insert(id.clone(), Arc::clone(&control));
    }

    {
        let storage = state
            .storage
            .lock()
            .map_err(|_| "Storage lock is unavailable.".to_string())?;
        storage
            .update_download_state(&id, DownloadState::Running, job.total_bytes, None)
            .map_err(|error| error.to_string())?;
    }

    tauri::async_runtime::spawn(async move {
        let job_id = job.id.clone();
        let output_path = job.output_path.clone();
        let started_at = std::time::Instant::now();
        let app_for_progress = app.clone();
        let app_for_output = app.clone();
        let app_for_speed_limit = app.clone();
        let job_id_for_output = job_id.clone();
        let job_id_for_progress = job_id.clone();
        let job_id_for_speed_limit = job_id.clone();
        let result = download_engine::download_to_disk(
            job,
            control,
            move |file_name, output_path, total_bytes, is_resumable| {
                let state = app_for_output.state::<AppState>();
                let storage = state
                    .storage
                    .lock()
                    .map_err(|_| "Storage lock is unavailable.".to_string())?;
                storage
                    .update_download_output(
                        &job_id_for_output,
                        &file_name,
                        &output_path,
                        total_bytes,
                        is_resumable,
                    )
                    .map_err(|error| error.to_string())
            },
            move |downloaded_bytes, total_bytes, speed_bps| {
                let state = app_for_progress.state::<AppState>();
                let storage = state
                    .storage
                    .lock()
                    .map_err(|_| "Storage lock is unavailable.".to_string())?;
                storage
                    .update_download_progress(
                        &job_id_for_progress,
                        downloaded_bytes,
                        total_bytes,
                        speed_bps,
                    )
                    .map_err(|error| error.to_string())
            },
            move || {
                let state = app_for_speed_limit.state::<AppState>();
                let storage = state
                    .storage
                    .lock()
                    .map_err(|_| "Storage lock is unavailable.".to_string())?;
                let app_settings = storage.get_app_settings().map_err(|error| error.to_string())?;
                let latest_job = storage
                    .get_download_job(&job_id_for_speed_limit)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "Download job no longer exists.".to_string())?;

                Ok(effective_download_speed_limit_kbps(&app_settings, &latest_job))
            },
        )
        .await;

        let state = app.state::<AppState>();
        if let Ok(mut active_downloads) = state.active_downloads.lock() {
            active_downloads.remove(&id);
        }

        if matches!(result, Err(download_engine::DownloadError::Failed(_))) {
            let _ = tokio::fs::remove_file(format!("{output_path}.trinitydownload")).await;
        }

        let should_pump_now = {
            let Ok(storage) = state.storage.lock() else {
                return;
            };

            match &result {
                Ok(()) => {
                    let total_bytes = storage
                        .get_download_job(&id)
                        .ok()
                        .flatten()
                        .map(|job| Some(job.downloaded_bytes))
                        .unwrap_or(None);
                    let _ = storage.update_download_state(
                        &id,
                        DownloadState::Completed,
                        total_bytes,
                        None,
                    );
                    if let (Some(hostname), Some(downloaded_bytes)) =
                        (hostname.as_deref(), total_bytes)
                    {
                        let elapsed_seconds = started_at.elapsed().as_secs_f64();
                        let average_speed_bps = if elapsed_seconds > 0.0 {
                            (downloaded_bytes as f64 / elapsed_seconds) as u64
                        } else {
                            downloaded_bytes
                        };
                        let _ = storage.record_host_download_success(
                            hostname,
                            connection_count,
                            average_speed_bps,
                        );
                    }
                    true
                }
                Err(download_engine::DownloadError::Canceled) => {
                    let _ = storage.update_download_state(
                        &id,
                        DownloadState::Canceled,
                        None,
                        Some("Download canceled by user."),
                    );
                    true
                }
                Err(download_engine::DownloadError::Paused) => {
                    let total_bytes = storage
                        .get_download_job(&id)
                        .ok()
                        .flatten()
                        .and_then(|job| job.total_bytes);
                    let _ = storage.update_download_state(
                        &id,
                        DownloadState::Paused,
                        total_bytes,
                        Some("Download paused. Partial file kept for resume."),
                    );
                    true
                }
                Err(download_engine::DownloadError::Failed(message)) => {
                    let app_settings = storage.get_app_settings().unwrap_or_default();
                    let retry_count = storage
                        .get_download_job(&id)
                        .ok()
                        .flatten()
                        .map(|job| job.retry_count)
                        .unwrap_or(app_settings.retry_attempts);

                    if app_settings.retry_enabled && retry_count < app_settings.retry_attempts {
                        let retry_message = format!(
                            "Retry {}/{} in {}s: {}",
                            retry_count + 1,
                            app_settings.retry_attempts,
                            app_settings.retry_delay_seconds,
                            message
                        );
                        let _ = storage.schedule_download_retry(
                            &id,
                            retry_message.as_str(),
                            app_settings.retry_delay_seconds,
                        );
                        let app_for_retry = app.clone();
                        let retry_delay_seconds = app_settings.retry_delay_seconds;
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(
                                retry_delay_seconds,
                            ))
                                .await;
                            let _ = pump_queue(app_for_retry);
                        });
                        true
                    } else {
                        let final_message = if app_settings.retry_enabled {
                            format!(
                                "Failed after {} retries: {}",
                                app_settings.retry_attempts, message
                            )
                        } else {
                            format!("Failed with automatic retry disabled: {}", message)
                        };
                        let _ = storage.update_download_state(
                            &id,
                            DownloadState::Failed,
                            None,
                            Some(final_message.as_str()),
                        );
                        if let Some(hostname) = hostname.as_deref() {
                            let _ = storage.record_host_download_failure(
                                hostname,
                                connection_count,
                                final_message.as_str(),
                            );
                        }
                        true
                    }
                }
            }
        };

        if should_pump_now {
            let _ = pump_queue(app);
        }
    });

    Ok(())
}

fn default_download_folder(app: &AppHandle) -> Result<PathBuf, String> {
    let folder = match app.path().download_dir() {
        Ok(folder) => folder,
        Err(_) => app
            .path()
            .app_data_dir()
            .map(|path| path.join("downloads"))
            .map_err(|error| error.to_string())?,
    };

    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    Ok(folder)
}

fn derive_file_name(url: &Url) -> String {
    let candidate = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.trim().is_empty())
        .unwrap_or("download");

    sanitize_file_name(candidate)
}

fn normalize_schedule_request(
    request: &CreateDownloadJobRequest,
) -> Result<(bool, Vec<String>, Option<String>, Option<String>), String> {
    if !request.scheduler_enabled {
        return Ok((false, Vec::new(), None, None));
    }

    let days = if request.schedule_days.is_empty() {
        vec![
            "Everyday".to_string(),
            "Sun".to_string(),
            "Mon".to_string(),
            "Tue".to_string(),
            "Wed".to_string(),
            "Thu".to_string(),
            "Fri".to_string(),
            "Sat".to_string(),
        ]
    } else {
        request
            .schedule_days
            .iter()
            .filter(|day| {
                matches!(
                    day.as_str(),
                    "Everyday" | "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat"
                )
            })
            .cloned()
            .collect::<Vec<_>>()
    };

    if days.is_empty() {
        return Err("Select at least one scheduler day.".to_string());
    }

    let schedule_from = request
        .schedule_from
        .as_deref()
        .filter(|value| is_valid_schedule_time(value))
        .ok_or_else(|| "Enter a valid scheduler start time.".to_string())?
        .to_string();
    let schedule_to = request
        .schedule_to
        .as_deref()
        .filter(|value| is_valid_schedule_time(value))
        .ok_or_else(|| "Enter a valid scheduler end time.".to_string())?
        .to_string();

    Ok((true, days, Some(schedule_from), Some(schedule_to)))
}

fn is_valid_schedule_time(value: &str) -> bool {
    let Some((hour, minute)) = value.split_once(':') else {
        return false;
    };

    matches!(
        (hour.parse::<u32>(), minute.parse::<u32>()),
        (Ok(hour), Ok(minute)) if hour < 24 && minute < 60
    )
}

fn normalize_time_setting(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if !is_valid_schedule_time(trimmed) {
        return Err("Enter valid schedule times in HH:MM format.".to_string());
    }

    Ok(trimmed.to_string())
}

fn effective_download_speed_limit_kbps(settings: &AppSettings, job: &DownloadJob) -> Option<u64> {
    let job_limit = (job.speed_limit_kbps > 0).then_some(job.speed_limit_kbps);
    let scheduled_limit = if settings.bandwidth_schedule_enabled
        && settings.bandwidth_schedule_limit_kbps > 0
        && is_time_window_active(
            &settings.bandwidth_schedule_start,
            &settings.bandwidth_schedule_end,
        )
    {
        Some(settings.bandwidth_schedule_limit_kbps)
    } else {
        None
    };

    match (job_limit, scheduled_limit) {
        (Some(job_limit), Some(scheduled_limit)) => Some(job_limit.min(scheduled_limit)),
        (Some(job_limit), None) => Some(job_limit),
        (None, Some(scheduled_limit)) => Some(scheduled_limit),
        (None, None) => None,
    }
}

fn is_time_window_active(start: &str, end: &str) -> bool {
    let Some(start_minutes) = time_value_to_minutes(start) else {
        return false;
    };
    let Some(end_minutes) = time_value_to_minutes(end) else {
        return false;
    };

    let now = chrono::Local::now();
    let now_minutes = now.hour() * 60 + now.minute();

    if start_minutes <= end_minutes {
        now_minutes >= start_minutes && now_minutes <= end_minutes
    } else {
        now_minutes >= start_minutes || now_minutes <= end_minutes
    }
}

fn time_value_to_minutes(value: &str) -> Option<u32> {
    let (hour, minute) = value.split_once(':')?;
    let hour = hour.parse::<u32>().ok()?;
    let minute = minute.parse::<u32>().ok()?;
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

fn file_name_from_content_disposition(headers: &reqwest::header::HeaderMap) -> Option<String> {
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

fn file_name_from_url(url: &Url) -> Option<String> {
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

fn total_bytes_from_content_range(value: &str) -> Option<u64> {
    value
        .rsplit_once('/')
        .and_then(|(_, total)| (total != "*").then_some(total))
        .and_then(|total| total.parse::<u64>().ok())
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

fn open_storage(app: &AppHandle) -> Result<Storage, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    Storage::open(app_data_dir.join("trinity.sqlite3")).map_err(|error| error.to_string())
}

fn load_jobs_with_cleanup(storage: &Storage) -> rusqlite::Result<Vec<DownloadJob>> {
    let mut jobs = storage.list_download_jobs()?;
    let missing_completed_job_ids = jobs
        .iter()
        .filter(|job| {
            matches!(job.state, DownloadState::Completed)
                && !job.output_path.trim().is_empty()
                && !PathBuf::from(job.output_path.trim()).exists()
        })
        .map(|job| job.id.clone())
        .collect::<Vec<_>>();

    if missing_completed_job_ids.is_empty() {
        return Ok(jobs);
    }

    for id in missing_completed_job_ids {
        storage.delete_download_job(&id)?;
    }

    jobs = storage.list_download_jobs()?;
    Ok(jobs)
}

fn sync_completed_file_watchers(state: &AppState, jobs: &[DownloadJob]) -> Result<(), String> {
    let mut next_directories = jobs
        .iter()
        .filter(|job| matches!(job.state, DownloadState::Completed))
        .filter_map(|job| {
            let output_path = job.output_path.trim();
            if output_path.is_empty() {
                return None;
            }

            PathBuf::from(output_path)
                .parent()
                .map(|parent| parent.to_path_buf())
        })
        .collect::<Vec<_>>();
    next_directories.sort();
    next_directories.dedup();

    let mut watcher = state
        .file_watcher
        .lock()
        .map_err(|_| "File watcher lock is unavailable.".to_string())?;
    let mut watched_directories = state
        .watched_directories
        .lock()
        .map_err(|_| "Watched directory registry is unavailable.".to_string())?;

    let directories_to_remove = watched_directories
        .iter()
        .filter(|current| !next_directories.iter().any(|next| next == *current))
        .cloned()
        .collect::<Vec<_>>();
    let directories_to_add = next_directories
        .iter()
        .filter(|next| !watched_directories.iter().any(|current| current == *next))
        .cloned()
        .collect::<Vec<_>>();

    for directory in directories_to_remove {
        watcher.unwatch(&directory).map_err(|error| error.to_string())?;
    }

    for directory in &directories_to_add {
        watcher
            .watch(directory, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;
    }

    *watched_directories = next_directories;
    Ok(())
}

fn should_process_file_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Remove(_)
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Metadata(_))
            | EventKind::Modify(ModifyKind::Data(_))
    )
}

fn handle_file_watch_event(app: &AppHandle, kind: &EventKind) -> Result<(), String> {
    if !should_process_file_event(kind) {
        return Ok(());
    }

    let storage = open_storage(app)?;
    let jobs_before = storage
        .list_download_jobs()
        .map_err(|error| error.to_string())?
        .len();
    let jobs_after = load_jobs_with_cleanup(&storage)
        .map_err(|error| error.to_string())?
        .len();

    if jobs_after < jobs_before {
        app.emit("downloads-changed", ())
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let storage = open_storage(app.handle()).map_err(|message| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    message,
                ))
            })?;
            storage.recover_running_downloads().map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    error.to_string(),
                ))
            })?;
            let app_handle = app.handle().clone();
            let file_watcher = notify::recommended_watcher(move |event_result: notify::Result<notify::Event>| {
                if let Ok(event) = event_result {
                    let _ = handle_file_watch_event(&app_handle, &event.kind);
                }
            })
            .map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    error.to_string(),
                ))
            })?;
            app.manage(AppState {
                storage: Mutex::new(storage),
                active_downloads: Mutex::new(HashMap::new()),
                file_watcher: Mutex::new(file_watcher),
                watched_directories: Mutex::new(Vec::new()),
                queue_running: AtomicBool::new(true),
            });
            let state = app.state::<AppState>();
            let jobs = {
                let storage = state.storage.lock().map_err(|_| {
                    Box::<dyn std::error::Error>::from(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "Storage lock is unavailable.",
                    ))
                })?;
                load_jobs_with_cleanup(&storage).map_err(|error| {
                    Box::<dyn std::error::Error>::from(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        error.to_string(),
                    ))
                })?
            };
            sync_completed_file_watchers(&state, &jobs).map_err(|message| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    message,
                ))
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            get_app_settings,
            update_app_settings,
            get_default_download_folder,
            inspect_download_url,
            create_download_job,
            list_download_jobs,
            delete_download_job,
            move_download_job_up,
            move_download_job_down,
            reorder_download_job,
            update_download_priority,
            update_download_speed_limit,
            start_download_job,
            cancel_download_job,
            pause_download_job,
            stop_queue
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
