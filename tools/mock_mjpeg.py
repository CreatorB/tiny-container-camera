#!/usr/bin/env python3
"""Mock IP Webcam server for testing the extension without a phone.

Serves an MJPEG stream at /video by cycling through the given JPEG files, and
the extension's test page at /tcc-test.html.

Usage: python3 tools/mock_mjpeg.py [--port 8090] [--fps 10] FILE.jpg [FILE.jpg ...]
"""
import argparse
import itertools
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BOUNDARY = b"tccframe"
TEST_PAGE = Path(__file__).with_name("tcc-test.html")


def make_handler(frames, fps):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/video"):
                self.stream()
            elif self.path.startswith("/tcc-test.html"):
                body = TEST_PAGE.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_error(404)

        def stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=" + BOUNDARY.decode())
            self.end_headers()
            try:
                for frame in itertools.cycle(frames):
                    self.wfile.write(b"--" + BOUNDARY + b"\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(b"Content-Length: %d\r\n\r\n" % len(frame))
                    self.wfile.write(frame + b"\r\n")
                    time.sleep(1 / fps)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, fmt, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--fps", type=float, default=10)
    ap.add_argument("files", nargs="+", type=Path)
    args = ap.parse_args()
    frames = [f.read_bytes() for f in args.files]
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(frames, args.fps))
    print(f"Mock stream: http://127.0.0.1:{args.port}/video")
    print(f"Test page:   http://127.0.0.1:{args.port}/tcc-test.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
