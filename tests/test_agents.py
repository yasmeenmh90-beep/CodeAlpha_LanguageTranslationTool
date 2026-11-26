import asyncio
from unittest.mock import patch

import httpx
import pytest

from app import agents


def test_agent_pipeline():
    calls = []

    async def post(self, url, **kwargs):
        calls.append(kwargs["json"])
        return httpx.Response(200, request=httpx.Request("POST", url),
                              json={"choices": [{"message": {"content": f"stage {len(calls)}"}}],
                                    "usage": {"total_tokens": 12}})

    with patch.object(httpx.AsyncClient, "post", post):
        result = asyncio.run(agents.orchestrate({"text": "Hello", "target": "fr"}, "test", "test"))
    assert len(calls) == 4
    assert result["translated_text"] == "stage 4"
    assert result["review"] == "stage 3"
    assert result["reported_tokens"] == 48
    assert all(step["status"] == "completed" for step in result["trace"])


def test_agent_pipeline_stops_on_error():
    calls = []

    async def post(self, url, **kwargs):
        calls.append(url)
        return httpx.Response(503, request=httpx.Request("POST", url))

    with patch.object(httpx.AsyncClient, "post", post):
        with pytest.raises(agents.AgentFailure) as exc:
            asyncio.run(agents.orchestrate({"text": "Hello"}, "test", "test"))
    assert len(calls) == 1
    assert exc.value.trace[0]["status"] == "failed"
