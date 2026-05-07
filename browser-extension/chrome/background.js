const BRIDGE_BASE_URL = "http://127.0.0.1:38491";
const STORAGE_KEYS = {
  capturePaused: "capturePaused",
  excludedSites: "excludedSites",
};
const CONTEXT_MENU_IDS = {
  link: "trinity-download-link",
  media: "trinity-download-media",
  page: "trinity-download-page",
};
const interceptedDownloadIds = new Set();
const DOWNLOAD_EXTENSIONS = new Set([
  "exe", "msi", "pkg", "dmg", "deb", "rpm", "apk",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst",
  "iso", "img", "torrent",
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm",
  "mp3", "flac", "aac", "ogg", "wav", "m4a",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);
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
    final_url: selectedUrl,
    request_method: "GET",
    request_body: null,
    page_url: info.pageUrl ?? tab?.url ?? null,
    suggested_file_name: deriveSuggestedFileName(selectedUrl),
    mime_type: null,
    referrer: tab?.url ?? null,
    browser: "chrome",
    user_agent: navigator.userAgent,
    cookies: null,
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
    sendResponse({ browserFallbackWhenUnavailable: true });
    return false;
  }

  if (message?.type === "open-trinity-options") {
    openTrinityOptions()
      .then((state) => sendResponse(state))
      .catch((error) => {
        console.error("Open Trinity options failed", error);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (message?.type === "set-browser-fallback-when-unavailable") {
    sendResponse({ browserFallbackWhenUnavailable: true });
    return false;
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
    final_url: currentUrl,
    request_method: "GET",
    request_body: null,
    page_url: currentUrl,
    suggested_file_name: deriveSuggestedFileName(currentUrl),
    mime_type: null,
    referrer: currentUrl,
    browser: "chrome",
    user_agent: navigator.userAgent,
    cookies: null,
    output_folder: null,
  });
}

async function sendToTrinity(payload) {
  const resolvedUrl = payload.final_url || payload.url;
  if (!isHttpUrl(resolvedUrl)) {
    await showBridgeBadge("URL?", "#7a3f00");
    return false;
  }

  try {
    const enrichedPayload = await enrichPayloadWithSession(payload);
    const response = await fetch(`${BRIDGE_BASE_URL}/downloads/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(enrichedPayload),
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

async function enrichPayloadWithSession(payload) {
  const resolvedUrl = payload.final_url || payload.url || "";
  const cookieUrls = [
    resolvedUrl,
    payload.url,
    payload.page_url,
    payload.referrer,
  ].filter((value, index, values) => isHttpUrl(value) && values.indexOf(value) === index);

  const cookies = await collectCookiesForUrls(cookieUrls);

  return {
    ...payload,
    user_agent: payload.user_agent || navigator.userAgent,
    cookies: cookies.length > 0 ? cookies : null,
  };
}

async function collectCookiesForUrls(urls) {
  if (!chrome.cookies?.getAll || !Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  const seen = new Set();
  const collected = [];

  for (const url of urls) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const cookie of cookies) {
        if (!cookie?.name) {
          continue;
        }

        const entry = `${cookie.name}=${cookie.value ?? ""}`;
        if (seen.has(entry)) {
          continue;
        }

        seen.add(entry);
        collected.push(entry);
      }
    } catch (error) {
      console.warn("Could not collect cookies for Trinity handoff", url, error);
    }
  }

  return collected;
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

async function handleCreatedDownload(downloadItem) {
  if (!shouldConsiderDownload(downloadItem)) {
    return;
  }

  if (interceptedDownloadIds.has(downloadItem.id)) {
    return;
  }

  // Use cached bridge status to make the capture decision without a network round-trip.
  // Fall back to a live ping when the cache says false — handles the startup race where
  // cachedBridgeAlive hasn't been populated yet but the bridge is actually running.
  if (!cachedBridgeAlive) {
    const alive = await pingBridge();
    cachedBridgeAlive = alive;
    if (!alive) {
      return;
    }
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
    url: downloadItem.url,
    final_url: downloadItem.finalUrl || downloadItem.url,
    request_method: "GET",
    request_body: null,
    page_url: pageUrl,
    suggested_file_name: deriveDownloadItemFileName(downloadItem),
    mime_type: downloadItem.mime || null,
    referrer: downloadItem.referrer || pageUrl || null,
    browser: "chrome",
    user_agent: navigator.userAgent,
    cookies: null,
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
  } = await chrome.storage.local.get([
    STORAGE_KEYS.capturePaused,
    STORAGE_KEYS.excludedSites,
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
      fallbackToBrowser: true,
    };
  }

  const sentToTrinity = await sendToTrinity({
    url: payload.url,
    final_url: payload.final_url ?? payload.url,
    request_method: payload.request_method ?? "GET",
    request_body: payload.request_body ?? null,
    page_url: payload.page_url ?? null,
    suggested_file_name: payload.suggested_file_name ?? deriveSuggestedFileName(payload.url),
    mime_type: payload.mime_type ?? null,
    referrer: payload.referrer ?? payload.page_url ?? null,
    browser: "chrome",
    user_agent: payload.user_agent ?? navigator.userAgent,
    cookies: payload.cookies ?? null,
    output_folder: null,
  });

  if (!sentToTrinity) {
    return {
      captured: false,
      fallbackToBrowser: true,
    };
  }

  markRecentlyCaptured(payload.url);
  if (payload.page_url) {
    markRecentlyCaptured(payload.page_url);
  }

  await showBridgeBadge("CAP", "#145d29");
  return { captured: true };
}

async function openTrinityOptions() {
  if (!cachedBridgeAlive && !(await pingBridge())) {
    cachedBridgeAlive = false;
    return { ok: false };
  }

  const response = await fetch(`${BRIDGE_BASE_URL}/app/open-options`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!response.ok) {
    throw new Error(`Bridge returned HTTP ${response.status}`);
  }

  cachedBridgeAlive = true;
  return { ok: true };
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

function hasDownloadExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
    const dotIndex = lastSegment.lastIndexOf(".");
    if (dotIndex === -1) return false;
    return DOWNLOAD_EXTENSIONS.has(lastSegment.slice(dotIndex + 1).toLowerCase());
  } catch {
    return false;
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
