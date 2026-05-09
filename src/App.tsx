import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock3,
  Flag,
  FolderInput,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import "./App.css";

type DownloadState =
  | "Queued"
  | "Running"
  | "Paused"
  | "Failed"
  | "Completed"
  | "Canceled";

type DownloadJob = {
  id: string;
  url: string;
  file_name: string;
  output_folder: string;
  output_path: string;
  state: DownloadState;
  queue_position: number;
  priority: number;
  connection_count: number;
  speed_limit_kbps: number;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bps: number;
  is_resumable: boolean;
  scheduler_enabled: boolean;
  schedule_days: string[];
  schedule_from: string | null;
  schedule_to: string | null;
  retry_count: number;
  next_retry_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type AppSettings = {
  max_concurrent_downloads: number;
  retry_enabled: boolean;
  retry_attempts: number;
  retry_delay_seconds: number;
  default_connection_count: number;
  default_download_speed_limit_kbps: number;
  bandwidth_schedule_enabled: boolean;
  bandwidth_schedule_start: string;
  bandwidth_schedule_end: string;
  bandwidth_schedule_limit_kbps: number;
  close_to_tray: boolean;
  launch_at_startup: boolean;
  start_minimized: boolean;
  startup_prompt_answered: boolean;
  default_folder_mode: "automatic" | "fixed";
  fixed_download_folder: string;
  show_save_as_button: boolean;
  delete_button_action: "remove" | "delete" | "ask";
  file_exists_action: "rename" | "overwrite" | "ask";
  remove_deleted_files: boolean;
  remove_completed_files: boolean;
  bottom_panel_follows_selection: boolean;
  show_tray_activity: boolean;
  use_custom_sort_order: boolean;
  skip_web_pages: boolean;
  use_server_file_time: boolean;
  mark_downloaded_files: boolean;
  browser_intercept_downloads: boolean;
  browser_start_without_confirmation: boolean;
  browser_skip_domains: string;
  browser_skip_extensions: string;
  browser_capture_extensions: string;
  browser_minimum_size_mb: number;
  browser_use_native_fallback: boolean;
  browser_ignore_insert_key: boolean;
  proxy_mode: "system" | "none" | "manual";
  proxy_host: string;
  proxy_port: number;
  proxy_username: string;
  proxy_password: string;
  notify_added: boolean;
  notify_completed: boolean;
  notify_failed: boolean;
  notify_inactive_only: boolean;
  play_sounds: boolean;
  completion_hook_enabled: boolean;
  completion_hook_path: string;
  completion_hook_arguments: string;
  avoid_sleep_with_active_downloads: boolean;
  avoid_sleep_with_scheduled_downloads: boolean;
  allow_sleep_if_resumable: boolean;
  check_for_updates_automatically: boolean;
  install_updates_automatically: boolean;
  test_toggle: boolean;
};

type AppUpdaterStatus = {
  configured: boolean;
  current_version: string;
};

type AppUpdateInfo = {
  current_version: string;
  version: string;
  body: string | null;
  date: string | null;
};

type DownloadProgressEvent = {
  id: string;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bps: number;
};

type DownloadUrlMetadata = {
  file_name: string;
  total_bytes: number | null;
};

type ExtensionDownloadRequest = {
  url: string;
  final_url?: string | null;
  request_method?: string | null;
  request_body?: string | null;
  request_body_encoding?: string | null;
  request_form_data?: Record<string, string[]> | null;
  request_headers?: Record<string, string> | null;
  page_url?: string | null;
  suggested_file_name?: string | null;
  mime_type?: string | null;
  response_status?: number | null;
  response_headers?: Record<string, string> | null;
  observed_file_name?: string | null;
  observed_content_type?: string | null;
  observed_content_length?: number | null;
  observed_accept_ranges?: string | null;
  browser_observed?: boolean | null;
  referrer?: string | null;
  browser?: string | null;
  user_agent?: string | null;
  cookies?: string[] | null;
  output_folder?: string | null;
};

type DownloadTabId =
  | "all"
  | "active"
  | "queued"
  | "completed"
  | "uncompleted"
  | "failed"
  | "paused";

type CategoryFilterId =
  | "all"
  | "compressed"
  | "documents"
  | "music"
  | "programs"
  | "video"
  | "unfinished"
  | "finished"
  | "queues";

type PriorityFilterId = "all" | "high" | "normal" | "low";

const SCHEDULE_DAYS = ["Everyday", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PREFERENCES_SECTIONS = [
  "general",
  "browserIntegration",
  "network",
  "trafficLimits",
  "antivirus",
  "distributedEngine",
  "remoteAccess",
  "advanced",
] as const;

type PreferencesSectionId = (typeof PREFERENCES_SECTIONS)[number];

type PreferencesDraft = {
  theme: string;
  uiStyle: string;
  language: string;
  launchAtStartup: boolean;
  startMinimized: boolean;
  defaultFolderMode: "automatic" | "fixed";
  fixedDownloadFolder: string;
  suggestFolderByType: boolean;
  suggestFolderByUrl: boolean;
  compactDownloads: boolean;
  standaloneWindows: boolean;
  removeDeletedFiles: boolean;
  removeCompletedFiles: boolean;
  autoRetryFailedDownloads: boolean;
  skipWebPages: boolean;
  useServerFileTime: boolean;
  markDownloadedFiles: boolean;
  maxBatchUrls: number;
  checkForUpdatesAutomatically: boolean;
  installUpdatesAutomatically: boolean;
  browserInterceptDownloads: boolean;
  browserStartWithoutConfirmation: boolean;
  browserSkipDomains: string;
  browserSkipExtensions: string;
  browserCaptureExtensions: string;
  browserMinimumSizeMb: number;
  browserUseNativeFallback: boolean;
  browserIgnoreInsertKey: boolean;
  proxyMode: "system" | "none" | "manual";
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
  limitPresetLow: string;
  limitPresetMedium: string;
  limitPresetHigh: string;
  defaultConnectionCount: number;
  defaultDownloadSpeedLimitKbps: number;
  bandwidthScheduleEnabled: boolean;
  bandwidthScheduleStart: string;
  bandwidthScheduleEnd: string;
  bandwidthScheduleLimitKbps: number;
  maxConnectionsLow: number;
  maxConnectionsMedium: number;
  maxConnectionsHigh: number;
  maxConnectionsPerServerLow: number;
  maxConnectionsPerServerMedium: number;
  maxConnectionsPerServerHigh: number;
  maxConcurrentDownloads: number;
  retryMode: "auto" | "manual";
  retryAttempts: number;
  retryDelaySeconds: number;
  additionalMetadataQueries: number;
  enableParallelAcceleration: boolean;
  antivirusProvider: string;
  antivirusPath: string;
  antivirusArguments: string;
  antivirusCheckAfterDownload: boolean;
  distributedDefaultHandler: boolean;
  distributedDeleteManifestOnFinish: boolean;
  distributedMonitorFolder: boolean;
  distributedWatchFolder: string;
  distributedAutoStart: boolean;
  distributedEncryption: string;
  distributedPeerDiscovery: boolean;
  distributedPeerExchange: boolean;
  distributedLocalPeerDiscovery: boolean;
  distributedUdpTransport: boolean;
  distributedSystemPort: boolean;
  distributedPortForwarding: boolean;
  remoteAccessEnabled: boolean;
  remoteAccessId: string;
  remoteAccessPassword: string;
  remoteAccessBypassProxy: boolean;
  notifyAdded: boolean;
  notifyCompleted: boolean;
  notifyFailed: boolean;
  notifyInactiveOnly: boolean;
  playSounds: boolean;
  avoidSleepWithActiveDownloads: boolean;
  avoidSleepWithScheduledDownloads: boolean;
  allowSleepIfResumable: boolean;
  testToggle: boolean;
  backupEveryHours: string;
  closeToTray: boolean;
  bottomPanelFollowsSelection: boolean;
  showTrayActivity: boolean;
  useCustomSortOrder: boolean;
  showSaveAsButton: boolean;
  showBuiltInTags: boolean;
  overallZoom: string;
  fontZoom: string;
  completionHookEnabled: boolean;
  completionHookPath: string;
  completionHookArguments: string;
  deleteButtonAction: "remove" | "delete" | "ask";
  fileExistsAction: "rename" | "overwrite" | "ask";
};

function createPreferencesDraft(maxConcurrentDownloads: number): PreferencesDraft {
  return {
    theme: "System",
    uiStyle: "Trinity Classic",
    language: "English (United States)",
    launchAtStartup: false,
    startMinimized: true,
    defaultFolderMode: "automatic",
    fixedDownloadFolder: "",
    suggestFolderByType: true,
    suggestFolderByUrl: false,
    compactDownloads: false,
    standaloneWindows: false,
    removeDeletedFiles: true,
    removeCompletedFiles: false,
    autoRetryFailedDownloads: true,
    skipWebPages: true,
    useServerFileTime: false,
    markDownloadedFiles: true,
    maxBatchUrls: 100,
    checkForUpdatesAutomatically: true,
    installUpdatesAutomatically: false,
    browserInterceptDownloads: true,
    browserStartWithoutConfirmation: false,
    browserSkipDomains: "accounts.google.com, drive.google.com",
    browserSkipExtensions: ".tmp, .part",
    browserCaptureExtensions: ".zip, .exe, .iso, .7z",
    browserMinimumSizeMb: 1,
    browserUseNativeFallback: true,
    browserIgnoreInsertKey: true,
    proxyMode: "system",
    proxyHost: "",
    proxyPort: "",
    proxyUsername: "",
    proxyPassword: "",
    limitPresetLow: "256 KB/s",
    limitPresetMedium: "2 MB/s",
    limitPresetHigh: "Unlimited",
    defaultConnectionCount: 4,
    defaultDownloadSpeedLimitKbps: 0,
    bandwidthScheduleEnabled: false,
    bandwidthScheduleStart: "22:00",
    bandwidthScheduleEnd: "06:00",
    bandwidthScheduleLimitKbps: 512,
    maxConnectionsLow: 15,
    maxConnectionsMedium: 50,
    maxConnectionsHigh: 200,
    maxConnectionsPerServerLow: 5,
    maxConnectionsPerServerMedium: 8,
    maxConnectionsPerServerHigh: 15,
    maxConcurrentDownloads,
    retryMode: "auto",
    retryAttempts: 3,
    retryDelaySeconds: 5,
    additionalMetadataQueries: 3,
    enableParallelAcceleration: true,
    antivirusProvider: "Configure manually",
    antivirusPath: "",
    antivirusArguments: "%path%",
    antivirusCheckAfterDownload: false,
    distributedDefaultHandler: false,
    distributedDeleteManifestOnFinish: false,
    distributedMonitorFolder: false,
    distributedWatchFolder: "",
    distributedAutoStart: false,
    distributedEncryption: "Prefer encryption",
    distributedPeerDiscovery: true,
    distributedPeerExchange: true,
    distributedLocalPeerDiscovery: true,
    distributedUdpTransport: true,
    distributedSystemPort: true,
    distributedPortForwarding: true,
    remoteAccessEnabled: false,
    remoteAccessId: "",
    remoteAccessPassword: "",
    remoteAccessBypassProxy: true,
    notifyAdded: false,
    notifyCompleted: true,
    notifyFailed: true,
    notifyInactiveOnly: true,
    playSounds: false,
    avoidSleepWithActiveDownloads: true,
    avoidSleepWithScheduledDownloads: true,
    allowSleepIfResumable: true,
    testToggle: false,
    backupEveryHours: "3 hours",
    closeToTray: true,
    bottomPanelFollowsSelection: true,
    showTrayActivity: true,
    useCustomSortOrder: false,
    showSaveAsButton: true,
    showBuiltInTags: true,
    overallZoom: "100%",
    fontZoom: "100%",
    completionHookEnabled: false,
    completionHookPath: "",
    completionHookArguments: "%path%",
    deleteButtonAction: "ask",
    fileExistsAction: "rename",
  };
}

function preferenceSectionLabel(sectionId: PreferencesSectionId) {
  switch (sectionId) {
    case "general":
      return "General";
    case "browserIntegration":
      return "Browser Integration";
    case "network":
      return "Network";
    case "trafficLimits":
      return "Traffic Limits";
    case "antivirus":
      return "Antivirus";
    case "distributedEngine":
      return "Distributed Engine";
    case "remoteAccess":
      return "Remote Access";
    case "advanced":
      return "Advanced";
  }
}

function App() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [jobsInitialized, setJobsInitialized] = useState(false);
  const [completingJobIds, setCompletingJobIds] = useState<Set<string>>(new Set());
  const [activeCountPulsing, setActiveCountPulsing] = useState(false);
  const prevJobStatesRef = useRef<Map<string, string>>(new Map());
  const prevNotificationStatesRef = useRef<Map<string, DownloadState>>(new Map());
  const prevJobIdsRef = useRef<Set<string>>(new Set());
  const prevActiveCountRef = useRef(0);
  const notificationBaselineReadyRef = useRef(false);
  const notificationPermissionRef = useRef<boolean | null>(null);
  const autoRemovingCompletedIdsRef = useRef<Set<string>>(new Set());
  const [systemIcons, setSystemIcons] = useState<Record<string, string>>({});
  const [url, setUrl] = useState("");
  const [outputFolder, setOutputFolder] = useState("");
  const [pendingSuggestedFileName, setPendingSuggestedFileName] = useState("");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isAddAnimatingOut, setIsAddAnimatingOut] = useState(false);
  const [newestJobId, setNewestJobId] = useState<string | null>(null);
  const [deletingJobIds, setDeletingJobIds] = useState<Set<string>>(new Set());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isStartupPromptOpen, setIsStartupPromptOpen] = useState(false);
  const [isStartupPromptAnimatingOut, setIsStartupPromptAnimatingOut] = useState(false);
  const [isStartupPromptSaving, setIsStartupPromptSaving] = useState(false);
  const [startupPromptError, setStartupPromptError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [isSchedulerEnabled, setIsSchedulerEnabled] = useState(false);
  const [scheduleDays, setScheduleDays] = useState<string[]>(SCHEDULE_DAYS);
  const [scheduleFrom, setScheduleFrom] = useState("06:00");
  const [scheduleTo, setScheduleTo] = useState("10:00");
  const [urlMetadata, setUrlMetadata] = useState<DownloadUrlMetadata | null>(null);
  const [browserObservedMetadata, setBrowserObservedMetadata] = useState<DownloadUrlMetadata | null>(null);
  const [isBrowserObservedDownload, setIsBrowserObservedDownload] = useState(false);
  const [isUrlMetadataLoading, setIsUrlMetadataLoading] = useState(false);
  const [urlMetadataError, setUrlMetadataError] = useState("");
  const [scheduleClock, setScheduleClock] = useState(() => Date.now());
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    max_concurrent_downloads: 3,
    retry_enabled: true,
    retry_attempts: 3,
    retry_delay_seconds: 5,
    default_connection_count: 4,
    default_download_speed_limit_kbps: 0,
    bandwidth_schedule_enabled: false,
    bandwidth_schedule_start: "22:00",
    bandwidth_schedule_end: "06:00",
    bandwidth_schedule_limit_kbps: 512,
    close_to_tray: true,
    launch_at_startup: false,
    start_minimized: false,
    startup_prompt_answered: false,
    default_folder_mode: "automatic",
    fixed_download_folder: "",
    show_save_as_button: true,
    delete_button_action: "ask",
    file_exists_action: "rename",
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
    browser_skip_domains: "accounts.google.com, drive.google.com",
    browser_skip_extensions: ".tmp, .part",
    browser_capture_extensions: ".zip, .exe, .iso, .7z",
    browser_minimum_size_mb: 1,
    browser_use_native_fallback: true,
    browser_ignore_insert_key: true,
    proxy_mode: "system",
    proxy_host: "",
    proxy_port: 8080,
    proxy_username: "",
    proxy_password: "",
    notify_added: false,
    notify_completed: true,
    notify_failed: true,
    notify_inactive_only: true,
    play_sounds: false,
    completion_hook_enabled: false,
    completion_hook_path: "",
    completion_hook_arguments: "%path%",
    avoid_sleep_with_active_downloads: true,
    avoid_sleep_with_scheduled_downloads: true,
    allow_sleep_if_resumable: true,
    check_for_updates_automatically: true,
    install_updates_automatically: false,
    test_toggle: false,
  });
  const [preferencesDraft, setPreferencesDraft] = useState<PreferencesDraft>(() =>
    createPreferencesDraft(3),
  );
  const [activePreferencesSection, setActivePreferencesSection] =
    useState<PreferencesSectionId>("general");
  const [preferencesStatus, setPreferencesStatus] = useState("");
  const [updaterStatus, setUpdaterStatus] = useState<AppUpdaterStatus>({
    configured: false,
    current_version: "0.1.0",
  });
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [isCheckingForUpdate, setIsCheckingForUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateStatusMessage, setUpdateStatusMessage] = useState("");
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<{
    downloadedBytes: number;
    totalBytes: number | null;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<DownloadTabId>("all");
  const [activeCategory, setActiveCategory] = useState<CategoryFilterId>("all");
  const [queueSearch, setQueueSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilterId>("all");
  const [queueScope, setQueueScope] = useState<"all" | "queueOnly" | "scheduled">("all");
  const [draggedJobId, setDraggedJobId] = useState<string | null>(null);
  const [dropTargetJobId, setDropTargetJobId] = useState<string | null>(null);
  const preferencesContentRef = useRef<HTMLElement | null>(null);
  const pendingIconKeysRef = useRef<Set<string>>(new Set());
  const settingsRef = useRef(settings);
  const autoUpdateCheckStartedRef = useRef(false);
  const isCheckingForUpdateRef = useRef(false);
  const isInstallingUpdateRef = useRef(false);
  const notifiedAvailableUpdateVersionRef = useRef<string | null>(null);
  const notifiedReadyUpdateVersionRef = useRef<string | null>(null);
  const effectiveUrlMetadata = browserObservedMetadata ?? urlMetadata;
  const extensionDisplayFileName =
    pendingSuggestedFileName.trim() ||
    effectiveUrlMetadata?.file_name ||
    deriveFileNameFromUrl(url) ||
    "";
  const isExtensionPrefilledDownload =
    extensionDisplayFileName.length > 0 && extensionDisplayFileName !== url;

  function preferredOutputFolderFromSettings(currentSettings: AppSettings) {
    if (
      currentSettings.default_folder_mode === "fixed" &&
      currentSettings.fixed_download_folder.trim().length > 0
    ) {
      return currentSettings.fixed_download_folder.trim();
    }

    return "";
  }

  function shouldUseInactiveOnlyNotifications(currentSettings: AppSettings) {
    return (
      currentSettings.notify_inactive_only &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    );
  }

  async function ensureNotificationPermission() {
    if (notificationPermissionRef.current === true) {
      return true;
    }
    if (notificationPermissionRef.current === false) {
      return false;
    }

    const alreadyGranted = await isPermissionGranted();
    if (alreadyGranted) {
      notificationPermissionRef.current = true;
      return true;
    }

    const permission = await requestPermission();
    const granted = permission === "granted";
    notificationPermissionRef.current = granted;
    return granted;
  }

  async function sendNativeNotification(title: string, body: string) {
    const currentSettings = settingsRef.current;
    if (shouldUseInactiveOnlyNotifications(currentSettings)) {
      return;
    }

    const permissionGranted = await ensureNotificationPermission();
    if (!permissionGranted) {
      return;
    }

    sendNotification({
      title,
      body,
      group: "downloads",
      silent: !currentSettings.play_sounds,
    });
  }

  async function checkForUpdates(options?: {
    silentIfCurrent?: boolean;
    autoInstall?: boolean;
    notifyIfFound?: boolean;
  }) {
    if (
      !updaterStatus.configured ||
      isCheckingForUpdateRef.current ||
      isInstallingUpdateRef.current
    ) {
      return;
    }

    setIsCheckingForUpdate(true);
    setUpdateStatusMessage("Checking for updates...");

    try {
      const update = await invoke<AppUpdateInfo | null>("check_for_app_update");
      setAvailableUpdate(update);

      if (update) {
        setUpdateStatusMessage(`Update ${update.version} is available.`);
        if (
          options?.notifyIfFound !== false &&
          notifiedAvailableUpdateVersionRef.current !== update.version
        ) {
          notifiedAvailableUpdateVersionRef.current = update.version;
          void sendNativeNotification(
            "Trinity update available",
            `Version ${update.version} is available.`,
          );
        }
        if (options?.autoInstall) {
          await installAvailableUpdate(update);
        }
      } else {
        setUpdateDownloadProgress(null);
        if (!options?.silentIfCurrent) {
          setUpdateStatusMessage("Trinity is up to date.");
        } else {
          setUpdateStatusMessage("");
        }
      }
    } catch (caughtError) {
      setUpdateStatusMessage(String(caughtError));
    } finally {
      setIsCheckingForUpdate(false);
    }
  }

  async function installAvailableUpdate(updateToInstall?: AppUpdateInfo | null) {
    if (!updaterStatus.configured || isInstallingUpdateRef.current) {
      return;
    }

    const targetVersion = updateToInstall?.version ?? availableUpdate?.version ?? null;
    setIsInstallingUpdate(true);
    setUpdateStatusMessage("Preparing update...");
    setUpdateDownloadProgress({ downloadedBytes: 0, totalBytes: null });

    try {
      await invoke("install_app_update");
      try {
        await invoke("show_main_window");
      } catch (caughtError) {
        console.error(caughtError);
      }
      if (targetVersion && notifiedReadyUpdateVersionRef.current !== targetVersion) {
        notifiedReadyUpdateVersionRef.current = targetVersion;
      }
      void sendNativeNotification(
        "Trinity update ready",
        targetVersion
          ? `Version ${targetVersion} is ready to finish installing.`
          : "A Trinity update is ready to finish installing.",
      );
      setAvailableUpdate(null);
      setUpdateStatusMessage("Update ready. Trinity will close to finish the installation.");
    } catch (caughtError) {
      setUpdateStatusMessage(String(caughtError));
      setUpdateDownloadProgress(null);
    } finally {
      setIsInstallingUpdate(false);
    }
  }

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    isCheckingForUpdateRef.current = isCheckingForUpdate;
  }, [isCheckingForUpdate]);

  useEffect(() => {
    isInstallingUpdateRef.current = isInstallingUpdate;
  }, [isInstallingUpdate]);

  useEffect(() => {
    invoke<AppUpdaterStatus>("get_app_updater_status")
      .then(setUpdaterStatus)
      .catch(console.error);

    invoke<AppSettings>("get_app_settings")
      .then((loadedSettings) => {
        setSettings(loadedSettings);
        setPreferencesDraft((currentDraft) => ({
          ...currentDraft,
          maxConcurrentDownloads: loadedSettings.max_concurrent_downloads,
          autoRetryFailedDownloads: loadedSettings.retry_enabled,
          retryMode: loadedSettings.retry_enabled ? "auto" : "manual",
          retryAttempts: loadedSettings.retry_attempts,
          retryDelaySeconds: loadedSettings.retry_delay_seconds,
          defaultConnectionCount: loadedSettings.default_connection_count,
          defaultDownloadSpeedLimitKbps: loadedSettings.default_download_speed_limit_kbps,
          bandwidthScheduleEnabled: loadedSettings.bandwidth_schedule_enabled,
          bandwidthScheduleStart: loadedSettings.bandwidth_schedule_start,
          bandwidthScheduleEnd: loadedSettings.bandwidth_schedule_end,
          bandwidthScheduleLimitKbps: loadedSettings.bandwidth_schedule_limit_kbps,
          closeToTray: loadedSettings.close_to_tray,
          launchAtStartup: loadedSettings.launch_at_startup,
          startMinimized: loadedSettings.start_minimized,
          defaultFolderMode: loadedSettings.default_folder_mode,
          fixedDownloadFolder: loadedSettings.fixed_download_folder,
          showSaveAsButton: loadedSettings.show_save_as_button,
          deleteButtonAction: loadedSettings.delete_button_action,
          fileExistsAction: loadedSettings.file_exists_action,
          removeDeletedFiles: loadedSettings.remove_deleted_files,
          removeCompletedFiles: loadedSettings.remove_completed_files,
          bottomPanelFollowsSelection: loadedSettings.bottom_panel_follows_selection,
          showTrayActivity: loadedSettings.show_tray_activity,
          useCustomSortOrder: loadedSettings.use_custom_sort_order,
          skipWebPages: loadedSettings.skip_web_pages,
          useServerFileTime: loadedSettings.use_server_file_time,
          markDownloadedFiles: loadedSettings.mark_downloaded_files,
          checkForUpdatesAutomatically: loadedSettings.check_for_updates_automatically,
          installUpdatesAutomatically: loadedSettings.install_updates_automatically,
          browserInterceptDownloads: loadedSettings.browser_intercept_downloads,
          browserStartWithoutConfirmation: loadedSettings.browser_start_without_confirmation,
          browserSkipDomains: loadedSettings.browser_skip_domains,
          browserSkipExtensions: loadedSettings.browser_skip_extensions,
          browserCaptureExtensions: loadedSettings.browser_capture_extensions,
          browserMinimumSizeMb: loadedSettings.browser_minimum_size_mb,
          browserUseNativeFallback: loadedSettings.browser_use_native_fallback,
          browserIgnoreInsertKey: loadedSettings.browser_ignore_insert_key,
          proxyMode: loadedSettings.proxy_mode,
          proxyHost: loadedSettings.proxy_host,
          proxyPort: String(loadedSettings.proxy_port),
          proxyUsername: loadedSettings.proxy_username,
          proxyPassword: loadedSettings.proxy_password,
          notifyAdded: loadedSettings.notify_added,
          notifyCompleted: loadedSettings.notify_completed,
          notifyFailed: loadedSettings.notify_failed,
          notifyInactiveOnly: loadedSettings.notify_inactive_only,
          playSounds: loadedSettings.play_sounds,
          completionHookEnabled: loadedSettings.completion_hook_enabled,
          completionHookPath: loadedSettings.completion_hook_path,
          completionHookArguments: loadedSettings.completion_hook_arguments,
          avoidSleepWithActiveDownloads: loadedSettings.avoid_sleep_with_active_downloads,
          avoidSleepWithScheduledDownloads:
            loadedSettings.avoid_sleep_with_scheduled_downloads,
          allowSleepIfResumable: loadedSettings.allow_sleep_if_resumable,
          testToggle: loadedSettings.test_toggle,
        }));
        if (!loadedSettings.startup_prompt_answered) {
          setStartupPromptError("");
          setIsStartupPromptOpen(true);
        }
      })
      .catch(console.error);
    refreshJobs();
  }, []);

  useEffect(() => {
    if (
      !updaterStatus.configured ||
      !settings.check_for_updates_automatically ||
      autoUpdateCheckStartedRef.current
    ) {
      return;
    }

    autoUpdateCheckStartedRef.current = true;
    void checkForUpdates({
      silentIfCurrent: true,
      autoInstall: settings.install_updates_automatically,
      notifyIfFound: true,
    });
  }, [
    settings.check_for_updates_automatically,
    settings.install_updates_automatically,
    updaterStatus.configured,
  ]);

  useEffect(() => {
    if (!updaterStatus.configured || !settings.check_for_updates_automatically) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void checkForUpdates({
        silentIfCurrent: true,
        autoInstall: settingsRef.current.install_updates_automatically,
        notifyIfFound: true,
      });
    }, 10 * 60 * 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [settings.check_for_updates_automatically, updaterStatus.configured]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen("downloads-changed", () => {
      refreshJobs().catch(console.error);
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(console.error);

    return () => {
      unlisten?.();
      };
    }, []);

  useEffect(() => {
    let totalDownloaded = 0;
    let unlisten: (() => void) | null = null;

    listen<{
      stage: string;
      downloaded_bytes: number;
      total_bytes: number | null;
    }>("app-update-progress", (event) => {
      if (event.payload.stage === "starting") {
        totalDownloaded = 0;
        setUpdateDownloadProgress({ downloadedBytes: 0, totalBytes: null });
        setUpdateStatusMessage("Downloading update...");
        return;
      }

      if (event.payload.stage === "downloading") {
        totalDownloaded += event.payload.downloaded_bytes;
        setUpdateDownloadProgress({
          downloadedBytes: totalDownloaded,
          totalBytes: event.payload.total_bytes,
        });
        setUpdateStatusMessage("Downloading update...");
      }
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(console.error);

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<ExtensionDownloadRequest>("extension-download-request", (event) => {
      const payload = event.payload;
      const resolvedUrl = payload.final_url?.trim() || (payload.url ?? "");
      const browserObserved = payload.browser_observed === true;
      const observedFileName =
        payload.observed_file_name?.trim() ||
        payload.suggested_file_name?.trim() ||
        deriveFileNameFromUrl(resolvedUrl);
      const observedMetadata =
        observedFileName || payload.observed_content_length != null
          ? {
              file_name: observedFileName || deriveFileNameFromUrl(resolvedUrl),
              total_bytes: payload.observed_content_length ?? null,
            }
          : null;
      if (settingsRef.current.browser_start_without_confirmation) {
        void invoke<DownloadJob>("create_download_job", {
          request: {
            url: resolvedUrl,
            suggested_file_name: observedFileName || null,
            output_folder: payload.output_folder?.trim() || null,
            scheduler_enabled: false,
            schedule_days: [],
            schedule_from: null,
            schedule_to: null,
          },
        })
          .then((job) => {
            setNewestJobId(job.id);
            return refreshJobs();
          })
          .catch((invokeError) => {
            console.error(invokeError);
            setError(typeof invokeError === "string" ? invokeError : "Could not add download.");
          });
        return;
      }

      setError("");
      setUrl(resolvedUrl);
      setPendingSuggestedFileName(observedFileName ?? "");
      setOutputFolder(
        payload.output_folder?.trim() || preferredOutputFolderFromSettings(settingsRef.current),
      );
      setIsBrowserObservedDownload(browserObserved);
      setBrowserObservedMetadata(observedMetadata);
      setIsSchedulerEnabled(false);
      setScheduleDays(SCHEDULE_DAYS);
      setScheduleFrom("06:00");
      setScheduleTo("10:00");
      setUrlMetadata(null);
      setUrlMetadataError("");
      setIsAddOpen(true);
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(console.error);

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen("extension-open-options", () => {
      openPreferencesPage();
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(console.error);

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!newestJobId) return;
    const timer = setTimeout(() => setNewestJobId(null), 450);
    return () => clearTimeout(timer);
  }, [newestJobId]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const currentPreferencesNode = preferencesContentRef.current;
    if (!currentPreferencesNode) {
      return;
    }
    const contentNode = currentPreferencesNode;

    const sectionElements = PREFERENCES_SECTIONS.map((sectionId) =>
      document.getElementById(`preferences-${sectionId}`),
    ).filter((element): element is HTMLElement => element instanceof HTMLElement);

    function syncActiveSection() {
      const currentTop = contentNode.scrollTop;
      const closestSection = sectionElements.reduce<HTMLElement | null>((closest, section) => {
        if (section.offsetTop - 24 <= currentTop) {
          return section;
        }
        return closest;
      }, sectionElements[0] ?? null);

      if (closestSection) {
        setActivePreferencesSection(
          closestSection.id.replace("preferences-", "") as PreferencesSectionId,
        );
      }
    }

    syncActiveSection();
    contentNode.addEventListener("scroll", syncActiveSection);
    return () => contentNode.removeEventListener("scroll", syncActiveSection);
  }, [isSettingsOpen]);

  useEffect(() => {
    if (!jobs.some((job) => job.state === "Running")) {
      return;
    }
    const intervalId = window.setInterval(() => {
      refreshJobs().catch(console.error);
    }, 3000);
    return () => window.clearInterval(intervalId);
  }, [jobs]);

  // Detect Running → Completed transitions to trigger the progress bar flash
  useEffect(() => {
    if (!jobsInitialized || notificationBaselineReadyRef.current) {
      return;
    }

    prevJobIdsRef.current = new Set(jobs.map((job) => job.id));
    prevNotificationStatesRef.current = new Map(jobs.map((job) => [job.id, job.state]));
    notificationBaselineReadyRef.current = true;
  }, [jobs, jobsInitialized]);

  useEffect(() => {
    if (!jobsInitialized || !notificationBaselineReadyRef.current) {
      return;
    }

    const previousIds = prevJobIdsRef.current;
    const currentIds = new Set(jobs.map((job) => job.id));
    const addedJobs = jobs.filter((job) => !previousIds.has(job.id));
    prevJobIdsRef.current = currentIds;

    if (!settings.notify_added || addedJobs.length === 0) {
      return;
    }

    for (const job of addedJobs) {
      void sendNativeNotification("Download added", job.file_name).catch(console.error);
    }
  }, [jobs, jobsInitialized, settings.notify_added]);

  useEffect(() => {
    if (!jobsInitialized || !notificationBaselineReadyRef.current) {
      return;
    }

    const previousStates = prevNotificationStatesRef.current;
    const completedJobs: DownloadJob[] = [];
    const failedJobs: DownloadJob[] = [];

    for (const job of jobs) {
      const previousState = previousStates.get(job.id);
      if (previousState && previousState !== job.state) {
        if (job.state === "Completed") {
          completedJobs.push(job);
        } else if (job.state === "Failed") {
          failedJobs.push(job);
        }
      }
    }

    prevNotificationStatesRef.current = new Map(jobs.map((job) => [job.id, job.state]));

    if (settings.notify_completed) {
      for (const job of completedJobs) {
        void sendNativeNotification("Download completed", job.file_name).catch(console.error);
      }
    }

    if (settings.notify_failed) {
      for (const job of failedJobs) {
        const body = job.error_message?.trim()
          ? `${job.file_name}\n${job.error_message.trim()}`
          : job.file_name;
        void sendNativeNotification("Download failed", body).catch(console.error);
      }
    }
  }, [jobs, jobsInitialized, settings.notify_completed, settings.notify_failed]);

  useEffect(() => {
    if (!jobsInitialized) {
      prevJobStatesRef.current = new Map(jobs.map((j) => [j.id, j.state]));
      return;
    }
    const prevStates = prevJobStatesRef.current;
    const newCompleting: string[] = [];
    for (const job of jobs) {
      if (prevStates.get(job.id) === "Running" && job.state === "Completed") {
        newCompleting.push(job.id);
      }
    }
    prevJobStatesRef.current = new Map(jobs.map((j) => [j.id, j.state]));
    if (newCompleting.length === 0) return;
    setCompletingJobIds((prev) => {
      const next = new Set(prev);
      newCompleting.forEach((id) => next.add(id));
      return next;
    });
    const animationTimer = setTimeout(() => {
      setCompletingJobIds((prev) => {
        const next = new Set(prev);
        newCompleting.forEach((id) => next.delete(id));
        return next;
      });
    }, 800);
    const autoRemoveIds = settings.remove_completed_files
      ? newCompleting.filter((id) => {
          if (autoRemovingCompletedIdsRef.current.has(id)) {
            return false;
          }
          autoRemovingCompletedIdsRef.current.add(id);
          return true;
        })
      : [];
    const removeTimer =
      autoRemoveIds.length > 0
        ? setTimeout(() => {
            autoRemoveIds.forEach((id) => {
              removeJobFromList(id)
                .catch(console.error)
                .finally(() => {
                  autoRemovingCompletedIdsRef.current.delete(id);
                });
            });
          }, 820)
        : null;
    return () => {
      clearTimeout(animationTimer);
      if (removeTimer) {
        clearTimeout(removeTimer);
        autoRemoveIds.forEach((id) => autoRemovingCompletedIdsRef.current.delete(id));
      }
    };
  }, [jobs, jobsInitialized, settings.remove_completed_files]);

  // Pulse the Active tab count when a new download starts.
  // Derived inline from jobs to avoid referencing activeCount before its declaration.
  useEffect(() => {
    const count = jobs.filter((j) => j.state === "Running").length;
    if (!jobsInitialized) {
      prevActiveCountRef.current = count;
      return;
    }
    if (count > prevActiveCountRef.current) {
      setActiveCountPulsing(true);
      const timer = setTimeout(() => setActiveCountPulsing(false), 500);
      prevActiveCountRef.current = count;
      return () => clearTimeout(timer);
    }
    prevActiveCountRef.current = count;
  }, [jobs, jobsInitialized]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<DownloadProgressEvent>("download-progress", (event) => {
      const { id, downloaded_bytes, total_bytes, speed_bps } = event.payload;
      setJobs((currentJobs) =>
        currentJobs.map((job) =>
          job.id === id
            ? {
                ...job,
                downloaded_bytes,
                total_bytes: total_bytes ?? job.total_bytes,
                speed_bps,
              }
            : job,
        ),
      );
    })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch(console.error);
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    setUrlMetadata(null);
    setUrlMetadataError("");

    if (!isAddOpen || !isHttpUrl(url)) {
      setIsUrlMetadataLoading(false);
      return;
    }

    const hasObservedFileName = Boolean(browserObservedMetadata?.file_name?.trim());
    const hasObservedSize = browserObservedMetadata?.total_bytes != null;
    if (isBrowserObservedDownload && hasObservedFileName && hasObservedSize) {
      setIsUrlMetadataLoading(false);
      return;
    }

    let isCurrentRequest = true;
    setIsUrlMetadataLoading(true);

    const timeoutId = window.setTimeout(() => {
      invoke<DownloadUrlMetadata>("inspect_download_url", { url })
        .then((metadata) => {
          if (isCurrentRequest) {
            setUrlMetadata(metadata);
          }
        })
        .catch((caughtError) => {
          if (isCurrentRequest) {
            setUrlMetadataError(String(caughtError));
          }
        })
        .finally(() => {
          if (isCurrentRequest) {
            setIsUrlMetadataLoading(false);
          }
        });
    }, 500);

    return () => {
      isCurrentRequest = false;
      window.clearTimeout(timeoutId);
    };
  }, [isAddOpen, url]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setScheduleClock(Date.now());
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const iconRequests = jobs.map(getJobIconRequest);

    iconRequests.forEach((iconRequest) => {
      if (systemIcons[iconRequest.key] || pendingIconKeysRef.current.has(iconRequest.key)) {
        return;
      }

      pendingIconKeysRef.current.add(iconRequest.key);
      invoke<string | null>("get_system_file_icon", {
        pathHint: iconRequest.pathHint,
        isDirectory: iconRequest.isDirectory,
      })
        .then((iconDataUrl) => {
          if (!iconDataUrl) {
            return;
          }

          setSystemIcons((currentIcons) => {
            if (currentIcons[iconRequest.key] === iconDataUrl) {
              return currentIcons;
            }

            return {
              ...currentIcons,
              [iconRequest.key]: iconDataUrl,
            };
          });
        })
        .catch(console.error)
        .finally(() => {
          pendingIconKeysRef.current.delete(iconRequest.key);
        });
    });
  }, [jobs, systemIcons]);

  async function refreshJobs() {
    const savedJobs = await invoke<DownloadJob[]>("list_download_jobs");
    setJobs(savedJobs);
    setJobsInitialized(true);
    setSelectedJobIds((currentIds) =>
      currentIds.filter((id) => savedJobs.some((job) => job.id === id)),
    );
  }

  async function createJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const job = await invoke<DownloadJob>("create_download_job", {
        request: {
          url,
          suggested_file_name: pendingSuggestedFileName || null,
          output_folder: outputFolder || null,
          scheduler_enabled: isSchedulerEnabled,
          schedule_days: isSchedulerEnabled ? scheduleDays : [],
          schedule_from: isSchedulerEnabled ? scheduleFrom : null,
          schedule_to: isSchedulerEnabled ? scheduleTo : null,
        },
      });
      setJobs((currentJobs) => [job, ...currentJobs]);
      setNewestJobId(job.id);
      setUrl("");
      setPendingSuggestedFileName("");
      setOutputFolder("");
      setIsBrowserObservedDownload(false);
      setBrowserObservedMetadata(null);
      setIsSchedulerEnabled(false);
      setScheduleDays(SCHEDULE_DAYS);
      setScheduleFrom("06:00");
      setScheduleTo("10:00");
      setUrlMetadata(null);
      setUrlMetadataError("");
      setIsAddAnimatingOut(true);
      setTimeout(() => {
        setIsAddOpen(false);
        setIsAddAnimatingOut(false);
      }, 220);
      await refreshJobs();
    } catch (caughtError) {
      setError(String(caughtError));
    } finally {
      setIsSubmitting(false);
    }
  }

  function openBlankAddDialog() {
    setError("");
    setUrl("");
    setPendingSuggestedFileName("");
    setOutputFolder(preferredOutputFolderFromSettings(settingsRef.current));
    setIsBrowserObservedDownload(false);
    setBrowserObservedMetadata(null);
    setIsSchedulerEnabled(false);
    setScheduleDays(SCHEDULE_DAYS);
    setScheduleFrom("06:00");
    setScheduleTo("10:00");
    setUrlMetadata(null);
    setUrlMetadataError("");
    setIsAddOpen(true);
  }

  function closeAddDialog() {
    setIsAddAnimatingOut(true);
    setTimeout(() => {
      setIsAddOpen(false);
      setIsAddAnimatingOut(false);
      setPendingSuggestedFileName("");
      setIsBrowserObservedDownload(false);
      setBrowserObservedMetadata(null);
    }, 220);
  }

  function closeStartupPrompt() {
    setIsStartupPromptAnimatingOut(true);
    setTimeout(() => {
      setIsStartupPromptOpen(false);
      setIsStartupPromptAnimatingOut(false);
      setStartupPromptError("");
    }, 220);
  }

  async function resolveStartupPrompt(launchAtStartup: boolean) {
    setIsStartupPromptSaving(true);
    setStartupPromptError("");

    try {
      const currentSettings = settingsRef.current;
      const updatedSettings = await invoke<AppSettings>("update_app_settings", {
        request: {
          max_concurrent_downloads: currentSettings.max_concurrent_downloads,
          retry_enabled: currentSettings.retry_enabled,
          retry_attempts: currentSettings.retry_attempts,
          retry_delay_seconds: currentSettings.retry_delay_seconds,
          default_connection_count: currentSettings.default_connection_count,
          default_download_speed_limit_kbps: currentSettings.default_download_speed_limit_kbps,
          bandwidth_schedule_enabled: currentSettings.bandwidth_schedule_enabled,
          bandwidth_schedule_start: currentSettings.bandwidth_schedule_start,
          bandwidth_schedule_end: currentSettings.bandwidth_schedule_end,
          bandwidth_schedule_limit_kbps: currentSettings.bandwidth_schedule_limit_kbps,
          close_to_tray: currentSettings.close_to_tray,
          launch_at_startup: launchAtStartup,
          start_minimized: currentSettings.start_minimized,
          startup_prompt_answered: true,
          default_folder_mode: currentSettings.default_folder_mode,
          fixed_download_folder: currentSettings.fixed_download_folder,
          show_save_as_button: currentSettings.show_save_as_button,
          delete_button_action: currentSettings.delete_button_action,
          file_exists_action: currentSettings.file_exists_action,
          remove_deleted_files: currentSettings.remove_deleted_files,
          remove_completed_files: currentSettings.remove_completed_files,
          bottom_panel_follows_selection: currentSettings.bottom_panel_follows_selection,
          show_tray_activity: currentSettings.show_tray_activity,
          use_custom_sort_order: currentSettings.use_custom_sort_order,
          skip_web_pages: currentSettings.skip_web_pages,
          use_server_file_time: currentSettings.use_server_file_time,
          mark_downloaded_files: currentSettings.mark_downloaded_files,
          browser_intercept_downloads: currentSettings.browser_intercept_downloads,
          browser_start_without_confirmation:
            currentSettings.browser_start_without_confirmation,
          browser_skip_domains: currentSettings.browser_skip_domains,
          browser_skip_extensions: currentSettings.browser_skip_extensions,
          browser_capture_extensions: currentSettings.browser_capture_extensions,
          browser_minimum_size_mb: currentSettings.browser_minimum_size_mb,
          browser_use_native_fallback: currentSettings.browser_use_native_fallback,
          browser_ignore_insert_key: currentSettings.browser_ignore_insert_key,
          proxy_mode: currentSettings.proxy_mode,
          proxy_host: currentSettings.proxy_host,
          proxy_port: currentSettings.proxy_port,
          proxy_username: currentSettings.proxy_username,
          proxy_password: currentSettings.proxy_password,
          notify_added: currentSettings.notify_added,
          notify_completed: currentSettings.notify_completed,
          notify_failed: currentSettings.notify_failed,
          notify_inactive_only: currentSettings.notify_inactive_only,
          play_sounds: currentSettings.play_sounds,
          completion_hook_enabled: currentSettings.completion_hook_enabled,
          completion_hook_path: currentSettings.completion_hook_path,
          completion_hook_arguments: currentSettings.completion_hook_arguments,
          avoid_sleep_with_active_downloads:
            currentSettings.avoid_sleep_with_active_downloads,
          avoid_sleep_with_scheduled_downloads:
            currentSettings.avoid_sleep_with_scheduled_downloads,
          allow_sleep_if_resumable: currentSettings.allow_sleep_if_resumable,
          check_for_updates_automatically:
            currentSettings.check_for_updates_automatically,
          install_updates_automatically:
            currentSettings.install_updates_automatically,
          test_toggle: currentSettings.test_toggle,
        },
      });
      setSettings(updatedSettings);
      setPreferencesDraft((currentDraft) => ({
        ...currentDraft,
        launchAtStartup: updatedSettings.launch_at_startup,
        startMinimized: updatedSettings.start_minimized,
        closeToTray: updatedSettings.close_to_tray,
        notifyAdded: updatedSettings.notify_added,
        notifyCompleted: updatedSettings.notify_completed,
        notifyFailed: updatedSettings.notify_failed,
        notifyInactiveOnly: updatedSettings.notify_inactive_only,
        playSounds: updatedSettings.play_sounds,
        completionHookEnabled: updatedSettings.completion_hook_enabled,
        completionHookPath: updatedSettings.completion_hook_path,
        completionHookArguments: updatedSettings.completion_hook_arguments,
        avoidSleepWithActiveDownloads: updatedSettings.avoid_sleep_with_active_downloads,
        avoidSleepWithScheduledDownloads:
          updatedSettings.avoid_sleep_with_scheduled_downloads,
        allowSleepIfResumable: updatedSettings.allow_sleep_if_resumable,
        checkForUpdatesAutomatically:
          updatedSettings.check_for_updates_automatically,
        installUpdatesAutomatically:
          updatedSettings.install_updates_automatically,
        testToggle: updatedSettings.test_toggle,
      }));
      closeStartupPrompt();
    } catch (caughtError) {
      setStartupPromptError(String(caughtError));
    } finally {
      setIsStartupPromptSaving(false);
    }
  }

  async function deleteJob(id: string) {
    setDeletingJobIds((prev) => new Set([...prev, id]));
    await new Promise((resolve) => setTimeout(resolve, 280));
    await invoke<boolean>("delete_download_job", { id });
    setJobs((currentJobs) => currentJobs.filter((job) => job.id !== id));
    setSelectedJobIds((currentIds) => currentIds.filter((jobId) => jobId !== id));
    setDeletingJobIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function removeJobFromList(id: string) {
    setDeletingJobIds((prev) => new Set([...prev, id]));
    await new Promise((resolve) => setTimeout(resolve, 280));
    await invoke<boolean>("remove_download_job", { id });
    setJobs((currentJobs) => currentJobs.filter((job) => job.id !== id));
    setSelectedJobIds((currentIds) => currentIds.filter((jobId) => jobId !== id));
    setDeletingJobIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function handleDeleteAction(id: string) {
    switch (settings.delete_button_action) {
      case "remove":
        await removeJobFromList(id);
        return;
      case "delete":
        await deleteJob(id);
        return;
      default: {
        const shouldDeleteFiles = window.confirm(
          "Delete downloaded files from disk too?\n\nChoose OK to delete files and remove the item, or Cancel to remove the item from Trinity only.",
        );
        if (shouldDeleteFiles) {
          await deleteJob(id);
        } else {
          await removeJobFromList(id);
        }
      }
    }
  }

  async function startJob(id: string) {
    await invoke<void>("start_download_job", { id });
    await refreshJobs();
  }

  async function cancelJob(id: string) {
    await invoke<void>("cancel_download_job", { id });
    await refreshJobs();
  }

  async function pauseJob(id: string) {
    await invoke<void>("pause_download_job", { id });
    await refreshJobs();
  }

  async function startSelectedJobs() {
    const jobsToStart = selectedJobs.filter(canStart);
    await Promise.all(jobsToStart.map((job) => invoke<void>("start_download_job", { id: job.id })));
    await refreshJobs();
  }

  async function pauseSelectedJobs() {
    const runningJobs = selectedJobs.filter((job) => job.state === "Running");
    await Promise.all(runningJobs.map((job) => invoke<void>("pause_download_job", { id: job.id })));
    await refreshJobs();
  }

  async function pauseAllRunningJobs() {
    await invoke<void>("stop_queue");
    await refreshJobs();
  }

  async function deleteSelectedJobs() {
    const deletableJobs = selectedJobs.filter((job) => job.state !== "Running");
    await Promise.all(
      deletableJobs.map((job) => invoke<boolean>("delete_download_job", { id: job.id })),
    );
    setJobs((currentJobs) =>
      currentJobs.filter((job) => !deletableJobs.some((deleted) => deleted.id === job.id)),
    );
    setSelectedJobIds([]);
  }

  async function moveSelectedJobUp() {
    if (!settings.use_custom_sort_order || selectedJobs.length !== 1) {
      return;
    }

    await invoke<boolean>("move_download_job_up", { id: selectedJobs[0].id });
    await refreshJobs();
  }

  async function moveSelectedJobDown() {
    if (!settings.use_custom_sort_order || selectedJobs.length !== 1) {
      return;
    }

    await invoke<boolean>("move_download_job_down", { id: selectedJobs[0].id });
    await refreshJobs();
  }

  async function updateSelectedPriority(priority: number) {
    const orderableJobs = selectedJobs.filter(isQueueManageable);
    await Promise.all(
      orderableJobs.map((job) =>
        invoke<boolean>("update_download_priority", {
          request: { id: job.id, priority },
        }),
      ),
    );
    await refreshJobs();
  }

  async function reorderQueueJob(draggedId: string, targetId: string) {
    if (!settings.use_custom_sort_order || draggedId === targetId) {
      return;
    }

    await invoke<boolean>("reorder_download_job", {
      request: { dragged_id: draggedId, target_id: targetId },
    });
    await refreshJobs();
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updatedSettings = await invoke<AppSettings>("update_app_settings", {
      request: {
        max_concurrent_downloads: preferencesDraft.maxConcurrentDownloads,
        retry_enabled: preferencesDraft.retryMode === "auto",
        retry_attempts: preferencesDraft.retryAttempts,
        retry_delay_seconds: preferencesDraft.retryDelaySeconds,
        default_connection_count: preferencesDraft.defaultConnectionCount,
        default_download_speed_limit_kbps: preferencesDraft.defaultDownloadSpeedLimitKbps,
        bandwidth_schedule_enabled: preferencesDraft.bandwidthScheduleEnabled,
        bandwidth_schedule_start: preferencesDraft.bandwidthScheduleStart,
        bandwidth_schedule_end: preferencesDraft.bandwidthScheduleEnd,
        bandwidth_schedule_limit_kbps: preferencesDraft.bandwidthScheduleLimitKbps,
        close_to_tray: preferencesDraft.closeToTray,
        launch_at_startup: preferencesDraft.launchAtStartup,
        start_minimized: preferencesDraft.startMinimized,
        startup_prompt_answered: settings.startup_prompt_answered,
        default_folder_mode: preferencesDraft.defaultFolderMode,
        fixed_download_folder: preferencesDraft.fixedDownloadFolder,
        show_save_as_button: preferencesDraft.showSaveAsButton,
        delete_button_action: preferencesDraft.deleteButtonAction,
        file_exists_action: preferencesDraft.fileExistsAction,
        remove_deleted_files: preferencesDraft.removeDeletedFiles,
        remove_completed_files: preferencesDraft.removeCompletedFiles,
        bottom_panel_follows_selection: preferencesDraft.bottomPanelFollowsSelection,
        show_tray_activity: preferencesDraft.showTrayActivity,
        use_custom_sort_order: preferencesDraft.useCustomSortOrder,
        skip_web_pages: preferencesDraft.skipWebPages,
        use_server_file_time: preferencesDraft.useServerFileTime,
        mark_downloaded_files: preferencesDraft.markDownloadedFiles,
        browser_intercept_downloads: preferencesDraft.browserInterceptDownloads,
        browser_start_without_confirmation:
          preferencesDraft.browserStartWithoutConfirmation,
        browser_skip_domains: preferencesDraft.browserSkipDomains,
        browser_skip_extensions: preferencesDraft.browserSkipExtensions,
        browser_capture_extensions: preferencesDraft.browserCaptureExtensions,
        browser_minimum_size_mb: preferencesDraft.browserMinimumSizeMb,
        browser_use_native_fallback: preferencesDraft.browserUseNativeFallback,
        browser_ignore_insert_key: preferencesDraft.browserIgnoreInsertKey,
        proxy_mode: preferencesDraft.proxyMode,
        proxy_host: preferencesDraft.proxyHost,
        proxy_port: parseInt(preferencesDraft.proxyPort, 10) || 8080,
        proxy_username: preferencesDraft.proxyUsername,
        proxy_password: preferencesDraft.proxyPassword,
        notify_added: preferencesDraft.notifyAdded,
        notify_completed: preferencesDraft.notifyCompleted,
        notify_failed: preferencesDraft.notifyFailed,
        notify_inactive_only: preferencesDraft.notifyInactiveOnly,
        play_sounds: preferencesDraft.playSounds,
        completion_hook_enabled: preferencesDraft.completionHookEnabled,
        completion_hook_path: preferencesDraft.completionHookPath,
        completion_hook_arguments: preferencesDraft.completionHookArguments,
        avoid_sleep_with_active_downloads: preferencesDraft.avoidSleepWithActiveDownloads,
        avoid_sleep_with_scheduled_downloads:
          preferencesDraft.avoidSleepWithScheduledDownloads,
        allow_sleep_if_resumable: preferencesDraft.allowSleepIfResumable,
        check_for_updates_automatically:
          preferencesDraft.checkForUpdatesAutomatically,
        install_updates_automatically:
          preferencesDraft.installUpdatesAutomatically,
        test_toggle: preferencesDraft.testToggle,
      },
    });
    setSettings(updatedSettings);
    setPreferencesDraft((currentDraft) => ({
      ...currentDraft,
      maxConcurrentDownloads: updatedSettings.max_concurrent_downloads,
      autoRetryFailedDownloads: updatedSettings.retry_enabled,
      retryMode: updatedSettings.retry_enabled ? "auto" : "manual",
      retryAttempts: updatedSettings.retry_attempts,
      retryDelaySeconds: updatedSettings.retry_delay_seconds,
      defaultConnectionCount: updatedSettings.default_connection_count,
      defaultDownloadSpeedLimitKbps: updatedSettings.default_download_speed_limit_kbps,
      bandwidthScheduleEnabled: updatedSettings.bandwidth_schedule_enabled,
      bandwidthScheduleStart: updatedSettings.bandwidth_schedule_start,
      bandwidthScheduleEnd: updatedSettings.bandwidth_schedule_end,
      bandwidthScheduleLimitKbps: updatedSettings.bandwidth_schedule_limit_kbps,
      closeToTray: updatedSettings.close_to_tray,
      launchAtStartup: updatedSettings.launch_at_startup,
      startMinimized: updatedSettings.start_minimized,
      defaultFolderMode: updatedSettings.default_folder_mode,
      fixedDownloadFolder: updatedSettings.fixed_download_folder,
      showSaveAsButton: updatedSettings.show_save_as_button,
      deleteButtonAction: updatedSettings.delete_button_action,
      fileExistsAction: updatedSettings.file_exists_action,
      removeDeletedFiles: updatedSettings.remove_deleted_files,
      removeCompletedFiles: updatedSettings.remove_completed_files,
      bottomPanelFollowsSelection: updatedSettings.bottom_panel_follows_selection,
      showTrayActivity: updatedSettings.show_tray_activity,
      useCustomSortOrder: updatedSettings.use_custom_sort_order,
      skipWebPages: updatedSettings.skip_web_pages,
      useServerFileTime: updatedSettings.use_server_file_time,
      markDownloadedFiles: updatedSettings.mark_downloaded_files,
      browserInterceptDownloads: updatedSettings.browser_intercept_downloads,
      browserStartWithoutConfirmation: updatedSettings.browser_start_without_confirmation,
      browserSkipDomains: updatedSettings.browser_skip_domains,
      browserSkipExtensions: updatedSettings.browser_skip_extensions,
      browserCaptureExtensions: updatedSettings.browser_capture_extensions,
      browserMinimumSizeMb: updatedSettings.browser_minimum_size_mb,
      browserUseNativeFallback: updatedSettings.browser_use_native_fallback,
      browserIgnoreInsertKey: updatedSettings.browser_ignore_insert_key,
      proxyMode: updatedSettings.proxy_mode,
      proxyHost: updatedSettings.proxy_host,
      proxyPort: String(updatedSettings.proxy_port),
      proxyUsername: updatedSettings.proxy_username,
      proxyPassword: updatedSettings.proxy_password,
      notifyAdded: updatedSettings.notify_added,
      notifyCompleted: updatedSettings.notify_completed,
      notifyFailed: updatedSettings.notify_failed,
      notifyInactiveOnly: updatedSettings.notify_inactive_only,
      playSounds: updatedSettings.play_sounds,
      completionHookEnabled: updatedSettings.completion_hook_enabled,
      completionHookPath: updatedSettings.completion_hook_path,
      completionHookArguments: updatedSettings.completion_hook_arguments,
      avoidSleepWithActiveDownloads: updatedSettings.avoid_sleep_with_active_downloads,
      avoidSleepWithScheduledDownloads:
        updatedSettings.avoid_sleep_with_scheduled_downloads,
      allowSleepIfResumable: updatedSettings.allow_sleep_if_resumable,
      checkForUpdatesAutomatically:
        updatedSettings.check_for_updates_automatically,
      installUpdatesAutomatically:
        updatedSettings.install_updates_automatically,
      testToggle: updatedSettings.test_toggle,
    }));
    if (
      updatedSettings.notify_added ||
      updatedSettings.notify_completed ||
      updatedSettings.notify_failed
    ) {
      notificationPermissionRef.current = null;
      void ensureNotificationPermission().catch(console.error);
    }
    setPreferencesStatus("Settings saved.");
    await refreshJobs();
  }

  function openPreferencesPage() {
    setPreferencesDraft((currentDraft) => ({
      ...currentDraft,
      maxConcurrentDownloads: settings.max_concurrent_downloads,
      autoRetryFailedDownloads: settings.retry_enabled,
      retryMode: settings.retry_enabled ? "auto" : "manual",
      retryAttempts: settings.retry_attempts,
      retryDelaySeconds: settings.retry_delay_seconds,
      defaultConnectionCount: settings.default_connection_count,
      defaultDownloadSpeedLimitKbps: settings.default_download_speed_limit_kbps,
      bandwidthScheduleEnabled: settings.bandwidth_schedule_enabled,
      bandwidthScheduleStart: settings.bandwidth_schedule_start,
      bandwidthScheduleEnd: settings.bandwidth_schedule_end,
      bandwidthScheduleLimitKbps: settings.bandwidth_schedule_limit_kbps,
      closeToTray: settings.close_to_tray,
      launchAtStartup: settings.launch_at_startup,
      startMinimized: settings.start_minimized,
      defaultFolderMode: settings.default_folder_mode,
      fixedDownloadFolder: settings.fixed_download_folder,
      showSaveAsButton: settings.show_save_as_button,
      deleteButtonAction: settings.delete_button_action,
      fileExistsAction: settings.file_exists_action,
      removeDeletedFiles: settings.remove_deleted_files,
      removeCompletedFiles: settings.remove_completed_files,
      bottomPanelFollowsSelection: settings.bottom_panel_follows_selection,
      showTrayActivity: settings.show_tray_activity,
      useCustomSortOrder: settings.use_custom_sort_order,
      skipWebPages: settings.skip_web_pages,
      useServerFileTime: settings.use_server_file_time,
      markDownloadedFiles: settings.mark_downloaded_files,
      browserInterceptDownloads: settings.browser_intercept_downloads,
      browserStartWithoutConfirmation: settings.browser_start_without_confirmation,
      browserSkipDomains: settings.browser_skip_domains,
      browserSkipExtensions: settings.browser_skip_extensions,
      browserCaptureExtensions: settings.browser_capture_extensions,
      browserMinimumSizeMb: settings.browser_minimum_size_mb,
      browserUseNativeFallback: settings.browser_use_native_fallback,
      browserIgnoreInsertKey: settings.browser_ignore_insert_key,
      proxyMode: settings.proxy_mode,
      proxyHost: settings.proxy_host,
      proxyPort: String(settings.proxy_port),
      proxyUsername: settings.proxy_username,
      proxyPassword: settings.proxy_password,
      notifyAdded: settings.notify_added,
      notifyCompleted: settings.notify_completed,
      notifyFailed: settings.notify_failed,
      notifyInactiveOnly: settings.notify_inactive_only,
      playSounds: settings.play_sounds,
      completionHookEnabled: settings.completion_hook_enabled,
      completionHookPath: settings.completion_hook_path,
      completionHookArguments: settings.completion_hook_arguments,
      avoidSleepWithActiveDownloads: settings.avoid_sleep_with_active_downloads,
      avoidSleepWithScheduledDownloads: settings.avoid_sleep_with_scheduled_downloads,
      allowSleepIfResumable: settings.allow_sleep_if_resumable,
    }));
    setPreferencesStatus("");
    setActivePreferencesSection("general");
    setIsSettingsOpen(true);
  }

  function closePreferencesPage() {
    setPreferencesStatus("");
    setIsSettingsOpen(false);
  }

  async function chooseOutputFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: outputFolder || undefined,
    });

    if (typeof selected === "string") {
      setOutputFolder(selected);
    }
  }

  async function useDefaultOutputFolder() {
    const folder = await invoke<string>("get_default_download_folder");
    setOutputFolder(folder);
  }

  async function choosePreferenceFolder(
    key: "fixedDownloadFolder" | "distributedWatchFolder",
  ) {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: preferencesDraft[key] || undefined,
    });

    if (typeof selected === "string") {
      setPreferencesDraft((currentDraft) => ({
        ...currentDraft,
        [key]: selected,
      }));
    }
  }

  async function choosePreferenceFile(
    key: "antivirusPath" | "completionHookPath",
  ) {
    const selected = await open({
      directory: false,
      multiple: false,
      defaultPath: preferencesDraft[key] || undefined,
    });

    if (typeof selected === "string") {
      setPreferencesDraft((currentDraft) => ({
        ...currentDraft,
        [key]: selected,
      }));
    }
  }

  function setPreferenceValue<Key extends keyof PreferencesDraft>(
    key: Key,
    value: PreferencesDraft[Key],
  ) {
    setPreferencesDraft((currentDraft) => ({
      ...currentDraft,
      [key]: value,
    }));
  }

  function jumpToPreferencesSection(sectionId: PreferencesSectionId) {
    setActivePreferencesSection(sectionId);
    document
      .getElementById(`preferences-${sectionId}`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function toggleScheduleDay(day: string) {
    setScheduleDays((currentDays) => {
      if (day === "Everyday") {
        return currentDays.includes("Everyday") ? [] : SCHEDULE_DAYS;
      }

      const withoutEveryday = currentDays.filter((currentDay) => currentDay !== "Everyday");
      const nextDays = withoutEveryday.includes(day)
        ? withoutEveryday.filter((currentDay) => currentDay !== day)
        : [...withoutEveryday, day];
      const allWeekDaysSelected = SCHEDULE_DAYS.slice(1).every((currentDay) =>
        nextDays.includes(currentDay),
      );

      return allWeekDaysSelected ? SCHEDULE_DAYS : nextDays;
    });
  }

  function toggleJobSelection(id: string) {
    setSelectedJobIds((currentIds) =>
      currentIds.includes(id)
        ? currentIds.filter((currentId) => currentId !== id)
        : [...currentIds, id],
    );
  }

  function toggleAllJobs() {
    setSelectedJobIds((currentIds) =>
      visibleJobs.length > 0 && visibleJobs.every((job) => currentIds.includes(job.id))
        ? currentIds.filter((id) => !visibleJobs.some((job) => job.id === id))
        : Array.from(new Set([...currentIds, ...visibleJobs.map((job) => job.id)])),
    );
  }

  function handleRowDragStart(job: DownloadJob) {
    if (!settings.use_custom_sort_order || !isQueueManageable(job)) {
      return;
    }

    setDraggedJobId(job.id);
    setDropTargetJobId(null);
  }

  function handleRowDrop(job: DownloadJob) {
    if (!settings.use_custom_sort_order || !draggedJobId || draggedJobId === job.id) {
      setDraggedJobId(null);
      setDropTargetJobId(null);
      return;
    }

    const draggedJob = jobs.find((candidate) => candidate.id === draggedJobId);
    if (!draggedJob || !canDragOntoRow(draggedJob, job)) {
      setDraggedJobId(null);
      setDropTargetJobId(null);
      return;
    }

    reorderQueueJob(draggedJobId, job.id).catch(console.error);
    setDraggedJobId(null);
    setDropTargetJobId(null);
  }

  const queuedCount = jobs.filter((job) => job.state === "Queued").length;
  const activeCount = jobs.filter((job) => job.state === "Running").length;
  const completedCount = jobs.filter((job) => job.state === "Completed").length;
  const failedCount = jobs.filter((job) => job.state === "Failed").length;
  const pausedCount = jobs.filter((job) => job.state === "Paused").length;
  const incompleteCount = jobs.filter(
    (job) => job.state !== "Completed" && job.state !== "Canceled",
  ).length;
  const visibleJobs = jobs.filter((job) =>
    matchesMainTab(job, activeTab) &&
    matchesCategoryFilter(job, activeCategory) &&
    matchesPriorityFilter(job, priorityFilter) &&
    matchesQueueScope(job, queueScope) &&
    matchesSearchFilter(job, queueSearch),
  );
  const globalSpeed = jobs
    .filter((job) => job.state === "Running")
    .reduce((total, job) => total + job.speed_bps, 0);
  const selectedJobs = jobs.filter((job) => selectedJobIds.includes(job.id));
  const canResumeSelected = selectedJobs.some(canStart);
  const canStopSelected = selectedJobs.some((job) => job.state === "Running");
  const canStopAll = jobs.some((job) => job.state === "Running");
  const canDeleteSelected = selectedJobs.some((job) => job.state !== "Running");
  const canMoveSelected =
    settings.use_custom_sort_order &&
    selectedJobs.length === 1 &&
    isQueueManageable(selectedJobs[0]);
  const canChangePrioritySelected = selectedJobs.some(isQueueManageable);
  const scheduleNow = new Date(scheduleClock);

  return (
    <main className="app-shell">
      <section className="command-bar" aria-label="Download commands">
        <button className="tool-button add" onClick={() => openBlankAddDialog()}>
          <span>
            <Plus size={30} strokeWidth={2.4} />
          </span>
          Add URL
        </button>
        <button
          className="tool-button"
          disabled={!canResumeSelected}
          onClick={() => startSelectedJobs()}
        >
          <span>
            <Play size={28} strokeWidth={1.9} />
          </span>
          Resume
        </button>
        <button
          className="tool-button"
          disabled={!canStopSelected}
          onClick={() => pauseSelectedJobs()}
        >
          <span>
            <Square size={25} strokeWidth={1.9} />
          </span>
          Stop
        </button>
        <button
          className="tool-button"
          disabled={!canStopAll}
          onClick={() => pauseAllRunningJobs()}
        >
          <span>
            <Square size={25} strokeWidth={1.9} />
            <Square size={18} strokeWidth={1.9} />
          </span>
          Stop All
        </button>
        <button
          className="tool-button"
          disabled={!canDeleteSelected}
          onClick={() => deleteSelectedJobs()}
        >
          <span>
            <Trash2 size={27} strokeWidth={1.9} />
          </span>
          Delete
        </button>
        <button
          className="tool-button"
          disabled={!canMoveSelected}
          onClick={() => moveSelectedJobUp()}
        >
          <span>
            <ArrowUp size={24} strokeWidth={2} />
          </span>
          Queue Up
        </button>
        <button
          className="tool-button"
          disabled={!canMoveSelected}
          onClick={() => moveSelectedJobDown()}
        >
          <span>
            <ArrowDown size={24} strokeWidth={2} />
          </span>
          Queue Down
        </button>
        <button
          className="tool-button"
          disabled={!canChangePrioritySelected}
          onClick={() => updateSelectedPriority(2)}
        >
          <span>
            <Flag size={24} strokeWidth={2} />
          </span>
          High
        </button>
        <button
          className="tool-button"
          disabled={!canChangePrioritySelected}
          onClick={() => updateSelectedPriority(1)}
        >
          <span>
            <Flag size={24} strokeWidth={2} />
          </span>
          Normal
        </button>
        <button
          className="tool-button"
          disabled={!canChangePrioritySelected}
          onClick={() => updateSelectedPriority(0)}
        >
          <span>
            <Flag size={24} strokeWidth={2} />
          </span>
          Low
        </button>
        <button
          className="tool-button"
          onClick={() => openPreferencesPage()}
        >
          <span>
            <Settings size={29} strokeWidth={1.8} />
          </span>
          Options
        </button>
        <button className="tool-button" disabled>
          <span>
            <FolderInput size={29} strokeWidth={1.8} />
          </span>
          Open
        </button>
        <div className="command-spacer" />
        <button className="icon-button" onClick={() => refreshJobs()}>
          <RefreshCw size={15} strokeWidth={2} />
          Refresh
        </button>
      </section>

      <div className="view-slot">
        <div className={`view-panel settings-panel${isSettingsOpen ? " onscreen" : ""}`}>
          <section className="preferences-strip">
            <button className="preferences-back" onClick={() => closePreferencesPage()}>
              <ArrowLeft size={15} strokeWidth={2} />
              Back to downloads
            </button>
            <span className="preferences-strip-note">
              Supported today: queue, retry, bandwidth, and segmented connection controls. The rest
              are still placeholders for upcoming engine features.
            </span>
          </section>
          <section className="preferences-layout">
            <aside className="preferences-sidebar">
              <div className="preferences-sidebar-head">
                <h2>Preferences</h2>
                <p>Engine, browser, network, automation, and distributed transfer settings.</p>
              </div>
              <nav className="preferences-nav" aria-label="Preferences sections">
                {PREFERENCES_SECTIONS.map((sectionId) => (
                  <button
                    className={`preferences-nav-item ${
                      activePreferencesSection === sectionId ? "active" : ""
                    }`}
                    key={sectionId}
                    onClick={() => jumpToPreferencesSection(sectionId)}
                    type="button"
                  >
                    {preferenceSectionLabel(sectionId)}
                  </button>
                ))}
              </nav>
            </aside>

            <section className="preferences-content" ref={preferencesContentRef}>
              <form className="preferences-page" onSubmit={saveSettings}>
                <header className="preferences-page-head">
                  <div>
                    <h1>Trinity Preferences</h1>
                    <p>
                      Build the manager around your workflow now, then fill in the advanced engine
                      integrations as those systems land.
                    </p>
                  </div>
                  <div className="preferences-head-actions">
                    <button
                      className="preferences-secondary-action"
                      onClick={() => closePreferencesPage()}
                      type="button"
                    >
                      Close
                    </button>
                    <button className="preferences-primary-action" type="submit">
                      <Save size={15} strokeWidth={2} />
                      Save Changes
                    </button>
                  </div>
                </header>

                {preferencesStatus ? (
                  <div className="preferences-status">{preferencesStatus}</div>
                ) : null}

                <section className="preferences-section" id="preferences-general">
                  <div className="preferences-section-head">
                    <div>
                      <h3>General</h3>
                      <p>Desktop behavior, default folders, updates, and list behavior.</p>
                    </div>
                    <span className="preferences-badge live">Live + placeholders</span>
                  </div>
                  <div className="preferences-grid two-column">
                    <label className="preferences-field">
                      <span>Theme</span>
                      <select
                        onChange={(event) => setPreferenceValue("theme", event.currentTarget.value)}
                        value={preferencesDraft.theme}
                      >
                        <option>System</option>
                        <option>Dark</option>
                        <option>Light</option>
                      </select>
                    </label>
                    <label className="preferences-field">
                      <span>UI style</span>
                      <select
                        onChange={(event) =>
                          setPreferenceValue("uiStyle", event.currentTarget.value)
                        }
                        value={preferencesDraft.uiStyle}
                      >
                        <option>Trinity Classic</option>
                        <option>Dense Operator</option>
                        <option>Minimal</option>
                      </select>
                    </label>
                    <label className="preferences-field wide">
                      <span>Language</span>
                      <select
                        onChange={(event) =>
                          setPreferenceValue("language", event.currentTarget.value)
                        }
                        value={preferencesDraft.language}
                      >
                        <option>English (United States)</option>
                        <option>English (United Kingdom)</option>
                        <option>Spanish</option>
                      </select>
                    </label>
                  </div>

                  <div className="preferences-group">
                    <h4>Startup</h4>
                    <div className="preferences-toggle-list">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.launchAtStartup}
                          onChange={(event) =>
                            setPreferenceValue("launchAtStartup", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Launch Trinity when Windows starts
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.startMinimized}
                          onChange={(event) =>
                            setPreferenceValue("startMinimized", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Start minimized to tray
                      </label>
                    </div>
                  </div>

                  <div className="preferences-group">
                    <h4>Default download folder</h4>
                    <div className="preferences-radio-list">
                      <label className="preferences-radio">
                        <input
                          checked={preferencesDraft.defaultFolderMode === "automatic"}
                          onChange={() => setPreferenceValue("defaultFolderMode", "automatic")}
                          type="radio"
                        />
                        Choose destination automatically
                      </label>
                      <div className="preferences-inline-toggles">
                        <label className="preferences-toggle">
                          <input
                            checked={preferencesDraft.suggestFolderByType}
                            onChange={(event) =>
                              setPreferenceValue("suggestFolderByType", event.currentTarget.checked)
                            }
                            type="checkbox"
                          />
                          Suggest folders by file type
                        </label>
                        <label className="preferences-toggle">
                          <input
                            checked={preferencesDraft.suggestFolderByUrl}
                            onChange={(event) =>
                              setPreferenceValue("suggestFolderByUrl", event.currentTarget.checked)
                            }
                            type="checkbox"
                          />
                          Suggest folders by source URL
                        </label>
                      </div>
                      <label className="preferences-radio">
                        <input
                          checked={preferencesDraft.defaultFolderMode === "fixed"}
                          onChange={() => setPreferenceValue("defaultFolderMode", "fixed")}
                          type="radio"
                        />
                        Use a fixed default folder
                      </label>
                      <div className="preferences-path-row">
                        <input
                          onChange={(event) =>
                            setPreferenceValue("fixedDownloadFolder", event.currentTarget.value)
                          }
                          placeholder="C:\\Downloads\\Trinity"
                          value={preferencesDraft.fixedDownloadFolder}
                        />
                        <button
                          className="preferences-path-button"
                          onClick={() => choosePreferenceFolder("fixedDownloadFolder")}
                          type="button"
                        >
                          <MoreHorizontal size={18} strokeWidth={2} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="preferences-group">
                    <h4>Downloads</h4>
                    <div className="preferences-toggle-grid">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.compactDownloads}
                          onChange={(event) =>
                            setPreferenceValue("compactDownloads", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Compact downloads list
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.standaloneWindows}
                          onChange={(event) =>
                            setPreferenceValue("standaloneWindows", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Use standalone download windows
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.removeDeletedFiles}
                          onChange={(event) =>
                            setPreferenceValue("removeDeletedFiles", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Remove deleted files from the list
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.removeCompletedFiles}
                          onChange={(event) =>
                            setPreferenceValue(
                              "removeCompletedFiles",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Remove completed downloads automatically
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.autoRetryFailedDownloads}
                          onChange={(event) => {
                            const isEnabled = event.currentTarget.checked;
                            setPreferenceValue("autoRetryFailedDownloads", isEnabled);
                            setPreferenceValue("retryMode", isEnabled ? "auto" : "manual");
                          }}
                          type="checkbox"
                        />
                        Automatically retry failed downloads
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.skipWebPages}
                          onChange={(event) =>
                            setPreferenceValue("skipWebPages", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Ignore web page captures
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.useServerFileTime}
                          onChange={(event) =>
                            setPreferenceValue("useServerFileTime", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Use server file timestamp when available
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.markDownloadedFiles}
                          onChange={(event) =>
                            setPreferenceValue("markDownloadedFiles", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Mark downloaded files on disk
                      </label>
                    </div>
                    <div className="preferences-inline-fields">
                      <label className="preferences-field compact">
                        <span>Maximum URLs in batch add</span>
                        <input
                          min={1}
                          onChange={(event) =>
                            setPreferenceValue(
                              "maxBatchUrls",
                              Number(event.currentTarget.value || 0),
                            )
                          }
                          type="number"
                          value={preferencesDraft.maxBatchUrls}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="preferences-group">
                    <h4>Updates</h4>
                    <div className="preferences-toggle-list">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.checkForUpdatesAutomatically}
                          onChange={(event) =>
                            setPreferenceValue(
                              "checkForUpdatesAutomatically",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Check for updates automatically
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.installUpdatesAutomatically}
                          onChange={(event) =>
                            setPreferenceValue(
                              "installUpdatesAutomatically",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Install updates automatically
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.testToggle}
                          onChange={(event) =>
                            setPreferenceValue("testToggle", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Test
                      </label>
                    </div>
                    <div className="preferences-update-card">
                      <div className="preferences-update-summary">
                        <strong>Current version</strong>
                        <span>{updaterStatus.current_version}</span>
                      </div>
                      <div className="preferences-update-summary">
                        <strong>Update server</strong>
                        <span>{updaterStatus.configured ? "Configured" : "Not configured in this build"}</span>
                      </div>
                      {availableUpdate ? (
                        <div className="preferences-update-summary">
                          <strong>Available update</strong>
                          <span>{availableUpdate.version}</span>
                        </div>
                      ) : null}
                      {availableUpdate?.body ? (
                        <p className="preferences-update-notes">{availableUpdate.body}</p>
                      ) : null}
                      {updateDownloadProgress ? (
                        <p className="preferences-update-status">
                          {updateStatusMessage}
                          {updateDownloadProgress.totalBytes
                            ? ` (${formatBytes(updateDownloadProgress.downloadedBytes)} / ${formatBytes(updateDownloadProgress.totalBytes)})`
                            : ` (${formatBytes(updateDownloadProgress.downloadedBytes)})`}
                        </p>
                      ) : updateStatusMessage ? (
                        <p className="preferences-update-status">{updateStatusMessage}</p>
                      ) : null}
                      <div className="preferences-update-actions">
                        <button
                          className="preferences-secondary-button"
                          disabled={!updaterStatus.configured || isCheckingForUpdate || isInstallingUpdate}
                          onClick={() => {
                            void checkForUpdates();
                          }}
                          type="button"
                        >
                          {isCheckingForUpdate ? "Checking..." : "Check now"}
                        </button>
                        <button
                          className="preferences-primary-button"
                          disabled={!availableUpdate || isInstallingUpdate || isCheckingForUpdate}
                          onClick={() => {
                            void installAvailableUpdate();
                          }}
                          type="button"
                        >
                          {isInstallingUpdate ? "Installing..." : "Update now"}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="preferences-section" id="preferences-browserIntegration">
                  <div className="preferences-section-head">
                    <div>
                      <h3>Browser Integration</h3>
                      <p>Capture download links, hand off files, and define browser filtering.</p>
                    </div>
                    <span className="preferences-badge placeholder">Placeholder</span>
                  </div>
                  <div className="browser-button-row">
                    <button className="browser-install-button" type="button">
                      Edge extension
                    </button>
                    <button className="browser-install-button" type="button">
                      Chrome extension
                    </button>
                    <button className="browser-install-button muted" type="button">
                      Firefox extension
                    </button>
                  </div>
                  <div className="preferences-toggle-grid">
                    <label className="preferences-toggle">
                      <input
                        checked={preferencesDraft.browserInterceptDownloads}
                        onChange={(event) =>
                          setPreferenceValue(
                            "browserInterceptDownloads",
                            event.currentTarget.checked,
                          )
                        }
                        type="checkbox"
                      />
                      Intercept downloads in supported browsers
                    </label>
                    <label className="preferences-toggle">
                      <input
                        checked={preferencesDraft.browserStartWithoutConfirmation}
                        onChange={(event) =>
                          setPreferenceValue(
                            "browserStartWithoutConfirmation",
                            event.currentTarget.checked,
                          )
                        }
                        type="checkbox"
                      />
                      Start download immediately without confirmation
                    </label>
                    <label className="preferences-toggle">
                      <input
                        checked={preferencesDraft.browserUseNativeFallback}
                        onChange={(event) =>
                          setPreferenceValue(
                            "browserUseNativeFallback",
                            event.currentTarget.checked,
                          )
                        }
                        type="checkbox"
                      />
                      Use the browser if Trinity is canceled
                    </label>
                    <label className="preferences-toggle">
                      <input
                        checked={preferencesDraft.browserIgnoreInsertKey}
                        onChange={(event) =>
                          setPreferenceValue(
                            "browserIgnoreInsertKey",
                            event.currentTarget.checked,
                          )
                        }
                        type="checkbox"
                      />
                      Ignore capture while INSERT is pressed
                    </label>
                  </div>
                  <div className="preferences-grid two-column">
                    <label className="preferences-field">
                      <span>Skip domains</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("browserSkipDomains", event.currentTarget.value)
                        }
                        value={preferencesDraft.browserSkipDomains}
                      />
                    </label>
                    <label className="preferences-field">
                      <span>Skip file extensions</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("browserSkipExtensions", event.currentTarget.value)
                        }
                        value={preferencesDraft.browserSkipExtensions}
                      />
                    </label>
                    <label className="preferences-field wide">
                      <span>Prefer capture for file extensions</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("browserCaptureExtensions", event.currentTarget.value)
                        }
                        value={preferencesDraft.browserCaptureExtensions}
                      />
                    </label>
                    <label className="preferences-field compact">
                      <span>Ignore downloads smaller than</span>
                      <div className="preferences-unit-field">
                        <input
                          min={0}
                          onChange={(event) =>
                            setPreferenceValue(
                              "browserMinimumSizeMb",
                              Number(event.currentTarget.value || 0),
                            )
                          }
                          type="number"
                          value={preferencesDraft.browserMinimumSizeMb}
                        />
                        <span>MB</span>
                      </div>
                    </label>
                  </div>
                </section>

                <section className="preferences-section" id="preferences-network">
                  <div className="preferences-section-head">
                    <div>
                      <h3>Network</h3>
                      <p>Proxy routing, authentication, and connection path controls.</p>
                    </div>
                    <span className="preferences-badge live">Live</span>
                  </div>
                  <div className="preferences-radio-list">
                    <label className="preferences-radio">
                      <input
                        checked={preferencesDraft.proxyMode === "system"}
                        onChange={() => setPreferenceValue("proxyMode", "system")}
                        type="radio"
                      />
                      Use system proxy
                    </label>
                    <label className="preferences-radio">
                      <input
                        checked={preferencesDraft.proxyMode === "none"}
                        onChange={() => setPreferenceValue("proxyMode", "none")}
                        type="radio"
                      />
                      Do not use a proxy
                    </label>
                    <label className="preferences-radio">
                      <input
                        checked={preferencesDraft.proxyMode === "manual"}
                        onChange={() => setPreferenceValue("proxyMode", "manual")}
                        type="radio"
                      />
                      Configure manually
                    </label>
                  </div>
                  {preferencesDraft.proxyMode === "manual" && (
                    <div className="preferences-grid two-column">
                      <label className="preferences-field">
                        <span>Proxy host</span>
                        <input
                          onChange={(event) => setPreferenceValue("proxyHost", event.currentTarget.value)}
                          placeholder="e.g. 192.168.1.1"
                          value={preferencesDraft.proxyHost}
                        />
                      </label>
                      <label className="preferences-field">
                        <span>Port</span>
                        <input
                          onChange={(event) => setPreferenceValue("proxyPort", event.currentTarget.value)}
                          placeholder="8080"
                          value={preferencesDraft.proxyPort}
                        />
                      </label>
                      <label className="preferences-field">
                        <span>Username <small style={{ color: "#7a8895" }}>(optional)</small></span>
                        <input
                          autoComplete="off"
                          onChange={(event) =>
                            setPreferenceValue("proxyUsername", event.currentTarget.value)
                          }
                          value={preferencesDraft.proxyUsername}
                        />
                      </label>
                      <label className="preferences-field">
                        <span>Password <small style={{ color: "#7a8895" }}>(optional)</small></span>
                        <input
                          autoComplete="new-password"
                          onChange={(event) =>
                            setPreferenceValue("proxyPassword", event.currentTarget.value)
                          }
                          type="password"
                          value={preferencesDraft.proxyPassword}
                        />
                      </label>
                    </div>
                  )}
                </section>

                <section className="preferences-section" id="preferences-trafficLimits">
                  <div className="preferences-section-head">
                    <div>
                      <h3>Traffic Limits</h3>
                      <p>Connection presets, queue depth, retries, scheduled caps, and per-download speed limits.</p>
                    </div>
                    <span className="preferences-badge live">Mostly live</span>
                  </div>
                  <div className="preferences-traffic-grid">
                    <div />
                    <strong>Low</strong>
                    <strong>Medium</strong>
                    <strong>High</strong>

                    <span>Download speed</span>
                    <select
                      onChange={(event) =>
                        setPreferenceValue("limitPresetLow", event.currentTarget.value)
                      }
                      value={preferencesDraft.limitPresetLow}
                    >
                      <option>256 KB/s</option>
                      <option>512 KB/s</option>
                      <option>1 MB/s</option>
                    </select>
                    <select
                      onChange={(event) =>
                        setPreferenceValue("limitPresetMedium", event.currentTarget.value)
                      }
                      value={preferencesDraft.limitPresetMedium}
                    >
                      <option>2 MB/s</option>
                      <option>4 MB/s</option>
                      <option>8 MB/s</option>
                    </select>
                    <select
                      onChange={(event) =>
                        setPreferenceValue("limitPresetHigh", event.currentTarget.value)
                      }
                      value={preferencesDraft.limitPresetHigh}
                    >
                      <option>Unlimited</option>
                      <option>16 MB/s</option>
                      <option>32 MB/s</option>
                    </select>

                    <span>Maximum connections</span>
                    <input
                      min={1}
                      onChange={(event) =>
                        setPreferenceValue("maxConnectionsLow", Number(event.currentTarget.value || 0))
                      }
                      type="number"
                      value={preferencesDraft.maxConnectionsLow}
                    />
                    <input
                      min={1}
                      onChange={(event) =>
                        setPreferenceValue(
                          "maxConnectionsMedium",
                          Number(event.currentTarget.value || 0),
                        )
                      }
                      type="number"
                      value={preferencesDraft.maxConnectionsMedium}
                    />
                    <input
                      min={1}
                      onChange={(event) =>
                        setPreferenceValue("maxConnectionsHigh", Number(event.currentTarget.value || 0))
                      }
                      type="number"
                      value={preferencesDraft.maxConnectionsHigh}
                    />

                    <span>Connections per server</span>
                    <input
                      min={1}
                      onChange={(event) =>
                        setPreferenceValue(
                          "maxConnectionsPerServerLow",
                          Number(event.currentTarget.value || 0),
                        )
                      }
                      type="number"
                      value={preferencesDraft.maxConnectionsPerServerLow}
                    />
                    <input
                      min={1}
                      onChange={(event) =>
                        setPreferenceValue(
                          "maxConnectionsPerServerMedium",
                          Number(event.currentTarget.value || 0),
                        )
                      }
                      type="number"
                      value={preferencesDraft.maxConnectionsPerServerMedium}
                    />
                    <input
                      min={1}
                      onChange={(event) =>
                        setPreferenceValue(
                          "maxConnectionsPerServerHigh",
                          Number(event.currentTarget.value || 0),
                        )
                      }
                      type="number"
                      value={preferencesDraft.maxConnectionsPerServerHigh}
                    />
                  </div>

                  <div className="preferences-grid three-column">
                    <label className="preferences-field live">
                      <span>Default segmented connections</span>
                      <input
                        max={16}
                        min={1}
                        onChange={(event) =>
                          setPreferenceValue(
                            "defaultConnectionCount",
                            Number(event.currentTarget.value || 0),
                          )
                        }
                        type="number"
                        value={preferencesDraft.defaultConnectionCount}
                      />
                      <small>Saved today and used for new downloads that support HTTP ranges.</small>
                    </label>
                    <label className="preferences-field live">
                      <span>Default per-download speed limit</span>
                      <div className="preferences-unit-field">
                        <input
                          min={0}
                          onChange={(event) =>
                            setPreferenceValue(
                              "defaultDownloadSpeedLimitKbps",
                              Number(event.currentTarget.value || 0),
                            )
                          }
                          type="number"
                          value={preferencesDraft.defaultDownloadSpeedLimitKbps}
                        />
                        <span>KB/s</span>
                      </div>
                      <small>`0` means unlimited for new downloads.</small>
                    </label>
                    <label className="preferences-field live">
                      <span>Maximum simultaneous downloads</span>
                      <input
                        max={10}
                        min={1}
                        onChange={(event) =>
                          setPreferenceValue(
                            "maxConcurrentDownloads",
                            Number(event.currentTarget.value || 0),
                          )
                        }
                        type="number"
                        value={preferencesDraft.maxConcurrentDownloads}
                      />
                      <small>Saved today and applied to the live queue.</small>
                    </label>
                    <label className="preferences-field">
                      <span>Retry mode</span>
                      <select
                        onChange={(event) =>
                          {
                            const retryMode =
                              event.currentTarget.value as PreferencesDraft["retryMode"];
                            setPreferenceValue("retryMode", retryMode);
                            setPreferenceValue("autoRetryFailedDownloads", retryMode === "auto");
                          }
                        }
                        value={preferencesDraft.retryMode}
                      >
                        <option value="auto">Automatic</option>
                        <option value="manual">Manual only</option>
                      </select>
                    </label>
                    <label className="preferences-field">
                      <span>Additional metadata queries</span>
                      <select
                        onChange={(event) =>
                          setPreferenceValue(
                            "additionalMetadataQueries",
                            Number(event.currentTarget.value || 0),
                          )
                        }
                        value={preferencesDraft.additionalMetadataQueries}
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                        <option value={4}>4</option>
                      </select>
                    </label>
                    <label className="preferences-toggle align-end">
                      <input
                        checked={preferencesDraft.bandwidthScheduleEnabled}
                        onChange={(event) =>
                          setPreferenceValue(
                            "bandwidthScheduleEnabled",
                            event.currentTarget.checked,
                          )
                        }
                        type="checkbox"
                      />
                      Enable scheduled bandwidth cap
                    </label>
                    <label className="preferences-field">
                      <span>Retry attempts</span>
                      <input
                        min={0}
                        onChange={(event) =>
                          setPreferenceValue("retryAttempts", Number(event.currentTarget.value || 0))
                        }
                        type="number"
                        value={preferencesDraft.retryAttempts}
                      />
                    </label>
                    <label className="preferences-field">
                      <span>Retry delay (seconds)</span>
                      <input
                        min={0}
                        onChange={(event) =>
                          setPreferenceValue(
                            "retryDelaySeconds",
                            Number(event.currentTarget.value || 0),
                          )
                        }
                        type="number"
                      value={preferencesDraft.retryDelaySeconds}
                    />
                  </label>
                    <label className="preferences-field">
                      <span>Scheduled cap start</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("bandwidthScheduleStart", event.currentTarget.value)
                        }
                        type="time"
                        value={preferencesDraft.bandwidthScheduleStart}
                      />
                    </label>
                    <label className="preferences-field">
                      <span>Scheduled cap end</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("bandwidthScheduleEnd", event.currentTarget.value)
                        }
                        type="time"
                        value={preferencesDraft.bandwidthScheduleEnd}
                      />
                    </label>
                    <label className="preferences-field">
                      <span>Scheduled cap limit</span>
                      <div className="preferences-unit-field">
                        <input
                          min={0}
                          onChange={(event) =>
                            setPreferenceValue(
                              "bandwidthScheduleLimitKbps",
                              Number(event.currentTarget.value || 0),
                            )
                          }
                          type="number"
                          value={preferencesDraft.bandwidthScheduleLimitKbps}
                        />
                        <span>KB/s</span>
                      </div>
                    </label>
                    <label className="preferences-toggle align-end">
                      <input
                        checked={preferencesDraft.enableParallelAcceleration}
                        onChange={(event) =>
                          setPreferenceValue(
                            "enableParallelAcceleration",
                            event.currentTarget.checked,
                          )
                        }
                        type="checkbox"
                      />
                      Enable parallel acceleration
                    </label>
                  </div>
                </section>

                <section className="preferences-section" id="preferences-antivirus">
                  <div className="preferences-section-head">
                    <div>
                      <h3>Antivirus</h3>
                      <p>Run a local scanner after completion with a configurable command template.</p>
                    </div>
                    <span className="preferences-badge placeholder">Placeholder</span>
                  </div>
                  <div className="preferences-grid two-column">
                    <label className="preferences-field">
                      <span>Provider</span>
                      <select
                        onChange={(event) =>
                          setPreferenceValue("antivirusProvider", event.currentTarget.value)
                        }
                        value={preferencesDraft.antivirusProvider}
                      >
                        <option>Configure manually</option>
                        <option>Windows Defender</option>
                        <option>Custom scanner</option>
                      </select>
                    </label>
                    <div className="preferences-spacer" />
                    <label className="preferences-field wide">
                      <span>Executable path</span>
                      <div className="preferences-path-row">
                        <input
                          onChange={(event) =>
                            setPreferenceValue("antivirusPath", event.currentTarget.value)
                          }
                          placeholder="C:\\Program Files\\Scanner\\scan.exe"
                          value={preferencesDraft.antivirusPath}
                        />
                        <button
                          className="preferences-path-button"
                          onClick={() => choosePreferenceFile("antivirusPath")}
                          type="button"
                        >
                          <MoreHorizontal size={18} strokeWidth={2} />
                        </button>
                      </div>
                    </label>
                    <label className="preferences-field wide">
                      <span>Arguments</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("antivirusArguments", event.currentTarget.value)
                        }
                        value={preferencesDraft.antivirusArguments}
                      />
                      <small>Use `%path%` where Trinity should inject the finished file path.</small>
                    </label>
                  </div>
                  <label className="preferences-toggle">
                    <input
                      checked={preferencesDraft.antivirusCheckAfterDownload}
                      onChange={(event) =>
                        setPreferenceValue(
                          "antivirusCheckAfterDownload",
                          event.currentTarget.checked,
                        )
                      }
                      type="checkbox"
                    />
                    Scan completed downloads automatically
                  </label>
                </section>

                <section className="preferences-section" id="preferences-distributedEngine">
                  <div className="preferences-section-head">
                    <div>
                      <h3>Distributed Engine</h3>
                      <p>
                        Placeholder controls for Trinity-native peer distribution. This section is
                        intentionally not BitTorrent-branded.
                      </p>
                    </div>
                    <span className="preferences-badge placeholder">Future engine</span>
                  </div>
                  <div className="preferences-group">
                    <h4>General</h4>
                    <div className="preferences-toggle-list">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedDefaultHandler}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedDefaultHandler",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Make Trinity the default handler for distributed manifests
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedDeleteManifestOnFinish}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedDeleteManifestOnFinish",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Delete source manifest after completion
                      </label>
                    </div>
                  </div>
                  <div className="preferences-group">
                    <h4>Monitoring</h4>
                    <div className="preferences-toggle-list">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedMonitorFolder}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedMonitorFolder",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Watch a folder for new distributed manifests
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedAutoStart}
                          onChange={(event) =>
                            setPreferenceValue("distributedAutoStart", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Start distributed jobs automatically
                      </label>
                    </div>
                    <div className="preferences-path-row">
                      <input
                        onChange={(event) =>
                          setPreferenceValue("distributedWatchFolder", event.currentTarget.value)
                        }
                        placeholder="C:\\Users\\deeck\\Downloads\\Distributed"
                        value={preferencesDraft.distributedWatchFolder}
                      />
                      <button
                        className="preferences-path-button"
                        onClick={() => choosePreferenceFolder("distributedWatchFolder")}
                        type="button"
                      >
                        <MoreHorizontal size={18} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                  <div className="preferences-group">
                    <h4>Privacy and peer routing</h4>
                    <div className="preferences-grid two-column">
                      <label className="preferences-field">
                        <span>Encryption</span>
                        <select
                          onChange={(event) =>
                            setPreferenceValue("distributedEncryption", event.currentTarget.value)
                          }
                          value={preferencesDraft.distributedEncryption}
                        >
                          <option>Prefer encryption</option>
                          <option>Require encryption</option>
                          <option>Disable encryption</option>
                        </select>
                      </label>
                    </div>
                    <div className="preferences-toggle-grid">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedPeerDiscovery}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedPeerDiscovery",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Enable peer discovery
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedPeerExchange}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedPeerExchange",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Enable peer exchange
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedLocalPeerDiscovery}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedLocalPeerDiscovery",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Enable local peer discovery
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedUdpTransport}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedUdpTransport",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Enable UDP transport
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedSystemPort}
                          onChange={(event) =>
                            setPreferenceValue("distributedSystemPort", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Use system-defined incoming port
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.distributedPortForwarding}
                          onChange={(event) =>
                            setPreferenceValue(
                              "distributedPortForwarding",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Use UPnP or NAT-PMP forwarding
                      </label>
                    </div>
                  </div>
                </section>

                <section className="preferences-section" id="preferences-remoteAccess">
                  <div className="preferences-section-head">
                    <div>
                      <h3>Remote Access</h3>
                      <p>Prepare for remote device management, queue viewing, and command sync.</p>
                    </div>
                    <span className="preferences-badge placeholder">Placeholder</span>
                  </div>
                  <div className="preferences-toggle-list">
                    <label className="preferences-toggle">
                      <input
                        checked={preferencesDraft.remoteAccessEnabled}
                        onChange={(event) =>
                          setPreferenceValue("remoteAccessEnabled", event.currentTarget.checked)
                        }
                        type="checkbox"
                      />
                      Allow remote access to Trinity on this device
                    </label>
                    <label className="preferences-toggle">
                      <input
                        checked={preferencesDraft.remoteAccessBypassProxy}
                        onChange={(event) =>
                          setPreferenceValue("remoteAccessBypassProxy", event.currentTarget.checked)
                        }
                        type="checkbox"
                      />
                      Do not use download proxy for remote access traffic
                    </label>
                  </div>
                  <div className="preferences-grid two-column">
                    <label className="preferences-field">
                      <span>Device ID</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("remoteAccessId", event.currentTarget.value)
                        }
                        placeholder="Device identifier"
                        value={preferencesDraft.remoteAccessId}
                      />
                    </label>
                    <label className="preferences-field">
                      <span>Password</span>
                      <input
                        onChange={(event) =>
                          setPreferenceValue("remoteAccessPassword", event.currentTarget.value)
                        }
                        placeholder="Remote access password"
                        type="password"
                        value={preferencesDraft.remoteAccessPassword}
                      />
                    </label>
                  </div>
                </section>

                <section className="preferences-section" id="preferences-advanced">
                  <div className="preferences-section-head">
                    <div>
                      <h3>Advanced</h3>
                      <p>Notifications, power management, hooks, and destructive action defaults.</p>
                    </div>
                    <span className="preferences-badge placeholder">Mostly placeholder</span>
                  </div>
                  <div className="preferences-group">
                    <h4>Notifications</h4>
                    <div className="preferences-toggle-grid">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.notifyAdded}
                          onChange={(event) =>
                            setPreferenceValue("notifyAdded", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Notify when a download is added
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.notifyCompleted}
                          onChange={(event) =>
                            setPreferenceValue("notifyCompleted", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Notify when a download completes
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.notifyFailed}
                          onChange={(event) =>
                            setPreferenceValue("notifyFailed", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Notify when a download fails
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.notifyInactiveOnly}
                          onChange={(event) =>
                            setPreferenceValue("notifyInactiveOnly", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Notify only while the window is inactive
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.playSounds}
                          onChange={(event) =>
                            setPreferenceValue("playSounds", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Play sounds for key events
                      </label>
                    </div>
                  </div>
                  <div className="preferences-group">
                    <h4>Power management</h4>
                    <div className="preferences-toggle-grid">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.avoidSleepWithActiveDownloads}
                          onChange={(event) =>
                            setPreferenceValue(
                              "avoidSleepWithActiveDownloads",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Avoid sleep while downloads are active
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.avoidSleepWithScheduledDownloads}
                          onChange={(event) =>
                            setPreferenceValue(
                              "avoidSleepWithScheduledDownloads",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Avoid sleep while scheduled work is pending
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.allowSleepIfResumable}
                          onChange={(event) =>
                            setPreferenceValue(
                              "allowSleepIfResumable",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Allow sleep if jobs can resume later
                      </label>
                    </div>
                  </div>
                  <div className="preferences-group">
                    <h4>Interface and automation</h4>
                    <div className="preferences-grid three-column">
                      <label className="preferences-field">
                        <span>Backup the download list every</span>
                        <select
                          onChange={(event) =>
                            setPreferenceValue("backupEveryHours", event.currentTarget.value)
                          }
                          value={preferencesDraft.backupEveryHours}
                        >
                          <option>1 hour</option>
                          <option>3 hours</option>
                          <option>6 hours</option>
                          <option>12 hours</option>
                        </select>
                      </label>
                      <label className="preferences-field">
                        <span>Delete button action</span>
                        <select
                          onChange={(event) =>
                            setPreferenceValue(
                              "deleteButtonAction",
                              event.currentTarget.value as PreferencesDraft["deleteButtonAction"],
                            )
                          }
                          value={preferencesDraft.deleteButtonAction}
                        >
                          <option value="remove">Remove from list only</option>
                          <option value="delete">Delete files</option>
                          <option value="ask">Always ask</option>
                        </select>
                      </label>
                      <label className="preferences-field">
                        <span>When file already exists</span>
                        <select
                          onChange={(event) =>
                            setPreferenceValue(
                              "fileExistsAction",
                              event.currentTarget.value as PreferencesDraft["fileExistsAction"],
                            )
                          }
                          value={preferencesDraft.fileExistsAction}
                        >
                          <option value="rename">Rename</option>
                          <option value="overwrite">Overwrite</option>
                          <option value="ask">Always ask</option>
                        </select>
                      </label>
                    </div>
                    <div className="preferences-toggle-grid">
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.closeToTray}
                          onChange={(event) =>
                            setPreferenceValue("closeToTray", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Keep Trinity running in the tray when the main window closes
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.bottomPanelFollowsSelection}
                          onChange={(event) =>
                            setPreferenceValue(
                              "bottomPanelFollowsSelection",
                              event.currentTarget.checked,
                            )
                          }
                          type="checkbox"
                        />
                        Open or hide detail panel based on selection
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.showTrayActivity}
                          onChange={(event) =>
                            setPreferenceValue("showTrayActivity", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Show download activity in the tray
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.useCustomSortOrder}
                          onChange={(event) =>
                            setPreferenceValue("useCustomSortOrder", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Use custom manual ordering
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.showSaveAsButton}
                          onChange={(event) =>
                            setPreferenceValue("showSaveAsButton", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Show `Save As` in add-download flows
                      </label>
                      <label className="preferences-toggle">
                        <input
                          checked={preferencesDraft.showBuiltInTags}
                          onChange={(event) =>
                            setPreferenceValue("showBuiltInTags", event.currentTarget.checked)
                          }
                          type="checkbox"
                        />
                        Show built-in tags
                      </label>
                    </div>
                    <div className="preferences-grid two-column">
                      <label className="preferences-field">
                        <span>Overall zoom</span>
                        <select
                          onChange={(event) =>
                            setPreferenceValue("overallZoom", event.currentTarget.value)
                          }
                          value={preferencesDraft.overallZoom}
                        >
                          <option>90%</option>
                          <option>100%</option>
                          <option>110%</option>
                        </select>
                      </label>
                      <label className="preferences-field">
                        <span>Font zoom</span>
                        <select
                          onChange={(event) =>
                            setPreferenceValue("fontZoom", event.currentTarget.value)
                          }
                          value={preferencesDraft.fontZoom}
                        >
                          <option>90%</option>
                          <option>100%</option>
                          <option>110%</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="preferences-group">
                    <h4>Completion hook</h4>
                    <label className="preferences-toggle">
                      <input
                        checked={preferencesDraft.completionHookEnabled}
                        onChange={(event) =>
                          setPreferenceValue("completionHookEnabled", event.currentTarget.checked)
                        }
                        type="checkbox"
                      />
                      Launch an external application when a download finishes
                    </label>
                    <div className="preferences-grid two-column">
                      <label className="preferences-field wide">
                        <span>Executable path</span>
                        <div className="preferences-path-row">
                          <input
                            onChange={(event) =>
                              setPreferenceValue("completionHookPath", event.currentTarget.value)
                            }
                            placeholder="C:\\Tools\\post-download.exe"
                            value={preferencesDraft.completionHookPath}
                          />
                          <button
                            className="preferences-path-button"
                            onClick={() => choosePreferenceFile("completionHookPath")}
                            type="button"
                          >
                            <MoreHorizontal size={18} strokeWidth={2} />
                          </button>
                        </div>
                      </label>
                      <label className="preferences-field wide">
                        <span>Arguments</span>
                        <input
                          onChange={(event) =>
                            setPreferenceValue(
                              "completionHookArguments",
                              event.currentTarget.value,
                            )
                          }
                          value={preferencesDraft.completionHookArguments}
                        />
                        <small>Use `%path%` where the completed file path should be injected.</small>
                      </label>
                    </div>
                  </div>

                  <footer className="preferences-footer-actions">
                    <button
                      className="preferences-secondary-action"
                      onClick={() => closePreferencesPage()}
                      type="button"
                    >
                      Close
                    </button>
                    <button className="preferences-primary-action" type="submit">
                      <Save size={15} strokeWidth={2} />
                      Save Changes
                    </button>
                  </footer>
                </section>
              </form>
            </section>
          </section>
        </div>
        <div className={`view-panel downloads-panel${isSettingsOpen ? " offscreen" : ""}`}>
          <nav className="tabs" aria-label="Download filters">
            <button
              className={`tab ${activeTab === "all" ? "active" : ""}`}
              onClick={() => setActiveTab("all")}
            >
              All ({jobs.length})
            </button>
            <button
              className={`tab ${activeTab === "active" ? "active" : ""}${activeCountPulsing ? " tab-count-pulsing" : ""}`}
              onClick={() => setActiveTab("active")}
            >
              Active (<span key={activeCountPulsing ? "p" : "n"} className={activeCountPulsing ? "tab-count" : undefined}>{activeCount}</span>)
            </button>
            <button
              className={`tab ${activeTab === "queued" ? "active" : ""}`}
              onClick={() => setActiveTab("queued")}
            >
              Queued ({queuedCount})
            </button>
            <button
              className={`tab ${activeTab === "completed" ? "active" : ""}`}
              onClick={() => setActiveTab("completed")}
            >
              Completed ({completedCount})
            </button>
            <button
              className={`tab ${activeTab === "uncompleted" ? "active" : ""}`}
              onClick={() => setActiveTab("uncompleted")}
            >
              Uncompleted ({incompleteCount})
            </button>
            <button
              className={`tab ${activeTab === "failed" ? "active" : ""}`}
              onClick={() => setActiveTab("failed")}
            >
              Failed ({failedCount})
            </button>
            <button
              className={`tab ${activeTab === "paused" ? "active" : ""}`}
              onClick={() => setActiveTab("paused")}
            >
              Paused ({pausedCount})
            </button>
            <button className="tab">+</button>
          </nav>

          <section className="main-pane">
            <aside className="category-tree" aria-label="Categories">
              <div className="category-title">Categories</div>
              <button
                className={`tree-item ${activeCategory === "all" ? "active" : ""}`}
                onClick={() => setActiveCategory("all")}
              >
                All Downloads
              </button>
              <button
                className={`tree-item ${activeCategory === "compressed" ? "active" : ""}`}
                onClick={() => setActiveCategory("compressed")}
              >
                Compressed
              </button>
              <button
                className={`tree-item ${activeCategory === "documents" ? "active" : ""}`}
                onClick={() => setActiveCategory("documents")}
              >
                Documents
              </button>
              <button
                className={`tree-item ${activeCategory === "music" ? "active" : ""}`}
                onClick={() => setActiveCategory("music")}
              >
                Music
              </button>
              <button
                className={`tree-item ${activeCategory === "programs" ? "active" : ""}`}
                onClick={() => setActiveCategory("programs")}
              >
                Programs
              </button>
              <button
                className={`tree-item ${activeCategory === "video" ? "active" : ""}`}
                onClick={() => setActiveCategory("video")}
              >
                Video
              </button>
              <button
                className={`tree-item ${activeCategory === "unfinished" ? "active" : ""}`}
                onClick={() => setActiveCategory("unfinished")}
              >
                Unfinished
              </button>
              <button
                className={`tree-item ${activeCategory === "finished" ? "active" : ""}`}
                onClick={() => setActiveCategory("finished")}
              >
                Finished
              </button>
              <button
                className={`tree-item ${activeCategory === "queues" ? "active" : ""}`}
                onClick={() => setActiveCategory("queues")}
              >
                Queues
              </button>
            </aside>

            <section className="download-table">
              <div className="table-filters">
                <label className="table-search">
                  <Search size={14} strokeWidth={2} />
                  <input
                    onChange={(event) => setQueueSearch(event.currentTarget.value)}
                    placeholder="Search downloads"
                    value={queueSearch}
                  />
                </label>
                <select
                  onChange={(event) =>
                    setPriorityFilter(event.currentTarget.value as PriorityFilterId)
                  }
                  value={priorityFilter}
                >
                  <option value="all">All priorities</option>
                  <option value="high">High priority</option>
                  <option value="normal">Normal priority</option>
                  <option value="low">Low priority</option>
                </select>
                <select
                  onChange={(event) =>
                    setQueueScope(event.currentTarget.value as "all" | "queueOnly" | "scheduled")
                  }
                  value={queueScope}
                >
                  <option value="all">All rows</option>
                  <option value="queueOnly">Queue-manageable</option>
                  <option value="scheduled">Scheduled only</option>
                </select>
              </div>
              <div className="table-head">
                <span className="check-cell">
                  <input
                    aria-label="Select all downloads"
                    checked={
                      visibleJobs.length > 0 &&
                      visibleJobs.every((job) => selectedJobIds.includes(job.id))
                    }
                    onChange={toggleAllJobs}
                    type="checkbox"
                  />
                </span>
                <span>File Name</span>
                <span>Status</span>
                <span>Size</span>
                <span>Transfer rate</span>
                <span>Actions</span>
              </div>
              <div className="download-list" key={activeTab}>
                {!jobsInitialized ? (
                  <>
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className="skeleton-row" />
                    ))}
                  </>
                ) : visibleJobs.length === 0 ? (
                  <div className="empty-state">
                    <h3>No matching downloads</h3>
                    <p>Adjust the active filters or create a new download job.</p>
                  </div>
                ) : (
                  visibleJobs.map((job) => {
                    const isSelected = selectedJobIds.includes(job.id);
                    const waitingForSchedule = isWaitingForSchedule(job, scheduleNow);
                    const scheduleSummary = job.scheduler_enabled
                      ? formatScheduleSummary(job)
                      : "";
                    const nextScheduledStart = waitingForSchedule
                      ? formatNextScheduledStart(job, scheduleNow)
                      : "";
                    const queuePolicySummary =
                      settings.use_custom_sort_order && isQueueManageable(job)
                      ? `Queue: ${formatPriorityLabel(job.priority)} / #${job.queue_position}`
                      : "";

                    return (
                      <article
                        className={`download-row ${deletingJobIds.has(job.id) ? "deleting " : ""}${job.id === newestJobId ? "new-job " : ""}${isSelected ? "selected" : ""} ${
                          dropTargetJobId === job.id ? "drop-target" : ""
                        }`}
                        draggable={settings.use_custom_sort_order && isQueueManageable(job)}
                        key={job.id}
                        onClick={() => toggleJobSelection(job.id)}
                        onDragEnd={() => {
                          setDraggedJobId(null);
                          setDropTargetJobId(null);
                        }}
                        onDragOver={(event) => {
                          const draggedJob = jobs.find((candidate) => candidate.id === draggedJobId);
                          if (!draggedJob || !canDragOntoRow(draggedJob, job)) {
                            return;
                          }
                          event.preventDefault();
                          if (dropTargetJobId !== job.id) {
                            setDropTargetJobId(job.id);
                          }
                        }}
                        onDragStart={(event) => {
                          handleRowDragStart(job);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", job.id);
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          handleRowDrop(job);
                        }}
                        >
                          <div className="download-primary-row">
                            <span className="check-cell file-icon-cell" aria-hidden="true">
                              {renderDownloadIcon(job, systemIcons)}
                            </span>
                            <div className="download-name">
                              <div className="download-entry-row">
                                <div className="download-title-block">
                                  <div className="download-title-row">
                                    <strong title={job.file_name}>{job.file_name}</strong>
                                  </div>
                                  <small title={job.url}>{job.url}</small>
                              </div>
                            </div>
                            {job.scheduler_enabled ? (
                              <small className="schedule-detail" title={scheduleSummary}>
                                {scheduleSummary}
                              </small>
                            ) : null}
                            {waitingForSchedule ? (
                              <small className="schedule-detail waiting">
                                Waiting for schedule window
                                {nextScheduledStart ? ` - Next start ${nextScheduledStart}` : ""}
                              </small>
                            ) : null}
                            {queuePolicySummary ? (
                              <small className="queue-policy-detail">{queuePolicySummary}</small>
                            ) : null}
                            {job.error_message && job.state !== "Paused" ? (
                              <em title={job.error_message}>{job.error_message}</em>
                            ) : null}
                            {job.next_retry_at ? (
                              <em>Next retry: {formatRetryTime(job.next_retry_at)}</em>
                            ) : null}
                          </div>
                          <span
                            className={`state-pill ${
                              waitingForSchedule
                                ? "state-scheduled"
                                : `state-${job.state.toLowerCase()}`
                            }`}
                          >
                            {waitingForSchedule ? "Scheduled" : job.state}
                          </span>
                          <span>{formatSize(job)}</span>
                          <span>{formatBytes(job.speed_bps)}/s</span>
                          <div className="row-actions">
                            {job.state === "Running" ? (
                              <>
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    pauseJob(job.id);
                                  }}
                                >
                                  Pause
                                </button>
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    cancelJob(job.id);
                                  }}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : null}
                            {job.state === "Queued" ||
                            job.state === "Failed" ||
                            job.state === "Canceled" ||
                            job.state === "Paused" ? (
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  startJob(job.id);
                                }}
                              >
                                Start
                              </button>
                            ) : null}
                            <button
                              className="icon-only"
                              disabled={!job.output_path}
                              onClick={(event) => {
                                event.stopPropagation();
                                invoke("reveal_in_folder", { path: job.output_path }).catch(() => {});
                              }}
                              title="Show in folder"
                            >
                              <FolderInput size={14} strokeWidth={2} />
                            </button>
                            <button
                              disabled={job.state === "Running"}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDeleteAction(job.id);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div className={`progress-track${job.state === "Running" ? " active" : ""}${completingJobIds.has(job.id) ? " completing" : ""}`}>
                          <span style={{ width: `${progressPercent(job)}%` }} />
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          </section>
        </div>
      </div>

      <footer className="bottom-bar">
        <strong>Down {formatBytes(globalSpeed)}/s</strong>
        <strong>Up 0 B/s</strong>
      </footer>

      {isAddOpen ? (
        <div className={`modal-backdrop${isAddAnimatingOut ? " closing" : ""}`} role="presentation">
          <section
            aria-labelledby="add-download-title"
            className={`modal new-download-modal${isAddAnimatingOut ? " closing" : ""}`}
            role="dialog"
          >
            <div className="modal-header">
              <h3 id="add-download-title">New download</h3>
              <button aria-label="Close" onClick={() => closeAddDialog()}>
                <X size={17} strokeWidth={2} />
              </button>
            </div>
            <form className="add-form new-download-form" onSubmit={createJob}>
              {settings.show_save_as_button ? (
                <label className="field-block">
                  <span>Save to</span>
                  <div className="path-row">
                    <input
                      onChange={(event) =>
                        setOutputFolder(event.currentTarget.value)
                      }
                      placeholder="Leave blank to use Downloads"
                      value={outputFolder}
                    />
                    <button
                      type="button"
                      aria-label="Use default downloads folder"
                      onClick={() => useDefaultOutputFolder()}
                    >
                      <ChevronDown size={14} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      aria-label="Browse for folder"
                      onClick={() => chooseOutputFolder()}
                    >
                      <MoreHorizontal size={18} strokeWidth={2} />
                    </button>
                  </div>
                </label>
              ) : null}
              <label className="field-block">
                <span>{isExtensionPrefilledDownload ? "File name" : "URL"}</span>
                {isExtensionPrefilledDownload ? (
                  <input
                    onChange={(event) =>
                      setPendingSuggestedFileName(event.currentTarget.value)
                    }
                    required
                    type="text"
                    value={pendingSuggestedFileName}
                  />
                ) : (
                  <input
                    autoFocus
                    onChange={(event) => {
                      setUrl(event.currentTarget.value);
                      setPendingSuggestedFileName("");
                    }}
                    placeholder="https://example.com/file.zip"
                    required
                    type="url"
                    value={url}
                  />
                )}
              </label>

              <div className="scheduler-row">
                <label className="checkbox-label">
                  <input
                    checked={isSchedulerEnabled}
                    onChange={(event) =>
                      setIsSchedulerEnabled(event.currentTarget.checked)
                    }
                    type="checkbox"
                  />
                  Scheduler
                </label>
                <span title={urlMetadataError || undefined}>
                  Size: {sizeMetadataLabel(urlMetadata, isUrlMetadataLoading, urlMetadataError)}
                </span>
              </div>

              {isSchedulerEnabled ? (
                <section className="scheduler-panel" aria-label="Scheduler">
                  <div className="day-row">
                    {SCHEDULE_DAYS.map((day) => (
                        <label className="checkbox-label" key={day}>
                          <input
                            checked={scheduleDays.includes(day)}
                            onChange={() => toggleScheduleDay(day)}
                            type="checkbox"
                          />
                          {day}
                        </label>
                      ))}
                  </div>
                  <div className="time-row">
                    <label>
                      From:
                      <span className="time-input-wrap">
                        <input
                          onChange={(event) => setScheduleFrom(event.currentTarget.value)}
                          type="time"
                          value={scheduleFrom}
                        />
                        <Clock3 size={14} strokeWidth={2} />
                      </span>
                    </label>
                    <label>
                      To:
                      <span className="time-input-wrap">
                        <input
                          onChange={(event) => setScheduleTo(event.currentTarget.value)}
                          type="time"
                          value={scheduleTo}
                        />
                        <Clock3 size={14} strokeWidth={2} />
                      </span>
                    </label>
                  </div>
                </section>
              ) : null}

              {error ? <p className="form-error">{error}</p> : null}
              <div className="form-actions">
                <button type="button" onClick={() => closeAddDialog()}>
                  Cancel
                </button>
                <button className="primary-action" disabled={isSubmitting}>
                  {isSubmitting ? "Adding..." : "Download"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {isStartupPromptOpen ? (
        <div
          className={`modal-backdrop${isStartupPromptAnimatingOut ? " closing" : ""}`}
          role="presentation"
        >
          <section
            aria-labelledby="startup-prompt-title"
            className={`modal startup-prompt-modal${isStartupPromptAnimatingOut ? " closing" : ""}`}
            role="dialog"
          >
            <div className="modal-header">
              <h3 id="startup-prompt-title">Launch Trinity at startup?</h3>
            </div>
            <div className="startup-prompt-body">
              <p>
                Start Trinity automatically when Windows starts so browser handoff and queued
                downloads are ready sooner.
              </p>
              <p className="startup-prompt-note">
                You can change this later in <strong>Options &gt; General &gt; Startup</strong>.
              </p>
              {startupPromptError ? <p className="form-error">{startupPromptError}</p> : null}
              <div className="form-actions startup-prompt-actions">
                <button
                  disabled={isStartupPromptSaving}
                  type="button"
                  onClick={() => resolveStartupPrompt(false)}
                >
                  No
                </button>
                <button
                  className="primary-action"
                  disabled={isStartupPromptSaving}
                  type="button"
                  onClick={() => resolveStartupPrompt(true)}
                >
                  {isStartupPromptSaving ? "Saving..." : "Yes, enable"}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

    </main>
  );
}

function progressPercent(job: DownloadJob) {
  if (!job.total_bytes) {
    return 0;
  }

  return Math.min(100, Math.floor((job.downloaded_bytes / job.total_bytes) * 100));
}

function canStart(job: DownloadJob) {
  return (
    job.state === "Queued" ||
    job.state === "Failed" ||
    job.state === "Canceled" ||
    job.state === "Paused"
  );
}

function isQueueManageable(job: DownloadJob) {
  return (
    job.state === "Queued" ||
    job.state === "Paused" ||
    job.state === "Failed" ||
    job.state === "Canceled"
  );
}

function canDragOntoRow(draggedJob: DownloadJob, targetJob: DownloadJob) {
  return (
    draggedJob.id !== targetJob.id &&
    isQueueManageable(draggedJob) &&
    isQueueManageable(targetJob) &&
    draggedJob.priority === targetJob.priority
  );
}

function matchesMainTab(job: DownloadJob, tab: DownloadTabId) {
  switch (tab) {
    case "active":
      return job.state === "Running";
    case "queued":
      return job.state === "Queued";
    case "completed":
      return job.state === "Completed";
    case "uncompleted":
      return job.state !== "Completed" && job.state !== "Canceled";
    case "failed":
      return job.state === "Failed";
    case "paused":
      return job.state === "Paused";
    default:
      return true;
  }
}

function matchesPriorityFilter(job: DownloadJob, priorityFilter: PriorityFilterId) {
  switch (priorityFilter) {
    case "high":
      return job.priority === 2;
    case "normal":
      return job.priority === 1;
    case "low":
      return job.priority === 0;
    default:
      return true;
  }
}

function matchesQueueScope(
  job: DownloadJob,
  queueScope: "all" | "queueOnly" | "scheduled",
) {
  switch (queueScope) {
    case "queueOnly":
      return isQueueManageable(job);
    case "scheduled":
      return job.scheduler_enabled;
    default:
      return true;
  }
}

function matchesSearchFilter(job: DownloadJob, searchValue: string) {
  const normalizedSearch = searchValue.trim().toLowerCase();
  if (!normalizedSearch) {
    return true;
  }

  return (
    job.file_name.toLowerCase().includes(normalizedSearch) ||
    job.url.toLowerCase().includes(normalizedSearch) ||
    job.output_folder.toLowerCase().includes(normalizedSearch)
  );
}

function matchesCategoryFilter(job: DownloadJob, category: CategoryFilterId) {
  const extension = getFileExtension(job.file_name);

  switch (category) {
    case "compressed":
      return [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"].includes(extension);
    case "documents":
      return [".pdf", ".doc", ".docx", ".txt", ".rtf", ".xlsx", ".pptx", ".csv"].includes(
        extension,
      );
    case "music":
      return [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"].includes(extension);
    case "programs":
      return [".exe", ".msi", ".zip", ".appx", ".msix", ".dmg"].includes(extension);
    case "video":
      return [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".webm"].includes(extension);
    case "unfinished":
      return job.state !== "Completed" && job.state !== "Canceled";
    case "finished":
      return job.state === "Completed";
    case "queues":
      return isQueueManageable(job);
    default:
      return true;
  }
}

function getFileExtension(fileName: string) {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex === -1) {
    return "";
  }

  return fileName.slice(extensionIndex).toLowerCase();
}

function getJobIconRequest(job: DownloadJob) {
  const extension = getFileExtension(job.file_name);
  const hasCompletedFilePath = job.state === "Completed" && job.output_path.trim().length > 0;
  const pathHint = hasCompletedFilePath ? job.output_path.trim() : job.file_name;
  const isDirectory = extension === "";
  const cacheKey = hasCompletedFilePath
    ? `path:${pathHint.toLowerCase()}`
    : `assoc:${isDirectory ? pathHint.toLowerCase() : extension}`;

  return {
    key: cacheKey,
    pathHint,
    isDirectory,
  };
}

function isWaitingForSchedule(job: DownloadJob, currentDate: Date) {
  return job.state === "Queued" && job.scheduler_enabled && !isScheduleWindowActive(job, currentDate);
}

function isScheduleWindowActive(job: DownloadJob, currentDate: Date) {
  if (!job.scheduler_enabled) {
    return true;
  }

  if (!isScheduleDayMatch(job, currentDate)) {
    return false;
  }

  const startMinutes = timeValueToMinutes(job.schedule_from);
  const endMinutes = timeValueToMinutes(job.schedule_to);
  if (startMinutes === null || endMinutes === null) {
    return false;
  }

  const currentMinutes = currentDate.getHours() * 60 + currentDate.getMinutes();
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function isScheduleDayMatch(job: DownloadJob, date: Date) {
  const selectedDays = normalizedScheduleDays(job);
  return selectedDays.includes(formatWeekday(date));
}

function normalizedScheduleDays(job: DownloadJob) {
  if (job.schedule_days.includes("Everyday")) {
    return SCHEDULE_DAYS.slice(1);
  }

  return job.schedule_days.filter((day) => day !== "Everyday");
}

function formatScheduleSummary(job: DownloadJob) {
  const days = job.schedule_days.includes("Everyday")
    ? "Every day"
    : normalizedScheduleDays(job).join(", ");
  const start = formatScheduleClock(job.schedule_from);
  const end = formatScheduleClock(job.schedule_to);

  if (!start || !end) {
    return days;
  }

  return `${days} ${start} - ${end}`;
}

function formatNextScheduledStart(job: DownloadJob, currentDate: Date) {
  if (!job.scheduler_enabled) {
    return "";
  }

  const startMinutes = timeValueToMinutes(job.schedule_from);
  if (startMinutes === null) {
    return "";
  }

  const selectedDays = normalizedScheduleDays(job);
  if (selectedDays.length === 0) {
    return "";
  }

  const currentDayStart = new Date(currentDate);
  currentDayStart.setSeconds(0, 0);

  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const candidateDate = new Date(currentDayStart);
    candidateDate.setDate(candidateDate.getDate() + dayOffset);
    candidateDate.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

    if (!selectedDays.includes(formatWeekday(candidateDate))) {
      continue;
    }

    if (candidateDate <= currentDate) {
      continue;
    }

    return candidateDate.toLocaleString([], {
      weekday: dayOffset === 0 ? undefined : "short",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  return "";
}

function isHttpUrl(value: string) {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function sizeMetadataLabel(
  metadata: DownloadUrlMetadata | null,
  isLoading: boolean,
  error: string,
) {
  if (isLoading) {
    return "checking...";
  }

  if (metadata?.total_bytes) {
    return formatBytes(metadata.total_bytes);
  }

  if (error) {
    return "unknown";
  }

  return "unknown";
}

function formatSize(job: DownloadJob) {
  if (job.total_bytes) {
    return formatBytes(job.total_bytes);
  }

  if (job.downloaded_bytes > 0) {
    return formatBytes(job.downloaded_bytes);
  }

  return "";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRetryTime(value: string) {
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatPriorityLabel(priority: number) {
  switch (priority) {
    case 2:
      return "High";
    case 0:
      return "Low";
    default:
      return "Normal";
  }
}

function renderDownloadIcon(job: DownloadJob, systemIcons: Record<string, string>) {
  const iconRequest = getJobIconRequest(job);
  const iconDataUrl = systemIcons[iconRequest.key];
  if (iconDataUrl) {
    return <img alt="" className="download-file-icon-image" draggable={false} src={iconDataUrl} />;
  }

  return <div className="download-file-icon-fallback" aria-hidden="true" />;
}

function timeValueToMinutes(value: string | null) {
  if (!value) {
    return null;
  }

  const [hour, minute] = value.split(":");
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);

  if (
    Number.isNaN(parsedHour) ||
    Number.isNaN(parsedMinute) ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    parsedMinute < 0 ||
    parsedMinute > 59
  ) {
    return null;
  }

  return parsedHour * 60 + parsedMinute;
}

function formatScheduleClock(value: string | null) {
  const totalMinutes = timeValueToMinutes(value);
  if (totalMinutes === null) {
    return "";
  }

  const date = new Date();
  date.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatWeekday(value: Date) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][value.getDay()];
}

function deriveFileNameFromUrl(value: string) {
  try {
    const parsedUrl = new URL(value);
    const pathname = parsedUrl.pathname.split("/").filter(Boolean);
    return pathname[pathname.length - 1] || "";
  } catch {
    return "";
  }
}

export default App;
