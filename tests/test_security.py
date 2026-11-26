from fastapi.testclient import TestClient
from app.main import app

def test_security_headers():
    with TestClient(app) as client:
        response = client.get("/api/health")
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"

def test_large_json_rejected():
    with TestClient(app) as client:
        assert client.post("/api/translate", content=b"x" * (128*1024+1)).status_code == 413

def test_large_upload_rejected():
    with TestClient(app) as client:
        assert client.post("/api/extract/txt", content=b"x" * (5*1024*1024+1)).status_code == 413
