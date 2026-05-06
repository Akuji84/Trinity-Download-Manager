const BRIDGE_BASE_URL = "http://127.0.0.1:38491";
const STORAGE_KEYS = {
  capturePaused: "capturePaused",
  excludedSites: "excludedSites",
  browserFallbackWhenUnavailable: "browserFallbackWhenUnavailable",
};
const CONTEXT_MENU_IDS = {
  link: "trinity-download-link",
  media: "trinity-download-media",
  page: "trinity-download-page",
};
const interceptedDownloadIds = new Set();
const RECENT_CAPTURE_WINDOW_MS = 8000;
const recentCapturedUrls = new Map();

// Cached bridge status so onCreated can cancel immediately without a network round-trip
let cachedBridgeAlive = false;
setInterval(refreshCachedBridgeStatus, 15000);
refreshCachedBridgeStatus();

async function refreshCachedBridgeStatus() {
  cachedBridgeAlive = await pingBridge();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.link,
      title: "Download with Trinity",
      contexts: ["link"],
    });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.media,
      title: "Download media with Trinity",
      contexts: ["image", "audio", "video"],
    });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_IDS.page,
      title: "Send page URL to Trinity",
      contexts: ["page"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const selectedUrl =
    info.linkUrl ??
    info.srcUrl ??
    info.pageUrl ??
    tab?.url ??
    "";

  await sendToTrinity({
    url: selectedUrl,
    page_url: info.pageUrl ?? tab?.url ?? null,
    suggested_file_name: deriveSuggestedFileName(selectedUrl),
    mime_type: null,
    referrer: tab?.url ?? null,
    browser: "chrome",
    output_folder: null,
  });
});

chrome.downloads.onCreated.addListener((downloadItem) => {
  handleCreatedDownload(downloadItem).catch((error) => {
    console.error("Automatic Trinity interception failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "capture-download-click") {
    captureDownloadClick(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("Capture download click failed", error);
        sendResponse({ captured: false });
      });
    return true;
  }

  if (message?.type === "bridge-status") {
    pingBridge()
      .then((connected) => sendResponse({ connected }))
      .catch((error) => {
        console.error("Bridge status check failed", error);
        sendResponse({ connected: false });
      });
    return true;
  }

  if (message?.type === "get-popup-state") {
    getPopupState()
      .then((state) => sendResponse(state))
      .catch((error) => {
        console.error("Popup state load failed", error);
        sendResponse({
          connected: false,
          capturePaused: false,
          siteExcluded: false,
          siteHost: "",
        });
      });
    return true;
  }

  if (message?.type === "toggle-capture-paused") {
    toggleCapturePaused()
      .then((state) => sendResponse(state))
      .catch((error) => {
        console.error("Capture pause toggle failed", error);
        sendResponse({ capturePaused: false });
      });
    return true;
  }

  if (message?.type === "toggle-site-exclusion") {
    toggleSiteExclusion(message.siteHost)
      .then((state) => sendResponse(state))
      .catch((error) => {
        console.error("Site exclusion toggle failed", error);
        sendResponse({ siteExcluded: false });
      });
    return true;
  }

  if (message?.type === "get-options-state") {
    getOptionsState()
      .then((state) => sendResponse(state))
      .catch((error) => {
        console.error("Options state load failed", error);
        sendResponse({ browserFallbackWhenUnavailable: true });
      });
    return true;
  }

  if (message?.type === "set-browser-fallback-when-unavailable") {
    setBrowserFallbackWhenUnavailable(message.value)
      .then((state) => sendResponse(state))
      .catch((error) => {
        console.error("Browser fallback setting update failed", error);
        sendResponse({ browserFallbackWhenUnavailable: true });
      });
    return true;
  }

  if (message?.type === "open-options-page") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "open-help-page") {
    chrome.tabs.create({
      url: "https://github.com/Akuji84/Trinity-Download-Manager/issues",
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function sendTabToTrinity(tab) {
  const currentUrl = tab?.url ?? "";
  await sendToTrinity({
    url: currentUrl,
    page_url: currentUrl,
    suggested_file_name: deriveSuggestedFileName(currentUrl),
    mime_type: null,
    referrer: currentUrl,
    browser: "chrome",
    output_folder: null,
  });
}

async function sendToTrinity(payload) {
  if (!isHttpUrl(payload.url)) {
    await showBridgeBadge("URL?", "#7a3f00");
    return false;
  }

  try {
    const response = await fetch(`${BRIDGE_BASE_URL}/downloads/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Bridge returned HTTP ${response.status}`);
    }

    cachedBridgeAlive = true;
    await showBridgeBadge("OK", "#145d29");
    return true;
  } catch (error) {
    console.error("Trinity bridge handoff failed", error);
    cachedBridgeAlive = false;
    await showBridgeBadge("ERR", "#6a1b1b");
    return false;
  }
}

async function pingBridge() {
  try {
    const response = await fetch(`${BRIDGE_BASE_URL}/app/ping`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      return false;
    }

    const payload = await response.json();
    return payload?.ok === true;
  } catch (error) {
    console.error("Trinity bridge ping failed", error);
    return false;
  }
}

async function getPopupState() {
  const [{ capturePaused = false, excludedSites = [] }, currentTab] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.capturePaused, STORAGE_KEYS.excludedSites]),
    getActiveTab(),
  ]);
  const siteHost = extractHost(currentTab?.url ?? "");

  return {
    connected: await pingBridge(),
    capturePaused,
    siteExcluded: siteHost ? excludedSites.includes(siteHost) : false,
    siteHost,
  };
}

async function getOptionsState() {
  const { browserFallbackWhenUnavailable = true } = await chrome.storage.local.get(
    STORAGE_KEYS.browserFallbackWhenUnavailable,
  );

  return { browserFallbackWhenUnavailable };
}

async function handleCreatedDownload(downloadItem) {
  if (!shouldConsiderDownload(downloadItem)) {
    return;
  }

  if (interceptedDownloadIds.has(downloadItem.id)) {
    return;
  }

  // Use cached bridge status to make the capture decision without a network round-trip.
  // This lets us cancel the Chrome download before it makes meaningful progress.
  if (!cachedBridgeAlive) {
    return;
  }

  const targetUrl = downloadItem.finalUrl || downloadItem.url || "";
  if (wasRecentlyCaptured(targetUrl)) {
    interceptedDownloadIds.add(downloadItem.id);
    try {
      await chrome.downloads.cancel(downloadItem.id);
    } catch (error) {
      console.warn("Could not cancel duplicate browser download after pre-capture", error);
    }

    try {
      await chrome.downloads.erase({ id: downloadItem.id });
    } catch (error) {
      console.warn("Could not erase duplicate browser download after pre-capture", error);
    }

    setTimeout(() => interceptedDownloadIds.delete(downloadItem.id), 5000);
    return;
  }

  const { capturePaused = false, excludedSites = [] } = await chrome.storage.local.get([
    STORAGE_KEYS.capturePaused,
    STORAGE_KEYS.excludedSites,
  ]);

  if (capturePaused) {
    return;
  }

  // Quick site check using the referrer already present on the download item
  const quickHost = extractHost(downloadItem.referrer || "");
  if (quickHost && excludedSites.includes(quickHost)) {
    return;
  }

  // Cancel the Chrome download immediately — before any further async work
  interceptedDownloadIds.add(downloadItem.id);
  try {
    await chrome.downloads.cancel(downloadItem.id);
  } catch (error) {
    console.warn("Could not cancel the browser download before Trinity handoff", error);
  }

  // Resolve the page URL for Trinity metadata (fine to await after cancel)
  const pageUrl = await resolveDownloadPageUrl(downloadItem);

  // Re-check exclusion with the resolved page URL in case referrer wasn't set
  const resolvedHost = extractHost(pageUrl || "");
  if (resolvedHost && excludedSites.includes(resolvedHost)) {
    interceptedDownloadIds.delete(downloadItem.id);
    return;
  }

  const sentToTrinity = await sendToTrinity({
    url: downloadItem.finalUrl || downloadItem.url,
    page_url: pageUrl,
    suggested_file_name: deriveDownloadItemFileName(downloadItem),
    mime_type: downloadItem.mime || null,
    referrer: downloadItem.referrer || pageUrl || null,
    browser: "chrome",
    output_folder: null,
  });

  if (sentToTrinity) {
    try {
      await chrome.downloads.erase({ id: downloadItem.id });
    } catch (error) {
      console.warn("Could not erase the canceled browser download", error);
    }
    await showBridgeBadge("CAP", "#145d29");
  }

  setTimeout(() => interceptedDownloadIds.delete(downloadItem.id), 5000);
}

function shouldConsiderDownload(downloadItem) {
  const targetUrl = downloadItem.finalUrl || downloadItem.url || "";
  if (!isHttpUrl(targetUrl)) {
    return false;
  }

  if (downloadItem.byExtensionId && downloadItem.byExtensionId !== chrome.runtime.id) {
    return false;
  }

  if (downloadItem.state && downloadItem.state !== "in_progress") {
    return false;
  }

  return true;
}

async function resolveDownloadPageUrl(downloadItem) {
  if (downloadItem.referrer) {
    return downloadItem.referrer;
  }

  if (typeof downloadItem.tabId === "number" && downloadItem.tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(downloadItem.tabId);
      return tab?.url ?? null;
    } catch (error) {
      console.warn("Could not resolve tab URL for download interception", error);
    }
  }

  return null;
}

function deriveDownloadItemFileName(downloadItem) {
  if (downloadItem.filename) {
    const parts = downloadItem.filename.split(/[/\\\\]/).filter(Boolean);
    const finalPart = parts.at(-1);
    if (finalPart) {
      return finalPart;
    }
  }

  return deriveSuggestedFileName(downloadItem.finalUrl || downloadItem.url);
}

async function toggleCapturePaused() {
  const { capturePaused = false } = await chrome.storage.local.get(STORAGE_KEYS.capturePaused);
  const nextValue = !capturePaused;
  await chrome.storage.local.set({ [STORAGE_KEYS.capturePaused]: nextValue });
  return { capturePaused: nextValue };
}

async function toggleSiteExclusion(siteHost) {
  if (!siteHost) {
    return { siteExcluded: false };
  }

  const { excludedSites = [] } = await chrome.storage.local.get(STORAGE_KEYS.excludedSites);
  const nextSites = excludedSites.includes(siteHost)
    ? excludedSites.filter((currentSite) => currentSite !== siteHost)
    : [...excludedSites, siteHost].sort();
  await chrome.storage.local.set({ [STORAGE_KEYS.excludedSites]: nextSites });

  return {
    siteExcluded: nextSites.includes(siteHost),
  };
}

async function captureDownloadClick(payload) {
  if (!payload || !isHttpUrl(payload.url)) {
    return { captured: false, fallbackToBrowser: true };
  }

  const {
    capturePaused = false,
    excludedSites = [],
    browserFallbackWhenUnavailable = true,
  } = await chrome.storage.local.get([
    STORAGE_KEYS.capturePaused,
    STORAGE_KEYS.excludedSites,
    STORAGE_KEYS.browserFallbackWhenUnavailable,
  ]);

  if (capturePaused) {
    return { captured: false, fallbackToBrowser: true };
  }

  const pageHost = extractHost(payload.page_url || payload.referrer || "");
  if (pageHost && excludedSites.includes(pageHost)) {
    return { captured: false, fallbackToBrowser: true };
  }

  if (!cachedBridgeAlive && !(await pingBridge())) {
    cachedBridgeAlive = false;
    return {
      captured: false,
      fallbackToBrowser: browserFallbackWhenUnavailable,
    };
  }

  const sentToTrinity = await sendToTrinity({
    url: payload.url,
    page_url: payload.page_url ?? null,
    suggested_file_name: payload.suggested_file_name ?? deriveSuggestedFileName(payload.url),
    mime_type: payload.mime_type ?? null,
    referrer: payload.referrer ?? payload.page_url ?? null,
    browser: "chrome",
    output_folder: null,
  });

  if (!sentToTrinity) {
    return {
      captured: false,
      fallbackToBrowser: browserFallbackWhenUnavailable,
    };
  }

  markRecentlyCaptured(payload.url);
  if (payload.page_url) {
    markRecentlyCaptured(payload.page_url);
  }

  await showBridgeBadge("CAP", "#145d29");
  return { captured: true };
}

async function setBrowserFallbackWhenUnavailable(value) {
  const nextValue = value !== false;
  await chrome.storage.local.set({
    [STORAGE_KEYS.browserFallbackWhenUnavailable]: nextValue,
  });
  return { browserFallbackWhenUnavailable: nextValue };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function extractHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function deriveSuggestedFileName(targetUrl) {
  try {
    const parsedUrl = new URL(targetUrl);
    const pathname = parsedUrl.pathname.split("/").filter(Boolean);
    const finalSegment = pathname.at(-1);
    return finalSegment || null;
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function markRecentlyCaptured(value) {
  if (!value) {
    return;
  }

  cleanupRecentCapturedUrls();
  recentCapturedUrls.set(value, Date.now() + RECENT_CAPTURE_WINDOW_MS);
}

function wasRecentlyCaptured(value) {
  if (!value) {
    return false;
  }

  cleanupRecentCapturedUrls();
  const expiresAt = recentCapturedUrls.get(value);
  return typeof expiresAt === "number" && expiresAt > Date.now();
}

function cleanupRecentCapturedUrls() {
  const now = Date.now();
  for (const [key, expiresAt] of recentCapturedUrls.entries()) {
    if (expiresAt <= now) {
      recentCapturedUrls.delete(key);
    }
  }
}

async function showBridgeBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 3000);
}
