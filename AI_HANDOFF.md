# Trinity Download Manager AI Handoff

## Product Goal

Build Trinity Download Manager into a professional desktop download manager comparable to tools like Free Download Manager, with a long-term goal of being reliable enough for thousands of users.

The product should prioritize a dependable download engine, responsive UI, recoverable state, safe updates, and a scalable architecture that can support advanced integrations over time.

## Core Principles

- Keep the download engine independent from the UI.
- Persist enough state to recover safely after app restarts or crashes.
- Treat download correctness, retries, resume behavior, and file integrity as core product features.
- Add advanced features only after the base engine and app workflow are stable.
- Favor maintainable architecture over quick one-off features.

## Stack Decision

Selected stack:

- Tauri 2.
- Rust backend.
- React frontend.
- TypeScript.
- Vite.
- SQLite for local durable state.

Reasoning:

- Rust is a strong fit for a reliable download engine, filesystem work, concurrency, and long-running background tasks.
- Tauri keeps the desktop app lighter than Electron.
- React and TypeScript provide a productive UI layer with strong typing.
- SQLite is appropriate for local download state, history, settings, and recovery metadata.

## Target Capabilities

- HTTP and HTTPS downloads.
- Fast multi-connection segmented downloads.
- Pause, resume, retry, and cancel.
- Broken download recovery.
- Queue management.
- Bandwidth limits.
- Scheduling.
- Categories.
- Browser integration.
- System tray and notifications.
- Settings, history, and logs.
- Crash recovery.
- Safe release and update process.
- Torrent and magnet support later.
- Video or site download support later, if desired.

## Proposed Architecture

### Download Engine

Handles the actual file transfer behavior.

Responsibilities:

- HTTP/HTTPS transfer.
- Segmented downloads.
- Range request support.
- Pause and resume.
- Retry policies.
- Checksum validation where available.
- Temporary file and part-file management.
- Merging file parts.
- Speed and progress calculation.
- Error classification.

Current location:

- `src-tauri/src/download_engine.rs`

### Task Manager

Controls download jobs and scheduling.

Responsibilities:

- Queue order.
- Maximum simultaneous downloads.
- Priority.
- Scheduling.
- Retry rules.
- State transitions such as queued, running, paused, failed, and completed.
- Persistence after restart.

Current location:

- `src-tauri/src/task_manager.rs`

### Storage Layer

Persists app data and recovery state.

Preferred default:

- SQLite for local app state.

Stores:

- Downloads.
- URLs.
- Output paths.
- Progress.
- Segment metadata.
- App settings.
- History.
- Error and diagnostic logs.

Current location:

- `src-tauri/src/storage.rs`

### Shared Models

Defines backend data contracts and command return types.

Current location:

- `src-tauri/src/models.rs`

### Desktop UI

Provides the primary user workflow.

Expected screens:

- Active downloads.
- Completed downloads.
- Failed downloads.
- Queue.
- Download detail panel.
- Add-download dialog.
- Settings.

Current location:

- `src/App.tsx`
- `src/App.css`

### Integration Layer

Added after the core is stable.

Potential integrations:

- Browser extension.
- Clipboard URL detection.
- System tray.
- Notifications.
- File associations.
- Magnet and torrent handling.
- Local API for browser extensions or companion tools.

## Development Phases

### Phase 1: Professional Foundation

Goal: establish the project structure and base app architecture.

Planned work:

- Choose the application stack.
- Create stable project layout.
- Add strong typing.
- Add logging.
- Add configuration handling.
- Add SQLite storage.
- Define download job models.
- Build the base UI shell.

Exit criteria:

- App starts locally.
- Basic navigation or layout exists.
- Project has clear modules for UI, download engine, storage, and shared types.
- Handoff and progress log are up to date.

Status:

- In progress.

### Phase 2: Basic Download Manager

Goal: make the first usable download manager.

Planned work:

- Add URL input.
- Download a file.
- Show progress.
- Cancel downloads.
- Save completed download history.
- Choose output folder.
- Open downloaded file or folder.
- Add basic retry handling.

Exit criteria:

- User can add a URL and download a file through the app.
- Download state survives app restart at a basic level.

### Phase 3: Real Download Engine

Goal: make downloading robust enough to compete with mature tools.

Planned work:

- Segmented downloads.
- Resume with HTTP range requests.
- Crash recovery.
- Per-download speed tracking.
- Global speed tracking.
- Bandwidth limits.
- Queue limits.
- File integrity checks.
- More precise error states.

Exit criteria:

- Interrupted downloads can resume when the server supports it.
- Large downloads do not freeze the UI.
- Multiple concurrent downloads remain stable.

### Phase 4: Product-Level Desktop App

Goal: add expected desktop product features.

Planned work:

- System tray.
- Notifications.
- Dark and light theme.
- Download categories.
- Batch URL import.
- Duplicate URL detection.
- Drag and drop.
- Clipboard monitor.
- Scheduler.
- Settings backup/export.

Exit criteria:

- App feels usable as a daily download manager.
- Common workflows are fast and discoverable.

### Phase 5: Browser Extension

Goal: let browsers send downloads to Trinity.

Planned work:

- Chrome/Edge extension.
- Firefox extension later.
- Native/local bridge or local API.
- Intercept downloads.
- Send URLs to Trinity.
- Right-click "Download with Trinity" action.
- Optional media link detection.

Exit criteria:

- Browser can hand off selected downloads to the desktop app.

### Phase 6: Advanced Features

Goal: expand after the foundation is stable.

Possible work:

- Torrent and magnet support.
- Video platform support.
- Remote download API.
- Plugin system.
- Optional account/cloud features.
- Optional mobile companion.

Exit criteria:

- Advanced features do not destabilize the core download workflow.

## Progress Log

### 2026-05-05

- Selected Tauri 2, Rust, React, TypeScript, Vite, and SQLite as the foundation stack.
- Scaffolded the desktop app with `create-tauri-app`.
- Installed npm dependencies with `npm install`.
- Renamed package/product metadata from the generic Tauri starter to Trinity Download Manager.
- Replaced the starter UI with a Trinity download manager shell showing navigation, summary counters, empty download state, and backend status.
- Added Rust module skeletons:
  - `src-tauri/src/download_engine.rs`
  - `src-tauri/src/task_manager.rs`
  - `src-tauri/src/storage.rs`
  - `src-tauri/src/models.rs`
- Added a Tauri command named `app_status` so the frontend can confirm the backend module surface is reachable.
- Added a first SQLite migration shape in the storage module for future download persistence.
- Updated the README with Trinity-specific development commands.
- Verified `npm run build` passes.
- Attempted `cargo check`; the first run failed because the C: drive ran out of disk space while compiling dependencies.
- Removed the partial generated `src-tauri/target` build directory after the disk-space failure.
- Reran `cargo check` after space was restored and fixed the generated `main.rs` library reference from the old scaffold name to `trinity_download_manager_lib`.
- Verified `cargo check` passes.
- Ran `cargo fmt`.
- Ran `npm run tauri dev`; the Tauri desktop app compiled and launched successfully.
- Added durable SQLite-backed download job storage at the app data path.
- Added backend commands:
  - `create_download_job`
  - `list_download_jobs`
  - `delete_download_job`
- Added URL validation for HTTP and HTTPS job creation.
- Added filename derivation and basic Windows-safe filename sanitization.
- Added an Add Download dialog in the UI.
- Updated the downloads table to render persisted jobs instead of placeholder empty content.
- Updated summary counters to reflect persisted queued, active, and completed jobs.
- Verified the updated app with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Added the first single-stream download engine path.
- Added backend command `start_download_job`.
- Added HTTP streaming with `reqwest`, async file writes with `tokio`, and progress streaming from network chunks into SQLite.
- Downloads now write to a `.trinitydownload` temporary file and rename to the final output path after success.
- Started jobs move from queued/failed to running, then completed or failed.
- The UI now has a Start button for queued/failed jobs and polls while jobs are running.
- Progress display now shows downloaded bytes and percentage when total size is known.
- Verified the downloader build with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Added per-job `speed_bps` and `error_message` fields to the SQLite-backed job model.
- Added backward-compatible SQLite migration logic for new job columns.
- Added active download cancellation tracking with in-memory atomic cancellation flags.
- Added backend command `cancel_download_job`.
- Running jobs now show a Cancel action in the UI.
- Failed and canceled jobs now store and display visible messages.
- Per-job and global speed now render from backend progress updates.
- Canceled downloads remove their temporary `.trinitydownload` file and move to the `Canceled` state.
- Verified cancellation/error/speed build path with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Fixed server-generated download names like `latest` by resolving filenames from `Content-Disposition` first, then the final redirected URL, then a safe fallback.
- Added unique output naming so existing files no longer cause an immediate failure.
- Verified the filename-resolution fix with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Added pause/resume groundwork.
- Added persisted `is_resumable` metadata and SQLite migration support.
- Added backend command `pause_download_job`.
- Running jobs now expose Pause separately from Cancel.
- Pause keeps the `.trinitydownload` partial file and moves the job to `Paused`.
- Starting a paused resumable job now resumes from the existing temp file size using an HTTP `Range` request.
- If a server ignores a resume request, the engine restarts cleanly from byte zero.
- UI rows now show whether resume is currently supported or unknown.
- Verified pause/resume groundwork with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Restyled the desktop UI toward a classic download manager layout inspired by Free Download Manager and Internet Download Manager.
- Replaced the previous card/sidebar layout with a dark title bar, command toolbar, filter tabs, category tree, dense download table, progress strips, and bottom transfer status bar.
- Preserved the existing Add URL, Start, Pause, Cancel, Delete, speed, progress, and resumable-state functionality in the new layout.
- Verified the UI restyle with `npm run build`, `cargo check`, and `npm run tauri dev`.
- Added `lucide-react` and replaced placeholder toolbar labels with real vector icons for Add URL, Resume, Stop, Stop All, Delete, Options, Open, and Refresh.
- Verified the icon update with `npm run build` and `cargo check`.
- Added table row selection with checkbox controls and selected-row highlighting.
- Wired top toolbar actions to selected jobs:
  - Resume starts selected queued/paused/failed/canceled jobs.
  - Stop pauses selected running jobs.
  - Stop All pauses all running jobs.
  - Delete removes selected non-running jobs.
- Verified toolbar selection behavior build path with `npm run build`, `cargo check`, and `npm run tauri dev`.
- Added backend queue manager pump with a fixed `MAX_CONCURRENT_DOWNLOADS` limit of 3.
- New queued jobs auto-start while queue capacity is available.
- When a running job completes, fails, pauses, or cancels, the queue automatically starts the next queued job if the queue is running.
- `start_download_job` now queues/resumes a job and lets the queue manager decide when it can run.
- Added backend `stop_queue` command; Stop All now pauses active downloads and prevents queued jobs from auto-starting until a job is resumed again.
- Verified queue manager build/runtime path with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Added persisted app settings in SQLite.
- Added backend commands `get_app_settings` and `update_app_settings`.
- Moved the queue concurrency limit out of a hard-coded constant and into persisted `max_concurrent_downloads`.
- Wired the Options toolbar button to a settings modal for maximum simultaneous downloads.
- Saving the setting immediately pumps the queue so newly available capacity can start queued jobs.
- Verified configurable queue settings with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Added automatic retry policy for engine failures.
- Added persisted retry metadata on downloads:
  - `retry_count`
  - `next_retry_at`
- Failed engine attempts now retry up to 3 times with a 5 second delay.
- Retry scheduling keeps the job queued until its retry time is due, while allowing other ready queued jobs to continue.
- User pause/cancel does not trigger retry.
- UI now shows retry count and next retry time in the download table.
- Verified retry policy with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Restyled the Add Download modal to match the compact IDM-style "New download" dialog.
- Changed the manual Add Download flow to show `URL` instead of a filename field.
- Kept filename handling in the backend download engine, where filenames are resolved from `Content-Disposition`, redirected URL, or fallback naming.
- Added visual-only scheduler controls in the Add Download modal as groundwork for a later scheduler implementation.
- Verified the Add Download modal update with `npm run build` and `cargo check`.
- Added real icon controls to the Add Download modal for close, default folder, browse folder, and schedule time fields.
- Added `@tauri-apps/plugin-dialog` and `tauri-plugin-dialog` so the browse button opens a native folder picker.
- Added backend command `get_default_download_folder`; the dropdown button now fills the Save to field with the OS Downloads folder.
- Added backend command `inspect_download_url`; typing a valid HTTP/HTTPS URL now checks server metadata and updates the dialog size label when `Content-Length` or `Content-Range` is available.
- Added persisted scheduler metadata on downloads:
  - `scheduler_enabled`
  - `schedule_days`
  - `schedule_from`
  - `schedule_to`
- Wired queue selection to skip scheduled jobs until their selected local day and time window is active.
- Verified scheduler and metadata work with `npm run build`, `cargo fmt`, `cargo check`, and `npm run tauri dev`.
- Added scheduled-download visibility in the main table.
- Queued jobs outside their schedule window now render as `Scheduled` instead of a plain queued state.
- Scheduled rows now show:
  - the configured days and time window
  - `Waiting for schedule window`
  - the next eligible local start time when it can be computed
- Added a lightweight 30 second UI clock refresh so scheduled status text stays current while the app is open.
- Verified scheduler table visibility with `npm run build` and `cargo check`.
- Replaced the old Options modal with a full Preferences page.
- Added a dedicated Preferences layout with:
  - left navigation
  - section-based scrolling
  - save and close actions
  - persistent bottom status bar continuity with the main app shell
- Added broad placeholder coverage for:
  - General
  - Browser Integration
  - Network
  - Traffic Limits
  - Antivirus
  - Distributed Engine
  - Remote Access
  - Advanced
- Kept `max simultaneous downloads` wired to the real persisted backend setting.
- Added save-status messaging that makes clear which settings are live today versus placeholder-only.
- Avoided BitTorrent branding and instead introduced a Trinity-native `Distributed Engine` section for future peer distribution work.
- Verified the full Preferences page with `npm run build`, `cargo check`, and `npm run tauri dev`.
- Extended persisted app settings with live retry controls:
  - `retry_enabled`
  - `retry_attempts`
  - `retry_delay_seconds`
- Wired the Preferences page retry controls to the backend settings model and SQLite storage.
- The download engine now uses persisted retry settings instead of hard-coded constants.
- Automatic retry can now be disabled entirely, and failure messaging changes accordingly.
- Added a retry-policy detail line to each download row so the active policy is visible in the main table.
- Verified persisted retry settings with `npm run build` and `cargo check`.
- Added persisted queue metadata on downloads:
  - `queue_position`
  - `priority`
- Queue selection now prefers higher priority first, then queue order.
- Added backend commands:
  - `move_download_job_up`
  - `move_download_job_down`
  - `update_download_priority`
- Added toolbar controls for:
  - Queue Up
  - Queue Down
  - High priority
  - Normal priority
  - Low priority
- Added queue detail text to download rows so resumable queued jobs now show their effective priority and queue slot.
- Verified queue ordering and priority controls with `npm run build`, `cargo check`, and `npm run tauri dev`.
- Added persisted bandwidth settings:
  - `default_download_speed_limit_kbps`
  - `bandwidth_schedule_enabled`
  - `bandwidth_schedule_start`
  - `bandwidth_schedule_end`
  - `bandwidth_schedule_limit_kbps`
- Added persisted per-download speed limit metadata on jobs:
  - `speed_limit_kbps`
- New downloads inherit the current default per-download speed limit from app settings.
- Running downloads now throttle in the Rust engine using the effective minimum of:
  - the job-specific speed limit
  - the active scheduled bandwidth cap
- Added toolbar controls to set selected job speed limits to:
  - unlimited
  - `512 KB/s`
  - `2 MB/s`
- Added row detail text to show each job's current speed limit policy and any active scheduled bandwidth cap.
- Wired the Preferences traffic settings to the backend so default and scheduled bandwidth controls are now live.
- Verified bandwidth scheduling and per-download limits with `npm run build`, `cargo check`, and `npm run tauri dev`.
- Added backend drag-drop queue reordering with a new `reorder_download_job` command.
- Drag-drop reordering is currently constrained to queue-manageable jobs inside the same priority bucket, so it stays consistent with the existing priority-first scheduler.
- Added live main-list filters:
  - top tab filters now actually change the table contents
  - category sidebar filters now actually change the table contents
  - search box across file name, URL, and output folder
  - queue-only / scheduled-only scope filter
  - priority filter
- Added a drag handle to queue-manageable rows and visual drop-target feedback in the table.
- Select-all now respects only the currently visible filtered rows instead of the whole dataset.
- Verified drag-drop queue reordering and richer filters with `npm run build` and `cargo check`.
- Manager-side Delete now removes the actual file from disk when it exists, removes any `.trinitydownload` partial sidecar, and then removes the job from SQLite.
- Completed jobs whose final files were deleted outside Trinity are now pruned automatically on job refresh so they disappear from the UI.
- Removed the extra per-row speed-limit and retry-policy text from the main download list to keep row details tighter.
- Added backend filesystem watching for directories containing completed downloads.
- When Windows reports a completed file being removed or renamed, Trinity now prunes that job immediately and emits a UI refresh event so the row disappears without manual refresh.
- Removed the three direct toolbar speed-limit buttons (`Unlimit`, `512 KB/s`, `2 MB/s`) to reduce command-bar clutter.
- Updated toolbar button text styling so short labels such as `Queue Up` and `Queue Down` stay on a single line.
- Removed the footer's bottom-left `Engine` and `Storage` status text, leaving only the live transfer totals.
- Added persisted segmented-download groundwork:
  - `connection_count` on each download job
  - `default_connection_count` in app settings
- Wired `Default segmented connections` in Preferences to live backend settings for new downloads.
- The Rust download engine now:
  - probes range support with a lightweight `bytes=0-0` request
  - plans byte ranges for fresh downloads when the server supports ranges
  - downloads segment parts concurrently
  - merges part files into the final `.trinitydownload` temp file before rename
  - falls back to the existing single-stream path when range support is missing, the file is too small, the requested connection count is `1`, or the job is a resume case
- Added segmented resume persistence:
  - a `.segments.json` manifest is written alongside segmented temp files
  - each segment persists its completed byte count and part-file path
  - paused, retried, or restarted segmented jobs can resume from saved segment progress
  - running jobs are converted to `Paused` during app startup recovery so interrupted segmented jobs can be resumed after restart
- Added adaptive segmented scheduling:
  - the engine now plans more persisted chunks than active connections
  - a worker pool equal to the active connection count consumes those chunks dynamically
  - faster connections finish chunks and immediately pick up more work instead of being stuck with one fixed byte range
- Added host-aware transfer tuning:
  - a persisted `host_profiles` table now records a recommended connection count per hostname
  - new downloads look up the hostname and inherit that learned recommendation instead of always using the global default
  - successful completions feed average observed throughput back into the host profile
  - final failures back off the host's recommended connection count conservatively
- Delete cleanup now removes segmented manifests and part files in addition to the final file/temp file.
- Reworked segmented storage layout so the user download folder no longer fills with visible `partN` files:
  - segmented downloads now write into one `.trinitydownload` temp payload beside the target file
  - the segmented resume manifest is stored in Trinity app data under `segment-manifests/`
  - no visible per-segment payload files are created in the destination folder anymore
- Paused downloads no longer store or render the old `Partial file kept for resume` message in the main list.
- Added file-type icons to the download name cell so common extensions such as executables, archives, media, documents, images, and folder-like entries are visually distinguishable in the main list.
- Replaced the generic row icon mapping with Windows shell icon lookup so download rows can use Explorer-style file associations, and completed executables can render their real embedded app icon.
- Moved the Windows shell icon into the leftmost row cell and removed the extra per-row gray checkbox square so each download row shows only one icon marker.
- Removed the visible row drag handle from the filename line so the Explorer icon sits directly next to the filename without the extra gray marker.
- Added the first browser-extension integration step:
  - created the `browser-extension/chrome/` workspace folder in the repo
  - started a local Trinity bridge on `http://127.0.0.1:38491`
  - added `GET /app/ping` for extension app detection
  - added `POST /downloads/create` for extension handoff
  - wired the frontend to open the Add Download dialog when the bridge receives an extension request
- Added the first Chrome MV3 extension files in `browser-extension/chrome/`:
  - `manifest.json` with the initial Chromium permissions and localhost host permission
  - `background.js` service worker with toolbar action, right-click menu items, bridge ping, and POST handoff to Trinity
  - toolbar badge feedback for invalid URLs, bridge unavailable, success, and handoff failure states
- Added the first extension popup menu and app-launch fallback:
  - clicking the extension now opens a menu-style popup instead of sending immediately
  - the popup asks the background worker to find Trinity through the localhost bridge
  - if the bridge is down, the popup now auto-attempts the `trinity://launch` protocol from inside the popup without opening a browser tab
  - the app now registers the `trinity://` deep-link scheme through Tauri
  - the popup includes pause capture, per-site exclusion, options, and help/feedback entries
- Added the new Trinity logo into the repo under `assets/branding/trinity-logo-source.png` and generated icon sizes from it for:
  - the Windows app bundle files in `src-tauri/icons/`
  - the Chrome extension icons in `browser-extension/chrome/icons/`
- Removed the baked light background from the Trinity logo source with a border-connected alpha cut and regenerated the app/extension icon outputs so the icon corners are actually transparent.
- Per user feedback, also cut the three enclosed circular interior regions to transparent alpha and regenerated the app/extension icon outputs from that hollowed source.
- Replaced the prior Trinity emblem source with the new user-provided branding image, renamed it to `assets/branding/trinity-logo-source.png`, and regenerated all Windows app and Chrome extension icon outputs from that new source.
- Per user feedback, the Chrome extension was switched back to dedicated icon files and those extension icons were regenerated from a tighter square crop of the base logo source so they read larger and more naturally in Chrome's toolbar and extension surfaces.
- Added first-pass Chrome automatic download interception:
  - requested the `downloads` permission in the extension manifest
  - listens for created Chrome downloads
  - respects the popup's pause-capture and site-exclusion settings
  - only auto-captures when Trinity's localhost bridge is already reachable
  - sends the browser download to Trinity, then cancels and erases the Chrome-side duplicate
- Current segmented implementation is still conservative:
  - segmented jobs rebalance naturally through the chunk queue, but live splitting/merging of in-flight chunks is not implemented yet
  - segmented part state is persisted on a short interval, so an abrupt kill may lose only the most recent in-flight chunk progress instead of the whole job
  - segmented range support still depends on the source actually honoring HTTP byte-range requests
  - learned host tuning exists only in the backend for now; there is not yet a Preferences or diagnostics UI for inspecting/editing host profiles

## Current Verification Status

- Frontend TypeScript and Vite build: passing.
- Rust `cargo check`: passing.
- Tauri dev launch: passing.

## Current Engine Limitations

- Downloads are single-stream only.
- Segmented downloads, segmented resume, adaptive chunk-pool scheduling, and basic host-aware connection tuning now exist for range-capable sources, but in-flight chunk splitting/merging and a visible host-tuning UI are not implemented yet.
- Retry is configurable globally, but there is not yet per-download retry override support.
- Queue ordering, priority, drag-drop reorder, and filterable queue views exist, but there is not yet multi-select drag reorder or saved custom views.
- Global bandwidth scheduling and per-download limits are implemented, but there is not yet a visual calendar/profile editor or separate upload shaping.
- Pause/resume currently works for single-stream downloads only when the server accepts byte ranges.
- Scheduler controls are persisted, respected by queue start rules, and visible in the table, but the backend does not yet publish a formal computed `next_start_at` field.
- Most Preferences sections are still frontend placeholders and are not yet persisted to SQLite.
- Running jobs cannot be deleted from the UI.
- Cancellation is cooperative and is checked between received network chunks.

## Next Step

Load the unpacked Chrome extension and verify the automatic interception flow against a running installed Trinity build, then add per-file-type and per-size capture rules so the browser side feels more controllable.
