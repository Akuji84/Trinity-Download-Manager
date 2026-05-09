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
    pub default_folder_mode: String,
    pub fixed_download_folder: String,
    pub show_save_as_button: bool,
    pub delete_button_action: String,
    pub file_exists_action: String,
    pub remove_deleted_files: bool,
    pub remove_completed_files: bool,
    pub bottom_panel_follows_selection: bool,
    pub show_tray_activity: bool,
    pub use_custom_sort_order: bool,
    pub skip_web_pages: bool,
    pub use_server_file_time: bool,
    pub mark_downloaded_files: bool,
    pub browser_intercept_downloads: bool,
    pub browser_start_without_confirmation: bool,
    pub browser_skip_domains: String,
    pub browser_skip_extensions: String,
    pub browser_capture_extensions: String,
    pub browser_minimum_size_mb: u64,
    pub browser_use_native_fallback: bool,
    pub browser_ignore_insert_key: bool,
    pub proxy_mode: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_username: String,
    pub proxy_password: String,
    pub notify_added: bool,
    pub notify_completed: bool,
    pub notify_failed: bool,
    pub notify_inactive_only: bool,
    pub play_sounds: bool,
    pub completion_hook_enabled: bool,
    pub completion_hook_path: String,
    pub completion_hook_arguments: String,
    pub avoid_sleep_with_active_downloads: bool,
    pub avoid_sleep_with_scheduled_downloads: bool,
    pub allow_sleep_if_resumable: bool,
    pub check_for_updates_automatically: bool,
    pub install_updates_automatically: bool,
    pub test_toggle: bool,
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
            default_folder_mode: "automatic".to_string(),
            fixed_download_folder: String::new(),
            show_save_as_button: true,
            delete_button_action: "ask".to_string(),
            file_exists_action: "rename".to_string(),
            remove_deleted_files: true,
            remove_completed_files: false,
            bottom_panel_follows_selection: true,
            show_tray_activity: true,
            use_custom_sort_order: false,
            skip_web_pages: true,
            use_server_file_time: false,
            mark_downloaded_files: true,
            browser_intercept_downloads: true,
            browser_start_without_confirmation: false,
            browser_skip_domains: "accounts.google.com, drive.google.com".to_string(),
            browser_skip_extensions: ".tmp, .part".to_string(),
            browser_capture_extensions: ".zip, .exe, .iso, .7z".to_string(),
            browser_minimum_size_mb: 1,
            browser_use_native_fallback: true,
            browser_ignore_insert_key: true,
            proxy_mode: "system".to_string(),
            proxy_host: String::new(),
            proxy_port: 8080,
            proxy_username: String::new(),
            proxy_password: String::new(),
            notify_added: false,
            notify_completed: true,
            notify_failed: true,
            notify_inactive_only: true,
            play_sounds: false,
            completion_hook_enabled: false,
            completion_hook_path: String::new(),
            completion_hook_arguments: "%path%".to_string(),
            avoid_sleep_with_active_downloads: true,
            avoid_sleep_with_scheduled_downloads: true,
            allow_sleep_if_resumable: true,
            check_for_updates_automatically: true,
            install_updates_automatically: false,
            test_toggle: false,
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
    pub default_folder_mode: String,
    pub fixed_download_folder: String,
    pub show_save_as_button: bool,
    pub delete_button_action: String,
    pub file_exists_action: String,
    pub remove_deleted_files: bool,
    pub remove_completed_files: bool,
    pub bottom_panel_follows_selection: bool,
    pub show_tray_activity: bool,
    pub use_custom_sort_order: bool,
    pub skip_web_pages: bool,
    pub use_server_file_time: bool,
    pub mark_downloaded_files: bool,
    pub browser_intercept_downloads: bool,
    pub browser_start_without_confirmation: bool,
    pub browser_skip_domains: String,
    pub browser_skip_extensions: String,
    pub browser_capture_extensions: String,
    pub browser_minimum_size_mb: u64,
    pub browser_use_native_fallback: bool,
    pub browser_ignore_insert_key: bool,
    pub proxy_mode: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub proxy_username: String,
    pub proxy_password: String,
    pub notify_added: bool,
    pub notify_completed: bool,
    pub notify_failed: bool,
    pub notify_inactive_only: bool,
    pub play_sounds: bool,
    pub completion_hook_enabled: bool,
    pub completion_hook_path: String,
    pub completion_hook_arguments: String,
    pub avoid_sleep_with_active_downloads: bool,
    pub avoid_sleep_with_scheduled_downloads: bool,
    pub allow_sleep_if_resumable: bool,
    pub check_for_updates_automatically: bool,
    pub install_updates_automatically: bool,
    pub test_toggle: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdaterStatus {
    pub configured: bool,
    pub current_version: String,
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
