from fastapi.testclient import TestClient
from app.main import app
from app import local_ai

def test_local_contextual(monkeypatch):
    monkeypatch.setenv("LINGUA_OLLAMA_MODEL", "qwen3:8b")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    async def complete(instruction, data):
        assert data["text"] == "Mujhe pani chahiye."
        return "I need water.", 12

    monkeypatch.setattr(local_ai, "complete", complete)
    with TestClient(app) as client:
        assert client.get("/api/advanced/capabilities").json()["contextual"]
        response = client.post("/api/translate/contextual", json={
            "text": "Mujhe pani chahiye.", "source": "ur", "target": "en",
            "romanized": True, "tone": "professional"})
        assert response.status_code == 200
        assert response.json()["provider"] == "ollama"
        assert response.json()["translated_text"] == "I need water."

def test_local_contextual_failure(monkeypatch):
    monkeypatch.setenv("LINGUA_OLLAMA_MODEL", "qwen3:8b")

    async def fail(*args):
        raise ValueError("Incomplete output")

    monkeypatch.setattr(local_ai, "complete", fail)
    with TestClient(app) as client:
        response = client.post("/api/translate/contextual", json={
            "text": "Hello", "source": "en", "target": "fr"})
        assert response.status_code == 502
        assert "Ollama" in response.json()["detail"]
