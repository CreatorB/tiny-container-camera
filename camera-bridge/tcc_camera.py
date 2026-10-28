#!/usr/bin/env python3
"""Serves the Android camera as an MJPEG stream using ADB, without any app.

Runs scrcpy-server (from the scrcpy package) on the device with the camera as
video source, decodes its H.264 stream with ffmpeg and serves the frames on
http://127.0.0.1:8765/video, the URL the extension reads by default.

Requires: adb (device connected, e.g. over wireless debugging), scrcpy >= 2.2
(for scrcpy-server), ffmpeg, Android 12+.

Usage: python3 tcc_camera.py [--facing front|back] [--size 1280] [--fps 30]
"""
import argparse
import os
import random
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVER_PATHS = ["/usr/share/scrcpy/scrcpy-server", "/usr/local/share/scrcpy/scrcpy-server"]
DEVICE_JAR = "/data/local/tmp/tcc-scrcpy-server.jar"
BOUNDARY = b"tccframe"


def log(*args):
    print("[tcc-camera]", *args, file=sys.stderr, flush=True)


def scrcpy_version():
    out = subprocess.run(["scrcpy", "--version"], capture_output=True, text=True).stdout
    return out.split()[1]


class Frames:
    """Holds the latest JPEG frame and wakes up waiting clients."""

    def __init__(self):
        self.cond = threading.Condition()
        self.frame = None
        self.seq = 0

    def put(self, frame):
        with self.cond:
            self.frame = frame
            self.seq += 1
            self.cond.notify_all()

    def wait(self, seq, timeout=5):
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq, timeout)
            return self.seq, self.frame


class Camera:
    def __init__(self, args):
        self.args = args
        self.frames = Frames()
        self.procs = []
        self.port = None
        self.bytes_in = 0
        self.frames_out = 0

    def adb(self, *cmd, **kw):
        base = ["adb"] + (["-s", self.args.serial] if self.args.serial else [])
        return subprocess.run(base + list(cmd), capture_output=True, text=True, **kw)

    def start(self):
        server = next((p for p in SERVER_PATHS if os.path.exists(p)), None)
        if not server:
            sys.exit("scrcpy-server not found; install scrcpy (sudo apt install scrcpy)")
        for tool in ("adb", "ffmpeg"):
            if not shutil.which(tool):
                sys.exit(f"{tool} not found")
        if self.adb("get-state").stdout.strip() != "device":
            sys.exit("no ADB device; connect one first (adb connect HOST:PORT)")

        r = self.adb("push", server, DEVICE_JAR)
        if r.returncode:
            sys.exit("adb push failed: " + r.stderr)

        scid = "%08x" % random.randrange(1, 0x7FFFFFFF)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        r = self.adb("forward", f"tcp:{self.port}", f"localabstract:scrcpy_{scid}")
        if r.returncode:
            sys.exit("adb forward failed: " + r.stderr)

        a = self.args
        params = [
            f"scid={scid}", "tunnel_forward=true", "audio=false", "control=false",
            "cleanup=true", "raw_stream=true", "video_codec=h264",
            "video_source=camera", f"camera_facing={a.facing}", f"max_size={a.size}",
            f"camera_fps={a.fps}", f"max_fps={a.fps}", f"video_bit_rate={a.bitrate}",
        ]
        cmd = ["shell", f"CLASSPATH={DEVICE_JAR}", "app_process", "/",
               "com.genymobile.scrcpy.Server", scrcpy_version()] + params
        base = ["adb"] + (["-s", a.serial] if a.serial else [])
        self.procs.append(subprocess.Popen(base + cmd, stdout=subprocess.DEVNULL, stderr=sys.stderr))
        log(f"camera {a.facing}, max {a.size}px, {a.fps} fps")

        sock, first = self.connect()
        ffmpeg = subprocess.Popen(
            # The raw stream has no timestamps (ffmpeg would give every frame
            # pts 0 and drop all but the first): stamp frames with the wall
            # clock, skip probing and flush every JPEG right away.
            ["ffmpeg", "-loglevel", "error", "-fflags", "nobuffer", "-flags", "low_delay",
             "-probesize", "32", "-analyzeduration", "0", "-use_wallclock_as_timestamps", "1",
             "-f", "h264", "-i", "pipe:0", "-fps_mode", "passthrough",
             "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", str(a.quality),
             "-flush_packets", "1", "pipe:1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.procs.append(ffmpeg)
        threading.Thread(target=self.ffmpeg_log, args=(ffmpeg.stderr,), daemon=True).start()
        threading.Thread(target=self.pump, args=(sock, first, ffmpeg.stdin), daemon=True).start()
        threading.Thread(target=self.split, args=(ffmpeg.stdout,), daemon=True).start()
        if a.verbose:
            threading.Thread(target=self.report, daemon=True).start()

    def ffmpeg_log(self, src):
        # Two frames stamped within the same muxer tick produce a harmless
        # "non monotonically increasing dts" message; everything else is shown.
        for line in src:
            text = line.decode("utf-8", "replace").rstrip()
            if "non monotonically increasing dts" not in text:
                log("ffmpeg:", text)

    def report(self):
        while True:
            time.sleep(5)
            log(f"last 5 s: {self.bytes_in // 1024} KiB H.264 in, {self.frames_out / 5:.1f} fps out")
            self.bytes_in = 0
            self.frames_out = 0

    def connect(self):
        """Returns (socket, first bytes read) once the device stream is up."""
        # The device socket only exists once the server is up; until then the
        # adb forward accepts and immediately closes connections.
        deadline = time.time() + 15
        while time.time() < deadline:
            s = socket.create_connection(("127.0.0.1", self.port))
            s.settimeout(1)
            try:
                first = s.recv(65536)
            except socket.timeout:
                first = b""
                s.settimeout(None)
                return s, first
            if first:
                s.settimeout(None)
                return s, first
            s.close()
            time.sleep(0.3)
        self.stop()
        sys.exit("camera stream did not start (is the screen unlocked? Android 12+?)")

    def pump(self, sock, first, out):
        try:
            if first:
                out.write(first)
            while True:
                data = sock.recv(65536)
                if not data:
                    break
                self.bytes_in += len(data)
                out.write(data)
                out.flush()
        except (BrokenPipeError, OSError):
            pass
        log("camera stream ended")
        os.kill(os.getpid(), signal.SIGTERM)

    def split(self, src):
        buf = b""
        while True:
            chunk = src.read1(65536)
            if not chunk:
                return
            buf += chunk
            while True:
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if start < 0 or end < 0:
                    break
                self.frames.put(buf[start:end + 2])
                self.frames_out += 1
                buf = buf[end + 2:]

    def stop(self):
        for p in reversed(self.procs):
            if p.poll() is None:
                p.terminate()
        if self.port:
            self.adb("forward", "--remove", f"tcp:{self.port}")


def make_handler(frames):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/video"):
                self.stream()
            elif self.path.startswith("/shot.jpg"):
                frame = frames.frame or frames.wait(0)[1]
                if not frame:
                    return self.send_error(503, "no frame yet")
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(frame)))
                self.end_headers()
                self.wfile.write(frame)
            else:
                self.send_error(404)

        def stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=" + BOUNDARY.decode())
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            seq = 0
            try:
                while True:
                    seq, frame = frames.wait(seq)
                    if not frame:
                        continue
                    self.wfile.write(b"--" + BOUNDARY + b"\r\nContent-Type: image/jpeg\r\n")
                    self.wfile.write(b"Content-Length: %d\r\n\r\n" % len(frame))
                    self.wfile.write(frame + b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, fmt, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--facing", choices=["front", "back"], default="front")
    ap.add_argument("--size", type=int, default=1280, help="max width/height in pixels")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--bitrate", type=int, default=4000000, help="H.264 bit rate in bits/s")
    ap.add_argument("--quality", type=int, default=5, help="JPEG quality, 2 (best) to 31")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--serial", help="ADB device serial, if more than one is connected")
    ap.add_argument("--verbose", action="store_true", help="log throughput every 5 seconds")
    args = ap.parse_args()

    cam = Camera(args)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(cam.frames))
    server.daemon_threads = True

    def shutdown(*_):
        cam.stop()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    cam.start()
    log(f"serving http://127.0.0.1:{args.port}/video")
    server.serve_forever()


if __name__ == "__main__":
    main()
