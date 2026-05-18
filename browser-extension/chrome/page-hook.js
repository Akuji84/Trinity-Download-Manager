(function () {
  if (window.__TRINITY_DOWNLOAD_HOOK__) {
    return;
  }
  window.__TRINITY_DOWNLOAD_HOOK__ = true;

  const PAGE_CAPTURE_EVENT = "trinity-page-download-capture";
  const PAGE_CAPTURE_RESULT_EVENT = "trinity-page-download-result";
  const PAGE_PIPELINE_CAPTURE_EVENT = "trinity-page-pipeline-capture";
  const DOWNLOAD_HINT_PATTERN =
    /(download|installer|install|setup|exe|msi|zip|rar|7z|pkg|dmg|apk|iso|torrent)/i;

  const originalWindowOpen = window.open.bind(window);
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const originalAnchorDispatchEvent = HTMLAnchorElement.prototype.dispatchEvent;
  const originalFormSubmit = HTMLFormElement.prototype.submit;
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const originalCreateObjectUrl = URL.createObjectURL ? URL.createObjectURL.bind(URL) : null;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const originalLocationAssign = window.location.assign.bind(window.location);
  const originalLocationReplace = window.location.replace.bind(window.location);
  const blobSourceByUrl = new Map();
  const xhrRequestUrlByInstance = new WeakMap();

  window.open = function patchedWindowOpen(url, target, features) {
    if (!shouldCaptureUrl(url, target)) {
      return originalWindowOpen(url, target, features);
    }

    requestCapture(
      {
        url: toAbsoluteSupportedUrl(url),
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
    const blobPayload = deriveBlobCapturePayload(this);
    if (blobPayload) {
      requestCapture(blobPayload, (captured) => {
        if (!captured) {
          originalAnchorClick.call(this);
        }
      });
      return;
    }

    if (!shouldCaptureAnchor(this)) {
      return originalAnchorClick.call(this);
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

  HTMLAnchorElement.prototype.dispatchEvent = function patchedAnchorDispatchEvent(event) {
    const blobPayload = deriveBlobCapturePayload(this);
    if (blobPayload && event?.type === "click") {
      requestCapture(blobPayload, (captured) => {
        if (!captured) {
          originalAnchorDispatchEvent.call(this, event);
        }
      });
      return true;
    }

    return originalAnchorDispatchEvent.call(this, event);
  };

  HTMLFormElement.prototype.submit = function patchedFormSubmit() {
    const actionUrl = this.action || this.getAttribute("action");
    if (!shouldCaptureUrl(actionUrl)) {
      return originalFormSubmit.call(this);
    }

    requestCapture(
      {
        url: toAbsoluteSupportedUrl(actionUrl),
        page_url: window.location.href,
        suggested_file_name: deriveSuggestedFileName(actionUrl),
        mime_type: null,
        referrer: window.location.href,
      },
      (captured) => {
        if (!captured) {
          originalFormSubmit.call(this);
        }
      },
    );
  };

  window.location.assign = function patchedLocationAssign(url) {
    if (!shouldCaptureUrl(url)) {
      return originalLocationAssign(url);
    }

    requestCapture(
      {
        url: toAbsoluteSupportedUrl(url),
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
    if (!shouldCaptureUrl(url)) {
      return originalLocationReplace(url);
    }

    requestCapture(
      {
        url: toAbsoluteSupportedUrl(url),
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

  if (originalFetch) {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch(input, init);
      tryCaptureFromResponse(input, response);
      return response;
    };
  }

  XMLHttpRequest.prototype.open = function patchedXhrOpen(method, url, async, user, password) {
    xhrRequestUrlByInstance.set(this, toAbsoluteSupportedUrl(url));
    return originalXhrOpen.call(this, method, url, async, user, password);
  };

  XMLHttpRequest.prototype.send = function patchedXhrSend(body) {
    const handleReadyState = () => {
      if (this.readyState !== 4) {
        return;
      }
      tryCaptureFromXhr(this, xhrRequestUrlByInstance.get(this));
      this.removeEventListener("readystatechange", handleReadyState);
    };
    this.addEventListener("readystatechange", handleReadyState);
    return originalXhrSend.call(this, body);
  };

  if (originalCreateObjectUrl) {
    URL.createObjectURL = function patchedCreateObjectURL(object) {
      const objectUrl = originalCreateObjectUrl(object);
      if (object instanceof Blob && isTorrentLikeBlob(object)) {
        const pendingSource = window.__TRINITY_LAST_TORRENT_SOURCE__ || null;
        if (pendingSource?.url) {
          blobSourceByUrl.set(objectUrl, {
            url: pendingSource.url,
            page_url: window.location.href,
            suggested_file_name: pendingSource.suggested_file_name || null,
            mime_type: pendingSource.mime_type || object.type || "application/x-bittorrent",
            referrer: window.location.href,
          });
          delete window.__TRINITY_LAST_TORRENT_SOURCE__;
        } else {
          emitPipelineCapture({
            url: objectUrl,
            page_url: window.location.href,
            suggested_file_name: null,
            mime_type: object.type || "application/x-bittorrent",
            referrer: window.location.href,
          });
        }
      }
      return objectUrl;
    };
  }

  function requestCapture(payload, onResult) {
    if (!payload?.url) {
      onResult(false);
      return;
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (captured) => {
      if (settled) {
        return;
      }
      settled = true;
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

    if (!isSupportedUrl(anchor.href)) {
      return false;
    }

    if (anchor.hasAttribute("download")) {
      return true;
    }

    if (isMagnetUrl(anchor.href) || isLikelyBinaryUrl(anchor.href)) {
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

  function emitPipelineCapture(payload) {
    window.dispatchEvent(
      new CustomEvent(PAGE_PIPELINE_CAPTURE_EVENT, {
        detail: { payload },
      }),
    );
  }

  function shouldCaptureUrl(url, target) {
    const absoluteUrl = toAbsoluteSupportedUrl(url);
    if (!absoluteUrl) {
      return false;
    }

    const combinedText = [String(url || ""), String(target || "")].join(" ").trim();
    return isMagnetUrl(absoluteUrl) || DOWNLOAD_HINT_PATTERN.test(combinedText) || isLikelyBinaryUrl(absoluteUrl);
  }

  function tryCaptureFromResponse(input, response) {
    if (!response) {
      return;
    }

    const responseUrl = response.url || deriveRequestUrl(input);
    const contentType = String(response.headers?.get?.("content-type") || "");
    const disposition = String(response.headers?.get?.("content-disposition") || "");
    const looksTorrent =
      isMagnetUrl(responseUrl) ||
      /\.torrent(?:$|[?#])/i.test(String(responseUrl || "")) ||
      /application\/x-bittorrent/i.test(contentType) ||
      /\.torrent/i.test(disposition);

    if (!looksTorrent) {
      return;
    }

    rememberTorrentSource({
      url: responseUrl,
      page_url: window.location.href,
      suggested_file_name: deriveSuggestedFileName(responseUrl) || deriveFilenameFromDisposition(disposition),
      mime_type: contentType || null,
      referrer: window.location.href,
    });
  }

  function tryCaptureFromXhr(xhr, requestUrl) {
    const contentType = String(xhr.getResponseHeader?.("content-type") || "");
    const disposition = String(xhr.getResponseHeader?.("content-disposition") || "");
    const responseUrl = xhr.responseURL || requestUrl;
    const looksTorrent =
      isMagnetUrl(responseUrl) ||
      /\.torrent(?:$|[?#])/i.test(String(responseUrl || "")) ||
      /application\/x-bittorrent/i.test(contentType) ||
      /\.torrent/i.test(disposition);

    if (!looksTorrent) {
      return;
    }

    rememberTorrentSource({
      url: responseUrl,
      page_url: window.location.href,
      suggested_file_name: deriveSuggestedFileName(responseUrl) || deriveFilenameFromDisposition(disposition),
      mime_type: contentType || null,
      referrer: window.location.href,
    });
  }

  function rememberTorrentSource(payload) {
    window.__TRINITY_LAST_TORRENT_SOURCE__ = payload;
    emitPipelineCapture(payload);
  }

  function deriveBlobCapturePayload(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) {
      return null;
    }

    if (!anchor.href || !anchor.href.startsWith("blob:")) {
      return null;
    }

    const payload = blobSourceByUrl.get(anchor.href);
    if (!payload?.url) {
      return null;
    }

    return {
      ...payload,
      suggested_file_name: anchor.download || payload.suggested_file_name || null,
    };
  }

  function deriveRequestUrl(input) {
    if (typeof input === "string") {
      return toAbsoluteSupportedUrl(input);
    }
    if (input && typeof input.url === "string") {
      return toAbsoluteSupportedUrl(input.url);
    }
    return null;
  }

  function deriveFilenameFromDisposition(disposition) {
    const utf8Match = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }

    const plainMatch = disposition.match(/filename\s*=\s*\"?([^\";]+)\"?/i);
    return plainMatch?.[1] || null;
  }

  function isTorrentLikeBlob(blob) {
    const type = String(blob?.type || "");
    return /application\/x-bittorrent/i.test(type);
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

  function toAbsoluteSupportedUrl(value) {
    if (isMagnetUrl(value)) {
      return String(value);
    }

    try {
      const parsed = new URL(String(value), window.location.href);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {}
    return null;
  }

  function isSupportedUrl(value) {
    return !!toAbsoluteSupportedUrl(value);
  }

  function isMagnetUrl(value) {
    return typeof value === "string" && value.startsWith("magnet:?");
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
