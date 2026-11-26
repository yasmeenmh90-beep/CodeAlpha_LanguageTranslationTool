// Observe existing UI state without changing translation or microphone logic.
const main = document.querySelector("#main");
const studio = document.querySelector("#translator");
const label = document.querySelector("#studio-activity-label");
if (main && studio && label) {
  const update = () => {
    const listening = Boolean(studio.querySelector("#mic.is-listening"));
    const translating = Boolean(studio.querySelector('#output[aria-busy="true"]'));
    const speaking = Boolean(studio.querySelector(".is-speaking"));
    const state = listening ? "listening" : translating ? "translating" : speaking ? "speaking" : "ready";
    if (main.dataset.activity !== state) {
      main.dataset.activity = state;
      label.textContent = { listening: "Listening", translating: "Translating", speaking: "Speaking", ready: "Ready" }[state];
    }
  };
  new MutationObserver(update).observe(studio, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["class", "aria-busy"]
  });
  update();
}
