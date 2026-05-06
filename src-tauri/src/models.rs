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

#[derive(Debug, Clone, Serialize)]
pub struct AppSettings {
    pub max_concurrent_downloads: usize,
    pub retry_enabled: bool,
    pub retry_attempts: u32,
    pub retry_delay_seconds: u64,
    pub default_download_speed_limit_kbps: u64,
    pub bandwidth_schedule_enabled: bool,
    pub bandwidth_schedule_start: String,
    pub bandwidth_schedule_end: String,
    pub bandwidth_schedule_limit_kbps: u64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            max_concurrent_downloads: 3,
            retry_enabled: true,
            retry_attempts: 3,
            retry_delay_seconds: 5,
            default_download_speed_limit_kbps: 0,
            bandwidth_schedule_enabled: false,
            bandwidth_schedule_start: "22:00".to_string(),
            bandwidth_schedule_end: "06:00".to_string(),
            bandwidth_schedule_limit_kbps: 512,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateAppSettingsRequest {
    pub max_concurrent_downloads: usize,
    pub retry_enabled: bool,
    pub retry_attempts: u32,
    pub retry_delay_seconds: u64,
    pub default_download_speed_limit_kbps: u64,
    pub bandwidth_schedule_enabled: bool,
    pub bandwidth_schedule_start: String,
    pub bandwidth_schedule_end: String,
    pub bandwidth_schedule_limit_kbps: u64,
}
