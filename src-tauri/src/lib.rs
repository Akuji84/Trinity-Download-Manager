mod download_engine;
mod models;
mod storage;
mod task_manager;

use std::{
    collections::HashMap,
    ffi::c_void,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use models::{
    AppSettings, AppStatus, BrowserIntegrationSettings, CreateDownloadJobRequest, DownloadJob,
    DownloadProgressEvent, DownloadState, DownloadUrlMetadata, ExtensionDownloadRequest,
    ReorderDownloadJobRequest, UpdateAppSettingsRequest, UpdateDownloadPriorityRequest,
    UpdateDownloadSpeedLimitRequest,
};
use reqwest::{
    header::{CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, COOKIE, RANGE, REFERER, USER_AGENT},
    Client, Method, StatusCode,
};
use storage::Storage;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;
use uuid::Uuid;
use chrono::Timelike;
#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{HANDLE, HWND},
        Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS,
            DeleteDC, DeleteObject, GetDC, HBRUSH, HGDIOBJ, ReleaseDC, SelectObject,
        },
        Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
        },
        UI::{
            Shell::{
                SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
            },
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, GetSystemMetrics, DI_NORMAL, HICON, SM_CXSMICON, SM_CYSMICON},
        },
    },
};

struct AppState {
    storage: Mutex<Storage>,
    active_downloads: Mutex<HashMap<String, Arc<download_engine::DownloadControl>>>,
    extension_request_contexts: Mutex<HashMap<String, ExtensionDownloadRequest>>,
    job_request_contexts: Mutex<HashMap<String, ExtensionDownloadRequest>>,
    file_watcher: Mutex<RecommendedWatcher>,
    watched_directories: Mutex<Vec<PathBuf>>,
    queue_running: AtomicBool,
    close_to_tray: AtomicBool,
}

const EXTENSION_BRIDGE_HOST: &str = "127.0.0.1";
const EXTENSION_BRIDGE_PORT: u16 = 38491;
const EXTENSION_DOWNLOAD_EVENT: &str = "extension-download-request";
const EXTENSION_OPEN_OPTIONS_EVENT: &str = "extension-open-options";

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn resolved_extension_url(request: &ExtensionDownloadRequest) -> &str {
    request
        .final_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| request.url.trim())
}

fn extension_context_for_url(
    state: &AppState,
    url: &str,
) -> Result<Option<ExtensionDownloadRequest>, String> {
    let contexts = state
        .extension_request_contexts
        .lock()
        .map_err(|_| "Extension request context lock is unavailable.".to_string())?;
    Ok(contexts.get(url).cloned())
}

fn apply_extension_request_headers(
    mut request: reqwest::RequestBuilder,
    context: Option<&ExtensionDownloadRequest>,
) -> reqwest::RequestBuilder {
    let Some(context) = context else {
        return request;
    };

    if let Some(referrer) = context.referrer.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        request = request.header(REFERER, referrer);
    }

    if let Some(user_agent) = context.user_agent.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
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

            if normalized_name == "content-type" && request_uses_form_data(Some(context)) {
                continue;
            }

            request = request.header(header_name, header_value);
        }
    }

    request
}

fn request_method_from_context(context: Option<&ExtensionDownloadRequest>) -> Method {
    context
        .and_then(|value| value.request_method.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Method::from_bytes(value.as_bytes()).ok())
        .unwrap_or(Method::GET)
}

fn request_body_bytes_from_context(context: Option<&ExtensionDownloadRequest>) -> Option<Vec<u8>> {
    let context = context?;
    let body = context
        .request_body
        .as_deref()
        .filter(|value| !value.is_empty())?;

    match context
        .request_body_encoding
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("text")
    {
        "base64" => BASE64_STANDARD.decode(body).ok(),
        _ => Some(body.as_bytes().to_vec()),
    }
}

fn request_form_entries_from_context(
    context: Option<&ExtensionDownloadRequest>,
) -> Option<Vec<(String, String)>> {
    let form_data = context?.request_form_data.as_ref()?;
    let mut entries = Vec::new();

    for (key, values) in form_data {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }

        for value in values {
            entries.push((key.to_string(), value.clone()));
        }
    }

    (!entries.is_empty()).then_some(entries)
}

fn request_uses_form_data(context: Option<&ExtensionDownloadRequest>) -> bool {
    context
        .and_then(|value| value.request_form_data.as_ref())
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn request_uses_multipart(context: Option<&ExtensionDownloadRequest>) -> bool {
    context
        .and_then(|value| value.request_headers.as_ref())
        .and_then(|headers| headers.get("content-type").or_else(|| headers.get("Content-Type")))
        .map(|value| value.to_ascii_lowercase().starts_with("multipart/form-data"))
        .unwrap_or(false)
}

fn build_extension_request(
    client: &Client,
    parsed_url: &Url,
    context: Option<&ExtensionDownloadRequest>,
    prefer_head_probe: bool,
) -> reqwest::RequestBuilder {
    let method = request_method_from_context(context);
    let use_head_probe = prefer_head_probe && method == Method::GET;
    let mut request = if use_head_probe {
        client.head(parsed_url.clone())
    } else {
        client.request(method.clone(), parsed_url.clone())
    };

    if !use_head_probe && method != Method::GET {
        if let Some(entries) = request_form_entries_from_context(context) {
            if request_uses_multipart(context) {
                let mut form = reqwest::multipart::Form::new();
                for (key, value) in entries {
                    form = form.text(key, value);
                }
                request = request.multipart(form);
            } else {
                request = request.form(&entries);
            }
        } else if let Some(body) = request_body_bytes_from_context(context) {
            request = request.body(body);
        }
    }

    apply_extension_request_headers(request, context)
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
        close_to_tray: request.close_to_tray,
        start_minimized: request.start_minimized,
        browser_intercept_downloads: request.browser_intercept_downloads,
        browser_start_without_confirmation: request.browser_start_without_confirmation,
        browser_skip_domains: request.browser_skip_domains.trim().to_string(),
        browser_skip_extensions: request.browser_skip_extensions.trim().to_string(),
        browser_capture_extensions: request.browser_capture_extensions.trim().to_string(),
        browser_minimum_size_mb: request.browser_minimum_size_mb.min(1024 * 1024),
        browser_use_native_fallback: request.browser_use_native_fallback,
        browser_ignore_insert_key: request.browser_ignore_insert_key,
    };
    state.close_to_tray.store(request.close_to_tray, Ordering::Relaxed);

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
fn get_system_file_icon(path_hint: String, is_directory: bool) -> Result<Option<String>, String> {
    if path_hint.trim().is_empty() {
        return Ok(None);
    }

    system_file_icon_data_url(path_hint.trim(), is_directory)
}

#[tauri::command]
async fn inspect_download_url(state: State<'_, AppState>, url: String) -> Result<DownloadUrlMetadata, String> {
    let parsed_url = Url::parse(url.trim()).map_err(|_| "Enter a valid URL.".to_string())?;
    match parsed_url.scheme() {
        "http" | "https" => {}
        _ => return Err("Only HTTP and HTTPS URLs are supported right now.".to_string()),
    }

    let extension_context = extension_context_for_url(&state, parsed_url.as_str())?;
    let client = Client::new();
    let method = request_method_from_context(extension_context.as_ref());
    let response = if method == Method::GET {
        match build_extension_request(&client, &parsed_url, extension_context.as_ref(), true)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => response,
            _ => build_extension_request(&client, &parsed_url, extension_context.as_ref(), false)
                .header(RANGE, "bytes=0-0")
                .send()
                .await
                .map_err(|error| error.to_string())?,
        }
    } else {
        build_extension_request(&client, &parsed_url, extension_context.as_ref(), false)
            .header(RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|error| error.to_string())?
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

    let file_name = request
        .suggested_file_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(sanitize_file_name)
        .unwrap_or_else(|| derive_file_name(&parsed_url));
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

    if let Some(context) = extension_context_for_url(&state, parsed_url.as_str())? {
        state
            .job_request_contexts
            .lock()
            .map_err(|_| "Job request context lock is unavailable.".to_string())?
            .insert(job.id.clone(), context);
    }

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
fn delete_download_job(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
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
        let manifest_root = segment_manifest_root(&app)?;
        download_engine::cleanup_download_artifacts(
            PathBuf::from(&output_path).as_path(),
            manifest_root.as_path(),
        )?;
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
fn reveal_in_folder(path: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if !path.exists() {
        return Err("File does not exist.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        // xdg-open the parent folder; no universal "select file" on Linux
        let parent = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

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
    let request_context = state
        .job_request_contexts
        .lock()
        .map_err(|_| "Job request context lock is unavailable.".to_string())?
        .get(&id)
        .cloned();
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
        let started_at = std::time::Instant::now();
        let manifest_root = segment_manifest_root(&app).unwrap_or_else(|_| {
            std::env::temp_dir().join("trinity-segment-manifests")
        });
        let app_for_progress = app.clone();
        let app_for_output = app.clone();
        let app_for_speed_limit = app.clone();
        let job_id_for_output = job_id.clone();
        let job_id_for_progress = job_id.clone();
        let job_id_for_speed_limit = job_id.clone();
        let result = download_engine::download_to_disk(
            job,
            request_context,
            manifest_root,
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
                    .map_err(|error| error.to_string())?;
                drop(storage);
                let _ = app_for_progress.emit(
                    "download-progress",
                    DownloadProgressEvent {
                        id: job_id_for_progress.clone(),
                        downloaded_bytes,
                        total_bytes,
                        speed_bps,
                    },
                );
                Ok(())
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
        if let Ok(mut request_contexts) = state.job_request_contexts.lock() {
            request_contexts.remove(&id);
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
                        None,
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

#[cfg(target_os = "windows")]
fn system_file_icon_data_url(path_hint: &str, is_directory: bool) -> Result<Option<String>, String> {
    let hint_path = PathBuf::from(path_hint);
    let path_exists = hint_path.exists();
    let normalized_hint = if path_exists {
        hint_path.to_string_lossy().to_string()
    } else if is_directory {
        path_hint.to_string()
    } else if path_hint.contains('.') {
        path_hint.to_string()
    } else {
        format!("{path_hint}.bin")
    };
    let wide_path = normalized_hint
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<u16>>();

    let mut file_info = SHFILEINFOW::default();
    let mut flags = SHGFI_ICON | SHGFI_SMALLICON;
    let attributes = if is_directory {
        FILE_ATTRIBUTE_DIRECTORY.0
    } else {
        FILE_ATTRIBUTE_NORMAL.0
    };
    if !path_exists {
        flags |= SHGFI_USEFILEATTRIBUTES;
    }

    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(attributes),
            Some(&mut file_info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };

    if result == 0 || file_info.hIcon.0.is_null() {
        return Ok(None);
    }

    unsafe { icon_handle_to_data_url(file_info.hIcon) }.map(Some)
}

#[cfg(not(target_os = "windows"))]
fn system_file_icon_data_url(
    _path_hint: &str,
    _is_directory: bool,
) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "windows")]
unsafe fn icon_handle_to_data_url(icon: HICON) -> Result<String, String> {
    let icon_width = GetSystemMetrics(SM_CXSMICON).max(16);
    let icon_height = GetSystemMetrics(SM_CYSMICON).max(16);
    let desktop_window = HWND(std::ptr::null_mut());

    let screen_dc = GetDC(desktop_window);
    if screen_dc.0.is_null() {
        let _ = DestroyIcon(icon);
        return Err("Could not acquire the screen context for icon rendering.".to_string());
    }

    let memory_dc = CreateCompatibleDC(screen_dc);
    if memory_dc.0.is_null() {
        let _ = ReleaseDC(desktop_window, screen_dc);
        let _ = DestroyIcon(icon);
        return Err("Could not allocate an icon render context.".to_string());
    }

    let mut bitmap_info = BITMAPINFO::default();
    bitmap_info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: icon_width,
        biHeight: -icon_height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };

    let mut pixel_buffer = std::ptr::null_mut::<c_void>();
    let dib_bitmap = CreateDIBSection(
        screen_dc,
        &bitmap_info,
        DIB_RGB_COLORS,
        &mut pixel_buffer,
        HANDLE(std::ptr::null_mut()),
        0,
    )
    .map_err(|error| format!("Could not allocate an icon bitmap: {error}"))?;
    if dib_bitmap.0.is_null() || pixel_buffer.is_null() {
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(desktop_window, screen_dc);
        let _ = DestroyIcon(icon);
        return Err("Could not allocate an icon bitmap.".to_string());
    }

    let previous_object = SelectObject(memory_dc, HGDIOBJ(dib_bitmap.0));
    DrawIconEx(
        memory_dc,
        0,
        0,
        icon,
        icon_width,
        icon_height,
        0,
        HBRUSH(std::ptr::null_mut()),
        DI_NORMAL,
    )
    .map_err(|error| format!("Could not render the file icon: {error}"))?;

    let pixel_len = (icon_width * icon_height * 4) as usize;
    let bgra_pixels = std::slice::from_raw_parts(pixel_buffer.cast::<u8>(), pixel_len);
    let mut rgba_pixels = Vec::with_capacity(pixel_len);
    for chunk in bgra_pixels.chunks_exact(4) {
        rgba_pixels.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]]);
    }

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, icon_width as u32, icon_height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("Could not encode icon PNG header: {error}"))?;
        writer
            .write_image_data(&rgba_pixels)
            .map_err(|error| format!("Could not encode icon PNG data: {error}"))?;
    }

    let _ = SelectObject(memory_dc, previous_object);
    let _ = DeleteObject(dib_bitmap);
    let _ = DeleteDC(memory_dc);
    let _ = ReleaseDC(desktop_window, screen_dc);
    let _ = DestroyIcon(icon);

    Ok(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(png_bytes)
    ))
}

fn segment_manifest_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("segment-manifests");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
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

fn start_extension_bridge(app: AppHandle) -> Result<(), String> {
    let listener = match TcpListener::bind((EXTENSION_BRIDGE_HOST, EXTENSION_BRIDGE_PORT)) {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!(
                "Trinity extension bridge could not bind to {}:{} because the port is already in use.",
                EXTENSION_BRIDGE_HOST, EXTENSION_BRIDGE_PORT
            );
            return Ok(());
        }
        Err(error) => {
            return Err(format!(
                "Could not start the Trinity extension bridge on {}:{}: {}",
                EXTENSION_BRIDGE_HOST, EXTENSION_BRIDGE_PORT, error
            ));
        }
    };

    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            match incoming {
                Ok(stream) => {
                    let _ = handle_extension_bridge_connection(&app, stream);
                }
                Err(error) => {
                    eprintln!("Trinity extension bridge stopped accepting connections: {error}");
                    break;
                }
            }
        }
    });

    Ok(())
}

fn handle_extension_bridge_connection(app: &AppHandle, mut stream: TcpStream) -> Result<(), String> {
    let (method, path, body) = read_http_request(&mut stream)?;

    match (method.as_str(), path.as_str()) {
        ("OPTIONS", _) => write_json_response(&mut stream, "204 No Content", &serde_json::json!({})),
        ("GET", "/app/ping") => write_json_response(
            &mut stream,
            "200 OK",
            &serde_json::json!({
                "ok": true,
                "appName": "Trinity Download Manager",
                "bridgePort": EXTENSION_BRIDGE_PORT,
                "endpoints": ["/app/ping", "/app/browser-settings", "/downloads/create", "/app/open-options"],
                "downloadHandoffVersion": 2
            }),
        ),
        ("GET", "/app/browser-settings") => {
            let settings = {
                let state = app.state::<AppState>();
                let storage = state
                    .storage
                    .lock()
                    .map_err(|_| "Storage lock is unavailable.".to_string())?;
                let settings = storage
                    .get_app_settings()
                    .map_err(|error| error.to_string())?;
                BrowserIntegrationSettings::from(&settings)
            };

            write_json_response(
                &mut stream,
                "200 OK",
                &serde_json::json!(settings),
            )
        }
        ("POST", "/app/open-options") => {
            focus_main_window(app);

            app.emit(EXTENSION_OPEN_OPTIONS_EVENT, ())
                .map_err(|error| error.to_string())?;

            write_json_response(
                &mut stream,
                "202 Accepted",
                &serde_json::json!({
                    "accepted": true
                }),
            )
        }
        ("POST", "/downloads/create") => {
            let request: ExtensionDownloadRequest = serde_json::from_slice(&body)
                .map_err(|error| format!("Invalid Trinity extension payload: {error}"))?;
            let resolved_url = resolved_extension_url(&request).to_string();
            let parsed_url = Url::parse(&resolved_url)
                .map_err(|_| "Invalid download URL.".to_string())?;
            match parsed_url.scheme() {
                "http" | "https" => {}
                _ => return Err("Only HTTP and HTTPS URLs are supported.".to_string()),
            }

            let state = app.state::<AppState>();
            let mut contexts = state
                .extension_request_contexts
                .lock()
                .map_err(|_| "Extension request context lock is unavailable.".to_string())?;
            contexts.insert(resolved_url.clone(), request.clone());
            let original_url = request.url.trim();
            if !original_url.is_empty() && original_url != resolved_url {
                contexts.insert(original_url.to_string(), request.clone());
            }

            app.emit(EXTENSION_DOWNLOAD_EVENT, request)
                .map_err(|error| error.to_string())?;

            focus_main_window(app);

            write_json_response(
                &mut stream,
                "202 Accepted",
                &serde_json::json!({
                    "accepted": true
                }),
            )
        }
        _ => write_json_response(
            &mut stream,
            "404 Not Found",
            &serde_json::json!({
                "error": "Not found"
            }),
        ),
    }
}

fn read_http_request(stream: &mut TcpStream) -> Result<(String, String, Vec<u8>), String> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end = loop {
        let bytes_read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            return Err("Connection closed before the request completed.".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);
        if let Some(position) = find_header_end(&buffer) {
            break position;
        }

        if buffer.len() > 1024 * 1024 {
            return Err("Incoming request exceeded the maximum bridge size.".to_string());
        }
    };

    let header_bytes = &buffer[..header_end];
    let header_text = String::from_utf8(header_bytes.to_vec())
        .map_err(|_| "Incoming bridge request headers were not valid UTF-8.".to_string())?;
    let mut header_lines = header_text.split("\r\n");
    let request_line = header_lines
        .next()
        .ok_or_else(|| "Incoming bridge request was missing the request line.".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Incoming bridge request was missing the method.".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "Incoming bridge request was missing the path.".to_string())?
        .to_string();

    let mut content_length = 0_usize;
    for line in header_lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("Content-Length") {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }

    let body_start = header_end + 4;
    while buffer.len().saturating_sub(body_start) < content_length {
        let bytes_read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);
    }

    let body_end = body_start.saturating_add(content_length).min(buffer.len());
    Ok((method, path, buffer[body_start..body_end].to_vec()))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn write_json_response(
    stream: &mut TcpStream,
    status: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let should_hide = window
                    .app_handle()
                    .state::<AppState>()
                    .close_to_tray
                    .load(Ordering::Relaxed);
                if should_hide {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
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
            let initial_settings = storage.get_app_settings().map_err(|error| {
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
                extension_request_contexts: Mutex::new(HashMap::new()),
                job_request_contexts: Mutex::new(HashMap::new()),
                file_watcher: Mutex::new(file_watcher),
                watched_directories: Mutex::new(Vec::new()),
                queue_running: AtomicBool::new(true),
                close_to_tray: AtomicBool::new(initial_settings.close_to_tray),
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
            start_extension_bridge(app.handle().clone()).map_err(|message| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    message,
                ))
            })?;

            // System tray
            let open_item = tauri::menu::MenuItem::with_id(app, "open", "Open Trinity", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let close_item = tauri::menu::MenuItem::with_id(app, "close", "Close Trinity", true, None::<&str>)?;
            let tray_menu = tauri::menu::Menu::with_items(app, &[&open_item, &separator, &close_item])?;
            let mut tray_builder = tauri::tray::TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("Trinity Download Manager")
                .on_tray_icon_event(|tray, event| {
                    match event {
                        tauri::tray::TrayIconEvent::Click { button, button_state, .. }
                            if button == tauri::tray::MouseButton::Left
                                && button_state == tauri::tray::MouseButtonState::Up =>
                        {
                            focus_main_window(&tray.app_handle());
                        }
                        tauri::tray::TrayIconEvent::DoubleClick { button, .. }
                            if button == tauri::tray::MouseButton::Left =>
                        {
                            focus_main_window(&tray.app_handle());
                        }
                        _ => {}
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        focus_main_window(app);
                    }
                    "close" => {
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

            if initial_settings.start_minimized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            get_app_settings,
            update_app_settings,
            get_default_download_folder,
            get_system_file_icon,
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
            stop_queue,
            reveal_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
