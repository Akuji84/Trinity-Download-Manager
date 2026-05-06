const statusNode = document.getElementById("popup-status");
const openTrinityButton = document.getElementById("open-trinity");
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
  popupState = {
    connected: response?.connected === true,
    capturePaused: response?.capturePaused === true,
    siteExcluded: response?.siteExcluded === true,
    siteHost: response?.siteHost ?? "",
  };
  render();
}

function render() {
  setStatus(popupState.connected ? "Trinity is connected." : "Trinity is not running.");
  openTrinityButton.hidden = popupState.connected;
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

openTrinityButton.addEventListener("click", async () => {
  await launchTrinityFromPopup();
  setStatus("Checking Trinity...");
  const response = await chrome.runtime.sendMessage({ type: "bridge-status" });
  popupState.connected = response?.connected === true;
  render();
});

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
  await chrome.runtime.sendMessage({ type: "open-options-page" });
});

helpButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "open-help-page" });
});

async function launchTrinityFromPopup() {
  const launchFrame = document.createElement("iframe");
  launchFrame.style.display = "none";
  launchFrame.src = "trinity://launch";
  document.body.appendChild(launchFrame);
  await new Promise((resolve) => setTimeout(resolve, 800));
  launchFrame.remove();
}

initializePopup().catch((error) => {
  console.error("Popup initialization failed", error);
  setStatus("Could not initialize the Trinity menu.");
});
