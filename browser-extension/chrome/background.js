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
    page_url: info.pageUrl ?? tab?.url ?? null,
    suggested_file_name: deriveSuggestedFileName(selectedUrl),
    mime_type: null,
    referrer: tab?.url ?? null,
    browser: "chrome",
    output_folder: null,
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bridge-status") {
    ensureBridgeReady()
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
    page_url: currentUrl,
    suggested_file_name: deriveSuggestedFileName(currentUrl),
    mime_type: null,
    referrer: currentUrl,
    browser: "chrome",
    output_folder: null,
  });
}

async function sendToTrinity(payload) {
  if (!isHttpUrl(payload.url)) {
    await showBridgeBadge("URL?", "#7a3f00");
    return;
  }

  const bridgeReady = await ensureBridgeReady();
  if (!bridgeReady) {
    await showBridgeBadge("OFF", "#6a1b1b");
    return;
  }

  try {
    const response = await fetch(`${BRIDGE_BASE_URL}/downloads/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Bridge returned HTTP ${response.status}`);
    }

    await showBridgeBadge("OK", "#145d29");
  } catch (error) {
    console.error("Trinity bridge handoff failed", error);
    await showBridgeBadge("ERR", "#6a1b1b");
  }
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

async function ensureBridgeReady() {
  if (await pingBridge()) {
    return true;
  }

  await launchTrinityManager();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await delay(500);
    if (await pingBridge()) {
      return true;
    }
  }

  return false;
}

async function launchTrinityManager() {
  const launchUrl = "trinity://launch";
  await chrome.tabs.create({ url: launchUrl, active: false });
}

async function getPopupState() {
  const [{ capturePaused = false, excludedSites = [] }, currentTab] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.capturePaused, STORAGE_KEYS.excludedSites]),
    getActiveTab(),
  ]);
  const siteHost = extractHost(currentTab?.url ?? "");

  return {
    connected: await ensureBridgeReady(),
    capturePaused,
    siteExcluded: siteHost ? excludedSites.includes(siteHost) : false,
    siteHost,
  };
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function showBridgeBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 3000);
}
