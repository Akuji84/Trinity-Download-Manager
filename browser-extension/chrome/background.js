const BRIDGE_BASE_URL = "http://127.0.0.1:38491";
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

chrome.action.onClicked.addListener(async (tab) => {
  await sendTabToTrinity(tab);
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

  const bridgeReady = await pingBridge();
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
