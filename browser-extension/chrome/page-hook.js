(function () {
  if (window.__TRINITY_DOWNLOAD_HOOK__) {
    return;
  }

  window.__TRINITY_DOWNLOAD_HOOK__ = true;

  // Automatic page-level JS interception is intentionally disabled.
  // Trinity now relies on the browser-resolved download event path instead
  // of patching page navigation or programmatic download triggers.
})();
