use std::{
    collections::{HashMap, HashSet},
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
use crate::models::{TorrentFileSelection, TorrentIntakeFile};

struct TorrentRuntime {
    runtime_id: String,
    torrent_id: usize,
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
        only_files: Option<Vec<usize>>,
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
                    only_files,
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
            torrent_id: handle.id(),
            source: source.to_string(),
            output_folder: output_folder.to_string_lossy().to_string(),
            handle,
        };

        let status = status_from_runtime(&runtime);
        self.runtimes.lock().await.insert(runtime_id, runtime);
        Ok(status)
    }

    pub async fn status(&self, runtime_id: &str) -> anyhow::Result<TorrentRuntimeStatus> {
        self.sync_runtimes(None).await?;
        let runtimes = self.runtimes.lock().await;
        let runtime = runtimes
            .get(runtime_id)
            .with_context(|| format!("torrent runtime {runtime_id} was not found"))?;
        Ok(status_from_runtime(runtime))
    }

    pub async fn list(&self, app: &AppHandle) -> anyhow::Result<Vec<TorrentRuntimeStatus>> {
        let default_output_folder = app
            .path()
            .download_dir()
            .or_else(|_| app.path().app_data_dir().map(|path| path.join("downloads")))
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let _ = self
            .ensure_session(app, default_output_folder.clone())
            .await?;
        self.sync_runtimes(Some(&default_output_folder)).await?;
        let runtimes = self.runtimes.lock().await;
        let mut items = runtimes.values().map(status_from_runtime).collect::<Vec<_>>();
        items.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        Ok(items)
    }

    pub async fn pause(&self, _app: &AppHandle, runtime_id: &str) -> anyhow::Result<TorrentRuntimeStatus> {
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
        Ok(status_from_runtime(runtime))
    }

    pub async fn resume(
        &self,
        _app: &AppHandle,
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
        Ok(status_from_runtime(runtime))
    }

    pub async fn remove(&self, runtime_id: &str, delete_files: bool) -> anyhow::Result<()> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .context("torrent session is not active")?;
        let torrent_id = self
            .runtimes
            .lock()
            .await
            .get(runtime_id)
            .with_context(|| format!("torrent runtime {runtime_id} was not found"))?
            .torrent_id;
        session
            .delete(torrent_id.into(), delete_files)
            .await
            .context("error removing torrent runtime")?;
        self.runtimes.lock().await.remove(runtime_id);
        Ok(())
    }

    pub async fn file_selection(&self, runtime_id: &str) -> anyhow::Result<TorrentFileSelection> {
        self.sync_runtimes(None).await?;
        let runtimes = self.runtimes.lock().await;
        let runtime = runtimes
            .get(runtime_id)
            .with_context(|| format!("torrent runtime {runtime_id} was not found"))?;
        file_selection_from_runtime(runtime)
    }

    pub async fn update_file_selection(
        &self,
        runtime_id: &str,
        only_files: &[usize],
    ) -> anyhow::Result<TorrentFileSelection> {
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
        session
            .update_only_files(&runtime.handle, &HashSet::from_iter(only_files.iter().copied()))
            .await?;
        file_selection_from_runtime(runtime)
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

    async fn sync_runtimes(&self, fallback_output_folder: Option<&PathBuf>) -> anyhow::Result<()> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .context("torrent session is not active")?;

        let known_output_folders = {
            let runtimes = self.runtimes.lock().await;
            runtimes
                .iter()
                .map(|(runtime_id, runtime)| (runtime_id.clone(), runtime.output_folder.clone()))
                .collect::<HashMap<_, _>>()
        };

        let discovered = session.with_torrents(|torrents| {
            torrents
                .map(|(_, handle)| TorrentRuntime {
                    runtime_id: handle.info_hash().as_string(),
                    torrent_id: handle.id(),
                    source: handle.info_hash().as_string(),
                    output_folder: known_output_folders
                        .get(&handle.info_hash().as_string())
                        .cloned()
                        .unwrap_or_else(|| {
                            fallback_output_folder
                                .map(|path| path.to_string_lossy().to_string())
                                .unwrap_or_default()
                        }),
                    handle: handle.clone(),
                })
                .collect::<Vec<_>>()
        });
        let discovered_ids = discovered
            .iter()
            .map(|runtime| runtime.runtime_id.clone())
            .collect::<HashSet<_>>();

        let mut runtimes = self.runtimes.lock().await;
        for runtime in discovered {
            runtimes
                .entry(runtime.runtime_id.clone())
                .or_insert(runtime);
        }
        runtimes.retain(|runtime_id, _| discovered_ids.contains(runtime_id));
        Ok(())
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

fn file_selection_from_runtime(runtime: &TorrentRuntime) -> anyhow::Result<TorrentFileSelection> {
    let selected = runtime.handle.only_files();
    let display_name = runtime
        .handle
        .name()
        .unwrap_or_else(|| "Torrent".to_string());
    let files = runtime
        .handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .map(|(index, file_info)| TorrentIntakeFile {
                    index,
                    name: file_info.relative_filename.to_string_lossy().replace('\\', "/"),
                    length: file_info.len,
                    selected: selected
                        .as_ref()
                        .map(|only_files| only_files.contains(&index))
                        .unwrap_or(true),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected_count = files.iter().filter(|file| file.selected).count();
    Ok(TorrentFileSelection {
        runtime_id: runtime.runtime_id.clone(),
        display_name,
        file_count: files.len(),
        selected_count,
        files,
    })
}
