(function () {
  if (window.__TRINITY_DOWNLOAD_HOOK__) {
    return;
  }
  window.__TRINITY_DOWNLOAD_HOOK__ = true;

  const PAGE_CAPTURE_EVENT = "trinity-page-download-capture";
  const PAGE_CAPTURE_RESULT_EVENT = "trinity-page-download-result";
  const DOWNLOAD_HINT_PATTERN =
    /(download|installer|install|setup|exe|msi|zip|rar|7z|pkg|dmg|apk|iso|torrent)/i;
  const CAPTURE_SUPPRESSION_WINDOW_MS = 10000;
  const pendingCaptureUrls = new Set();
  const suppressedCaptureUrls = new Map();

  const originalWindowOpen = window.open.bind(window);
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const originalLocationAssign = window.location.assign.bind(window.location);
  const originalLocationReplace = window.location.replace.bind(window.location);

  window.open = function patchedWindowOpen(url, target, features) {
    const absoluteUrl = toAbsoluteHttpUrl(url);
    if (!shouldCaptureUrl(url, target, absoluteUrl)) {
      return originalWindowOpen(url, target, features);
    }

    if (shouldSuppressCaptureUrl(absoluteUrl)) {
      return null;
    }

    requestCapture(
      {
        url: absoluteUrl,
        page_url: window.location.href,
        suggested_file_name: deriveSuggestedFileName(url),
        mime_type: null,
        referrer: window.location.href,
      },
      (captured) => {
        if (!captured) {
          originalWindowOpen(url, target, features);
        }
      },
    );

    return null;
  };

  HTMLAnchorElement.prototype.click = function patchedAnchorClick() {
    if (!shouldCaptureAnchor(this)) {
      return originalAnchorClick.call(this);
    }

    if (shouldSuppressCaptureUrl(this.href)) {
      return;
    }

    requestCapture(
      {
        url: this.href,
        page_url: window.location.href,
        suggested_file_name: this.download || deriveSuggestedFileName(this.href),
        mime_type: null,
        referrer: window.location.href,
      },
      (captured) => {
        if (!captured) {
          originalAnchorClick.call(this);
        }
      },
    );
  };

  window.location.assign = function patchedLocationAssign(url) {
    const absoluteUrl = toAbsoluteHttpUrl(url);
    if (!shouldCaptureUrl(url, undefined, absoluteUrl)) {
      return originalLocationAssign(url);
    }

    if (shouldSuppressCaptureUrl(absoluteUrl)) {
      return;
    }

    requestCapture(
      {
        url: absoluteUrl,
        page_url: window.location.href,
        suggested_file_name: deriveSuggestedFileName(url),
        mime_type: null,
        referrer: window.location.href,
      },
      (captured) => {
        if (!captured) {
          originalLocationAssign(url);
        }
      },
    );
  };

  window.location.replace = function patchedLocationReplace(url) {
    const absoluteUrl = toAbsoluteHttpUrl(url);
    if (!shouldCaptureUrl(url, undefined, absoluteUrl)) {
      return originalLocationReplace(url);
    }

    if (shouldSuppressCaptureUrl(absoluteUrl)) {
      return;
    }

    requestCapture(
      {
        url: absoluteUrl,
        page_url: window.location.href,
        suggested_file_name: deriveSuggestedFileName(url),
        mime_type: null,
        referrer: window.location.href,
      },
      (captured) => {
        if (!captured) {
          originalLocationReplace(url);
        }
      },
    );
  };

  function requestCapture(payload, onResult) {
    if (!payload?.url) {
      onResult(false);
      return;
    }

    const normalizedUrl = normalizeCaptureUrl(payload.url);
    if (shouldSuppressCaptureUrl(normalizedUrl)) {
      onResult(true);
      return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    pendingCaptureUrls.add(normalizedUrl);

    const finish = (captured) => {
      if (settled) {
        return;
      }
      settled = true;
      pendingCaptureUrls.delete(normalizedUrl);
      if (captured) {
        suppressedCaptureUrls.set(
          normalizedUrl,
          Date.now() + CAPTURE_SUPPRESSION_WINDOW_MS,
        );
      } else {
        suppressedCaptureUrls.delete(normalizedUrl);
      }
      onResult(captured);
    };

    const resultHandler = (event) => {
      if (event.detail?.requestId !== requestId) {
        return;
      }

      window.removeEventListener(PAGE_CAPTURE_RESULT_EVENT, resultHandler);
      if (event.detail?.captured === true) {
        finish(true);
        return;
      }

      finish(event.detail?.fallbackToBrowser !== true);
    };

    window.addEventListener(PAGE_CAPTURE_RESULT_EVENT, resultHandler);
    window.dispatchEvent(
      new CustomEvent(PAGE_CAPTURE_EVENT, {
        detail: {
          requestId,
          payload,
        },
      }),
    );

    setTimeout(() => {
      window.removeEventListener(PAGE_CAPTURE_RESULT_EVENT, resultHandler);
      finish(true);
    }, 5000);
  }

  function shouldCaptureAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) {
      return false;
    }

    if (!isHttpUrl(anchor.href)) {
      return false;
    }

    if (anchor.hasAttribute("download")) {
      return true;
    }

    const combinedText = [
      anchor.textContent || "",
      anchor.getAttribute("aria-label") || "",
      anchor.getAttribute("title") || "",
      anchor.href,
    ]
      .join(" ")
      .trim();

    return DOWNLOAD_HINT_PATTERN.test(combinedText);
  }

  function shouldCaptureUrl(url, target, absoluteUrl = toAbsoluteHttpUrl(url)) {
    if (!absoluteUrl) {
      return false;
    }

    const combinedText = [String(url || ""), String(target || "")].join(" ").trim();
    return DOWNLOAD_HINT_PATTERN.test(combinedText) || isLikelyBinaryUrl(absoluteUrl);
  }

  function isLikelyBinaryUrl(value) {
    try {
      const parsed = new URL(value, window.location.href);
      const pathname = parsed.pathname.toLowerCase();
      return /\.(exe|msi|zip|rar|7z|pkg|dmg|apk|iso|torrent|deb|rpm)(?:$|[?#])/.test(pathname);
    } catch {
      return false;
    }
  }

  function toAbsoluteHttpUrl(value) {
    try {
      const parsed = new URL(String(value), window.location.href);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {}
    return null;
  }

  function isHttpUrl(value) {
    return !!toAbsoluteHttpUrl(value);
  }

  function shouldSuppressCaptureUrl(value) {
    const normalizedUrl = normalizeCaptureUrl(value);
    if (!normalizedUrl) {
      return false;
    }

    if (pendingCaptureUrls.has(normalizedUrl)) {
      return true;
    }

    cleanupSuppressedCaptureUrls();
    const expiresAt = suppressedCaptureUrls.get(normalizedUrl);
    return typeof expiresAt === "number" && expiresAt > Date.now();
  }

  function cleanupSuppressedCaptureUrls() {
    const now = Date.now();
    for (const [key, expiresAt] of suppressedCaptureUrls.entries()) {
      if (expiresAt <= now) {
        suppressedCaptureUrls.delete(key);
      }
    }
  }

  function normalizeCaptureUrl(value) {
    return toAbsoluteHttpUrl(value) || "";
  }

  function deriveSuggestedFileName(value) {
    try {
      const parsed = new URL(String(value), window.location.href);
      const pathname = parsed.pathname.split("/").filter(Boolean);
      return pathname.at(-1) || null;
    } catch {
      return null;
    }
  }
})();
