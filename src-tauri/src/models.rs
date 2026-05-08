use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct AppStatus {
    pub app_name: String,
    pub engine: String,
    pub storage: String,
    pub task_manager: String,
}

impl AppStatus {
    pub fn foundation_ready() -> Self {
        Self {
            app_name: "Trinity Download Manager".to_string(),
            engine: "initialized".to_string(),
            storage: "sqlite ready".to_string(),
            task_manager: "initialized".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DownloadState {
    Queued,
    Running,
    Paused,
    Failed,
    Completed,
    Canceled,
}

impl DownloadState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Failed => "failed",
            Self::Completed => "completed",
            Self::Canceled => "canceled",
        }
    }
}

impl TryFrom<&str> for DownloadState {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "failed" => Ok(Self::Failed),
            "completed" => Ok(Self::Completed),
            "canceled" => Ok(Self::Canceled),
            _ => Err(format!("unknown download state: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadJob {
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub output_folder: String,
    pub output_path: String,
    pub state: DownloadState,
    pub queue_position: i64,
    pub priority: i32,
    pub connection_count: u32,
    pub speed_limit_kbps: u64,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: u64,
    pub is_resumable: bool,
    pub scheduler_enabled: bool,
    pub schedule_days: Vec<String>,
    pub schedule_from: Option<String>,
    pub schedule_to: Option<String>,
    pub retry_count: u32,
    pub next_retry_at: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateDownloadPriorityRequest {
    pub id: String,
    pub priority: i32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateDownloadSpeedLimitRequest {
    pub id: String,
    pub speed_limit_kbps: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReorderDownloadJobRequest {
    pub dragged_id: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateDownloadJobRequest {
    pub url: String,
    pub suggested_file_name: Option<String>,
    pub output_folder: Option<String>,
    pub scheduler_enabled: bool,
    pub schedule_days: Vec<String>,
    pub schedule_from: Option<String>,
    pub schedule_to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadUrlMetadata {
    pub file_name: String,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionDownloadRequest {
    pub url: String,
    pub final_url: Option<String>,
    pub request_method: Option<String>,
    pub request_body: Option<String>,
    pub request_body_encoding: Option<String>,
    pub request_form_data: Option<std::collections::HashMap<String, Vec<String>>>,
    pub request_headers: Option<std::collections::HashMap<String, String>>,
    pub page_url: Option<String>,
    pub suggested_file_name: Option<String>,
    pub mime_type: Option<String>,
    pub response_status: Option<u16>,
    pub response_headers: Option<std::collections::HashMap<String, String>>,
    pub observed_file_name: Option<String>,
    pub observed_content_type: Option<String>,
    pub observed_content_length: Option<u64>,
    pub observed_accept_ranges: Option<String>,
    pub browser_observed: Option<bool>,
    pub referrer: Option<String>,
    pub browser: Option<String>,
    pub user_agent: Option<String>,
    pub cookies: Option<Vec<String>>,
    pub output_folder: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserIntegrationSettings {
    pub intercept_downloads: bool,
    pub start_without_confirmation: bool,
    pub skip_domains: String,
    pub skip_extensions: String,
    pub capture_extensions: String,
    pub minimum_size_mb: u64,
    pub use_native_fallback: bool,
    pub ignore_insert_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppSettings {
    pub max_concurrent_downloads: usize,
    pub retry_enabled: bool,
    pub retry_attempts: u32,
    pub retry_delay_seconds: u64,
    pub default_connection_count: u32,
    pub default_download_speed_limit_kbps: u64,
    pub bandwidth_schedule_enabled: bool,
    pub bandwidth_schedule_start: String,
    pub bandwidth_schedule_end: String,
    pub bandwidth_schedule_limit_kbps: u64,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
    pub start_minimized: bool,
    pub startup_prompt_answered: bool,
    pub browser_intercept_downloads: bool,
    pub browser_start_without_confirmation: bool,
    pub browser_skip_domains: String,
    pub browser_skip_extensions: String,
    pub browser_capture_extensions: String,
    pub browser_minimum_size_mb: u64,
    pub browser_use_native_fallback: bool,
    pub browser_ignore_insert_key: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            max_concurrent_downloads: 3,
            retry_enabled: true,
            retry_attempts: 3,
            retry_delay_seconds: 5,
            default_connection_count: 4,
            default_download_speed_limit_kbps: 0,
            bandwidth_schedule_enabled: false,
            bandwidth_schedule_start: "22:00".to_string(),
            bandwidth_schedule_end: "06:00".to_string(),
            bandwidth_schedule_limit_kbps: 512,
            close_to_tray: true,
            launch_at_startup: false,
            start_minimized: false,
            startup_prompt_answered: false,
            browser_intercept_downloads: true,
            browser_start_without_confirmation: false,
            browser_skip_domains: "accounts.google.com, drive.google.com".to_string(),
            browser_skip_extensions: ".tmp, .part".to_string(),
            browser_capture_extensions: ".zip, .exe, .iso, .7z".to_string(),
            browser_minimum_size_mb: 1,
            browser_use_native_fallback: true,
            browser_ignore_insert_key: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateAppSettingsRequest {
    pub max_concurrent_downloads: usize,
    pub retry_enabled: bool,
    pub retry_attempts: u32,
    pub retry_delay_seconds: u64,
    pub default_connection_count: u32,
    pub default_download_speed_limit_kbps: u64,
    pub bandwidth_schedule_enabled: bool,
    pub bandwidth_schedule_start: String,
    pub bandwidth_schedule_end: String,
    pub bandwidth_schedule_limit_kbps: u64,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
    pub start_minimized: bool,
    pub startup_prompt_answered: bool,
    pub browser_intercept_downloads: bool,
    pub browser_start_without_confirmation: bool,
    pub browser_skip_domains: String,
    pub browser_skip_extensions: String,
    pub browser_capture_extensions: String,
    pub browser_minimum_size_mb: u64,
    pub browser_use_native_fallback: bool,
    pub browser_ignore_insert_key: bool,
}

impl From<&AppSettings> for BrowserIntegrationSettings {
    fn from(value: &AppSettings) -> Self {
        Self {
            intercept_downloads: value.browser_intercept_downloads,
            start_without_confirmation: value.browser_start_without_confirmation,
            skip_domains: value.browser_skip_domains.clone(),
            skip_extensions: value.browser_skip_extensions.clone(),
            capture_extensions: value.browser_capture_extensions.clone(),
            minimum_size_mb: value.browser_minimum_size_mb,
            use_native_fallback: value.browser_use_native_fallback,
            ignore_insert_key: value.browser_ignore_insert_key,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgressEvent {
    pub id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub speed_bps: u64,
}
