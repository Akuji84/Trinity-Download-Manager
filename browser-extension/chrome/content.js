const DOWNLOAD_HINT_PATTERN =
  /(download|installer|install|setup|exe|msi|zip|rar|7z|pkg|dmg|apk|iso|torrent)/i;
const PAGE_CAPTURE_EVENT = "trinity-page-download-capture";
const PAGE_CAPTURE_RESULT_EVENT = "trinity-page-download-result";

injectPageHook();

window.addEventListener(PAGE_CAPTURE_EVENT, (event) => {
  const detail = event.detail;
  if (!detail?.requestId || !detail?.payload) {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "capture-download-click",
      payload: detail.payload,
    },
    (response) => {
      const captured = chrome.runtime.lastError ? false : response?.captured === true;
      window.dispatchEvent(
        new CustomEvent(PAGE_CAPTURE_RESULT_EVENT, {
          detail: {
            requestId: detail.requestId,
            captured,
          },
        }),
      );
    },
  );
});

document.addEventListener(
  "click",
  (event) => {
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

    chrome.runtime.sendMessage(
      {
        type: "capture-download-click",
        payload,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          fallbackToBrowser(candidate, payload.url);
          return;
        }

        if (response?.captured === true) {
          return;
        }

        if (response?.captured === false) {
          fallbackToBrowser(candidate, payload.url);
        }
      },
    );
  },
  true,
);

function injectPageHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-hook.js");
  script.async = false;
  script.dataset.trinityHook = "true";
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
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
