"""Single-process guard; deploy behind an authenticated rate-limiting gateway."""
from collections import OrderedDict
import time
from starlette.responses import JSONResponse

class RequestGuard:
    def __init__(self, app):
        self.app = app
        self.clients = OrderedDict()
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        async def secure_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer")]
            await send(message)
        async def reject(code, detail):
            await JSONResponse({"detail":detail}, status_code=code)(scope, receive, secure_send)
        if scope["method"] != "POST" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, secure_send)
        now = time.monotonic()
        key = (scope.get("client") or ("unknown",))[0]
        start,count = self.clients.get(key,(now,0))
        if now-start >= 60: start,count=now,0
        if count >= 60 or self.active >= 16:
            return await reject(429,"Request limit reached. Try again later.")
        self.clients[key]=(start,count+1)
        self.clients.move_to_end(key)
        if len(self.clients)>2048: self.clients.popitem(last=False)
        self.active += 1
        limit = 5*1024*1024 if scope["path"].startswith("/api/extract/") else 128*1024
        try:
            body=bytearray()
            while True:
                event=await receive()
                if event["type"]=="http.disconnect": return
                if len(body)+len(event.get("body",b""))>limit:
                    return await reject(413,"Request body too large.")
                body.extend(event.get("body",b""))
                if not event.get("more_body",False): break
            delivered=False
            async def replay():
                nonlocal delivered
                if delivered: return await receive()
                delivered=True
                return {"type":"http.request","body":bytes(body),"more_body":False}
            await self.app(scope,replay,secure_send)
        finally:
            self.active -= 1
