#!/usr/bin/env python3
"""MLX embedding sidecar for agent-memory: POST /embed {"input": [...]} returns {"embeddings": [[...]]}."""

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

IDLE_SECONDS = 15 * 60
MAX_TOKENS = 2048


def load_embedder(model_name):
    try:
        import mlx_embeddings
        from mlx_embeddings.utils import load
    except ImportError:
        print(
            "agent-memory mlx_server: python module mlx_embeddings is missing; "
            "install it with `python3 -m pip install mlx-embeddings`",
            file=sys.stderr,
        )
        sys.exit(2)
    model, tokenizer = load(model_name)
    generate = getattr(mlx_embeddings, "generate", None)

    def embed(texts):
        if generate is not None:
            return generate(model, tokenizer, texts=texts).text_embeds.tolist()
        inputs = tokenizer.batch_encode_plus(
            texts, return_tensors="mlx", padding=True, truncation=True, max_length=MAX_TOKENS
        )
        outputs = model(inputs["input_ids"], attention_mask=inputs["attention_mask"])
        return outputs.text_embeds.tolist()

    return embed


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, payload):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            state["last"] = time.monotonic()
            if self.path == "/health":
                self.reply(200, {"ok": True, "model": state["model"]})
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            state["last"] = time.monotonic()
            if self.path != "/embed":
                self.reply(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                texts = json.loads(self.rfile.read(length) or b"{}").get("input")
                if isinstance(texts, str):
                    texts = [texts]
                if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                    self.reply(400, {"error": "input must be a string or a list of strings"})
                    return
                self.reply(200, {"embeddings": state["embed"](texts) if texts else []})
            except Exception as error:  # noqa: BLE001 - report any model failure to the client
                self.reply(500, {"error": str(error)})
            state["last"] = time.monotonic()

    return Handler


def main():
    parser = argparse.ArgumentParser(description="agent-memory MLX embedding sidecar")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="mlx-community/embeddinggemma-300m-4bit")
    args = parser.parse_args()

    state = {"model": args.model, "embed": None, "last": time.monotonic()}
    try:
        server = HTTPServer(("127.0.0.1", args.port), make_handler(state))
    except OSError as error:
        print(f"agent-memory mlx_server: cannot bind 127.0.0.1:{args.port}: {error}", file=sys.stderr)
        sys.exit(1)
    state["embed"] = load_embedder(args.model)
    state["last"] = time.monotonic()
    server.timeout = 30
    with server:
        while time.monotonic() - state["last"] < IDLE_SECONDS:
            server.handle_request()


if __name__ == "__main__":
    main()
