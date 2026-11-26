"""Shared fixtures: every test starts from a clean, offline state."""

import pytest

from app import translators

PROVIDER_ENV = (
    "TRANSLATOR_PROVIDER",
    "GOOGLE_API_KEY",
    "AZURE_TRANSLATOR_KEY",
    "AZURE_TRANSLATOR_REGION",
    "MYMEMORY_EMAIL",
)


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    # Ignore any keys from a developer's real .env (load_dotenv runs at import time).
    for name in PROVIDER_ENV:
        monkeypatch.delenv(name, raising=False)
    # No real sleeping between retries.
    monkeypatch.setattr(translators, "RETRY_BACKOFF", 0)
    translators.CACHE.clear()

    # deep-translator uses `requests`, which respx can't intercept: block it so no
    # test can ever reach the real network. Tests that need it re-patch this.
    async def free_blocked(self, text, source, target):
        raise translators.TranslationError("Free provider disabled in tests.")

    monkeypatch.setattr(translators.FreeGoogleTranslator, "translate", free_blocked)
    yield
    translators.CACHE.clear()
