const statusNode = document.getElementById("popup-status");
const captureButton = document.getElementById("toggle-capture");
const siteButton = document.getElementById("toggle-site");
const optionsButton = document.getElementById("open-options");
const helpButton = document.getElementById("open-help");

let popupState = {
  connected: false,
  capturePaused: false,
  siteExcluded: false,
  siteHost: "",
};

async function initializePopup() {
  setStatus("Looking for Trinity...");
  const response = await chrome.runtime.sendMessage({ type: "get-popup-state" });
  popupState = normalizePopupState(response);

  if (!popupState.connected) {
    setStatus("Opening Trinity...");
    await launchTrinityFromPopup();
    const retriedResponse = await chrome.runtime.sendMessage({ type: "bridge-status" });
    popupState.connected = retriedResponse?.connected === true;
  }

  render();
}

function render() {
  setStatus(popupState.connected ? "Trinity is connected." : "Trinity is not running.");
  captureButton.textContent = popupState.capturePaused
    ? "Resume catching downloads from all sites"
    : "Pause to catch downloads from all sites";
  siteButton.textContent = popupState.siteExcluded
    ? `Catch downloads from ${popupState.siteHost || "this site"}`
    : `Don't catch downloads from ${popupState.siteHost || "this site"}`;
  siteButton.disabled = !popupState.siteHost;
}

function setStatus(value) {
  statusNode.textContent = value;
}

captureButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "toggle-capture-paused" });
  popupState.capturePaused = response?.capturePaused === true;
  render();
});

siteButton.addEventListener("click", async () => {
  if (!popupState.siteHost) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "toggle-site-exclusion",
    siteHost: popupState.siteHost,
  });
  popupState.siteExcluded = response?.siteExcluded === true;
  render();
});

optionsButton.addEventListener("click", async () => {
  optionsButton.disabled = true;
  try {
    await openTrinityOptionsFromPopup();
  } finally {
    optionsButton.disabled = false;
  }
});

helpButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "open-help-page" });
});

function normalizePopupState(response) {
  return {
    connected: response?.connected === true,
    capturePaused: response?.capturePaused === true,
    siteExcluded: response?.siteExcluded === true,
    siteHost: response?.siteHost ?? "",
  };
}

async function launchTrinityFromPopup() {
  const launchFrame = document.createElement("iframe");
  launchFrame.style.display = "none";
  launchFrame.src = "trinity://launch";
  document.body.appendChild(launchFrame);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  launchFrame.remove();
}

async function openTrinityOptionsFromPopup() {
  let bridgeStatus = await chrome.runtime.sendMessage({ type: "bridge-status" });
  if (bridgeStatus?.connected !== true) {
    setStatus("Opening Trinity...");
    await launchTrinityFromPopup();
    bridgeStatus = await waitForBridgeConnection();
  }

  if (bridgeStatus?.connected !== true) {
    setStatus("Could not reach Trinity.");
    return;
  }

  setStatus("Opening Preferences...");
  const response = await chrome.runtime.sendMessage({ type: "open-trinity-options" });
  if (response?.ok === true) {
    popupState.connected = true;
    setStatus("Opening Preferences...");
    window.close();
    return;
  }

  setStatus("Could not open Preferences.");
}

async function waitForBridgeConnection() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 6000) {
    const response = await chrome.runtime.sendMessage({ type: "bridge-status" });
    if (response?.connected === true) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return { connected: false };
}

initializePopup().catch((error) => {
  console.error("Popup initialization failed", error);
  setStatus("Could not initialize the Trinity menu.");
});
