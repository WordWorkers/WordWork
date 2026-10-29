# Fake AI server for the smoke test (WW_SPIKE=1) and manual UI testing:
#   python3 tools/fake_ollama.py [port]        (default 11434)
# Speaks enough of Ollama's API (/api/version, /api/tags, /api/show, /api/chat)
# and the OpenAI API (/v1/models, /v1/chat/completions, key "hemlig") to test
# the AI assistant without a real model. Answers stream slowly so "Stoppa" can
# be tested.
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORDS = "1. ”vår tid och samtid” är en dubblering – stryk det ena. ".split() * 6


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/version":
            return self.send_json({"version": "0.0-fake"})
        if self.path == "/api/tags":
            return self.send_json({"models": [
                {"name": "fake-model:7b", "size": 4_700_000_000, "details": {"parameter_size": "7B"}},
                {"name": "nomic-embed-text:latest", "size": 1, "details": {}},
            ]})
        if self.path == "/v1/models":
            if self.headers.get("authorization") != "Bearer hemlig":
                return self.send_json({"error": {"message": "Incorrect API key"}}, 401)
            return self.send_json({"data": [{"id": "fake-gpt"}, {"id": "text-embedding-3-small"}]})
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        if self.path == "/api/show":
            return self.send_json({"capabilities": ["completion", "thinking"]})
        openai = self.path == "/v1/chat/completions"
        if not openai and self.path != "/api/chat":
            return self.send_json({"error": "not found"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if openai else "application/x-ndjson")
        self.end_headers()

        def line(obj):
            data = json.dumps(obj, ensure_ascii=False)
            self.wfile.write((f"data: {data}\n\n" if openai else data + "\n").encode())
            self.wfile.flush()
            time.sleep(0.04)

        try:
            if openai:
                line({"model": body["model"], "choices": [{"delta": {"content": "<think>Jag funderar.</think>"}}]})
                for w in WORDS:
                    line({"choices": [{"delta": {"content": w + " "}}]})
                line({"choices": [], "usage": {"completion_tokens": len(WORDS)}})
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                line({"message": {"thinking": "Jag funderar."}, "done": False})
                for w in WORDS:
                    line({"message": {"content": w + " "}, "done": False})
                line({"model": body["model"], "message": {"content": ""}, "done": True, "eval_count": len(WORDS),
                      "eval_duration": 1_500_000_000, "total_duration": 2_000_000_000})
        except BrokenPipeError:
            print("client disconnected (cancelled)", flush=True)

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 11434), H).serve_forever()
