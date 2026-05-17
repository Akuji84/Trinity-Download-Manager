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
const REQUEST_METADATA_WINDOW_MS = 15000;
const DOWNLOAD_TRANSACTION_WINDOW_MS = 30000;
const FILENAME_DETERMINATION_TIMEOUT_MS = 2500;
const recentRequestMetadata = new Map();
const recentDownloadTransactions = new Map();
// Stores Chrome-determined filenames from onDeterminingFilename, keyed by download ID.
// onDeterminingFilename fires after onCreated and gives us the real filename from
// Content-Disposition before any bytes are written to disk.
const determinedFilenames = new Map(); // downloadId -> { basename, resolve }|{ basename }

function shouldSkipBridgeUrl(url) {
  return typeof url === "string" && url.startsWith(BRIDGE_BASE_URL);
}

// Cached bridge status so onCreated can cancel immediately without a network round-trip
let cachedBridgeAlive = false;
setInterval(refreshCachedBridgeStatus, 15000);
refreshCachedBridgeStatus();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (shouldSkipBridgeUrl(details?.url || "")) {
      return;
    }
    cacheRequestMetadata(details);
    cacheDownloadTransactionRequest(details);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (shouldSkipBridgeUrl(details?.url || "")) {
      return;
    }
    cacheRequestHeaders(details);
    cacheDownloadTransactionRequestHeaders(details);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (shouldSkipBridgeUrl(details?.url || "")) {
      return;
    }
    cacheDownloadTransactionResponseHeaders(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (shouldSkipBridgeUrl(details?.url || "")) {
      return;
    }
    cacheDownloadTransactionResponseStarted(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"],
);

// onDeterminingFilename fires after onCreated once Chrome has the server's response headers
// and the real save path (Content-Disposition filename). Chrome PAUSES the download here
// waiting for suggest() — no bytes are written to disk until suggest() is called.
// We hold the suggest() callback instead of calling it immediately so handleCreatedDownload
// can cancel the download while it is paused, preventing Chrome from writing/opening the file.
// A safety timeout releases the hold if handleCreatedDownload never picks it up.
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const basename = downloadItem.filename
    ? downloadItem.filename.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || null
    : null;

  const entry = determinedFilenames.get(downloadItem.id);
  if (entry && typeof entry.resolve === "function") {
    // handleCreatedDownload registered a waiter first — hand over basename + suggest
    clearTimeout(entry.timeoutId);
    determinedFilenames.delete(downloadItem.id);
    entry.resolve({ basename, suggest });
  } else {
    // Store eagerly with a safety timeout in case handleCreatedDownload never claims it
    const safetyTimeoutId = setTimeout(() => {
      const pending = determinedFilenames.get(downloadItem.id);
      if (pending && typeof pending.suggest === "function") {
        pending.suggest({ filename: downloadItem.filename || "", conflictAction: "uniquify" });
      }
      determinedFilenames.delete(downloadItem.id);
    }, FILENAME_DETERMINATION_TIMEOUT_MS);
    determinedFilenames.set(downloadItem.id, { basename, suggest, safetyTimeoutId });
  }
});

// Resolves with { basename, suggest } once onDeterminingFilename fires for this download,
// or null on timeout (fallback to header/URL derivation, safety timeout releases Chrome).
function waitForDeterminedFilename(downloadId) {
  const existing = determinedFilenames.get(downloadId);
  if (existing && typeof existing.resolve !== "function") {
    clearTimeout(existing.safetyTimeoutId);
    determinedFilenames.delete(downloadId);
    return Promise.resolve({ basename: existing.basename, suggest: existing.suggest });
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      determinedFilenames.delete(downloadId);
      resolve(null);
    }, FILENAME_DETERMINATION_TIMEOUT_MS);
    determinedFilenames.set(downloadId, { resolve, timeoutId });
  });
}

// Releases a held suggest() immediately — used when we decide NOT to intercept a download.
function releasePendingFilenameHold(downloadId) {
  const entry = determinedFilenames.get(downloadId);
  if (!entry) {
    return;
  }
  clearTimeout(entry.safetyTimeoutId || entry.timeoutId);
  determinedFilenames.delete(downloadId);
  if (typeof entry.suggest === "function") {
    try {
      entry.suggest({ filename: "", conflictAction: "uniquify" });
    } catch {
      // ignore
    }
  }
  if (typeof entry.resolve === "function") {
    entry.resolve(null);
  }
}

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

function cacheDownloadTransactionRequest(details) {
  const requestId = String(details?.requestId || "").trim();
  const url = details?.url || "";
  if (!requestId || !isHttpUrl(url)) {
    return;
  }

  cleanupRecentDownloadTransactions();
  const current = recentDownloadTransactions.get(requestId);
  recentDownloadTransactions.set(requestId, {
    requestId,
    createdAt: current?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + DOWNLOAD_TRANSACTION_WINDOW_MS,
    url,
    method: String(details.method || current?.method || "GET").trim().toUpperCase(),
    type: details?.type || current?.type || "",
    tabId: typeof details?.tabId === "number" ? details.tabId : current?.tabId ?? null,
    frameId: typeof details?.frameId === "number" ? details.frameId : current?.frameId ?? null,
    initiator: details?.initiator || details?.documentUrl || current?.initiator || null,
    requestBody: serializeRequestBody(details?.requestBody) || current?.requestBody || null,
    requestHeaders: current?.requestHeaders || null,
    responseHeaders: current?.responseHeaders || null,
    statusCode: current?.statusCode ?? null,
    statusLine: current?.statusLine || "",
    ip: current?.ip || "",
    fromCache: current?.fromCache ?? null,
  });
}

function cacheDownloadTransactionRequestHeaders(details) {
  const requestId = String(details?.requestId || "").trim();
  const url = details?.url || "";
  if (!requestId || !isHttpUrl(url)) {
    return;
  }

  cleanupRecentDownloadTransactions();
  const current = recentDownloadTransactions.get(requestId);
  recentDownloadTransactions.set(requestId, {
    requestId,
    createdAt: current?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + DOWNLOAD_TRANSACTION_WINDOW_MS,
    url,
    method: String(details.method || current?.method || "GET").trim().toUpperCase(),
    type: details?.type || current?.type || "",
    tabId: current?.tabId ?? (typeof details?.tabId === "number" ? details.tabId : null),
    frameId: current?.frameId ?? (typeof details?.frameId === "number" ? details.frameId : null),
    initiator: current?.initiator ?? details?.initiator ?? details?.documentUrl ?? null,
    requestBody: current?.requestBody || null,
    requestHeaders: extractReplayHeaders(details?.requestHeaders) || current?.requestHeaders || null,
    responseHeaders: current?.responseHeaders || null,
    statusCode: current?.statusCode ?? null,
    statusLine: current?.statusLine || "",
    ip: current?.ip || "",
    fromCache: current?.fromCache ?? null,
  });
}

function cacheDownloadTransactionResponseHeaders(details) {
  const requestId = String(details?.requestId || "").trim();
  const url = details?.url || "";
  if (!requestId || !isHttpUrl(url)) {
    return;
  }

  cleanupRecentDownloadTransactions();
  const current = recentDownloadTransactions.get(requestId);
  recentDownloadTransactions.set(requestId, {
    requestId,
    createdAt: current?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + DOWNLOAD_TRANSACTION_WINDOW_MS,
    url,
    method: String(details.method || current?.method || "GET").trim().toUpperCase(),
    type: details?.type || current?.type || "",
    tabId: current?.tabId ?? (typeof details?.tabId === "number" ? details.tabId : null),
    frameId: current?.frameId ?? (typeof details?.frameId === "number" ? details.frameId : null),
    initiator: current?.initiator ?? details?.initiator ?? details?.documentUrl ?? null,
    requestBody: current?.requestBody || null,
    requestHeaders: current?.requestHeaders || null,
    responseHeaders: extractDebugResponseHeaders(details?.responseHeaders),
    statusCode: details?.statusCode ?? current?.statusCode ?? null,
    statusLine: details?.statusLine || current?.statusLine || "",
    ip: current?.ip || "",
    fromCache: current?.fromCache ?? null,
  });
}

function cacheDownloadTransactionResponseStarted(details) {
  const requestId = String(details?.requestId || "").trim();
  const url = details?.url || "";
  if (!requestId || !isHttpUrl(url)) {
    return;
  }

  cleanupRecentDownloadTransactions();
  const current = recentDownloadTransactions.get(requestId);
  recentDownloadTransactions.set(requestId, {
    requestId,
    createdAt: current?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + DOWNLOAD_TRANSACTION_WINDOW_MS,
    url,
    method: String(details.method || current?.method || "GET").trim().toUpperCase(),
    type: details?.type || current?.type || "",
    tabId: current?.tabId ?? (typeof details?.tabId === "number" ? details.tabId : null),
    frameId: current?.frameId ?? (typeof details?.frameId === "number" ? details.frameId : null),
    initiator: current?.initiator ?? details?.initiator ?? details?.documentUrl ?? null,
    requestBody: current?.requestBody || null,
    requestHeaders: current?.requestHeaders || null,
    responseHeaders: Object.keys(current?.responseHeaders || {}).length > 0
      ? current.responseHeaders
      : extractDebugResponseHeaders(details?.responseHeaders),
    statusCode: details?.statusCode ?? current?.statusCode ?? null,
    statusLine: current?.statusLine || "",
    ip: details?.ip || current?.ip || "",
    fromCache: details?.fromCache ?? current?.fromCache ?? null,
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

function cleanupRecentDownloadTransactions() {
  const now = Date.now();
  for (const [key, value] of recentDownloadTransactions.entries()) {
    if (!value || value.expiresAt <= now) {
      recentDownloadTransactions.delete(key);
    }
  }
}

function findDownloadTransactionForItem(downloadItem) {
  cleanupRecentDownloadTransactions();
  const candidateUrls = [
    downloadItem?.finalUrl,
    downloadItem?.url,
  ].filter((value, index, values) => isHttpUrl(value) && values.indexOf(value) === index);
  if (candidateUrls.length === 0) {
    return null;
  }

  const downloadReferrer = String(downloadItem?.referrer || "").trim();
  const downloadTabId = typeof downloadItem?.tabId === "number" ? downloadItem.tabId : null;
  const candidates = [];
  for (const transaction of recentDownloadTransactions.values()) {
    if (!transaction || !candidateUrls.includes(transaction.url)) {
      continue;
    }
    if (transaction.type && transaction.type !== "main_frame") {
      continue;
    }
    if (downloadTabId != null && transaction.tabId != null && transaction.tabId !== downloadTabId) {
      continue;
    }
    if (downloadReferrer && transaction.initiator && transaction.initiator !== downloadReferrer) {
      continue;
    }
    candidates.push(transaction);
  }

  candidates.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  return candidates[0] || null;
}

function summarizeDownloadTransaction(transaction) {
  if (!transaction) {
    return null;
  }

  return {
    requestId: transaction.requestId,
    url: transaction.url,
    method: transaction.method || "",
    type: transaction.type || "",
    tabId: transaction.tabId ?? null,
    initiator: transaction.initiator || null,
    statusCode: transaction.statusCode ?? null,
    statusLine: transaction.statusLine || "",
    requestHeaders: transaction.requestHeaders || null,
    responseHeaders: transaction.responseHeaders || null,
  };
}

function deriveObservedFileNameFromHeaders(responseHeaders) {
  const contentDisposition = String(responseHeaders?.["content-disposition"] || "").trim();
  if (!contentDisposition) {
    return null;
  }

  for (const part of contentDisposition.split(";")) {
    const trimmedPart = part.trim();
    if (trimmedPart.toLowerCase().startsWith("filename*=")) {
      const rawValue = trimmedPart.slice("filename*=".length).trim();
      const encodedValue = rawValue.replace(/^UTF-8''/i, "").replace(/^["']|["']$/g, "");
      try {
        return decodeURIComponent(encodedValue);
      } catch {
        return encodedValue;
      }
    }

    if (trimmedPart.toLowerCase().startsWith("filename=")) {
      return trimmedPart.slice("filename=".length).trim().replace(/^["']|["']$/g, "");
    }
  }

  return null;
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

function extractDebugResponseHeaders(responseHeaders) {
  if (!Array.isArray(responseHeaders) || responseHeaders.length === 0) {
    return {};
  }

  const allowedHeaders = new Set([
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "location",
    "set-cookie",
    "x-goog-hash",
  ]);
  const headers = {};

  for (const header of responseHeaders) {
    const name = String(header?.name || "").trim();
    const value = String(header?.value || "").trim();
    if (!name || !value) {
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (!allowedHeaders.has(normalizedName)) {
      continue;
    }

    headers[normalizedName] = value;
  }

  return headers;
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
      releasePendingFilenameHold(downloadItem.id);
      return;
    }
  }

  const { capturePaused = false, excludedSites = [] } = await chrome.storage.local.get([
    STORAGE_KEYS.capturePaused,
    STORAGE_KEYS.excludedSites,
  ]);

  if (capturePaused) {
    releasePendingFilenameHold(downloadItem.id);
    return;
  }

  // Quick site check using the referrer already present on the download item
  const quickHost = extractHost(downloadItem.referrer || "");
  if (quickHost && excludedSites.includes(quickHost)) {
    releasePendingFilenameHold(downloadItem.id);
    return;
  }

  // We are intercepting this download. Mark it so concurrent onCreated calls are ignored.
  interceptedDownloadIds.add(downloadItem.id);

  // Wait for onDeterminingFilename — Chrome is paused here, no bytes written to disk yet.
  // We cancel while Chrome is paused so the file is never saved or opened.
  const [filenameResult, pageUrl] = await Promise.all([
    waitForDeterminedFilename(downloadItem.id),
    resolveDownloadPageUrl(downloadItem),
  ]);

  // Re-check exclusion with the resolved page URL in case referrer wasn't set
  const resolvedHost = extractHost(pageUrl || "");
  if (resolvedHost && excludedSites.includes(resolvedHost)) {
    interceptedDownloadIds.delete(downloadItem.id);
    if (filenameResult?.suggest) {
      try { filenameResult.suggest({ filename: downloadItem.filename || "", conflictAction: "uniquify" }); } catch { /* ignore */ }
    }
    return;
  }

  // Cancel Chrome's download while it is paused at filename determination
  try {
    await chrome.downloads.cancel(downloadItem.id);
  } catch (error) {
    console.warn("Could not cancel the browser download before Trinity handoff", error);
  }

  // Release Chrome's filename-determination pause. Chrome ignores suggest() for canceled downloads.
  if (filenameResult?.suggest) {
    try { filenameResult.suggest({ filename: downloadItem.filename || "", conflictAction: "uniquify" }); } catch { /* ignore */ }
  }

  const transaction = findDownloadTransactionForItem(downloadItem);
  const observedFileName =
    filenameResult?.basename ||
    deriveObservedFileNameFromHeaders(transaction?.responseHeaders) ||
    deriveDownloadItemFileName(downloadItem);

  const sentToTrinity = await sendToTrinity({
    url: downloadItem.url,
    final_url: downloadItem.finalUrl || downloadItem.url,
    request_method: transaction?.method || "GET",
    request_body: transaction?.requestBody?.value ?? null,
    request_body_encoding: transaction?.requestBody?.encoding ?? null,
    request_form_data: transaction?.requestBody?.formData ?? null,
    request_headers: transaction?.requestHeaders || null,
    page_url: pageUrl,
    suggested_file_name: observedFileName || deriveDownloadItemFileName(downloadItem),
    mime_type: transaction?.responseHeaders?.["content-type"] || downloadItem.mime || null,
    response_status: transaction?.statusCode ?? null,
    response_headers: transaction?.responseHeaders || null,
    observed_file_name: observedFileName,
    observed_content_type: transaction?.responseHeaders?.["content-type"] || downloadItem.mime || null,
    observed_content_length: transaction?.responseHeaders?.["content-length"]
      ? Number(transaction.responseHeaders["content-length"]) || null
      : null,
    observed_accept_ranges: transaction?.responseHeaders?.["accept-ranges"] || null,
    browser_observed: true,
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
  return { captured: false, fallbackToBrowser: true };
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

function isHttpUrl(value) {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

async function showBridgeBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 3000);
}
