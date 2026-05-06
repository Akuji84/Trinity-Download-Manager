const browserFallbackCheckbox = document.getElementById("browser-fallback");
const saveStatusNode = document.getElementById("save-status");

async function initializeOptions() {
  const state = await chrome.runtime.sendMessage({ type: "get-options-state" });
  browserFallbackCheckbox.checked = state?.browserFallbackWhenUnavailable !== false;
}

browserFallbackCheckbox.addEventListener("change", async () => {
  const response = await chrome.runtime.sendMessage({
    type: "set-browser-fallback-when-unavailable",
    value: browserFallbackCheckbox.checked,
  });

  browserFallbackCheckbox.checked = response?.browserFallbackWhenUnavailable !== false;
  saveStatusNode.textContent = "Saved.";
  setTimeout(() => {
    if (saveStatusNode.textContent === "Saved.") {
      saveStatusNode.textContent = "";
    }
  }, 1500);
});

initializeOptions().catch((error) => {
  console.error("Could not initialize Trinity extension options", error);
  saveStatusNode.textContent = "Could not load settings.";
});
