const DOWNLOAD_HINT_PATTERN =
  /(download|installer|install|setup|exe|msi|zip|rar|7z|pkg|dmg|apk|iso|torrent)/i;
const PAGE_CAPTURE_EVENT = "trinity-page-download-capture";
const PAGE_CAPTURE_RESULT_EVENT = "trinity-page-download-result";
const CAPTURE_SUPPRESSION_WINDOW_MS = 10000;
let insertPressed = false;
const pendingCaptureUrls = new Set();
const successfulCaptureUrls = new Map();

injectPageHook();

window.addEventListener("keydown", (event) => {
  if (event.key === "Insert") {
    insertPressed = true;
  }
}, true);

window.addEventListener("keyup", (event) => {
  if (event.key === "Insert") {
    insertPressed = false;
  }
}, true);

window.addEventListener("blur", () => {
  insertPressed = false;
});

window.addEventListener(PAGE_CAPTURE_EVENT, (event) => {
  try {
    const detail = event.detail;
    if (!detail?.requestId || !detail?.payload) {
      return;
    }

    const normalizedUrl = normalizeCaptureUrl(detail.payload.url);
    if (!normalizedUrl) {
      return;
    }

    if (shouldSuppressBrowserFallback(normalizedUrl)) {
      dispatchPageCaptureResult(detail.requestId, true, false);
      return;
    }

    beginCapture(normalizedUrl);

    sendRuntimeMessage(
      {
        type: "capture-download-click",
        payload: detail.payload,
      },
      (response) => {
        void resolvePageCaptureResponse(detail, response, normalizedUrl);
      },
    );
  } catch {
    // If the extension context was invalidated mid-dispatch, allow the page hook
    // timeout/fallback path to continue without surfacing an uncaught page error.
  }
});

document.addEventListener(
  "click",
  (event) => {
    try {
      if (event.defaultPrevented) {
        return;
      }

      if (event.button !== 0) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const candidate = findDownloadCandidate(event.target);
      if (!candidate) {
        return;
      }

      const payload = buildPayload(candidate);
      if (!payload || !shouldCaptureCandidate(candidate, payload)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const normalizedUrl = normalizeCaptureUrl(payload.url);
      if (!normalizedUrl) {
        fallbackToBrowser(candidate, payload.url);
        return;
      }

      if (shouldSuppressBrowserFallback(normalizedUrl)) {
        return;
      }

      beginCapture(normalizedUrl);

      sendRuntimeMessage(
        {
          type: "capture-download-click",
          payload,
        },
        (response) => {
          void resolveClickCaptureResponse(candidate, payload, response, normalizedUrl);
        },
      );
    } catch {
      // If an old content script survives an extension reload, fail closed to the
      // normal browser path instead of surfacing an uncaught page exception.
    }
  },
  true,
);

function injectPageHook() {
  if (!isExtensionContextAvailable()) {
    return;
  }

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-hook.js");
  script.async = false;
  script.dataset.trinityHook = "true";
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

function sendRuntimeMessage(message, callback) {
  if (!isExtensionContextAvailable()) {
    callback(undefined);
    return;
  }

  try {
    chrome.runtime.sendMessage(message, callback);
  } catch {
    callback(undefined);
  }
}

async function resolveClickCaptureResponse(candidate, payload, response, normalizedUrl) {
  if (hasRuntimeLastError()) {
    finishCapture(normalizedUrl, false);
    fallbackToBrowser(candidate, payload.url);
    return;
  }

  if (response?.captured === true) {
    finishCapture(normalizedUrl, true);
    return;
  }

  if (response?.retryAfterLaunch === true) {
    const retriedResponse = await relaunchAndRetryCapture(payload);
    if (retriedResponse?.captured === true) {
      finishCapture(normalizedUrl, true);
      return;
    }

    finishCapture(normalizedUrl, false);
    if (shouldSuppressBrowserFallback(normalizedUrl)) {
      return;
    }

    if (retriedResponse?.fallbackToBrowser !== false) {
      fallbackToBrowser(candidate, payload.url);
    }
    return;
  }

  finishCapture(normalizedUrl, false);
  if (shouldSuppressBrowserFallback(normalizedUrl)) {
    return;
  }

  if (response?.fallbackToBrowser !== false) {
    fallbackToBrowser(candidate, payload.url);
  }
}

async function resolvePageCaptureResponse(detail, response, normalizedUrl) {
  if (hasRuntimeLastError()) {
    finishCapture(normalizedUrl, false);
    dispatchPageCaptureResult(detail.requestId, false, true);
    return;
  }

  let finalResponse = response;
  if (response?.retryAfterLaunch === true) {
    finalResponse = await relaunchAndRetryCapture(detail.payload);
  }

  const captured = finalResponse?.captured === true;
  finishCapture(normalizedUrl, captured);
  const fallbackToBrowser =
    captured || shouldSuppressBrowserFallback(normalizedUrl)
      ? false
      : finalResponse?.fallbackToBrowser !== false;

  dispatchPageCaptureResult(
    detail.requestId,
    captured,
    fallbackToBrowser,
  );
}

function dispatchPageCaptureResult(requestId, captured, fallbackToBrowser) {
  window.dispatchEvent(
    new CustomEvent(PAGE_CAPTURE_RESULT_EVENT, {
      detail: {
        requestId,
        captured,
        fallbackToBrowser,
      },
    }),
  );
}

async function relaunchAndRetryCapture(payload) {
  await launchTrinityFromContent();
  await waitForBridgeFromContent();

  return await new Promise((resolve) => {
    sendRuntimeMessage(
      {
        type: "capture-download-click",
        payload,
      },
      (retryResponse) => {
        if (hasRuntimeLastError()) {
          resolve({ captured: false, fallbackToBrowser: true });
          return;
        }

        resolve(retryResponse ?? { captured: false, fallbackToBrowser: true });
      },
    );
  });
}

async function launchTrinityFromContent() {
  const launchFrame = document.createElement("iframe");
  launchFrame.style.display = "none";
  launchFrame.src = "trinity://launch";
  (document.documentElement || document.body).appendChild(launchFrame);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  launchFrame.remove();
}

async function waitForBridgeFromContent() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 6000) {
    const status = await new Promise((resolve) => {
      sendRuntimeMessage({ type: "bridge-status" }, (response) => {
        if (hasRuntimeLastError()) {
          resolve({ connected: false });
          return;
        }

        resolve(response ?? { connected: false });
      });
    });

    if (status?.connected === true) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return false;
}

function normalizeCaptureUrl(value) {
  try {
    return new URL(value, window.location.href).toString();
  } catch {
    return "";
  }
}

function beginCapture(normalizedUrl) {
  cleanupSuccessfulCaptureUrls();
  pendingCaptureUrls.add(normalizedUrl);
}

function finishCapture(normalizedUrl, captured) {
  pendingCaptureUrls.delete(normalizedUrl);
  cleanupSuccessfulCaptureUrls();
  if (captured) {
    successfulCaptureUrls.set(
      normalizedUrl,
      Date.now() + CAPTURE_SUPPRESSION_WINDOW_MS,
    );
    return;
  }
}

function shouldSuppressBrowserFallback(normalizedUrl) {
  if (!normalizedUrl) {
    return false;
  }

  cleanupSuccessfulCaptureUrls();
  if (pendingCaptureUrls.has(normalizedUrl)) {
    return true;
  }

  const expiresAt = successfulCaptureUrls.get(normalizedUrl);
  return typeof expiresAt === "number" && expiresAt > Date.now();
}

function cleanupSuccessfulCaptureUrls() {
  const now = Date.now();
  for (const [url, expiresAt] of successfulCaptureUrls.entries()) {
    if (expiresAt <= now) {
      successfulCaptureUrls.delete(url);
    }
  }
}

function isExtensionContextAvailable() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function hasRuntimeLastError() {
  try {
    return Boolean(chrome.runtime?.lastError);
  } catch {
    return true;
  }
}

function findDownloadCandidate(startNode) {
  if (!(startNode instanceof Element)) {
    return null;
  }

  const anchor = startNode.closest("a[href]");
  if (anchor) {
    return anchor;
  }

  return startNode.closest("[data-download-url]");
}

function buildPayload(candidate) {
  const url =
    candidate instanceof HTMLAnchorElement
      ? candidate.href
      : candidate.getAttribute("data-download-url");

  if (!url || !isHttpUrl(url)) {
    return null;
  }

  return {
    url,
    page_url: window.location.href,
    suggested_file_name: deriveSuggestedFileName(url, candidate),
    mime_type: null,
    referrer: window.location.href,
    insert_pressed: insertPressed,
  };
}

function shouldCaptureCandidate(candidate, payload) {
  if (candidate instanceof HTMLAnchorElement && candidate.hasAttribute("download")) {
    return true;
  }

  const url = payload.url;
  const combinedText = [
    candidate.textContent || "",
    candidate.getAttribute?.("aria-label") || "",
    candidate.getAttribute?.("title") || "",
    url,
  ]
    .join(" ")
    .trim();

  return DOWNLOAD_HINT_PATTERN.test(combinedText);
}

function fallbackToBrowser(candidate, url) {
  if (candidate instanceof HTMLAnchorElement) {
    window.location.href = candidate.href;
    return;
  }

  window.location.href = url;
}

function deriveSuggestedFileName(url, candidate) {
  if (candidate instanceof HTMLAnchorElement && candidate.download) {
    return candidate.download;
  }

  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname.split("/").filter(Boolean);
    return pathname.at(-1) || null;
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
