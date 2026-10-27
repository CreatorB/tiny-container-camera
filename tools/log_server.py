#!/usr/bin/env python3
"""Collects log lines POSTed by a debug build of the extension.

Usage: python3 tools/log_server.py [--port 8091] [--out tcc.log]
Build the debug extension with: sh build.sh --debug
"""
import argparse
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def make_handler(out):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            text = self.rfile.read(length).decode("utf-8", "replace")
            with open(out, "a", encoding="utf-8") as f:
                f.write(time.strftime("%H:%M:%S ") + text + "\n")
            self.send_response(204)
            self.end_headers()

        def log_message(self, fmt, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8091)
    ap.add_argument("--out", default="tcc.log")
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args.out))
    print(f"Logging to {args.out} on http://127.0.0.1:{args.port}/log")
    server.serve_forever()


if __name__ == "__main__":
    main()
