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
- Added pre-click Chrome capture for likely download links/buttons:
  - a new `content.js` runs on pages and captures likely download clicks before Chrome starts its own save/download flow
  - likely download candidates are detected from anchor `download` attributes and download/install/setup-style text or URLs
  - the content script asks the background worker to hand the URL to Trinity first and only falls back to the browser if Trinity capture is unavailable
  - recent pre-captured URLs are tracked so any later `chrome.downloads.onCreated` duplicate can be canceled and erased immediately
- Added page-context capture hooks for JS-triggered downloads:
  - `page-hook.js` is injected into the page world so site JavaScript calls to `window.open(...)`, programmatic anchor clicks, and `location.assign/replace(...)` can be intercepted before Chrome starts its own download UI
  - the page hook relays likely download URLs to the content script, which asks the background worker to hand them to Trinity first
  - browser fallback is preserved if Trinity capture is unavailable or rejected
  - the fallback path is now biased against Chrome duplicates: page-hook capture waits longer and defaults to suppressing Chrome if the handoff result is merely delayed instead of explicitly rejected
- Added explicit browser fallback control in the extension:
  - browser fallback when Trinity is unavailable is now fixed as the default policy instead of a user-editable browser-side setting
  - the browser extension options page was removed
  - the popup `Options` action now targets Trinity's own Preferences through the localhost bridge instead of opening a browser page
  - the bridge now exposes `/app/open-options`, which focuses the main window and opens Trinity Preferences
- Wired Trinity's Browser Integration preferences into the actual extension capture pipeline:
  - app settings now persist browser capture fields in SQLite and return them through Tauri `get_app_settings` / `update_app_settings`
  - the localhost bridge now exposes `GET /app/browser-settings`
  - the Chrome extension now fetches those settings from Trinity and enforces intercept enabled/disabled, skip domains, skip extensions, capture extensions, minimum known size, fixed native fallback, and INSERT-key bypass
  - the popup `Options` action still routes into Trinity Preferences, but the extension-side dead browser options code path was removed
  - extension-triggered downloads now honor `Start downloading without confirmation` by creating the job directly instead of always opening the Add Download dialog
- Preserved extension-provided suggested filenames end to end:
  - `create_download_job` now accepts an optional `suggested_file_name`
  - silent extension captures pass the browser-provided filename directly into backend job creation
  - extension-launched Add Download flows keep that suggested filename attached until the user confirms, unless they manually edit the URL
  - manual Add URL opens clear any extension-provided filename state so normal URL-derived naming stays untouched
- Fixed the extension popup `Options` flow so it reliably opens Trinity Preferences:
  - the popup now tries the real `open-trinity-options` request first instead of depending on a separate bridge-status precheck
  - if that first request fails, the popup launches the app via `trinity://launch`, waits for the bridge to come up, then retries
  - the app-side `/app/open-options` bridge handler now shows/unminimizes/focuses the main window before emitting the Preferences-open event
  - this is meant to cover the minimized and tray-hidden cases where the process is alive but the earlier popup flow still fell into `Could not open Preferences`
- Added single-instance app routing for protocol launches:
  - Trinity now uses `tauri-plugin-single-instance`
  - if `trinity://launch` is triggered while Trinity is already running, the existing app instance is focused instead of spawning a second window/process
  - the bridge-triggered `open-options` and `downloads/create` paths now share the same main-window focus helper
  - this is the fix for the user-reported case where clicking extension `Options` opened a new Trinity window instead of using the already-running one
- Updated the browser capture path to wake Trinity and retry before falling back to Chrome:
  - if click/page capture cannot reach Trinity through the bridge, the content script now launches `trinity://launch`, waits for the bridge to come up, then retries the same capture request
  - only after that retry fails does the extension allow the browser's native download/save flow to continue
  - this is the fix for the regression where reinstalling the app/extension caused Chrome `Save As` to win immediately instead of Trinity taking over
- Hardened extension/browser-settings compatibility:
  - if the bridge is alive but `/app/browser-settings` returns `404`, the extension now treats that as an older Trinity build and falls back to default browser settings
  - that `404` no longer marks the bridge as dead or blocks capture
- Restored the extension capture path to the last known-good implementation from before the later browser-settings / retry layering:
  - `browser-extension/chrome/background.js`
  - `browser-extension/chrome/content.js`
  - `browser-extension/chrome/page-hook.js`
  were reset to the working capture behavior used around commit `fb58d46`
  - this intentionally backs out the newer capture experiments after they failed to stop Chrome's duplicate `Save As` flow reliably
  - popup `Options -> Trinity Preferences` remains on the newer app-Preferences path
- Hardened content-script bridge calls against extension reload/invalidation:
  - `content.js` now checks that the extension runtime context is still valid before calling `chrome.runtime.sendMessage(...)`
  - message sends are wrapped so an invalidated extension context falls back cleanly instead of throwing an uncaught page error
  - the top-level click interception and page-capture event handlers are now wrapped in `try/catch` as well, because some invalidated-extension failures can occur before the inner message helper gets control
- Rebuilt the full icon set from the new square branding asset:
  - added `scripts/regenerate_icons.py` to regenerate app and extension icons consistently from `assets/branding/trinity-logo-square.png`
  - refreshed `assets/branding/trinity-logo-source.png` from that square asset
  - regenerated Tauri Windows/macOS/iOS/Android icon outputs under `src-tauri/icons/`
  - regenerated Chrome extension icon outputs under `browser-extension/chrome/icons/`
- Simplified the NSIS desktop shortcut icon fix:
  - the installer now ships a dedicated `trinity-shortcut.ico` into `$INSTDIR`
  - desktop shortcuts are recreated during the install section against that installed `.ico`
  - the Finish-page desktop shortcut flow is suppressed because it was replacing the working shortcut with the wrong icon on this machine
  - the old `.lnk` LinkFlags patching path was removed because the shortcut no longer depends on Explorer extracting the exe icon
- Extended the NSIS shortcut-icon fix to the Start menu/search entry:
  - the NSIS postinstall hook now recreates both the desktop shortcut and the Start menu shortcut with the same installed `trinity-shortcut.ico`
  - both shortcuts now get the same AppUserModelId handling and shell refresh notification
  - this is meant to align the wrong desktop/search shortcut icons with the already-correct tray and installer icons
- Fixed the remaining shortcut icon source mismatch:
  - the NSIS postinstall hook had still been copying `src-tauri/icons/icon.ico` into `$INSTDIR\\trinity-shortcut.ico`
  - that meant the desktop and Start menu shortcuts were still using the tighter main app icon instead of the padded shortcut-specific icon
  - the hook now ships `src-tauri/icons/shortcut-icon.ico` directly, so shortcut rendering uses the padded icon path that was generated for Windows desktop/search sizes
- Fixed tray right-click behavior:
  - the tray icon click handler had been treating any click as a restore/focus action, which could interfere with the context menu behavior
  - the tray now only restores on left-click / left double-click
  - the tray menu action is now labeled `Close Trinity` and exits the app fully from the tray menu
- Current segmented implementation is still conservative:
  - segmented jobs rebalance naturally through the chunk queue, but live splitting/merging of in-flight chunks is not implemented yet
  - segmented part state is persisted on a short interval, so an abrupt kill may lose only the most recent in-flight chunk progress instead of the whole job
  - segmented range support still depends on the source actually honoring HTTP byte-range requests
  - learned host tuning exists only in the backend for now; there is not yet a Preferences or diagnostics UI for inspecting/editing host profiles
- Fixed extension Options button so it reliably opens Trinity Preferences:
  - the popup now tries `open-trinity-options` first, then launches via `trinity://launch`, waits for the bridge, and retries
  - the Rust `/app/open-options` bridge handler focuses/unminimizes the main window then emits an `extension-open-options` event
  - the React frontend added a `listen("extension-open-options", ...)` useEffect that sets `isSettingsOpen(true)`
- Added smooth settings slide animation:
  - both the downloads panel and settings panel are always in the DOM (`position: absolute; inset: 0` inside an `overflow: hidden` view-slot)
  - settings panel slides in from the right with `transform: translateX(100%)` → `translateX(0)` (320ms spring curve)
  - fixed a z-index stacking bug where the modal was hidden behind view panels; `.modal-backdrop` now uses `z-index: 200`
- Added modal open/close animations and new-row entrance animation:
  - `backdrop-in/out` and `modal-in/out` keyframes animate the add-download dialog
  - `isAddAnimatingOut` state keeps the modal mounted for 220ms after close to let the exit animation play
  - `job-row-in` keyframe slides new rows in from the left with a blue left-border accent; `newestJobId` state drives the trigger
- Added tray right-click context menu:
  - right-click shows "Open Trinity" / separator / "Close Trinity"
  - "Close Trinity" calls `app.exit(0)` for a full exit
  - left-click only (`MouseButton::Left + MouseButtonState::Up`) focuses the main window
- Added 8 UI micro-animations:
  - row delete: `job-row-out` keyframe (slide left + fade, 260ms); `deletingJobIds: Set<string>` delays the actual invoke by 280ms
  - state pill transitions: `transition: background 220ms, border-color 220ms, color 220ms` on `.state-pill`
  - progress bar shimmer: `shimmer` keyframe sweeps a lighter highlight across the fill bar while `job.state === "Running"`
  - tab switch fade: `key={activeTab}` on `.download-list` forces remount on tab change; `tab-list-in` keyframe (180ms)
  - empty state entrance: `empty-state-in` keyframe fires on mount (320ms)
  - button press feedback: `.tool-button:active, .icon-button:active { transform: scale(0.95) }`
  - bottom bar speed counter: `font-variant-numeric: tabular-nums` prevents layout shift as digits change
  - form error slide-in: `form-error-in` keyframe (fade down from -5px, 180ms)
- Removed Resume column from download table:
  - removed "Resume" header and the `is_resumable` / retry-count cell from every download row
  - table grid updated from 7 to 6 columns: `28px minmax(230px, 1.8fr) 92px 94px 118px 190px`
- Added Show in Folder button to each download row:
  - a `FolderInput` icon button sits at the left of the Actions area
  - clicking calls a new `reveal_in_folder` Tauri command with `job.output_path`
  - Rust implementation: `explorer /select,<path>` on Windows, `open -R` on macOS, `xdg-open <parent>` on Linux
  - button is disabled when `output_path` is empty (job not yet started/completed)
- Tightened Chrome extension capture heuristics after Steam/Discord regressions:
  - `content.js` now only pre-captures direct file URLs or strong download endpoints such as `/api/downloads/`, `/releases/download/`, `/installer/`, and `/installers/`
  - this keeps Steam-style landing pages from being swallowed before the browser can navigate to the real redirected download
  - `page-hook.js` now uses the same strong-URL rules instead of broad `download/install` text matching for programmatic navigation
  - the page hook also tracks in-flight and recently successful capture URLs so duplicate JS-triggered download calls for the same URL do not reopen Chrome's own download flow after Trinity already accepted the job
- Updated the Add Download modal for browser-fetched downloads:
  - when Trinity opens the modal from an extension/browser handoff with a suggested filename, the dialog now shows `File name` and the browser-provided filename instead of exposing the raw URL in the main field
  - manual Add URL flow remains unchanged and still shows an editable `URL` field
- Fixed browser-prefilled modal detection for redirected downloads such as Steam:
  - the Add Download modal now tracks browser-origin separately from whether the extension already supplied a filename
  - this means redirected browser downloads can still render `File name` and use fetched metadata like `SteamSetup.exe` even if the suggested filename was initially empty
- Hardened browser-prefilled filename mode:
  - the modal now also flips into `File name` mode whenever fetched URL metadata returns a real filename different from the raw URL
  - this protects redirected browser downloads like Steam even if the earlier browser-origin flag is lost in a stale running build/session
- Simplified Add Download filename presentation:
  - the modal now shows `File name` whenever the resolved display filename differs from the raw URL, regardless of whether the browser-origin flag survived
  - this trades a stricter browser-only rule for a more reliable installed-app behavior on redirected downloads such as Steam
- Extended filename presentation to direct file URLs on any site:
  - the Add Download modal now derives a filename from the URL path itself before waiting on metadata
  - if the URL already ends in something like `SteamSetup.exe`, the modal immediately shows `File name` with that value instead of showing the raw URL
  - metadata still overrides that derived value when the server reports a better filename
- Browser integration needs a resolver-first architecture like IDM/FDM:
  - current Trinity behavior still relies too heavily on the clicked URL or early page URL, which fails on gated/redirected/browser-managed downloads (for example GoFile, Steam landing pages, and other protected download flows)
  - mature download managers solve this by letting the browser resolve the real download first, then handing the native app richer metadata instead of asking the native app to guess from the page URL
  - the browser handoff payload needs to evolve toward:
    - final resolved download URL
    - suggested filename from the browser download item
    - referrer/page URL
    - MIME type when available
    - user agent
    - cookies/session state for sites that require browser-authenticated requests
    - request method / POST body support later if needed for more protected sites
  - Trinity should treat tiny HTML or intermediate responses as unresolved browser-gated downloads, not as valid file downloads
  - this is the architectural path required to make difficult sites work more like IDM/FDM instead of relying on fragile URL guessing
- Implemented browser handoff contract v2 foundation:
  - `ExtensionDownloadRequest` now supports `final_url`, `user_agent`, and `cookies` fields in addition to the original clicked `url`, filename, referrer, MIME type, and page URL
  - the localhost bridge advertises `downloadHandoffVersion: 2` from `/app/ping`
  - Trinity now prefers `final_url` when validating and consuming extension download requests
  - the Chrome extension now sends both the original URL and resolved `final_url` where available, plus `user_agent` and cookie placeholders for the next browser-session transfer step
- Extended browser handoff contract v2 with request replay fields:
  - `ExtensionDownloadRequest` now also supports `request_method` and `request_body`
  - current extension paths populate safe defaults (`GET`, `null`) for direct link, context-menu, content-script, page-hook, and browser-download-item handoffs
  - this does not replay POST/browser-authenticated requests yet; it establishes the cross-process contract so the next step can start sending real non-GET metadata where available
- Started session-transfer support for browser-gated downloads:
  - the Chrome extension now requests `cookies` permission and attaches real browser cookies for the resolved download URL plus page/referrer context before sending a handoff to Trinity
  - Trinity now keeps browser request context in memory and reuses `cookies`, `referrer`, and `user_agent` during both URL inspection and actual download-engine HTTP requests
  - this first pass intentionally avoids changing the SQLite job schema; the browser session context is transient and tied to the active handoff/job launch path
  - this first pass intentionally avoided changing the SQLite job schema; the browser session context is transient and tied to the active handoff/job launch path
- Trinity now honors request replay metadata from the browser handoff:
  - the Rust side now builds inspection and download requests from `request_method` and `request_body` instead of assuming `GET` everywhere
  - browser-originated non-GET downloads stay on the single-stream path for now; segmented/range logic remains limited to plain `GET` requests because replaying multiple ranged POST-style requests is not yet safe
  - this closes the app-side half of the IDM/FDM-style browser handoff path; the remaining gap is populating real non-GET request metadata from Chrome when sites actually trigger downloads that way
- The Chrome extension now captures real request metadata when the browser issues a request:
  - added `webRequest` permission and a lightweight `onBeforeRequest` cache keyed by URL
  - request metadata currently captures the real HTTP method and a best-effort serialized request body (`formData` as URL-encoded text, raw request bodies as decoded text when possible)
  - Trinity handoff payload enrichment now prefers that captured browser metadata over placeholder `GET` / `null` values
  - this closes the extension-side half of the request replay path for the common cases Chrome exposes through `webRequest`
- Trinity now captures and replays the most important request headers for gated downloads:
  - the Chrome extension caches a filtered set of replay-worthy headers from `webRequest.onBeforeSendHeaders`
  - current replay header set is intentionally narrow: `accept`, `accept-language`, `authorization`, `content-type`, `origin`, and `x-requested-with`
  - Trinity now forwards those headers during both URL inspection and actual download requests, while still refusing to blindly replay transport/problematic headers like `cookie`, `host`, `content-length`, `range`, `referer`, or `user-agent`
  - this improves fidelity for browser-authenticated downloads without turning the handoff into an unsafe raw browser request clone

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
- Most Preferences sections are still frontend placeholders and are not yet persisted to SQLite, but the Browser Integration controls are now persisted and active.
- Running jobs cannot be deleted from the UI.
- Cancellation is cooperative and is checked between received network chunks.

### 2026-05-07 — Fix extension pre-capture for page-redirect downloads (e.g. Steam installer)
**Commit:** `e6c063f` — "Skip pre-capture for page URLs, use onCreated"

- Steam's "Install Steam Now" button has an `href` that is a page URL (`/about/?snr=...`), not a direct file URL. The old content.js pre-captured it, called `event.preventDefault()`, and sent the page URL to Trinity, which downloaded the HTML instead of the installer.
- Fix: `shouldCaptureCandidate` in `content.js` now requires the URL to have a recognized file extension before pre-capturing. Added `hasDownloadExtension()` helper and `DOWNLOAD_EXTENSIONS` set covering exe/msi/dmg/zip/iso/mp4/pdf and more.
- For page-style URLs (no extension), content.js returns early without `event.preventDefault()`, so Chrome follows the link naturally. When the server redirects to the real file, `chrome.downloads.onCreated` fires with `downloadItem.finalUrl` (the actual `.exe` URL), and `handleCreatedDownload` cancels Chrome's download before it completes and sends the correct URL to Trinity.
- Anchors with a `download` attribute are still pre-captured regardless of extension.

### 2026-05-07 — Restore pre-capture for non-extension URLs; block HTML downloads in engine
**Commit:** `ed3c3af` — "Restore pre-capture, block HTML downloads"

- The previous fix (skip pre-capture for non-extension URLs) broke Discord: `onCreated` is less reliable than pre-capture because it only checks `cachedBridgeAlive` without a live ping fallback. Discord pre-capture via DOWNLOAD_HINT_PATTERN was the working path.
- Reverted `shouldCaptureCandidate` in `content.js` to the original behavior — non-extension URLs matching DOWNLOAD_HINT_PATTERN are still pre-captured.
- `hasDownloadExtension` and `DOWNLOAD_EXTENSIONS` kept in `content.js` for future use (blob URL detection, etc.)
- Added Content-Type guard in `download_engine.rs` (`download_single_stream`): if the server responds with `text/html`, the job immediately fails with "URL returned a web page, not a downloadable file. Use the direct file URL." instead of saving HTML as `download.bin`. This catches the Steam/page-redirect case with a meaningful error.
- Result: Discord ✓ (pre-captured, Trinity follows redirect to CDN exe), Steam: clear error instead of silent junk download.

### 2026-05-07 — Browser-assisted redirect capture for page-redirect downloads
**Commit:** `2e2d48e` — "Use browser redirect for no-extension downloads"

- For URLs without a recognized file extension (Steam, package manager pages, etc.), `captureDownloadClick` in `background.js` now calls `chrome.downloads.download()` instead of sending to Trinity directly. Chrome follows the server's redirect chain with full session cookies, resolving the real CDN/file URL.
- `handleCreatedDownload` intercepts the `onCreated` event for that Chrome download, immediately cancels Chrome's copy, and sends `downloadItem.finalUrl` (the resolved file URL) to Trinity.
- For URLs WITH a recognized file extension (Discord CDN, direct .exe/.zip links), the existing direct Trinity path is used unchanged.
- `DOWNLOAD_EXTENSIONS` set and `hasDownloadExtension()` added to `background.js` (mirrors content.js).
- Result: Steam → Chrome follows with session cookies → CDN .exe URL → Trinity downloads ✓. Discord → direct extension (has .exe in final URL after pre-capture) or same path ✓.
- The HTML content-type guard in `download_engine.rs` remains as a safety net for any HTML that slips through.

### 2026-05-07 — Fix Discord dialog and Steam navigation (three-part fix)
**Commit:** `5d43e4b` — "Fix Discord dialog and Steam navigation"

**Problem:** The `chrome.downloads.download()` branch introduced in 2e2d48e caused two regressions:
1. Discord: Chrome showed a save/install dialog because `chrome.downloads.download()` creates a visible managed download (`.exe` triggers Chrome's installer prompt before `handleCreatedDownload` can cancel it).
2. Steam: Still grabbed HTML because `chrome.downloads.download()` sends a raw HTTP request without browser page rendering or JavaScript execution — Steam requires a real Chrome page navigation with session cookies to reach the CDN installer URL.

**Fix (three changes):**

1. `content.js` `shouldCaptureCandidate`: restored the `hasDownloadExtension` guard — non-extension URLs (e.g. Steam's `/about/?snr=...`) skip `event.preventDefault()` so Chrome navigates the page naturally. Direct file URLs (e.g. Discord CDN `.exe`) are still pre-captured as before.

2. `background.js` `handleCreatedDownload`: when `cachedBridgeAlive` is false, now falls back to a live `pingBridge()` call before giving up. This fixes the startup race condition where the extension is freshly loaded, `cachedBridgeAlive` hasn't been populated yet, but the bridge is actually running — causing Discord's `onCreated` event to be missed.

3. `background.js` `captureDownloadClick`: removed the entire `chrome.downloads.download()` block. Non-extension URL clicks now let Chrome navigate; when the server redirects to the real file, `onCreated` fires with `downloadItem.finalUrl` (the actual `.exe`/CDN URL), and `handleCreatedDownload` cancels Chrome and sends to Trinity.

**Result:** Steam → Chrome follows the page naturally with session cookies → CDN `.exe` URL fires `onCreated` → Trinity intercepts ✓. Discord → pre-captured via extension match → Trinity downloads directly ✓. No Chrome save dialogs. No HTML downloads.

### 2026-05-07 - Preserve binary browser request bodies safely
**Commit:** `c588f65`

- Added `request_body_encoding` to the browser handoff contract.
- The Chrome extension now classifies request bodies as either `text` or `base64`.
- Raw browser request bodies that are not safe UTF-8 text are now base64-encoded instead of being lossy-decoded into strings.
- Trinity now decodes and replays base64 request bodies on both:
  - bridge-side URL inspection
  - actual Rust download requests
- This closes the obvious non-text request-body gap in the request replay path without changing the SQLite job schema.

### 2026-05-07 - Rebuild multipart and structured form bodies
**Commit:** `pending`

- Added `request_form_data` to the browser handoff contract so Chrome-exposed form fields can be preserved semantically instead of flattened into fake text.
- The extension now keeps `formData` payloads as structured key -> array-of-values data during handoff enrichment.
- Trinity now rebuilds browser-originated form submissions on the Rust side:
  - `multipart/form-data` requests are reconstructed with `reqwest` multipart forms
  - other structured form submissions fall back to request `.form(...)`
- When Trinity rebuilds a form body, it intentionally skips replaying the original `content-type` header so `reqwest` can emit the correct boundary/content-type for the reconstructed request.

### 2026-05-07 - Move browser capture toward a scalable two-lane model
**Commit:** `pending`

- We do not want the extension architecture to grow around hardcoded website paths or one-off hostname exceptions.
- The scalable capture model is now:
  1. **Direct capture lane** - only send straight to Trinity when the URL looks like a direct file and a lightweight browser-side probe says the endpoint behaves like a real file response.
  2. **Browser-resolved lane** - if the candidate is ambiguous or the probe suggests HTML/intermediate content, let Chrome resolve the real download first and intercept it through the browser-managed download event path.
- The extension now uses a generic response-based probe for likely direct-file clicks instead of relying on host-specific carveouts.
- This keeps the architecture aligned with the longer-term IDM/FDM-style model: prefer browser resolution for ambiguous flows, and use direct pre-capture only for low-risk direct-file cases.

## Next Step

Test and close the remaining site-specific gaps: identify any download flows that still fail after the current method/body/header/cookie/form replay stack, then add only the missing targeted browser request context those sites actually require.
