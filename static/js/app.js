import { recordUsage } from "./learning-data.js";
// TranslateX — app entry point. Owns application state and wires the UI to the
// API, storage, picker, engine menu, speech, voice, toast and history modules.
import { $, $$, el, icon, setIcon, isMac, isTypingTarget, prefersReducedMotion } from "./dom.js";
import * as api from "./api.js";
import { store, getArray, KEYS } from "./storage.js";
import { LanguagePicker } from "./picker.js";
import { EngineMenu } from "./engine.js";
import { toast } from "./toast.js";
import * as speech from "./speech.js";
import { VoiceInput, supported as voiceSupported } from "./voice.js";
import { renderHistory, refreshTimes } from "./history.js";

/* ---------------------------------------------------------------- constants */

const MAX_CHARS = 5000;
const WARN_AT = Math.floor(MAX_CHARS * 0.9);
const MAX_TARGETS = 5;
const DEBOUNCE_MS = 600;
const SKELETON_DELAY_MS = 120; // avoid flashing the skeleton for very fast responses
const HISTORY_LIMIT = 20;
const FAVORITES_LIMIT = 100;
const RECENT_LANG_LIMIT = 6;
const MERGE_WINDOW_MS = 60_000; // auto-translate refinements within this window replace the last entry
const RTL_LANGS = new Set(["ar", "ur", "fa"]);
const ROMAN_SOURCES = ["ur", "hi"];

// Right-to-left characters: Hebrew + every Arabic-script block (Arabic, Supplement,
// Extended-A, Presentation Forms A/B).
const RTL_CHAR = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;
const LETTER = /\p{L}/u;
const LATIN = /[A-Za-zÀ-ɏḀ-ỿ]/;

/* -------------------------------------------------------------------- state */

const prefs = store.get(KEYS.prefs, {}) || {};
const savedMulti = store.get(KEYS.multi, {}) || {};

const state = {
  languages: [],
  names: new Map(),
  source: typeof prefs.source === "string" ? prefs.source : "auto",
  target: typeof prefs.target === "string" ? prefs.target : "fr",
  provider: typeof prefs.provider === "string" ? prefs.provider : null, // "auto" | engine name | null (unknown backend)
  engines: [], // [{ name, label, configured, requires }]
  detected: null, // language code detected for the current input (source = auto)
  result: null, // single-target result (see toResult)
  batch: null, // multi-target result { text, source, results, elapsed }
  error: null, // ApiError
  loading: false,
  romanized: false, // treat Latin input as romanized Urdu/Hindi
  romanSuggested: false, // backend thinks the (auto-detected) input is romanized Urdu
  fileBase: null, // base filename of an uploaded .txt (used for the download name)
  multi: {
    enabled: savedMulti.enabled === true,
    targets: Array.isArray(savedMulti.targets) ? savedMulti.targets.slice(0, MAX_TARGETS) : [],
  },
  history: getArray(KEYS.history),
  favorites: getArray(KEYS.favorites),
  recents: {
    source: getArray(KEYS.recentSource, ["auto", "en", "es", "fr"]),
    target: getArray(KEYS.recentTarget, ["fr", "es", "de", "ar"]),
  },
  tab: "recent",
  lastKey: "", // identifies the last request so unchanged input isn't re-sent
  controller: null, // AbortController for the in-flight request
  seq: 0, // monotonically increasing request id (guards against stale responses)
};

const pickers = { source: null, target: null };
let engineMenu = null;
let voice = null;
let voiceBase = ""; // text that was in the box when voice input started
let debounceTimer = 0;
let skeletonTimer = 0;
let swapTurns = 0;

/* ---------------------------------------------------------------- elements */

const ui = {
  translator: $("#translator"),
  input: $("#input"),
  clear: $("#clear"),
  count: $("#char-count"),
  translateBtn: $("#translate"),
  speakIn: $("#speak-in"),
  mic: $("#mic"),
  upload: $("#upload"),
  fileInput: $("#file-input"),
  sourcePane: $(".pane--source"),
  romanHint: $("#roman-hint"),
  romanHintText: $("#roman-hint-text"),
  romanToggle: $("#roman-toggle"),
  detectedBadge: $("#detected-badge"),
  swap: $("#swap"),
  multiToggle: $("#multi-toggle"),
  multiBar: $("#multi-bar"),
  multiChips: $("#multi-chips"),
  multiCount: $("#multi-count"),
  multiResults: $("#multi-results"),
  outputRegion: $("#output"),
  outputText: $("#output-text"),
  outputNote: $("#output-note"),
  alts: $("#output-alts"),
  altsList: $("#alts-list"),
  placeholder: $("#output-placeholder"),
  errorBox: $("#output-error"),
  errorTitle: $("#output-error-title"),
  errorTried: $("#output-error-tried"),
  errorDetail: $("#output-error-detail"),
  retry: $("#retry"),
  meta: $("#output-meta"),
  speakOut: $("#speak-out"),
  copy: $("#copy"),
  download: $("#download"),
  share: $("#share"),
  star: $("#star"),
  themeToggle: $("#theme-toggle"),
  themeColor: $('meta[name="theme-color"]'),
  shortcutsBtn: $("#shortcuts-btn"),
  dialog: $("#shortcuts-dialog"),
  dialogClose: $("#shortcuts-close"),
  tabs: $$('[role="tab"]'),
  panel: $("#history-panel"),
  historyList: $("#history-list"),
  historyEmpty: $("#history-empty"),
  emptyTitle: $("#empty-title"),
  emptyText: $("#empty-text"),
  clearHistory: $("#clear-history"),
  countRecent: $("#count-recent"),
  countStarred: $("#count-starred"),
};

/* ----------------------------------------------------------------- helpers */

const name = (code) => state.names.get(code) || code;
const langDir = (code) => (code && RTL_LANGS.has(code.split("-")[0]) ? "rtl" : "ltr");

/**
 * Direction from the text itself (first strong character), so romanized Urdu
 * typed with source=Urdu stays left-to-right. Falls back to the language when
 * the text has no letters yet (e.g. an empty box shows its placeholder correctly).
 */
function textDir(text) {
  for (const ch of text || "") {
    if (RTL_CHAR.test(ch)) return "rtl";
    if (LETTER.test(ch)) return "ltr";
  }
  return null;
}
const dirOf = (text, lang) => textDir(text) || langDir(lang);

/** At least 60% of the letters are Latin. */
function isLatinText(text) {
  let letters = 0;
  let latin = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters += 1;
    if (LATIN.test(ch)) latin += 1;
  }
  return letters > 0 && latin / letters >= 0.6;
}

const engineLabel = (p) => (engineMenu ? engineMenu.shortLabel(p) : p);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const entryKey = (e) => `${e.source}|${e.target}|${e.text}|${e.romanized ? 1 : 0}`;
const hasOutput = () => Boolean(!state.multi.enabled && state.result && !state.error);
const romanLangName = () => (state.source === "hi" ? "Hindi" : "Urdu");

/** Does `detail` say anything that `title` doesn't already? (avoids repeated sentences) */
function addsInformation(title, detail) {
  if (!detail) return false;
  const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const known = words(title);
  const filler = new Set(["the", "a", "an", "is", "are", "was", "right", "now", "this", "that", "to", "of", "it", "service"]);
  return [...words(detail)].some((w) => !known.has(w) && !filler.has(w));
}

function savePrefs() {
  store.set(KEYS.prefs, { source: state.source, target: state.target, provider: state.provider });
}

function saveMulti() {
  store.set(KEYS.multi, state.multi);
}

function requestKey(text) {
  const targets = state.multi.enabled ? state.multi.targets.join(",") : state.target;
  return JSON.stringify([text, state.source, targets, state.provider || "", state.romanized, state.multi.enabled]);
}

/* ------------------------------------------------------------ input editor */

function autoGrow() {
  const ta = ui.input;
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
}

function updateCounter() {
  const n = ui.input.value.length;
  ui.count.textContent = `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
  ui.count.classList.toggle("is-warn", n >= WARN_AT && n < MAX_CHARS);
  ui.count.classList.toggle("is-max", n >= MAX_CHARS);
}

function syncInputControls() {
  const hasText = ui.input.value.trim().length > 0;
  ui.clear.hidden = ui.input.value.length === 0;
  ui.speakIn.disabled = !hasText;
  ui.share.disabled = !hasText || state.multi.enabled;
}

/** Refresh everything that depends on the input text (no network). */
function afterInputChanged() {
  updateCounter();
  syncInputControls();
  autoGrow();
  updateDirections();
  updateRomanHint();
}

function updateDirections() {
  const srcLang = state.source === "auto" ? state.detected : state.source;
  ui.input.dir = dirOf(ui.input.value, srcLang);
  if (state.romanized) ui.input.lang = `${state.source === "hi" ? "hi" : "ur"}-Latn`;
  else if (srcLang) ui.input.lang = srcLang;
  else ui.input.removeAttribute("lang");

  const outLang = state.result ? state.result.target : state.target;
  ui.outputText.dir = dirOf(state.result ? state.result.translation : "", outLang);
  ui.outputText.lang = outLang;
}

/* ------------------------------------------------------------- Roman Urdu */

function updateRomanHint() {
  const text = ui.input.value.trim();
  const latin = Boolean(text) && isLatinText(text);
  if (!latin) {
    state.romanized = false;
    state.romanSuggested = false;
  }
  const suggest = latin && (ROMAN_SOURCES.includes(state.source) || (state.source === "auto" && state.romanSuggested));
  const show = latin && (state.romanized || suggest);
  ui.romanHint.hidden = !show;
  if (!show) return;

  const lang = romanLangName();
  ui.romanHint.classList.toggle("is-on", state.romanized);
  ui.romanToggle.setAttribute("aria-pressed", String(state.romanized));
  if (state.romanized) {
    ui.romanHintText.textContent = `Translating as Roman ${lang}. Quality depends on the engine.`;
    ui.romanToggle.textContent = "Turn off";
  } else {
    ui.romanHintText.textContent = `Looks like Roman ${lang}. Translate as ${lang}?`;
    ui.romanToggle.textContent = `Translate as ${lang}`;
  }
}

function toggleRomanized() {
  state.romanized = !state.romanized;
  updateRomanHint();
  updateDirections();
  runTranslate({ force: true });
}

/* -------------------------------------------------------------- languages */

function setDetected(code) {
  state.detected = code || null;
  const show = state.source === "auto" && state.detected && !state.romanized;
  ui.detectedBadge.hidden = !show;
  ui.detectedBadge.textContent = show ? `Detected: ${name(state.detected)}` : "";
  pickers.source?.setDetected(show ? name(state.detected) : null);
  updateDirections();
}

function pushRecent(kind, code) {
  const list = [code, ...state.recents[kind].filter((c) => c !== code)].slice(0, RECENT_LANG_LIMIT);
  state.recents[kind] = list;
  store.set(kind === "source" ? KEYS.recentSource : KEYS.recentTarget, list);
  pickers[kind]?.renderChips();
}

function firstTargetOtherThan(code) {
  return (
    state.recents.target.find((c) => c !== code && c !== "auto" && state.names.has(c)) ||
    (code === "en" ? "fr" : "en")
  );
}

function setSource(code, { translate = true } = {}) {
  if (code === state.source) return;
  const prev = state.source;
  // Picking the current target as source would be a no-op translation, so flip them.
  if (code === state.target && !state.multi.enabled) {
    state.target = prev !== "auto" ? prev : firstTargetOtherThan(code);
    pickers.target.setValue(state.target);
    pushRecent("target", state.target);
  }
  state.source = code;
  pickers.source.setValue(code);
  pushRecent("source", code);
  if (code !== "auto") setDetected(null);
  if (!ROMAN_SOURCES.includes(code) && code !== "auto") state.romanized = false;
  state.romanSuggested = false;
  if (state.multi.enabled && state.multi.targets.includes(code)) {
    state.multi.targets = state.multi.targets.filter((t) => t !== code);
    if (!state.multi.targets.length) state.multi.targets = [firstTargetOtherThan(code)];
    saveMulti();
    renderMultiChips();
  }
  afterLanguageChange(translate);
}

function setTarget(code, { translate = true } = {}) {
  if (code === state.target) return;
  const prev = state.target;
  if (code === state.source) {
    state.source = prev;
    pickers.source.setValue(prev);
    pushRecent("source", prev);
    setDetected(null);
  }
  state.target = code;
  pickers.target.setValue(code);
  pushRecent("target", code);
  afterLanguageChange(translate);
}

function afterLanguageChange(translate) {
  savePrefs();
  updateDirections();
  updateRomanHint();
  if (translate && ui.input.value.trim()) runTranslate();
}

function setupLanguages(languages) {
  state.languages = languages;
  state.names = new Map(languages.map((l) => [l.code, l.name]));

  // Discard stale preferences (e.g. a language removed from the backend).
  if (!state.names.has(state.source)) state.source = "auto";
  if (!state.names.has(state.target) || state.target === "auto") state.target = state.source === "fr" ? "en" : "fr";
  if (state.source === state.target) state.source = "auto";
  state.multi.targets = state.multi.targets.filter((t) => state.names.has(t) && t !== "auto" && t !== state.source);

  pickers.source = new LanguagePicker({
    id: "source",
    root: $("#source-bar"),
    languages,
    includeAuto: true,
    value: state.source,
    label: "Source language",
    getRecents: () => state.recents.source,
    onSelect: (code) => setSource(code),
  });
  pickers.target = new LanguagePicker({
    id: "target",
    root: $("#target-bar"),
    languages,
    includeAuto: false,
    value: state.target,
    label: "Target language",
    getRecents: () => state.recents.target,
    onSelect: (code) => (state.multi.enabled ? toggleMultiTarget(code) : setTarget(code)),
  });
  applyMultiUI();
  updateDirections();
  renderHistoryView(); // names are now available for the cards
}

/* ---------------------------------------------------------------- engines */

async function setupEngines() {
  engineMenu = new EngineMenu({
    root: $("#engine-root"),
    onSelect: (engine) => {
      state.provider = engine;
      savePrefs();
      state.lastKey = "";
      toast(`Engine: ${engine === "auto" ? "Auto (fallback chain)" : engineLabel(engine)}`, { type: "info", duration: 2000 });
      if (ui.input.value.trim()) runTranslate();
    },
  });
  const info = await api.getProviders();
  if (!info) {
    state.provider = null; // backend can't choose engines: leave the pill disabled
    return;
  }
  state.engines = info.providers;
  const usable = (n) => n === "auto" || info.providers.some((p) => p.name === n && p.configured);
  if (!usable(state.provider)) state.provider = usable(info.default) ? info.default : "auto";
  engineMenu.setEngines(info, state.provider);
}

/* --------------------------------------------------------- multi-language */

function seedMultiTargets() {
  const picks = [state.target, ...state.recents.target].filter(
    (c, i, all) => c !== "auto" && c !== state.source && state.names.has(c) && all.indexOf(c) === i
  );
  return picks.slice(0, 3);
}

function setMulti(on, { translate = true } = {}) {
  state.multi.enabled = on;
  if (on && !state.multi.targets.length) state.multi.targets = seedMultiTargets();
  saveMulti();
  cancelInFlight();
  state.result = null;
  state.batch = null;
  state.error = null;
  state.lastKey = "";
  speech.stop();
  applyMultiUI();
  renderOutput();
  if (translate && ui.input.value.trim()) runTranslate();
}

function applyMultiUI() {
  const on = state.multi.enabled;
  ui.multiToggle.setAttribute("aria-checked", String(on));
  ui.translator.classList.toggle("is-multi", on);
  ui.multiBar.hidden = !on;
  ui.swap.disabled = on;
  ui.swap.dataset.tooltip = on ? "Swap is off in multi-language mode" : "Swap languages";
  if (pickers.target) {
    if (on) pickers.target.setMulti(true, { getSelected: () => state.multi.targets, label: "Add language" });
    else {
      pickers.target.setMulti(false);
      pickers.target.setValue(state.target);
    }
  }
  syncInputControls();
  renderMultiChips();
}

function renderMultiChips() {
  const { targets } = state.multi;
  ui.multiChips.replaceChildren(
    ...targets.map((code) => {
      const btn = el("button", { type: "button", class: "chip chip--removable", "aria-label": `Remove ${name(code)}` }, [
        el("span", { text: name(code) }),
        icon("x", "icon icon--xs"),
      ]);
      btn.addEventListener("click", () => toggleMultiTarget(code));
      return el("li", {}, [btn]);
    })
  );
  ui.multiCount.textContent = `${targets.length} of ${MAX_TARGETS}`;
  if (pickers.target && state.multi.enabled) {
    pickers.target.labelOverride = targets.length >= MAX_TARGETS ? "5 of 5 selected" : "Add language";
    pickers.target.updateLabel();
  }
}

function toggleMultiTarget(code) {
  const { targets } = state.multi;
  if (targets.includes(code)) {
    if (targets.length === 1) {
      toast("Keep at least one target language.", { type: "info" });
      return;
    }
    state.multi.targets = targets.filter((t) => t !== code);
  } else {
    if (targets.length >= MAX_TARGETS) {
      toast(`You can translate into up to ${MAX_TARGETS} languages at once.`, { type: "info" });
      return;
    }
    if (code === state.source) {
      toast("That's the source language.", { type: "info" });
      return;
    }
    state.multi.targets = [...targets, code];
    pushRecent("target", code);
  }
  saveMulti();
  renderMultiChips();
  if (ui.input.value.trim()) runTranslate();
}

/* ------------------------------------------------------------- translate */

function setLoading(on) {
  state.loading = on;
  ui.translateBtn.disabled = on;
  ui.translateBtn.classList.toggle("is-loading", on);
  ui.translateBtn.setAttribute("aria-busy", String(on));
  ui.outputRegion.setAttribute("aria-busy", String(on));
  clearTimeout(skeletonTimer);
  if (on) skeletonTimer = setTimeout(() => ui.outputRegion.classList.add("is-loading"), SKELETON_DELAY_MS);
  else ui.outputRegion.classList.remove("is-loading");
}

function cancelInFlight() {
  clearTimeout(debounceTimer);
  if (state.controller) state.controller.abort();
  state.controller = null;
  state.seq += 1; // invalidate any response still on its way
  if (state.loading) setLoading(false);
}

function toResult(req, data, elapsed) {
  return {
    text: req.text,
    translation: data.translated_text,
    source: req.source,
    detected: req.source === "auto" ? data.detected_source || null : null,
    detectedConfidence: data.detected_confidence ?? null,
    target: data.target || req.target,
    provider: data.provider,
    providersTried: data.providers_tried || [],
    cached: Boolean(data.cached),
    alternatives: data.alternatives || [],
    romanized: Boolean(data.romanized),
    warnings: data.warnings || [],
    elapsed,
  };
}

/**
 * Translate the current input (single or multi-target). Auto-translate calls this
 * without `force`, which skips the request when nothing relevant changed. Every
 * new call aborts the previous request, and a sequence id makes sure an
 * out-of-order response can never overwrite a newer one.
 */
async function runTranslate({ force = false } = {}) {
  clearTimeout(debounceTimer);
  const text = ui.input.value.trim();
  if (!text) {
    if (force) {
      toast("Type or paste some text to translate.", { type: "info" });
      ui.input.focus();
    }
    return;
  }

  const multi = state.multi.enabled;
  const key = requestKey(text);
  const haveResult = multi ? state.batch : state.result;
  if (!force && key === state.lastKey && (haveResult || state.loading)) return;
  state.lastKey = key;

  const req = { text, source: state.source, provider: state.provider, romanized: state.romanized };
  if (multi) req.targets = [...state.multi.targets];
  else req.target = state.target;

  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;
  const seq = ++state.seq;
  setLoading(true);
  const started = performance.now();

  try {
    const data = multi ? await api.translateBatch(req, controller.signal) : await api.translate(req, controller.signal);
    if (seq !== state.seq) return; // a newer request superseded this one
    const elapsed = Math.round(performance.now() - started);
    state.error = null;
    if (multi) {
      for (const item of data.results) recordUsage({target:item.target,provider:item.result?.provider || "unknown",elapsed:null,cached:item.result?.cached,ok:item.ok});
    } else recordUsage({target:req.target,provider:data.provider,elapsed,cached:data.cached,ok:true});

    if (multi) {
      state.batch = { text, source: req.source, results: data.results, elapsed };
      const first = data.results.find((r) => r.ok)?.result;
      if (first) {
        engineMenu?.setUsed(first.provider);
        state.romanSuggested = Boolean(first.suggest_romanized);
      }
      setDetected(req.source === "auto" && first ? first.detected_source : null);
    } else {
      state.result = toResult(req, data, elapsed);
      state.romanSuggested = Boolean(data.suggest_romanized);
      engineMenu?.setUsed(data.provider);
      setDetected(state.result.detected);
      addToHistory(state.result);
    }
    renderOutput();
    updateRomanHint();
  } catch (err) {
    if (err.name === "AbortError" || seq !== state.seq) return;
    recordUsage({target:req.target || "batch",provider:req.provider || "auto",elapsed:Math.round(performance.now()-started),ok:false});
    state.error =
      err instanceof api.ApiError
        ? err
        : new api.ApiError({ kind: "unknown", title: "Something went wrong while translating.", detail: String(err.message || err) });
    state.result = null;
    state.batch = null;
    state.lastKey = ""; // allow the same request to be retried
    renderOutput();
  } finally {
    if (seq === state.seq) {
      state.controller = null;
      setLoading(false);
    }
  }
}

function scheduleTranslate() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runTranslate(), DEBOUNCE_MS);
}

/* ---------------------------------------------------------------- output */

function renderError() {
  const { error } = state;
  ui.errorBox.hidden = !error;
  if (!error) return;
  ui.errorTitle.textContent = error.title;

  const tried = error.providersTried || [];
  ui.errorTried.hidden = tried.length === 0;
  ui.errorTried.textContent = tried.length ? `Tried: ${tried.map(engineLabel).join(" → ")}` : "";

  // Per-engine reasons are new information; a lone backend sentence is shown only if it adds something.
  const failures = error.failures || [];
  const lines = failures.length
    ? failures.map((f) => `${engineLabel(f.provider)}: ${f.reason}`).filter((line) => addsInformation(error.title, line))
    : addsInformation(error.title, error.detail)
      ? [error.detail]
      : [];
  if (state.romanized && failures.length) {
    lines.push("Roman Urdu needs an engine with auto-detect: Google Cloud, Microsoft, or the free Google endpoint. MyMemory can't read it.");
  }
  const detail = lines.join("\n");
  ui.errorDetail.textContent = detail;
  ui.errorDetail.hidden = !detail;
}

function renderOutput() {
  const multi = state.multi.enabled;
  const { result, error, batch } = state;
  const show = hasOutput();

  renderError();

  ui.outputText.textContent = show ? result.translation : "";
  ui.outputText.hidden = !show;

  const warnings = show ? result.warnings : [];
  ui.outputNote.hidden = warnings.length === 0;
  ui.outputNote.textContent = warnings.join(" ");

  const alts = show ? result.alternatives : [];
  ui.alts.hidden = alts.length === 0;
  ui.altsList.replaceChildren(
    ...alts.map((alt) => el("li", { class: "alts__item", text: alt, dir: dirOf(alt, result.target), lang: result.target }))
  );

  ui.multiResults.hidden = !(multi && batch && !error);
  if (multi && batch && !error) renderBatch(batch);

  ui.placeholder.hidden = Boolean(error || (multi ? batch : result));
  ui.placeholder.textContent = multi ? "Translations will appear here, one card per language" : "Translation will appear here";

  for (const btn of [ui.speakOut, ui.copy, ui.download, ui.star]) btn.disabled = !show;
  if (!show && speech.isSpeaking(ui.speakOut)) speech.stop();

  renderMeta();
  renderStar();
  updateDirections();
}

function metaChip(text, extra = "", iconName = null) {
  return el("span", { class: `meta-chip ${extra}`.trim() }, [iconName ? icon(iconName, "icon icon--xs") : null, el("span", { text })]);
}

function renderMeta() {
  const items = [];
  if (state.multi.enabled && state.batch && !state.error) {
    const ok = state.batch.results.filter((r) => r.ok).map((r) => r.result);
    const engines = [...new Set(ok.map((r) => r.provider))].filter((p) => p !== "none");
    if (engines.length) items.push(metaChip(engines.map(engineLabel).join(", "), "", "zap"));
    if (ok.length && ok.every((r) => r.cached)) items.push(metaChip("cached", "meta-chip--cached"));
    items.push(el("span", { class: "meta__item", text: `${ok.length}/${state.batch.results.length} languages · ${state.batch.elapsed} ms` }));
  } else if (hasOutput()) {
    const r = state.result;
    if (r.provider === "none") {
      items.push(el("span", { class: "meta__item", text: "Same language — nothing to translate" }));
    } else {
      items.push(metaChip(engineLabel(r.provider), "", "zap"));
      if (r.cached) items.push(metaChip("cached", "meta-chip--cached"));
      items.push(el("span", { class: "meta__item", text: `${r.elapsed} ms` }));
      if (r.romanized) items.push(metaChip(`from Roman ${romanLangName()}`, "meta-chip--accent"));
      if (r.source === "auto" && r.detected) {
        const pct = r.detectedConfidence != null ? ` · ${Math.round(r.detectedConfidence * 100)}%` : "";
        items.push(el("span", { class: "meta__item", text: `Detected ${name(r.detected)}${pct}` }));
      }
      if (r.providersTried.length > 1) {
        items.push(el("span", { class: "meta__item meta__tried", text: `Fallback: ${r.providersTried.map(engineLabel).join(" → ")}` }));
      }
    }
  }
  ui.meta.replaceChildren(...items);
}

function renderBatch(batch) {
  ui.multiResults.replaceChildren(
    ...batch.results.map((item) => {
      const card = el("li", { class: `mcard${item.ok ? "" : " mcard--error"}` });
      const head = el("div", { class: "mcard__head" }, [el("span", { class: "mcard__lang", text: name(item.target) })]);
      card.append(head);

      if (!item.ok) {
        const reason = item.error?.detail || "Translation failed.";
        card.append(el("p", { class: "mcard__error", text: reason }));
        return card;
      }
      const r = item.result;
      head.append(metaChip(engineLabel(r.provider), "", "zap"));
      if (r.cached) head.append(metaChip("cached", "meta-chip--cached"));
      card.append(el("p", { class: "mcard__text", text: r.translated_text, dir: dirOf(r.translated_text, item.target), lang: item.target }));

      const listen = el("button", { type: "button", class: "icon-btn icon-btn--sm speak-btn", "aria-label": `Listen to ${name(item.target)} translation`, "aria-pressed": "false", "data-tooltip": "Listen" }, [
        icon("volume"),
        el("span", { class: "eq", "aria-hidden": "true" }, [el("i"), el("i"), el("i")]),
      ]);
      listen.addEventListener("click", () => speech.toggle(r.translated_text, item.target, listen, (m) => toast(m, { type: "info" })));
      const copy = el("button", { type: "button", class: "icon-btn icon-btn--sm", "aria-label": `Copy ${name(item.target)} translation`, "data-tooltip": "Copy", "data-tooltip-align": "end" }, [icon("copy")]);
      copy.addEventListener("click", async () => {
        if (await copyText(r.translated_text)) {
          flashCopied(copy);
          toast(`${name(item.target)} translation copied.`, { type: "success", duration: 2000 });
        }
      });
      card.append(el("div", { class: "mcard__actions" }, [listen, copy]));
      return card;
    })
  );
}

function renderStar() {
  const starred = hasOutput() && isStarred(state.result);
  ui.star.classList.toggle("is-starred", starred);
  ui.star.setAttribute("aria-pressed", String(starred));
  ui.star.setAttribute("aria-label", starred ? "Remove translation from starred" : "Star this translation");
  ui.star.dataset.tooltip = starred ? "Unstar" : "Star";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
    const ta = el("textarea", { class: "sr-only", "aria-hidden": "true" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Morph a copy button's icon into a check mark for 1.5s. */
function flashCopied(btn) {
  setIcon(btn, "check");
  btn.classList.add("is-done");
  btn.dataset.tooltip = "Copied!";
  clearTimeout(btn._resetTimer);
  btn._resetTimer = setTimeout(() => {
    setIcon(btn, "copy");
    btn.classList.remove("is-done");
    btn.dataset.tooltip = "Copy";
  }, 1500);
}

async function copyOutput() {
  if (state.multi.enabled && state.batch && !state.error) {
    const text = state.batch.results
      .filter((r) => r.ok)
      .map((r) => `${name(r.target)}:\n${r.result.translated_text}`)
      .join("\n\n");
    if (text && (await copyText(text))) toast("All translations copied.", { type: "success", duration: 2200 });
    return;
  }
  if (!hasOutput()) {
    toast("Nothing to copy yet.", { type: "info" });
    return;
  }
  if (!(await copyText(state.result.translation))) {
    toast("Couldn't copy to the clipboard.", { type: "error" });
    return;
  }
  flashCopied(ui.copy);
  toast("Translation copied to clipboard.", { type: "success", duration: 2200 });
}

function downloadOutput() {
  if (!hasOutput()) return;
  const { translation, source, detected, target } = state.result;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  // Uploaded files keep their base name: notes.txt -> notes-fr.txt
  const filename = state.fileBase ? `${state.fileBase}-${target}.txt` : `translatex-${detected || source}-${target}-${stamp}.txt`;
  const blob = new Blob([translation], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Downloaded ${filename}`, { type: "success", duration: 2500 });
}

function clearAll() {
  cancelInFlight();
  voice?.stop();
  ui.input.value = "";
  state.result = null;
  state.batch = null;
  state.error = null;
  state.lastKey = "";
  state.romanized = false;
  state.romanSuggested = false;
  state.fileBase = null;
  speech.stop();
  setDetected(null);
  afterInputChanged();
  renderOutput();
  ui.input.focus();
}

function swapLanguages() {
  if (!pickers.source) return; // languages failed to load
  if (state.multi.enabled) {
    toast("Swap isn't available while translating into multiple languages.", { type: "info" });
    return;
  }
  const newTarget = state.source === "auto" ? state.detected : state.source;
  if (!newTarget) {
    toast("Choose a source language, or translate once so it can be detected, before swapping.", { type: "info" });
    return;
  }
  // Rotate 180° per click (accumulates so it always spins the same direction).
  swapTurns += 1;
  ui.swap.style.setProperty("--spin", `${swapTurns * 180}deg`);

  const newSource = state.target;
  const prev = hasOutput() ? state.result : null;
  cancelInFlight();

  state.source = newSource;
  state.target = newTarget;
  state.romanized = false;
  state.romanSuggested = false;
  pickers.source.setValue(newSource);
  pickers.target.setValue(newTarget);
  pushRecent("source", newSource);
  pushRecent("target", newTarget);
  setDetected(null);
  savePrefs();

  if (prev) {
    // Swap the text pair too, so no new request is needed.
    ui.input.value = prev.translation;
    state.result = {
      ...prev,
      text: prev.translation,
      translation: prev.text,
      source: newSource,
      detected: null,
      target: newTarget,
      romanized: false,
      alternatives: [],
      warnings: [],
      providersTried: [prev.provider],
    };
    state.error = null;
    state.lastKey = requestKey(prev.translation.trim());
    afterInputChanged();
    renderOutput();
  } else {
    afterInputChanged();
    if (ui.input.value.trim()) runTranslate();
  }
}

/* ------------------------------------------------------------- files & share */

async function loadFile(file) {
  if (!file) return;
  const isTxt = /\.txt$/i.test(file.name) || file.type === "text/plain";
  if (!isTxt) {
    toast("Only plain-text (.txt) files are supported.", { type: "error" });
    return;
  }
  if (file.size > 1_000_000) {
    toast(`“${file.name}” is too large. The limit is 5,000 characters.`, { type: "error", duration: 6000 });
    return;
  }
  const text = (await file.text()).replace(/^﻿/, "");
  if (!text.trim()) {
    toast(`“${file.name}” is empty.`, { type: "error" });
    return;
  }
  if (text.length > MAX_CHARS) {
    toast(`“${file.name}” has ${text.length.toLocaleString()} characters. The limit is 5,000.`, { type: "error", duration: 6000 });
    return;
  }
  voice?.stop();
  ui.input.value = text;
  state.fileBase = file.name.replace(/\.[^.]+$/, "") || "translation";
  state.romanized = false;
  afterInputChanged();
  toast(`Loaded “${file.name}”.`, { type: "success", duration: 2200 });
  runTranslate({ force: true });
}

function setupFileDrop() {
  const pane = ui.sourcePane;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  let depth = 0; // dragenter/leave fire for every child element

  pane.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    pane.classList.add("is-dragging");
  });
  pane.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  pane.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) pane.classList.remove("is-dragging");
  });
  pane.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    pane.classList.remove("is-dragging");
    loadFile(e.dataTransfer.files[0]);
  });
  // A file dropped anywhere else must not navigate away from the app.
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (e) => {
      if (hasFiles(e) && !pane.contains(e.target)) e.preventDefault();
    });
  }

  ui.upload.addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", () => {
    loadFile(ui.fileInput.files[0]);
    ui.fileInput.value = ""; // allow re-uploading the same file
  });
}

function shareUrl() {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("text", ui.input.value.trim());
  url.searchParams.set("from", state.source);
  url.searchParams.set("to", state.target);
  return url.toString();
}

async function shareLink() {
  if (!ui.input.value.trim()) return;
  const url = shareUrl();
  if (await copyText(url)) {
    flashShare();
    toast(url.length > 8000 ? "Share link copied. It's very long, so some apps may cut it off." : "Share link copied.", {
      type: "success",
      duration: 2500,
    });
  } else {
    toast("Couldn't copy the share link.", { type: "error" });
  }
}

function flashShare() {
  setIcon(ui.share, "check");
  ui.share.classList.add("is-done");
  setTimeout(() => {
    setIcon(ui.share, "link");
    ui.share.classList.remove("is-done");
  }, 1500);
}

/** Apply ?text=&from=&to= from a share link, then clean the URL. Returns true if applied. */
function applyShareParams() {
  const params = new URLSearchParams(location.search);
  const text = params.get("text");
  if (!text) return false;
  const from = params.get("from");
  const to = params.get("to");
  if (state.multi.enabled) setMulti(false, { translate: false });
  if (from && (from === "auto" || state.names.has(from))) setSource(from, { translate: false });
  if (to && to !== "auto" && state.names.has(to)) setTarget(to, { translate: false });
  ui.input.value = text.slice(0, MAX_CHARS);
  afterInputChanged();
  history.replaceState(null, "", location.pathname);
  runTranslate({ force: true });
  return true;
}

/* ----------------------------------------------------------------- voice */

function setupVoice() {
  if (!voiceSupported) {
    ui.mic.hidden = true;
    return;
  }
  ui.mic.hidden = false;
  voice = new VoiceInput({
    onText(transcript) {
      const sep = voiceBase && !/\s$/.test(voiceBase) ? " " : "";
      ui.input.value = (voiceBase + sep + transcript).slice(0, MAX_CHARS);
      afterInputChanged();
      scheduleTranslate();
    },
    onState(listening) {
      ui.mic.classList.toggle("is-listening", listening);
      ui.mic.setAttribute("aria-pressed", String(listening));
      ui.mic.setAttribute("aria-label", listening ? "Stop voice input" : "Voice input");
      ui.mic.dataset.tooltip = listening ? "Stop (Esc)" : "Voice input";
      if (!listening && ui.input.value.trim()) runTranslate();
    },
    onError: (message) => toast(message, { type: "error", duration: 5000 }),
  });
  ui.mic.addEventListener("click", () => {
    voiceBase = ui.input.value;
    const lang = state.source === "auto" ? state.detected || (navigator.language || "en").split("-")[0] : state.source;
    voice.toggle(lang);
  });
}

/* --------------------------------------------------------------- history */

function isStarred(entry) {
  const key = entryKey(entry);
  return state.favorites.some((f) => entryKey(f) === key);
}

function saveHistory() {
  store.set(KEYS.history, state.history);
}

function saveFavorites() {
  store.set(KEYS.favorites, state.favorites);
}

/** The subset of a result worth persisting. */
function toEntry(r) {
  const { text, translation, source, detected, target, provider, romanized } = r;
  return { id: newId(), text, translation, source, detected, target, provider, romanized: Boolean(romanized), ts: Date.now() };
}

function addToHistory(result) {
  if (result.provider === "none") return; // same-language no-op; not worth keeping
  const entry = toEntry(result);
  const top = state.history[0];

  // While auto-translating, each pause produces a result. If this one just extends
  // (or trims) the previous entry, replace it instead of flooding the history.
  const isRefinement =
    top &&
    !isStarred(top) &&
    top.source === entry.source &&
    top.target === entry.target &&
    entry.ts - top.ts < MERGE_WINDOW_MS &&
    (entry.text.startsWith(top.text) || top.text.startsWith(entry.text));

  let list = state.history.filter((h) => entryKey(h) !== entryKey(entry));
  if (isRefinement && list[0] && list[0].id === top.id) list = list.slice(1);
  state.history = [entry, ...list].slice(0, HISTORY_LIMIT);
  saveHistory();
  renderHistoryView();
}

function toggleStar(entry) {
  if (isStarred(entry)) {
    const key = entryKey(entry);
    state.favorites = state.favorites.filter((f) => entryKey(f) !== key);
    toast("Removed from starred.", { type: "info", duration: 2200 });
  } else {
    state.favorites = [toEntry(entry), ...state.favorites].slice(0, FAVORITES_LIMIT);
    toast("Saved to starred.", { type: "success", duration: 2200 });
  }
  saveFavorites();
  renderStar();
  renderHistoryView();
}

function deleteEntry(entry) {
  if (state.tab === "starred") {
    state.favorites = state.favorites.filter((f) => f.id !== entry.id);
    saveFavorites();
    renderStar();
  } else {
    state.history = state.history.filter((h) => h.id !== entry.id);
    saveHistory();
  }
  renderHistoryView();
  // Keep keyboard focus inside the list after the card disappears.
  (ui.historyList.querySelector(".hcard__main") || ui.panel).focus({ preventScroll: true });
}

function restoreEntry(entry) {
  if (state.multi.enabled) setMulti(false, { translate: false });
  cancelInFlight();
  if (state.names.has(entry.source) || entry.source === "auto") {
    state.source = entry.source;
    pickers.source?.setValue(entry.source);
  }
  if (state.names.has(entry.target)) {
    state.target = entry.target;
    pickers.target?.setValue(entry.target);
  }
  savePrefs();

  ui.input.value = entry.text;
  state.romanized = Boolean(entry.romanized);
  state.fileBase = null;
  state.result = {
    text: entry.text,
    translation: entry.translation,
    source: entry.source,
    detected: entry.detected || null,
    detectedConfidence: null,
    target: entry.target,
    provider: entry.provider,
    providersTried: [entry.provider],
    cached: false,
    alternatives: [],
    romanized: Boolean(entry.romanized),
    warnings: [],
    elapsed: 0,
  };
  state.error = null;
  state.lastKey = requestKey(entry.text);
  setDetected(entry.source === "auto" ? entry.detected : null);
  afterInputChanged();
  renderOutput();
  ui.meta.replaceChildren(el("span", { class: "meta__item", text: "Restored from history" }));

  $("#translator").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  ui.input.focus({ preventScroll: true });
  toast("Translation restored.", { type: "success", duration: 2000 });
}

const EMPTY_COPY = {
  recent: ["No translations yet", "Your last 20 translations will show up here, so you can pick up where you left off."],
  starred: ["Nothing starred yet", "Star a translation to keep it here. Starred items aren't removed when history rolls over."],
};

function renderHistoryView() {
  const items = state.tab === "recent" ? state.history : state.favorites;
  ui.countRecent.textContent = String(state.history.length);
  ui.countStarred.textContent = String(state.favorites.length);

  for (const tab of ui.tabs) {
    const selected = tab.dataset.tab === state.tab;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) ui.panel.setAttribute("aria-labelledby", tab.id);
  }

  ui.clearHistory.hidden = items.length === 0;
  ui.historyEmpty.hidden = items.length > 0;
  ui.historyList.hidden = items.length === 0;
  const [title, text] = EMPTY_COPY[state.tab];
  ui.emptyTitle.textContent = title;
  ui.emptyText.textContent = text;

  renderHistory(ui.historyList, items, {
    name,
    dirOf,
    isStarred,
    onRestore: restoreEntry,
    onDelete: deleteEntry,
    onToggleStar: toggleStar,
  });
}

function selectTab(tab, focus = false) {
  state.tab = tab;
  renderHistoryView();
  if (focus) ui.tabs.find((t) => t.dataset.tab === tab)?.focus();
}

function clearHistoryTab() {
  const isRecent = state.tab === "recent";
  const backup = isRecent ? state.history : state.favorites;
  if (!backup.length) return;
  if (isRecent) {
    state.history = [];
    saveHistory();
  } else {
    state.favorites = [];
    saveFavorites();
    renderStar();
  }
  renderHistoryView();
  toast(`Cleared ${backup.length} ${isRecent ? "recent" : "starred"} translation${backup.length === 1 ? "" : "s"}.`, {
    type: "info",
    duration: 6000,
    action: {
      label: "Undo",
      onClick() {
        if (isRecent) {
          state.history = backup;
          saveHistory();
        } else {
          state.favorites = backup;
          saveFavorites();
          renderStar();
        }
        renderHistoryView();
      },
    },
  });
}

/* ----------------------------------------------------------------- theme */

function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) store.set(KEYS.theme, theme);
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  ui.themeToggle.setAttribute("aria-label", label);
  ui.themeToggle.dataset.tooltip = theme === "dark" ? "Light theme" : "Dark theme";
  ui.themeColor?.setAttribute("content", theme === "dark" ? "#0d0c13" : "#f7f7fb");
}

function setupTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  applyTheme(current, false);
  ui.themeToggle.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
  });
  // Follow the OS setting until the user makes an explicit choice.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!store.has(KEYS.theme)) applyTheme(e.matches ? "dark" : "light", false);
  });
}

/* -------------------------------------------------------------- shortcuts */

function openShortcuts() {
  if (!ui.dialog.open) ui.dialog.showModal();
}

function setupShortcuts() {
  for (const node of $$("[data-mod]")) node.textContent = isMac ? "⌘" : "Ctrl";

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (e.key === "Escape" && voice?.listening) {
      voice.stop();
      return;
    }
    if (ui.dialog.open && !(mod && key === "enter")) return;

    if (mod && key === "enter") {
      e.preventDefault();
      if (ui.dialog.open) ui.dialog.close();
      runTranslate({ force: true });
    } else if (mod && e.shiftKey && key === "s") {
      e.preventDefault();
      swapLanguages();
    } else if (mod && e.shiftKey && key === "c") {
      e.preventDefault();
      copyOutput();
    } else if (e.key === "?" && !mod && !isTypingTarget(e.target)) {
      e.preventDefault();
      openShortcuts();
    }
  });

  ui.shortcutsBtn.addEventListener("click", openShortcuts);
  ui.dialogClose.addEventListener("click", () => ui.dialog.close());
  // Click on the backdrop (outside the dialog box) closes it.
  ui.dialog.addEventListener("click", (e) => {
    if (e.target === ui.dialog) ui.dialog.close();
  });
}

/* ----------------------------------------------------------------- events */

function bindEvents() {
  ui.input.addEventListener("input", () => {
    afterInputChanged();
    if (!ui.input.value.trim()) {
      // Emptied: drop any pending/in-flight work and reset the output.
      cancelInFlight();
      state.result = null;
      state.batch = null;
      state.error = null;
      state.lastKey = "";
      state.fileBase = null;
      setDetected(null);
      renderOutput();
      return;
    }
    scheduleTranslate();
  });

  // Header shadow once the page is scrolled.
  const topbar = $(".topbar");
  const onScroll = () => topbar.classList.toggle("is-scrolled", window.scrollY > 4);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(autoGrow);
  });

  ui.translateBtn.addEventListener("click", () => runTranslate({ force: true }));
  ui.retry.addEventListener("click", () => runTranslate({ force: true }));
  ui.clear.addEventListener("click", clearAll);
  ui.swap.addEventListener("click", swapLanguages);
  ui.copy.addEventListener("click", copyOutput);
  ui.download.addEventListener("click", downloadOutput);
  ui.share.addEventListener("click", shareLink);
  ui.star.addEventListener("click", () => hasOutput() && toggleStar(state.result));
  ui.romanToggle.addEventListener("click", toggleRomanized);
  ui.multiToggle.addEventListener("click", () => setMulti(!state.multi.enabled));

  const notice = (msg) => toast(msg, { type: "info" });
  ui.speakIn.addEventListener("click", () => {
    const text = ui.input.value.trim();
    if (!text) return;
    const lang = state.romanized ? "en" : state.source === "auto" ? state.detected : state.source;
    speech.toggle(text, lang, ui.speakIn, notice);
  });
  ui.speakOut.addEventListener("click", () => {
    if (hasOutput()) speech.toggle(state.result.translation, state.result.target, ui.speakOut, notice);
  });

  // History tabs: click + arrow-key navigation (WAI-ARIA tabs pattern).
  for (const tab of ui.tabs) {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const i = ui.tabs.indexOf(tab);
      const n = ui.tabs.length;
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
      selectTab(ui.tabs[next].dataset.tab, true);
    });
  }
  ui.clearHistory.addEventListener("click", clearHistoryTab);

  // Keep "x min ago" labels fresh.
  setInterval(() => refreshTimes(ui.historyList), 30_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshTimes(ui.historyList);
  });
}

/* ------------------------------------------------------------------- init */

async function init() {
  if (!speech.supported) {
    for (const b of [ui.speakIn, ui.speakOut]) b.dataset.tooltip = "Speech not supported";
  }
  setupTheme();
  setupShortcuts();
  setupVoice();
  setupFileDrop();
  bindEvents();
  afterInputChanged();
  applyMultiUI();
  renderOutput();
  renderHistoryView();

  // Engines and languages load in parallel; the engine choice must be known
  // before a share link triggers the first translation.
  const enginesReady = setupEngines();
  try {
    setupLanguages(await api.getLanguages());
  } catch (err) {
    state.error = err instanceof api.ApiError ? err : new api.ApiError({ kind: "unknown", title: "Couldn't load the language list." });
    renderOutput();
    toast("Couldn't load the language list. Is the server running?", { type: "error", duration: 6000 });
    return;
  }
  await enginesReady;
  applyShareParams();
}

init();
