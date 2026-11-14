"""Probe-only stub for the Gemini API.

Returns a deterministic numbered-lines "translation" (each line prefixed
with [TR]) so the translate stage can be exercised end to end without a
real API key. NOT part of the product; used only by PROBE.md runs.

Usage: python stub_gemini.py [port]   (default 8077)
Then run the worker with GEMINI_BASE_URL=http://127.0.0.1:8077/v1beta
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NUMBERED = re.compile(r"^(\d+)[.)]\s*(.*)$")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        parts = (body.get("contents") or [{}])[0].get("parts", [])
        prompt = "".join(p.get("text", "") for p in parts)
        lines = []
        for raw in prompt.split("\n"):
            m = NUMBERED.match(raw.strip())
            if m:
                lines.append((int(m.group(1)), m.group(2)))
        translated = "\n".join(f"{n}. [TR] {text}" for n, text in lines)
        payload = {"candidates": [{"content": {"parts": [{"text": translated}]}}]}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8077
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
