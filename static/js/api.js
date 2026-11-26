// Thin client for the FastAPI backend. All failures surface as ApiError with a
// friendly `title` for the UI and the raw backend `detail` kept for transparency.

export class ApiError extends Error {
  constructor({ kind, title, detail = "", status = 0, providersTried = [], failures = [] }) {
    super(title);
    this.name = "ApiError";
    this.kind = kind; // "network" | "validation" | "too-long" | "config" | "auth" | "rate-limit" | "engines" | "server" | "unknown"
    this.title = title;
    this.detail = detail;
    this.status = status;
    this.providersTried = providersTried; // engine names tried, in order
    this.failures = failures; // [{ provider, label, reason }]
  }
}

/** FastAPI returns `detail` as a string (HTTPException) or an array (422 validation). */
function detailToString(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && d.msg ? String(d.msg).replace(/^Value error,\s*/i, "") : String(d)))
      .join("; ");
  }
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** Map an HTTP status + response body to a user-friendly error. */
export function classifyError(status, body) {
  const rawDetail = body && body.detail;
  const providersTried = (body && Array.isArray(body.providers_tried) && body.providers_tried) || [];
  const failures = (body && Array.isArray(body.errors) && body.errors) || [];
  const err = classifyDetail(status, rawDetail);
  err.providersTried = providersTried;
  err.failures = failures;
  // Several engines failed: summarise instead of repeating the backend sentence.
  if (failures.length) {
    const reasons = failures.map((f) => String(f.reason).toLowerCase());
    if (reasons.every((r) => /rate|429|quota|too many/.test(r))) {
      err.kind = "rate-limit";
      err.title =
        failures.length > 1
          ? "Every translation engine is rate-limiting right now. Try again in a minute."
          : "The translation engine is rate-limiting right now. Try again in a minute.";
    } else if (failures.length > 1) {
      err.kind = "engines";
      err.title = "None of the translation engines could translate this right now.";
    }
  }
  return err;
}

function classifyDetail(status, rawDetail) {
  const detail = detailToString(rawDetail);
  const d = detail.toLowerCase();
  const tooLong =
    /at most \d+ characters|too long/.test(d) ||
    (Array.isArray(rawDetail) && rawDetail.some((x) => x && x.type === "string_too_long"));

  if (status === 422 && tooLong)
    return new ApiError({ kind: "too-long", title: "That text is too long — the limit is 5,000 characters.", detail, status });
  if (status === 422)
    return new ApiError({ kind: "validation", title: "The request couldn't be processed.", detail, status });
  if (/romanized/.test(d))
    return new ApiError({ kind: "romanized", title: "This engine can't translate romanized text.", detail, status });
  if (/not set|not configured|missing.*key/.test(d))
    return new ApiError({ kind: "config", title: "The translation provider isn't configured on the server.", detail, status });
  if (/\((401|403)\)/.test(d))
    return new ApiError({ kind: "auth", title: "The translation provider rejected the request. Check the API key.", detail, status });
  if (status === 429 || /\(429\)/.test(d))
    return new ApiError({ kind: "rate-limit", title: "Too many requests. Wait a moment and try again.", detail, status });
  if (status >= 500)
    return new ApiError({ kind: "server", title: "The translation service is unavailable right now.", detail, status });
  return new ApiError({ kind: "unknown", title: "Something went wrong while translating.", detail, status });
}

function networkError() {
  return navigator.onLine === false
    ? new ApiError({ kind: "network", title: "You're offline. Check your internet connection and try again." })
    : new ApiError({
        kind: "network",
        title: "Can't reach the translation server.",
        detail: "Make sure the FastAPI server is running, then retry.",
      });
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw networkError();
  }
  const data = await readJson(res);
  if (!res.ok) throw classifyError(res.status, data);
  return data;
}

/**
 * Languages as [{ code, name }]. Accepts both the current backend shape
 * ({ code: name }) and a list shape ({ languages: [{ code, name }] }).
 */
export async function getLanguages() {
  const data = await request("/api/languages");
  if (data && Array.isArray(data.languages)) return data.languages.map(({ code, name }) => ({ code, name }));
  return Object.entries(data || {}).map(([code, name]) => ({ code, name }));
}

/** GET /api/providers -> { default, chain, providers: [{ name, label, configured, requires }] } or null. */
export async function getProviders() {
  try {
    const data = await request("/api/providers");
    return data && Array.isArray(data.providers) && data.providers.length ? data : null;
  } catch {
    return null;
  }
}

function body({ text, source, provider, romanized }) {
  const out = { text, source };
  if (provider) out.provider = provider;
  if (romanized) out.romanized = true;
  return out;
}

const post = (url, payload, signal) =>
  request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal });

/** POST /api/translate. Pass an AbortSignal so superseded requests can be cancelled. */
export function translate(req, signal) {
  return post("/api/translate", { ...body(req), target: req.target }, signal);
}

/** POST /api/translate/batch -> { source, results: [{ target, ok, result, error }] } (max 5 targets). */
export function translateBatch(req, signal) {
  return post("/api/translate/batch", { ...body(req), targets: req.targets }, signal);
}

/** POST /api/detect -> { language, name, confidence, script, romanized }. */
export function detect(text, signal) {
  return post("/api/detect", { text }, signal);
}
