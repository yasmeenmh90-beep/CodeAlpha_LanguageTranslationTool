"""Translation providers, the fallback chain, retries and the result cache.

Providers (tried in this order when the engine is "auto"):
  microsoft  Microsoft Translator v3        needs AZURE_TRANSLATOR_KEY (+ AZURE_TRANSLATOR_REGION)
  google     Google Cloud Translation v2    needs GOOGLE_API_KEY
  mymemory   MyMemory (translated.net)      free, no key; MYMEMORY_EMAIL raises the daily quota
  free       Google web via deep-translator free, no key; often rate-limited — last resort

Engine selection:
  * The request's `provider` wins: "auto" = chain, a name = only that engine (no silent fallback).
  * Otherwise TRANSLATOR_PROVIDER from the environment is used the same way (empty = "auto").

A provider that fails with a rate limit, a 5xx or a network error is retried once after
RETRY_BACKOFF seconds, then the chain moves on. Other failures (bad key, unsupported
input) move on immediately.
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import re
from collections import OrderedDict
from dataclasses import dataclass, field, replace

import httpx

from .detect import detect_language, dominant_script
from .languages import LANGUAGES, MICROSOFT_CODE_MAP

PROVIDER_ORDER: tuple[str, ...] = ("ollama", "microsoft", "google", "mymemory", "free")
PROVIDER_LABELS = {
    "ollama": "Ollama (local AI)",
    "microsoft": "Microsoft Translator",
    "google": "Google Cloud Translation",
    "mymemory": "MyMemory",
    "free": "Google (free web)",
}
# Environment variable each provider needs (None = works without a key).
PROVIDER_REQUIRES = {"ollama": "LINGUA_OLLAMA_MODEL", "microsoft": "AZURE_TRANSLATOR_KEY", "google": "GOOGLE_API_KEY", "mymemory": None, "free": None}
# Engines whose auto-detect copes with romanized Urdu/Hindi. MyMemory needs an explicit
# source language and only matches translation memory, so it can't.
ROMANIZED_CAPABLE = frozenset({"ollama", "microsoft", "google", "free"})

logger = logging.getLogger(__name__)

RETRY_BACKOFF = 0.4  # seconds before the single retry (tests set this to 0)
_MS_REVERSE = {v: k for k, v in MICROSOFT_CODE_MAP.items()}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


def request_timeout() -> httpx.Timeout:
    return httpx.Timeout(_env_float("REQUEST_TIMEOUT", 15.0))


# --------------------------------------------------------------------------- errors / results


class TranslationError(Exception):
    """A provider failed. The message is safe to show to users."""

    def __init__(self, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class ProvidersExhausted(Exception):
    """Every provider that was tried failed."""

    def __init__(self, failures: list[tuple[str, str]], tried: list[str], pinned: bool):
        self.failures = failures
        self.tried = tried
        self.pinned = pinned
        if pinned and len(failures) == 1:
            self.message = failures[0][1]
        else:
            reasons = "; ".join(f"{PROVIDER_LABELS.get(n, n)}: {r}" for n, r in failures)
            self.message = f"All translation engines failed — {reasons}" if failures else "No translation engine is available."
        super().__init__(self.message)


@dataclass
class TranslationResult:
    translated_text: str
    detected_source: str | None
    provider: str
    alternatives: list[str] = field(default_factory=list)
    detected_confidence: float | None = None
    detection_method: str | None = None  # "provider" or "heuristic"


@dataclass
class ChainResult:
    result: TranslationResult
    providers_tried: list[str]
    cached: bool = False


def _http_error(resp: httpx.Response, label: str) -> TranslationError:
    code = resp.status_code
    if code == 429:
        return TranslationError(f"{label} rate limit reached (429).", retryable=True)
    return TranslationError(f"{label} API error ({code}).", retryable=code >= 500)


async def _send(method: str, url: str, **kwargs) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=request_timeout()) as client:
            return await client.request(method, url, **kwargs)
    except httpx.TimeoutException as exc:
        raise TranslationError("Request timed out.", retryable=True) from exc
    except httpx.HTTPError as exc:
        raise TranslationError(f"Network error ({type(exc).__name__}).", retryable=True) from exc


# --------------------------------------------------------------------------- providers


class GoogleCloudTranslator:
    name = "google"
    URL = "https://translation.googleapis.com/language/translate/v2"

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def translate(self, text: str, source: str, target: str) -> TranslationResult:
        payload = {"q": text, "target": target, "format": "text"}
        if source != "auto":
            payload["source"] = source
        resp = await _send("POST", self.URL, params={"key": self.api_key}, json=payload)
        if resp.status_code != 200:
            raise _http_error(resp, "Google Translate")
        item = resp.json()["data"]["translations"][0]
        detected = item.get("detectedSourceLanguage")
        return TranslationResult(
            translated_text=html.unescape(item["translatedText"]),
            detected_source=detected,
            provider=self.name,
            detection_method="provider" if detected else None,
        )


class MicrosoftTranslator:
    name = "microsoft"
    URL = "https://api.cognitive.microsofttranslator.com/translate"

    def __init__(self, key: str, region: str):
        self.key = key
        self.region = region

    async def translate(self, text: str, source: str, target: str) -> TranslationResult:
        params = {"api-version": "3.0", "to": MICROSOFT_CODE_MAP.get(target, target)}
        if source != "auto":
            params["from"] = MICROSOFT_CODE_MAP.get(source, source)
        headers = {
            "Ocp-Apim-Subscription-Key": self.key,
            "Ocp-Apim-Subscription-Region": self.region,
            "Content-Type": "application/json",
        }
        resp = await _send("POST", self.URL, params=params, headers=headers, json=[{"Text": text}])
        if resp.status_code != 200:
            raise _http_error(resp, "Microsoft Translator")
        item = resp.json()[0]
        detected = item.get("detectedLanguage") or {}
        code = detected.get("language")
        return TranslationResult(
            translated_text=html.unescape(item["translations"][0]["text"]),
            detected_source=_MS_REVERSE.get(code, code),
            provider=self.name,
            detected_confidence=detected.get("score"),
            detection_method="provider" if code else None,
        )


class MyMemoryTranslator:
    """MyMemory free API. No auto-detect, and `q` is limited to ~500 bytes per request."""

    name = "mymemory"
    URL = "https://api.mymemory.translated.net/get"
    MAX_BYTES = 450

    def __init__(self, email: str | None = None):
        self.email = email

    async def translate(self, text: str, source: str, target: str) -> TranslationResult:
        detected = confidence = None
        src = source
        if source == "auto":
            d = detect_language(text)
            if d.romanized:
                raise TranslationError("MyMemory can't translate romanized Urdu/Hindi.")
            if d.language and d.confidence >= 0.3 and d.language in LANGUAGES:
                src, detected, confidence = d.language, d.language, d.confidence
            else:
                src = "en"  # MyMemory requires a source; English is the most likely guess
        if src == target:
            return TranslationResult(text, detected, self.name, [], confidence, "heuristic" if detected else None)

        chunks = split_for_limit(text, self.MAX_BYTES)
        parts: list[str] = []
        alternatives: list[str] = []
        for chunk, sep in chunks:
            if not chunk.strip():
                parts.append(chunk + sep)
                continue
            params = {"q": chunk, "langpair": f"{src}|{target}"}
            if self.email:
                params["de"] = self.email
            resp = await _send("GET", self.URL, params=params)
            if resp.status_code != 200:
                raise _http_error(resp, "MyMemory")
            data = resp.json()
            translated, alts = parse_mymemory(data, target)
            parts.append(translated + sep)
            if len(chunks) == 1:
                alternatives = alts
        return TranslationResult(
            translated_text="".join(parts),
            detected_source=detected,
            provider=self.name,
            alternatives=alternatives,
            detected_confidence=confidence,
            detection_method="heuristic" if detected else None,
        )


def _same_language(tag: str | None, target: str) -> bool:
    """MyMemory tags matches like "fr-FR"; compare primary subtags ("zh-CN" vs "zh-TW" both count as zh)."""
    if not tag:
        return True  # no tag given: can't tell, keep it
    return tag.split("-")[0].lower() == target.split("-")[0].lower()


def _plausible_alternative(alt: str, main: str, target: str) -> bool:
    """Reject alternatives that are clearly not in the target language.

    MyMemory's crowd-sourced memory sometimes mislabels entries (e.g. "Buenos días"
    tagged fr-FR), so the tag alone isn't enough: also require the same script as the
    main translation, and drop text the offline detector confidently places elsewhere.
    """
    if dominant_script(alt) != dominant_script(main):
        return False
    d = detect_language(alt)
    if target and d.language and d.confidence >= 0.4 and not d.romanized:
        return d.language.split("-")[0] == target.split("-")[0]
    return True


def parse_mymemory(data: dict, target: str = "") -> tuple[str, list[str]]:
    """Return (translation, alternatives) or raise TranslationError for MyMemory-level errors.

    Alternatives come from translation-memory matches, which can be in *other*
    languages (e.g. a Spanish entry for an en|fr query), so they're filtered by target.
    """
    response = data.get("responseData") or {}
    translated = html.unescape(response.get("translatedText") or "")
    try:
        status = int(str(data.get("responseStatus", 200)))
    except ValueError:
        status = 500
    if data.get("quotaFinished") or "MYMEMORY WARNING" in translated.upper():
        raise TranslationError("MyMemory daily free quota is used up.")
    if status == 429:
        raise TranslationError("MyMemory rate limit reached (429).", retryable=True)
    if status != 200:
        detail = data.get("responseDetails") or "no details"
        raise TranslationError(f"MyMemory error ({status}): {detail}", retryable=status >= 500)
    if not translated.strip():
        # Happens when MyMemory's best translation-memory hit is an empty entry.
        raise TranslationError("MyMemory returned an empty translation for this text.")

    alternatives: list[str] = []
    seen = {translated.strip().casefold()}
    for match in data.get("matches") or []:
        if target and not _same_language(match.get("target"), target):
            continue
        alt = html.unescape(str(match.get("translation") or "")).strip()
        if alt and alt.casefold() not in seen and _plausible_alternative(alt, translated, target):
            seen.add(alt.casefold())
            alternatives.append(alt)
        if len(alternatives) == 3:
            break
    return translated, alternatives


def split_for_limit(text: str, max_bytes: int) -> list[tuple[str, str]]:
    """Split text into (chunk, separator) pairs whose chunks fit in max_bytes of UTF-8.

    Each cut prefers the last line break, then the last sentence end, then the last
    space inside the window. Joining `chunk + sep` for every pair reproduces the text.
    """
    out: list[tuple[str, str]] = []
    rest = text
    while len(rest.encode("utf-8")) > max_bytes:
        used = cut = 0
        for ch in rest:  # longest prefix that fits in max_bytes
            used += len(ch.encode("utf-8"))
            if used > max_bytes:
                break
            cut += 1
        window = rest[:cut]
        best = None
        for pattern in (r"\n+", r"(?<=[.!?。！？؟])\s+", r"\s+"):
            matches = [m for m in re.finditer(pattern, window) if m.start() > 0]
            if matches:
                best = matches[-1]
                break
        if best:
            out.append((rest[: best.start()], best.group(0)))
            rest = rest[best.end() :]
        else:  # one enormous "word": hard cut
            out.append((rest[:cut], ""))
            rest = rest[cut:]
    out.append((rest, ""))
    return out


class FreeGoogleTranslator:
    """No-key fallback using deep-translator (Google's web endpoint). Fine for demos only."""

    name = "free"

    async def translate(self, text: str, source: str, target: str) -> TranslationResult:
        from deep_translator import GoogleTranslator  # imported lazily
        from starlette.concurrency import run_in_threadpool

        try:
            translated = await run_in_threadpool(GoogleTranslator(source=source, target=target).translate, text)
        except Exception as exc:  # deep-translator raises many exception types
            kind = type(exc).__name__
            if kind == "TooManyRequests":
                raise TranslationError("Google's free endpoint is rate-limiting this server.", retryable=True) from exc
            if kind in ("RequestError", "ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout"):
                raise TranslationError("Couldn't reach Google's free endpoint.", retryable=True) from exc
            raise TranslationError(f"Google's free endpoint failed ({kind}).") from exc
        return TranslationResult(html.unescape(translated or ""), None, self.name)


# --------------------------------------------------------------------------- configuration


def is_configured(name: str) -> bool:
    requires = PROVIDER_REQUIRES[name]
    return requires is None or bool(os.getenv(requires))


def default_provider() -> str:
    value = os.getenv("TRANSLATOR_PROVIDER", "").strip().lower()
    return value if value in PROVIDER_ORDER else "auto"


def configured_chain() -> list[str]:
    return [n for n in PROVIDER_ORDER if is_configured(n)]


class OllamaTranslator:
    name = "ollama"

    async def translate(self, text, source, target):
        from .local_ai import complete
        try:
            output, _ = await complete(
                "Translate to the target language. Interpret Roman Urdu or Hindi and mixed-language input. Preserve facts and return only translation.",
                {"text": text, "source": LANGUAGES[source], "target": LANGUAGES[target]})
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
            raise TranslationError("Local AI unavailable. Start Ollama and install the configured model.") from None
        return TranslationResult(output, None, self.name)


def build_provider(name: str):
    if name == "ollama":
        return OllamaTranslator()
    if name == "microsoft":
        key = os.getenv("AZURE_TRANSLATOR_KEY")
        if not key:
            raise TranslationError("AZURE_TRANSLATOR_KEY is not set.")
        return MicrosoftTranslator(key, os.getenv("AZURE_TRANSLATOR_REGION") or "global")
    if name == "google":
        key = os.getenv("GOOGLE_API_KEY")
        if not key:
            raise TranslationError("GOOGLE_API_KEY is not set.")
        return GoogleCloudTranslator(key)
    if name == "mymemory":
        return MyMemoryTranslator(os.getenv("MYMEMORY_EMAIL") or None)
    if name == "free":
        return FreeGoogleTranslator()
    raise TranslationError(f"Unknown provider: {name}")


# --------------------------------------------------------------------------- cache


class LRUCache:
    def __init__(self, size: int):
        self.size = size
        self._data: OrderedDict = OrderedDict()

    def get(self, key):
        if key not in self._data:
            return None
        self._data.move_to_end(key)
        return self._data[key]

    def put(self, key, value) -> None:
        if self.size <= 0:
            return
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self.size:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()

    def __len__(self) -> int:
        return len(self._data)


CACHE = LRUCache(int(_env_float("CACHE_SIZE", 500)))


# --------------------------------------------------------------------------- chain


async def _attempt(provider, text: str, source: str, target: str) -> TranslationResult:
    try:
        return await provider.translate(text, source, target)
    except TranslationError as exc:
        if not exc.retryable:
            raise
        await asyncio.sleep(RETRY_BACKOFF)
        return await provider.translate(text, source, target)


async def translate_text(
    text: str, source: str, target: str, provider: str | None = None, romanized: bool = False
) -> ChainResult:
    """Translate with the requested engine (or the fallback chain). Raises ProvidersExhausted."""
    requested = (provider or default_provider()).lower()
    if requested != "auto" and requested not in PROVIDER_ORDER:
        requested = "auto"

    key = (text, source, target, requested, romanized)
    hit = CACHE.get(key)
    if hit is not None:
        return replace(hit, cached=True)

    if requested == "auto":
        names = configured_chain()
        if romanized:
            names = [n for n in names if n in ROMANIZED_CAPABLE]
    else:
        if romanized and requested not in ROMANIZED_CAPABLE:
            reason = f"{PROVIDER_LABELS[requested]} can't translate romanized text. Choose Auto, Ollama, Google or Microsoft."
            raise ProvidersExhausted([(requested, reason)], [requested], pinned=True)
        names = [requested]

    # Romanized text goes to the engine's own auto-detect.
    src = "auto" if romanized else source
    failures: list[tuple[str, str]] = []
    tried: list[str] = []
    for name in names:
        tried.append(name)
        try:
            result = await _attempt(build_provider(name), text, src, target)
        except TranslationError as exc:
            failures.append((name, str(exc)))
            continue
        except Exception as exc:  # never let one broken provider take down the chain
            logger.exception("Provider %s failed unexpectedly", name)
            failures.append((name, f"Unexpected error ({type(exc).__name__})."))
            continue
        outcome = ChainResult(result, list(tried))
        CACHE.put(key, outcome)
        return outcome

    raise ProvidersExhausted(failures, tried, pinned=requested != "auto")
