const DOWNLOAD_HINT_PATTERN =
  /(download|installer|install|setup|exe|msi|zip|rar|7z|pkg|dmg|apk|iso|torrent)/i;
const PAGE_CAPTURE_EVENT = "trinity-page-download-capture";
const PAGE_CAPTURE_RESULT_EVENT = "trinity-page-download-result";

injectPageHook();

window.addEventListener(PAGE_CAPTURE_EVENT, (event) => {
  try {
    const detail = event.detail;
    if (!detail?.requestId || !detail?.payload) {
      return;
    }

    sendRuntimeMessage(
      {
        type: "capture-download-click",
        payload: detail.payload,
      },
      (response) => {
        const captured = hasRuntimeLastError() ? false : response?.captured === true;
        const fallbackToBrowser = hasRuntimeLastError()
          ? true
          : response?.fallbackToBrowser !== false;
        window.dispatchEvent(
          new CustomEvent(PAGE_CAPTURE_RESULT_EVENT, {
            detail: {
              requestId: detail.requestId,
              captured,
              fallbackToBrowser,
            },
          }),
        );
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

      sendRuntimeMessage(
        {
          type: "capture-download-click",
          payload,
        },
        (response) => {
          if (hasRuntimeLastError()) {
            fallbackToBrowser(candidate, payload.url);
            return;
          }

          if (response?.captured === true) {
            return;
          }

          if (response?.fallbackToBrowser !== false) {
            fallbackToBrowser(candidate, payload.url);
          }
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
