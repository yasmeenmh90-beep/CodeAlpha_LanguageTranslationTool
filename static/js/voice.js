// Voice input via the Web Speech API (SpeechRecognition). Chrome/Edge/Safari only;
// the mic button is hidden when the API is missing. Note: Chrome sends audio to
// Google's servers for recognition, so it needs a network connection.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const supported = typeof Recognition === "function";

// BCP-47 tags give recognizers a better hint than bare language codes.
const LOCALES = {
  en: "en-US", ar: "ar-SA", bn: "bn-IN", "zh-CN": "zh-CN", nl: "nl-NL", fr: "fr-FR", de: "de-DE", el: "el-GR",
  hi: "hi-IN", id: "id-ID", it: "it-IT", ja: "ja-JP", ko: "ko-KR", fa: "fa-IR", pl: "pl-PL", pt: "pt-PT",
  pa: "pa-IN", ru: "ru-RU", es: "es-ES", sv: "sv-SE", ta: "ta-IN", tr: "tr-TR", uk: "uk-UA", ur: "ur-PK", vi: "vi-VN",
};

const ERRORS = {
  "not-allowed": "Microphone access was blocked. Allow it in your browser's site settings.",
  "service-not-allowed": "Voice input isn't allowed in this browser.",
  "audio-capture": "No microphone was found.",
  network: "Voice input needs an internet connection.",
  "no-speech": "Didn't catch that. Try speaking again.",
  "language-not-supported": "Voice input doesn't support this language in your browser.",
};

export class VoiceInput {
  /**
   * @param {object} o
   * @param {(text: string) => void} o.onText     called with the full transcript so far
   * @param {(listening: boolean) => void} o.onState
   * @param {(message: string) => void} o.onError
   */
  constructor({ onText, onState, onError }) {
    this.onText = onText;
    this.onState = onState;
    this.onError = onError;
    this.rec = null;
    this.listening = false;
  }

  start(lang) {
    if (!supported || this.listening) return;
    const rec = new Recognition();
    rec.lang = LOCALES[lang] || lang || navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;

    rec.addEventListener("result", (e) => {
      let text = "";
      for (const result of e.results) text += result[0].transcript;
      this.onText(text.trim());
    });
    rec.addEventListener("error", (e) => {
      if (e.error !== "aborted") this.onError(ERRORS[e.error] || `Voice input stopped (${e.error}).`);
    });
    rec.addEventListener("end", () => this.#setListening(false));

    this.rec = rec;
    try {
      rec.start();
      this.#setListening(true);
    } catch (err) {
      this.onError("Couldn't start voice input.");
    }
  }

  stop() {
    if (this.rec && this.listening) this.rec.stop();
  }

  toggle(lang) {
    if (this.listening) this.stop();
    else this.start(lang);
  }

  #setListening(on) {
    this.listening = on;
    if (!on) this.rec = null;
    this.onState(on);
  }
}
