async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function refreshStatus() {
  const [healthStatus, sessionStatus] = await Promise.allSettled([
    fetchJson('/health'),
    fetchJson('/api/session/status'),
  ]);

  const healthEl = document.querySelector('#health-status');
  const sessionEl = document.querySelector('#session-status');

  healthEl.textContent = healthStatus.status === 'fulfilled' ? 'Online' : 'Unavailable';
  sessionEl.textContent =
    sessionStatus.status === 'fulfilled' && sessionStatus.value.sessionActive ? 'Active' : 'Not set';
}

async function startGatedDownload() {
  await fetchJson('/api/session/start');
  await refreshStatus();
  window.location.href = '/download/gated?sizeMb=12&name=gated-browser-session-12mb.bin';
}

async function startJsTriggeredDownload() {
  const metadata = {
    name: 'js-programmatic-6mb.bin',
    sizeMb: 6,
  };

  await new Promise((resolve) => window.setTimeout(resolve, 150));

  const anchor = document.createElement('a');
  anchor.href = `/download/js-programmatic?sizeMb=${metadata.sizeMb}&name=${encodeURIComponent(metadata.name)}`;
  anchor.download = metadata.name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

document.querySelector('#gated-download')?.addEventListener('click', () => {
  startGatedDownload().catch((error) => {
    console.error(error);
    window.alert(`Gated download failed: ${error.message}`);
  });
});

document.querySelector('#js-download')?.addEventListener('click', () => {
  startJsTriggeredDownload().catch((error) => {
    console.error(error);
    window.alert(`JS-triggered download failed: ${error.message}`);
  });
});

refreshStatus().catch((error) => console.error(error));
