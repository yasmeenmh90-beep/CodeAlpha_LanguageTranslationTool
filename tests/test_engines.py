"""Engine chain, cache, new endpoints and MyMemory parsing. All HTTP is mocked with respx."""

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import translators
from app.main import app

client = TestClient(app)

MS_URL = "https://api.cognitive.microsofttranslator.com/translate"
GOOGLE_URL = "https://translation.googleapis.com/language/translate/v2"
MYMEMORY = dict(host="api.mymemory.translated.net", path="/get")


def mymemory_ok(text, matches=None):
    return httpx.Response(
        200,
        json={
            "responseData": {"translatedText": text, "match": 1},
            "responseStatus": 200,
            "responseDetails": "",
            "quotaFinished": False,
            "matches": matches or [],
        },
    )


def google_ok(text, detected="en"):
    return httpx.Response(200, json={"data": {"translations": [{"translatedText": text, "detectedSourceLanguage": detected}]}})


# --------------------------------------------------------------------------- fallback chain


@respx.mock
def test_fallback_first_provider_429_then_second_succeeds(monkeypatch):
    monkeypatch.setenv("AZURE_TRANSLATOR_KEY", "k")
    monkeypatch.setenv("GOOGLE_API_KEY", "g")
    ms = respx.post(MS_URL).mock(return_value=httpx.Response(429))
    google = respx.post(GOOGLE_URL).mock(return_value=google_ok("Bonjour"))

    r = client.post("/api/translate", json={"text": "Hello", "target": "fr"})

    assert r.status_code == 200
    data = r.json()
    assert data["translated_text"] == "Bonjour"
    assert data["provider"] == "google"
    assert data["providers_tried"] == ["microsoft", "google"]
    assert data["cached"] is False
    assert ms.call_count == 2  # rate limit -> one retry before moving on
    assert google.call_count == 1


@respx.mock
def test_non_retryable_error_moves_on_without_retry(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "bad")
    google = respx.post(GOOGLE_URL).mock(return_value=httpx.Response(403))
    respx.get(**MYMEMORY).mock(return_value=mymemory_ok("Bonjour"))

    data = client.post("/api/translate", json={"text": "Hello", "target": "fr"}).json()

    assert google.call_count == 1  # 403 isn't retried
    assert data["provider"] == "mymemory"
    assert data["providers_tried"] == ["google", "mymemory"]


@respx.mock
def test_network_error_is_retried_once(monkeypatch):
    route = respx.get(**MYMEMORY).mock(side_effect=[httpx.ConnectError("boom"), mymemory_ok("Hola")])
    data = client.post("/api/translate", json={"text": "Hello", "source": "en", "target": "es"}).json()
    assert data["translated_text"] == "Hola" and route.call_count == 2


@respx.mock
def test_all_providers_fail_returns_502_with_every_reason(monkeypatch):
    monkeypatch.setenv("AZURE_TRANSLATOR_KEY", "k")
    monkeypatch.setenv("GOOGLE_API_KEY", "g")
    respx.post(MS_URL).mock(return_value=httpx.Response(500))
    respx.post(GOOGLE_URL).mock(return_value=httpx.Response(403))
    respx.get(**MYMEMORY).mock(return_value=httpx.Response(429))

    r = client.post("/api/translate", json={"text": "Hello", "target": "fr"})

    assert r.status_code == 502
    body = r.json()
    assert body["providers_tried"] == ["microsoft", "google", "mymemory", "free"]
    reasons = {e["provider"]: e["reason"] for e in body["errors"]}
    assert "(500)" in reasons["microsoft"]
    assert "(403)" in reasons["google"]
    assert "429" in reasons["mymemory"]
    assert "disabled in tests" in reasons["free"]
    assert isinstance(body["detail"], str) and "All translation engines failed" in body["detail"]
    for label in ("Microsoft Translator", "Google Cloud Translation", "MyMemory", "Google (free web)"):
        assert label in body["detail"]


@respx.mock
def test_pinned_provider_does_not_fall_back(monkeypatch):
    route = respx.get(**MYMEMORY).mock(return_value=httpx.Response(503))
    r = client.post("/api/translate", json={"text": "Hello", "target": "fr", "provider": "mymemory"})
    assert r.status_code == 502
    assert r.json()["providers_tried"] == ["mymemory"]
    assert route.call_count == 2  # 5xx retried once, then no fallback


def test_unknown_provider_is_422():
    r = client.post("/api/translate", json={"text": "Hello", "target": "fr", "provider": "deepl"})
    assert r.status_code == 422


def test_unconfigured_pinned_provider_reports_missing_key():
    r = client.post("/api/translate", json={"text": "Hello", "target": "fr", "provider": "google"})
    assert r.status_code == 502 and "GOOGLE_API_KEY is not set" in r.json()["detail"]


# --------------------------------------------------------------------------- cache


@respx.mock
def test_cache_hit_on_second_call():
    route = respx.get(**MYMEMORY).mock(return_value=mymemory_ok("Bonjour"))
    body = {"text": "Hello", "source": "en", "target": "fr"}

    first = client.post("/api/translate", json=body).json()
    second = client.post("/api/translate", json=body).json()

    assert first["cached"] is False and second["cached"] is True
    assert second["translated_text"] == "Bonjour" and second["provider"] == "mymemory"
    assert route.call_count == 1


def test_lru_cache_evicts_oldest():
    cache = translators.LRUCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.get("a")  # "a" is now most recent
    cache.put("c", 3)
    assert cache.get("b") is None and cache.get("a") == 1 and cache.get("c") == 3


# --------------------------------------------------------------------------- /api/providers & health


def test_providers_endpoint_defaults(monkeypatch):
    monkeypatch.setenv("AZURE_TRANSLATOR_KEY", "k")
    data = client.get("/api/providers").json()
    assert data["default"] == "auto"
    assert [p["name"] for p in data["providers"]] == ["microsoft", "google", "mymemory", "free"]
    configured = {p["name"]: p["configured"] for p in data["providers"]}
    assert configured == {"microsoft": True, "google": False, "mymemory": True, "free": True}
    assert data["chain"] == ["microsoft", "mymemory", "free"]
    assert all(p["label"] for p in data["providers"])


def test_providers_default_follows_env(monkeypatch):
    monkeypatch.setenv("TRANSLATOR_PROVIDER", "mymemory")
    assert client.get("/api/providers").json()["default"] == "mymemory"
    assert client.get("/api/health").json()["default_provider"] == "mymemory"


# --------------------------------------------------------------------------- /api/detect


@pytest.mark.parametrize(
    "text, language, script, romanized",
    [
        ("آپ کیسے ہیں؟", "ur", "Arabic", False),
        ("السلام عليكم", "ar", "Arabic", False),
        ("नमस्ते आप कैसे हैं", "hi", "Devanagari", False),
        ("Привет, как дела", "ru", "Cyrillic", False),
        ("Bonjour, comment allez-vous", "fr", "Latin", False),
        ("kia hal h?", "ur", "Latin", True),
        ("mujhe pani chahiye", "ur", "Latin", True),
        ("The main road is closed", "en", "Latin", False),
    ],
)
def test_detect_endpoint(text, language, script, romanized):
    data = client.post("/api/detect", json={"text": text}).json()
    assert data["language"] == language
    assert data["script"] == script
    assert data["romanized"] is romanized
    assert 0 < data["confidence"] <= 1


def test_detect_rejects_blank():
    assert client.post("/api/detect", json={"text": "  "}).status_code == 422


# --------------------------------------------------------------------------- batch


@respx.mock
def test_batch_translates_each_target():
    def reply(request):
        pair = request.url.params["langpair"]
        return mymemory_ok({"en|fr": "Bonjour", "en|de": "Hallo", "en|es": "Hola"}[pair])

    respx.get(**MYMEMORY).mock(side_effect=reply)
    r = client.post("/api/translate/batch", json={"text": "Hello", "source": "en", "targets": ["fr", "de", "es", "fr"]})

    assert r.status_code == 200
    results = r.json()["results"]
    assert [x["target"] for x in results] == ["fr", "de", "es"]  # duplicates removed
    assert [x["result"]["translated_text"] for x in results] == ["Bonjour", "Hallo", "Hola"]
    assert all(x["ok"] for x in results)


@respx.mock
def test_batch_reports_per_target_errors():
    def reply(request):
        if request.url.params["langpair"] == "en|de":
            return httpx.Response(403)
        return mymemory_ok("Bonjour")

    respx.get(**MYMEMORY).mock(side_effect=reply)
    results = client.post(
        "/api/translate/batch", json={"text": "Hello", "source": "en", "targets": ["fr", "de"], "provider": "mymemory"}
    ).json()["results"]
    assert results[0]["ok"] is True
    assert results[1]["ok"] is False and "403" in results[1]["error"]["detail"]


@pytest.mark.parametrize(
    "targets", [["fr", "de", "es", "it", "pt", "nl"], [], ["xx"], ["auto"]], ids=["six", "empty", "bad", "auto"]
)
def test_batch_validation(targets):
    r = client.post("/api/translate/batch", json={"text": "Hello", "targets": targets})
    assert r.status_code == 422


# --------------------------------------------------------------------------- MyMemory


@respx.mock
def test_mymemory_parsing_entities_alternatives_and_detection():
    route = respx.get(**MYMEMORY).mock(
        return_value=mymemory_ok(
            "Bonjour l&#39;ami",
            matches=[
                {"translation": "Bonjour l&#39;ami", "quality": "74"},
                {"translation": "Salut l&#39;ami", "quality": "70"},
                {"translation": "Bonjour mon ami", "quality": "60"},
            ],
        )
    )
    data = client.post("/api/translate", json={"text": "Hello my friend, how are you", "target": "fr"}).json()

    assert data["translated_text"] == "Bonjour l'ami"  # entities decoded
    assert data["alternatives"] == ["Salut l'ami", "Bonjour mon ami"]  # main result not repeated
    assert data["detected_source"] == "en" and data["detection_method"] == "heuristic"
    assert route.calls.last.request.url.params["langpair"] == "en|fr"  # auto -> detected source


@respx.mock
def test_mymemory_alternatives_filtered_by_target_language():
    # Real MyMemory responses can include translation-memory matches in other languages.
    respx.get(**MYMEMORY).mock(
        return_value=mymemory_ok(
            "Bonjour",
            matches=[
                {"translation": "Buenos días", "target": "es-ES"},
                {"translation": "Buenos días amigos", "target": "fr-FR"},  # mislabelled (seen in real data)
                {"translation": "صبح بخیر", "target": "fr-FR"},  # wrong script
                {"translation": "Salut", "target": "fr-FR"},
                {"translation": "Bon matin", "target": "fr-CA"},
            ],
        )
    )
    data = client.post("/api/translate", json={"text": "Good morning", "source": "en", "target": "fr"}).json()
    assert data["alternatives"] == ["Salut", "Bon matin"]


@respx.mock
def test_mymemory_quota_warning_is_a_failure():
    respx.get(**MYMEMORY).mock(
        return_value=mymemory_ok("MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY")
    )
    r = client.post("/api/translate", json={"text": "Hello", "source": "en", "target": "fr"})
    assert r.status_code == 502
    reasons = {e["provider"]: e["reason"] for e in r.json()["errors"]}
    assert "quota" in reasons["mymemory"]


@respx.mock
def test_mymemory_long_text_is_chunked():
    route = respx.get(**MYMEMORY).mock(side_effect=lambda req: mymemory_ok(f"<{len(req.url.params['q'])}>"))
    text = "This is a sentence. " * 60  # ~1,200 bytes, over MyMemory's per-request limit
    data = client.post("/api/translate", json={"text": text.strip(), "source": "en", "target": "fr"}).json()
    assert route.call_count >= 3
    assert all(len(c.request.url.params["q"].encode()) <= translators.MyMemoryTranslator.MAX_BYTES for c in route.calls)
    assert data["translated_text"].count("<") == route.call_count


def test_split_for_limit_round_trips():
    text = ("Line one is here. Another sentence follows!\n" * 30) + "x" * 1000
    parts = translators.split_for_limit(text, 200)
    assert "".join(c + s for c, s in parts) == text
    assert all(len(c.encode()) <= 200 for c, _ in parts)


# --------------------------------------------------------------------------- HTML entities


@respx.mock
def test_html_entities_decoded_for_microsoft(monkeypatch):
    monkeypatch.setenv("AZURE_TRANSLATOR_KEY", "k")
    respx.post(MS_URL).mock(
        return_value=httpx.Response(
            200, json=[{"detectedLanguage": {"language": "en", "score": 0.97}, "translations": [{"text": "Tom &amp; Jerry"}]}]
        )
    )
    data = client.post("/api/translate", json={"text": "Tom & Jerry", "target": "fr"}).json()
    assert data["translated_text"] == "Tom & Jerry"
    assert data["detected_confidence"] == 0.97 and data["detection_method"] == "provider"


# --------------------------------------------------------------------------- romanized Urdu


@respx.mock
def test_romanized_suggestion_when_source_is_urdu():
    respx.get(**MYMEMORY).mock(return_value=mymemory_ok("kia hal h?"))
    data = client.post("/api/translate", json={"text": "kia hal h?", "source": "ur", "target": "en", "provider": "mymemory"}).json()
    assert data["suggest_romanized"] is True and data["romanized"] is False


@respx.mock
def test_romanized_uses_auto_detect_and_skips_mymemory(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "g")
    google = respx.post(GOOGLE_URL).mock(return_value=google_ok("How are you?", detected="hi"))
    mymemory = respx.get(**MYMEMORY).mock(return_value=mymemory_ok("nope"))

    data = client.post(
        "/api/translate", json={"text": "kia hal hai", "source": "ur", "target": "en", "romanized": True}
    ).json()

    assert data["translated_text"] == "How are you?" and data["romanized"] is True
    assert "source" not in google.calls.last.request.read().decode()  # sent as auto-detect
    assert mymemory.call_count == 0
    assert data["providers_tried"] == ["google"]


def test_romanized_with_mymemory_pinned_is_explained():
    r = client.post(
        "/api/translate", json={"text": "kia hal hai", "source": "ur", "target": "en", "romanized": True, "provider": "mymemory"}
    )
    assert r.status_code == 502 and "can't translate romanized text" in r.json()["detail"]


@respx.mock
def test_romanized_unchanged_output_warns(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "g")
    respx.post(GOOGLE_URL).mock(return_value=google_ok("kia hal hai", detected="en"))
    data = client.post(
        "/api/translate", json={"text": "kia hal hai", "source": "ur", "target": "en", "romanized": True}
    ).json()
    assert data["warnings"] and "unchanged" in data["warnings"][0]
