import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_and_index():
    # /api/health now also reports configured providers, so check fields instead of equality.
    health = client.get("/api/health").json()
    assert health["status"] == "ok"
    assert health["providers"]["mymemory"] is True and health["providers"]["google"] is False
    assert "Language Translator" in client.get("/").text


def test_languages_endpoint():
    langs = client.get("/api/languages").json()
    assert langs["en"] == "English" and "auto" in langs


@pytest.mark.parametrize(
    "body",
    [
        {"text": "   ", "target": "fr"},
        {"text": "hi", "target": "xx"},
        {"text": "hi", "target": "auto"},
        {"text": "x" * 5001, "target": "fr"},
    ],
)
def test_validation_errors(body):
    assert client.post("/api/translate", json=body).status_code == 422


def test_same_language_short_circuits():
    r = client.post("/api/translate", json={"text": "Hello", "source": "en", "target": "en"})
    assert r.json()["translated_text"] == "Hello"


@respx.mock
def test_google_provider(monkeypatch):
    monkeypatch.setenv("TRANSLATOR_PROVIDER", "google")
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    route = respx.post("https://translation.googleapis.com/language/translate/v2").mock(
        return_value=httpx.Response(200, json={"data": {"translations": [
            {"translatedText": "Bonjour l&#39;ami", "detectedSourceLanguage": "en"}]}})
    )
    r = client.post("/api/translate", json={"text": "Hello friend", "target": "fr"})
    data = r.json()
    assert r.status_code == 200
    assert data["translated_text"] == "Bonjour l'ami"  # HTML entities decoded
    assert data["detected_source"] == "en" and data["provider"] == "google"
    assert route.calls.last.request.url.params["key"] == "test-key"


@respx.mock
def test_microsoft_provider(monkeypatch):
    monkeypatch.setenv("TRANSLATOR_PROVIDER", "microsoft")
    monkeypatch.setenv("AZURE_TRANSLATOR_KEY", "k")
    monkeypatch.setenv("AZURE_TRANSLATOR_REGION", "uaenorth")
    route = respx.post("https://api.cognitive.microsofttranslator.com/translate").mock(
        return_value=httpx.Response(200, json=[{
            "detectedLanguage": {"language": "en", "score": 1.0},
            "translations": [{"text": "你好", "to": "zh-Hans"}]}])
    )
    r = client.post("/api/translate", json={"text": "Hello", "target": "zh-CN"})
    assert r.json()["translated_text"] == "你好"
    req = route.calls.last.request
    assert req.url.params["to"] == "zh-Hans"  # code mapping applied
    assert req.headers["Ocp-Apim-Subscription-Region"] == "uaenorth"


@respx.mock
def test_provider_error_returns_502(monkeypatch):
    monkeypatch.setenv("TRANSLATOR_PROVIDER", "google")
    monkeypatch.setenv("GOOGLE_API_KEY", "bad")
    respx.post("https://translation.googleapis.com/language/translate/v2").mock(
        return_value=httpx.Response(403, json={"error": "forbidden"})
    )
    r = client.post("/api/translate", json={"text": "Hello", "target": "fr"})
    assert r.status_code == 502 and "403" in r.json()["detail"]
