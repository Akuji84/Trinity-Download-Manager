// Automatic page-level pre-capture is intentionally disabled.
// Trinity now uses the browser-resolved download flow as the primary lane:
// Chrome resolves redirects, session-gated URLs, and final filenames first,
// then the extension intercepts the browser-managed download event.
