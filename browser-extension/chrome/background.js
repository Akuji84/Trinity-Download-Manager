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
const REQUEST_METADATA_WINDOW_MS = 15000;
const DIRECT_CAPTURE_PROBE_TIMEOUT_MS = 2500;
const DIRECT_CAPTURE_PROBE_BYTES = "bytes=0-4095";
const MAX_CAPTURE_RESOLUTION_DEPTH = 4;
const MIN_CONFIDENT_FILE_SIZE_BYTES = 64 * 1024;
const recentCapturedUrls = new Map();
const recentRequestMetadata = new Map();

// Cached bridge status so onCreated can cancel immediately without a network round-trip
let cachedBridgeAlive = false;
setInterval(refreshCachedBridgeStatus, 15000);
refreshCachedBridgeStatus();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    cacheRequestMetadata(details);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    cacheRequestHeaders(details);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

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
  const requestMetadata = findRecentRequestMetadata(payload);
  const cookieUrls = [
    resolvedUrl,
    payload.url,
    payload.page_url,
    payload.referrer,
  ].filter((value, index, values) => isHttpUrl(value) && values.indexOf(value) === index);

  const cookies = await collectCookiesForUrls(cookieUrls);

  return {
    ...payload,
    request_method: shouldUseCapturedRequestMethod(payload, requestMetadata)
      ? requestMetadata?.method || payload.request_method || "GET"
      : payload.request_method || "GET",
    request_body:
      payload.request_body != null
        ? payload.request_body
        : requestMetadata?.body?.value ?? null,
    request_body_encoding:
      payload.request_body != null
        ? payload.request_body_encoding ?? "text"
        : requestMetadata?.body?.encoding ?? null,
    request_form_data:
      payload.request_form_data && Object.keys(payload.request_form_data).length > 0
        ? payload.request_form_data
        : requestMetadata?.body?.formData && Object.keys(requestMetadata.body.formData).length > 0
          ? requestMetadata.body.formData
          : null,
    request_headers:
      payload.request_headers && Object.keys(payload.request_headers).length > 0
        ? payload.request_headers
        : requestMetadata?.headers && Object.keys(requestMetadata.headers).length > 0
          ? requestMetadata.headers
          : null,
    user_agent: payload.user_agent || navigator.userAgent,
    cookies: cookies.length > 0 ? cookies : null,
  };
}

function shouldUseCapturedRequestMethod(payload, requestMetadata) {
  if (!requestMetadata?.method) {
    return false;
  }

  const payloadMethod = String(payload.request_method || "GET").trim().toUpperCase();
  return payloadMethod === "GET" && payload.request_body == null;
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

function cacheRequestMetadata(details) {
  const url = details?.url || "";
  if (!isHttpUrl(url)) {
    return;
  }

  const method = String(details.method || "GET").trim().toUpperCase();
  const body = serializeRequestBody(details.requestBody);
  cleanupRecentRequestMetadata();
  recentRequestMetadata.set(url, {
    method,
    body,
    headers: null,
    tabId: typeof details.tabId === "number" ? details.tabId : null,
    frameId: typeof details.frameId === "number" ? details.frameId : null,
    initiator: details.initiator || details.documentUrl || null,
    expiresAt: Date.now() + REQUEST_METADATA_WINDOW_MS,
  });
}

function cacheRequestHeaders(details) {
  const url = details?.url || "";
  if (!isHttpUrl(url)) {
    return;
  }

  const headers = extractReplayHeaders(details.requestHeaders);
  if (!headers || Object.keys(headers).length === 0) {
    return;
  }

  cleanupRecentRequestMetadata();
  const current = recentRequestMetadata.get(url);
  recentRequestMetadata.set(url, {
    method: current?.method || String(details.method || "GET").trim().toUpperCase(),
    body: current?.body ?? null,
    headers,
    tabId: current?.tabId ?? (typeof details.tabId === "number" ? details.tabId : null),
    frameId: current?.frameId ?? (typeof details.frameId === "number" ? details.frameId : null),
    initiator: current?.initiator ?? details.initiator ?? details.documentUrl ?? null,
    expiresAt: Date.now() + REQUEST_METADATA_WINDOW_MS,
  });
}

function findRecentRequestMetadata(payload) {
  cleanupRecentRequestMetadata();
  const candidates = [
    payload.final_url,
    payload.url,
  ].filter((value, index, values) => isHttpUrl(value) && values.indexOf(value) === index);

  for (const candidate of candidates) {
    const metadata = recentRequestMetadata.get(candidate);
    if (metadata && metadata.expiresAt > Date.now()) {
      return metadata;
    }
  }

  return null;
}

function cleanupRecentRequestMetadata() {
  const now = Date.now();
  for (const [key, value] of recentRequestMetadata.entries()) {
    if (!value || value.expiresAt <= now) {
      recentRequestMetadata.delete(key);
    }
  }
}

function extractReplayHeaders(requestHeaders) {
  if (!Array.isArray(requestHeaders) || requestHeaders.length === 0) {
    return null;
  }

  const allowedHeaders = new Set([
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "origin",
    "x-requested-with",
  ]);
  const excludedHeaders = new Set([
    "cookie",
    "content-length",
    "host",
    "referer",
    "user-agent",
  ]);
  const replayHeaders = {};

  for (const header of requestHeaders) {
    const name = String(header?.name || "").trim();
    const value = String(header?.value || "").trim();
    if (!name || !value) {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (excludedHeaders.has(normalizedName) || !allowedHeaders.has(normalizedName)) {
      continue;
    }

    replayHeaders[normalizedName] = value;
  }

  return Object.keys(replayHeaders).length > 0 ? replayHeaders : null;
}

function serializeRequestBody(requestBody) {
  if (!requestBody) {
    return null;
  }

  if (requestBody.formData && typeof requestBody.formData === "object") {
    const normalizedFormData = {};
    for (const [key, values] of Object.entries(requestBody.formData)) {
      if (!Array.isArray(values) || values.length === 0) {
        continue;
      }

      normalizedFormData[key] = values.map((value) => String(value));
    }

    return Object.keys(normalizedFormData).length > 0
      ? { value: null, encoding: null, formData: normalizedFormData }
      : null;
  }

  if (Array.isArray(requestBody.raw) && requestBody.raw.length > 0) {
    const chunks = requestBody.raw
      .map((part) => {
        const bytes = part?.bytes;
        if (!bytes) {
          return null;
        }
        return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer || bytes);
      })
      .filter(Boolean);

    if (chunks.length === 0) {
      return null;
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const decoded = tryDecodeUtf8Body(combined);
    if (decoded != null) {
      return { value: decoded, encoding: "text" };
    }

    return {
      value: encodeBase64Bytes(combined),
      encoding: "base64",
    };
  }

  return null;
}

function tryDecodeUtf8Body(bytes) {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const sanitized = decoded.replace(/\0/g, "").trim();
    if (!sanitized) {
      return null;
    }

    const nonPrintableCount = [...sanitized].filter((character) => {
      const code = character.charCodeAt(0);
      return code < 9 || (code > 13 && code < 32);
    }).length;
    if (nonPrintableCount > 0) {
      return null;
    }

    return sanitized;
  } catch {
    return null;
  }
}

function encodeBase64Bytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
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
    await showBridgeBadge("ERR", "#6a1b1b");
    return { captured: false, fallbackToBrowser: false };
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
    await showBridgeBadge("ERR", "#6a1b1b");
    return { captured: false, fallbackToBrowser: false };
  }

  const resolvedPayload = await resolveCapturePayloadForTrinity(payload);
  if (!resolvedPayload) {
    console.error("Trinity could not resolve a direct downloadable file from the browser candidate", payload.url);
    await showBridgeBadge("ERR", "#6a1b1b");
    return {
      captured: false,
      fallbackToBrowser: false,
      error: "Could not resolve a direct downloadable file.",
    };
  }

  const sentToTrinity = await sendToTrinity(resolvedPayload);

  if (!sentToTrinity) {
    await showBridgeBadge("ERR", "#6a1b1b");
    return {
      captured: false,
      fallbackToBrowser: false,
      error: "Trinity bridge handoff failed.",
    };
  }

  markRecentlyCaptured(resolvedPayload.final_url || resolvedPayload.url);
  markRecentlyCaptured(resolvedPayload.url);
  if (resolvedPayload.page_url) {
    markRecentlyCaptured(resolvedPayload.page_url);
  }

  await showBridgeBadge("CAP", "#145d29");
  return { captured: true, fallbackToBrowser: false };
}

async function resolveCapturePayloadForTrinity(payload, depth = 0, visited = new Set()) {
  const targetUrl = payload.final_url || payload.url || "";
  if (!isHttpUrl(targetUrl)) {
    return null;
  }

  if (depth >= MAX_CAPTURE_RESOLUTION_DEPTH || visited.has(targetUrl)) {
    return null;
  }
  visited.add(targetUrl);

  const probe = await probeDirectDownloadCandidate(payload);
  if (!probe) {
    return null;
  }

  if (probe.isDownloadableFile) {
    const finalUrl = probe.finalUrl || targetUrl;
    const fileName =
      probe.contentDispositionFileName ||
      deriveSuggestedFileName(finalUrl) ||
      payload.suggested_file_name ||
      null;
    return {
      ...payload,
      url: finalUrl,
      final_url: finalUrl,
      suggested_file_name: fileName,
      mime_type: probe.contentType || payload.mime_type || null,
    };
  }

  for (const nextUrl of probe.discoveredUrls) {
    const resolved = await resolveCapturePayloadForTrinity(
      {
        ...payload,
        url: nextUrl,
        final_url: nextUrl,
        suggested_file_name: deriveSuggestedFileName(nextUrl) || payload.suggested_file_name || null,
      },
      depth + 1,
      visited,
    );
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function probeDirectDownloadCandidate(payload) {
  const targetUrl = payload.final_url || payload.url || "";
  if (!isHttpUrl(targetUrl)) {
    return null;
  }

  const probeHeaders = {};
  if (payload.request_headers && typeof payload.request_headers === "object") {
    for (const [name, value] of Object.entries(payload.request_headers)) {
      if (!name || !value) {
        continue;
      }
      const normalized = name.toLowerCase();
      if (normalized === "authorization" || normalized === "origin" || normalized === "accept") {
        probeHeaders[name] = value;
      }
    }
  }

  try {
    const response = await fetchWithTimeout(
      targetUrl,
      {
        method: "GET",
        cache: "no-store",
        credentials: "include",
        headers: {
          ...probeHeaders,
          Range: DIRECT_CAPTURE_PROBE_BYTES,
        },
        referrer: payload.referrer || payload.page_url || undefined,
        redirect: "follow",
      },
      DIRECT_CAPTURE_PROBE_TIMEOUT_MS,
    );

    return summarizeProbeResponse(response, targetUrl);
  } catch {
    try {
      const response = await fetchWithTimeout(
        targetUrl,
        {
          method: "GET",
          cache: "no-store",
          credentials: "include",
          headers: {
            ...probeHeaders,
            Range: DIRECT_CAPTURE_PROBE_BYTES,
          },
          referrer: payload.referrer || payload.page_url || undefined,
          redirect: "follow",
        },
        DIRECT_CAPTURE_PROBE_TIMEOUT_MS,
      );

      return summarizeProbeResponse(response, targetUrl);
    } catch (error) {
      console.warn("Direct capture probe failed", targetUrl, error);
      return null;
    }
  }
}

async function summarizeProbeResponse(response, fallbackUrl) {
  const contentType = response.headers.get("content-type") || "";
  const disposition = response.headers.get("content-disposition") || "";
  const acceptRanges = response.headers.get("accept-ranges") || "";
  const contentLength = parseHeaderNumber(response.headers.get("content-length"));
  const contentRange = response.headers.get("content-range") || "";
  const bodyPreview = await readProbePreview(response);
  const discoveredUrls = extractCandidateUrlsFromBody(bodyPreview.text, response.url || fallbackUrl);
  const fileLikeMime = isFileLikeContentType(contentType);
  const supportsRanges =
    acceptRanges.toLowerCase().includes("bytes") ||
    response.status === 206 ||
    contentRange.toLowerCase().startsWith("bytes ");
  const contentDispositionFileName = fileNameFromContentDisposition(disposition);
  const isLikelySmallPlaceholder =
    typeof contentLength === "number" &&
    contentLength > 0 &&
    contentLength < MIN_CONFIDENT_FILE_SIZE_BYTES &&
    !contentDispositionFileName &&
    !supportsRanges;
  const isDownloadableFile =
    !!contentDispositionFileName ||
    (
      fileLikeMime &&
      !looksLikeHtmlContentType(contentType) &&
      (
        supportsRanges ||
        (typeof contentLength === "number" && contentLength >= MIN_CONFIDENT_FILE_SIZE_BYTES)
      )
    );

  return {
    finalUrl: response.url || fallbackUrl,
    contentType,
    contentLength,
    contentDispositionFileName,
    discoveredUrls,
    looksHtml: looksLikeHtmlContentType(contentType),
    isDownloadableFile: isDownloadableFile && !isLikelySmallPlaceholder,
  };
}

async function readProbePreview(response) {
  try {
    const clone = response.clone();
    const text = await clone.text();
    return {
      text: text.slice(0, 128 * 1024),
    };
  } catch {
    return { text: "" };
  }
}

function extractCandidateUrlsFromBody(bodyText, baseUrl) {
  if (!bodyText || typeof bodyText !== "string") {
    return [];
  }

  const candidates = new Set();
  const pushCandidate = (value) => {
    const resolved = resolveHttpUrl(value, baseUrl);
    if (!resolved) {
      return;
    }
    candidates.add(resolved);
  };

  for (const match of bodyText.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    pushCandidate(match[0]);
  }

  for (const match of bodyText.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    pushCandidate(match[1]);
  }

  for (const match of bodyText.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/gi)) {
    pushCandidate(match[1]);
  }

  for (const match of bodyText.matchAll(/content\s*=\s*["'][^"']*url=([^"'>]+)["']/gi)) {
    pushCandidate(match[1]);
  }

  return [...candidates].filter((value) => value !== baseUrl);
}

function resolveHttpUrl(value, baseUrl) {
  try {
    const parsed = new URL(String(value), baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseHeaderNumber(value) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function looksLikeHtmlContentType(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  return (
    normalized.startsWith("text/html") ||
    normalized.startsWith("text/plain") ||
    normalized.startsWith("application/xhtml") ||
    normalized.startsWith("application/json") ||
    normalized.startsWith("text/xml") ||
    normalized.startsWith("application/xml")
  );
}

function isFileLikeContentType(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  return (
    normalized.startsWith("application/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/") ||
    normalized.startsWith("image/")
  );
}

function fileNameFromContentDisposition(value) {
  if (!value) {
    return null;
  }

  const utf8Match = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const basicMatch = value.match(/filename\s*=\s*\"?([^\";]+)\"?/i);
  return basicMatch?.[1] || null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
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
