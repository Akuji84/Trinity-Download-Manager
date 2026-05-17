use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
};

use anyhow::Context;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ManagedTorrent, Session, SessionOptions,
    SessionPersistenceConfig, TorrentStatsState,
};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use url::Url;

use crate::models::TorrentRuntimeStatus;

struct TorrentRuntime {
    runtime_id: String,
    source: String,
    output_folder: String,
    handle: Arc<ManagedTorrent>,
}

pub struct TorrentManager {
    session: Mutex<Option<Arc<Session>>>,
    runtimes: Mutex<HashMap<String, TorrentRuntime>>,
}

impl Default for TorrentManager {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
            runtimes: Mutex::new(HashMap::new()),
        }
    }
}

impl TorrentManager {
    pub async fn start(
        &self,
        app: &AppHandle,
        source: &str,
        output_folder: PathBuf,
    ) -> anyhow::Result<TorrentRuntimeStatus> {
        let session = self.ensure_session(app, output_folder.clone()).await?;
        let source = source.trim();
        let add = if source.to_ascii_lowercase().starts_with("magnet:?") {
            AddTorrent::from_url(source.to_string())
        } else if matches!(Url::parse(source), Ok(url) if matches!(url.scheme(), "http" | "https")) {
            AddTorrent::from_url(source.to_string())
        } else {
            AddTorrent::from_local_filename(source)
                .with_context(|| format!("error reading torrent source {source:?}"))?
        };

        let response = session
            .add_torrent(
                add,
                Some(AddTorrentOptions {
                    overwrite: true,
                    output_folder: Some(output_folder.to_string_lossy().to_string()),
                    ..Default::default()
                }),
            )
            .await
            .context("error starting torrent session")?;

        let handle = match response {
            AddTorrentResponse::Added(_, handle) | AddTorrentResponse::AlreadyManaged(_, handle) => {
                handle
            }
            AddTorrentResponse::ListOnly(_) => {
                anyhow::bail!("torrent runtime unexpectedly returned list-only metadata")
            }
        };

        let runtime_id = handle.info_hash().as_string();
        let runtime = TorrentRuntime {
            runtime_id: runtime_id.clone(),
            source: source.to_string(),
            output_folder: output_folder.to_string_lossy().to_string(),
            handle,
        };

        let status = status_from_runtime(&runtime);
        self.runtimes.lock().await.insert(runtime_id, runtime);
        Ok(status)
    }

    pub async fn status(&self, runtime_id: &str) -> anyhow::Result<TorrentRuntimeStatus> {
        let runtimes = self.runtimes.lock().await;
        let runtime = runtimes
            .get(runtime_id)
            .with_context(|| format!("torrent runtime {runtime_id} was not found"))?;
        Ok(status_from_runtime(runtime))
    }

    pub async fn pause(&self, app: &AppHandle, runtime_id: &str) -> anyhow::Result<TorrentRuntimeStatus> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .context("torrent session is not active")?;
        let runtimes = self.runtimes.lock().await;
        let runtime = runtimes
            .get(runtime_id)
            .with_context(|| format!("torrent runtime {runtime_id} was not found"))?;
        session.pause(&runtime.handle).await?;
        let _ = app;
        Ok(status_from_runtime(runtime))
    }

    pub async fn resume(
        &self,
        app: &AppHandle,
        runtime_id: &str,
    ) -> anyhow::Result<TorrentRuntimeStatus> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .context("torrent session is not active")?;
        let runtimes = self.runtimes.lock().await;
        let runtime = runtimes
            .get(runtime_id)
            .with_context(|| format!("torrent runtime {runtime_id} was not found"))?;
        session.unpause(&runtime.handle).await?;
        let _ = app;
        Ok(status_from_runtime(runtime))
    }

    async fn ensure_session(
        &self,
        app: &AppHandle,
        default_output_folder: PathBuf,
    ) -> anyhow::Result<Arc<Session>> {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_ref() {
            return Ok(session.clone());
        }

        let persistence_folder = app
            .path()
            .app_data_dir()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?
            .join("torrent-session");
        std::fs::create_dir_all(&persistence_folder)?;

        let session = Session::new_with_opts(
            default_output_folder,
            SessionOptions {
                fastresume: true,
                persistence: Some(SessionPersistenceConfig::Json {
                    folder: Some(persistence_folder),
                }),
                ..Default::default()
            },
        )
        .await?;

        *guard = Some(session.clone());
        Ok(session)
    }
}

fn status_from_runtime(runtime: &TorrentRuntime) -> TorrentRuntimeStatus {
    let stats = runtime.handle.stats();
    let file_count = runtime
        .handle
        .with_metadata(|metadata| metadata.file_infos.len())
        .unwrap_or(0);
    let display_name = runtime
        .handle
        .name()
        .unwrap_or_else(|| "Torrent".to_string());
    let download_speed_bps = stats
        .live
        .as_ref()
        .map(|live| (live.download_speed.mbps * 1024.0 * 1024.0).round() as u64)
        .unwrap_or(0);
    let upload_speed_bps = stats
        .live
        .as_ref()
        .map(|live| (live.upload_speed.mbps * 1024.0 * 1024.0).round() as u64)
        .unwrap_or(0);
    let eta_seconds = if download_speed_bps > 0 && stats.progress_bytes < stats.total_bytes {
        Some((stats.total_bytes - stats.progress_bytes).div_ceil(download_speed_bps))
    } else {
        None
    };
    let state = match stats.state {
        TorrentStatsState::Initializing => "Initializing",
        TorrentStatsState::Live if stats.finished => "Seeding",
        TorrentStatsState::Live => "Downloading",
        TorrentStatsState::Paused if stats.finished => "Completed",
        TorrentStatsState::Paused => "Paused",
        TorrentStatsState::Error => "Failed",
    };

    TorrentRuntimeStatus {
        id: runtime.runtime_id.clone(),
        source: runtime.source.clone(),
        display_name,
        info_hash: runtime.handle.info_hash().as_string(),
        output_folder: runtime.output_folder.clone(),
        state: state.to_string(),
        total_bytes: stats.total_bytes,
        downloaded_bytes: stats.progress_bytes,
        uploaded_bytes: stats.uploaded_bytes,
        download_speed_bps,
        upload_speed_bps,
        eta_seconds,
        file_count,
        finished: stats.finished,
        is_paused: runtime.handle.is_paused(),
        error_message: stats.error,
    }
}
