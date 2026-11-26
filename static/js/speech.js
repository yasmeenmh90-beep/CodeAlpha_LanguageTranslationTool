// Text-to-speech via the Web Speech API. Only one utterance plays at a time;
// clicking the active button again stops playback.

export const supported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

let current = null; // { btn, utterance }

if (supported) {
  // Some browsers (Chrome) populate voices asynchronously.
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener?.("voiceschanged", () => speechSynthesis.getVoices());
}

function setActive(btn, on) {
  btn.classList.toggle("is-speaking", on);
  btn.setAttribute("aria-pressed", String(on));
  if (!btn.dataset.label) btn.dataset.label = btn.getAttribute("aria-label");
  btn.setAttribute("aria-label", on ? "Stop speaking" : btn.dataset.label);
  btn.dataset.tooltip = on ? "Stop" : "Listen";
}

export function stop() {
  if (!supported) return;
  const prev = current;
  current = null;
  speechSynthesis.cancel();
  if (prev) setActive(prev.btn, false);
}

export function isSpeaking(btn) {
  return Boolean(current && current.btn === btn);
}

/**
 * Speak `text` in `lang` and reflect state on `btn`. Toggles off if `btn` is already speaking.
 * `onNotice(message)` is called for non-fatal issues (no matching voice, unsupported).
 */
export function toggle(text, lang, btn, onNotice) {
  if (!supported) {
    onNotice?.("Text-to-speech isn't supported in this browser.");
    return;
  }
  if (isSpeaking(btn)) {
    stop();
    return;
  }
  stop();

  const utterance = new SpeechSynthesisUtterance(text);
  if (lang && lang !== "auto") {
    utterance.lang = lang;
    const primary = lang.toLowerCase().split("-")[0];
    const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === primary);
    if (voice) utterance.voice = voice;
    else onNotice?.("No voice installed for this language — using the default voice.");
  }

  const done = () => {
    // Ignore events from utterances that were cancelled and replaced.
    if (current && current.utterance === utterance) {
      current = null;
      setActive(btn, false);
    }
  };
  utterance.addEventListener("end", done);
  utterance.addEventListener("error", done);

  current = { btn, utterance };
  setActive(btn, true);
  speechSynthesis.speak(utterance);
}
