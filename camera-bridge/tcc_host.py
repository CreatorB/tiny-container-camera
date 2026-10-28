#!/usr/bin/env python3
"""Native messaging host for the Tiny Container Camera extension.

Lets the extension check ADB, connect or pair a device over wireless
debugging, and start or stop tcc_camera.py. Firefox starts this script for
each message (runtime.sendNativeMessage); the camera bridge runs detached so
it outlives it.
"""
import json
import os
import re
import signal
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "tcc_camera.py")
STATE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "tiny-container-camera")
PID_FILE = os.path.join(STATE_DIR, "bridge.pid")
LOG_FILE = os.path.join(STATE_DIR, "bridge.log")
ADDRESS_RE = re.compile(r"^[\w.\-]+:\d{1,5}$")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(msg):
    data = json.dumps(msg).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def adb(*args, timeout=15):
    try:
        r = subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip()
    except FileNotFoundError:
        return "adb not found"
    except subprocess.TimeoutExpired:
        return "adb timed out"


def devices():
    out = adb("devices", "-l")
    found = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2:
            model = next((p[6:] for p in parts if p.startswith("model:")), "")
            found.append({"serial": parts[0], "state": parts[1], "model": model})
    return found


def bridge_pid():
    try:
        with open(PID_FILE) as f:
            pid, facing = f.read().split()
        os.kill(int(pid), 0)
        return int(pid), facing
    except (OSError, ValueError):
        return None, None


def status():
    pid, facing = bridge_pid()
    return {"ok": True, "devices": devices(), "running": pid is not None, "facing": facing}


def connect(address):
    if address:
        if not ADDRESS_RE.match(address):
            return {"ok": False, "error": "address must look like HOST:PORT"}
        out = adb("connect", address)
    else:
        # Wireless debugging advertises its connect port over mDNS.
        services = adb("mdns", "services")
        match = re.search(r"_adb-tls-connect\._tcp\.?\s+([\d.]+:\d+)", services)
        if not match:
            return {"ok": False, "error": "no device found over mDNS; enter HOST:PORT from "
                    "Developer options > Wireless debugging"}
        out = adb("connect", match.group(1))
    return {"ok": "connected" in out, "output": out, "devices": devices()}


def pair(address, code):
    if not ADDRESS_RE.match(address or "") or not re.match(r"^\d{6}$", code or ""):
        return {"ok": False, "error": "pairing needs HOST:PORT and the 6-digit code"}
    out = adb("pair", address, code, timeout=30)
    return {"ok": "Successfully paired" in out, "output": out}


def start(facing):
    facing = "back" if facing == "back" else "front"
    pid, current = bridge_pid()
    if pid and current == facing:
        return {"ok": True, "running": True, "facing": facing}
    if pid:
        stop()
    if not any(d["state"] == "device" for d in devices()):
        return {"ok": False, "error": "no ADB device connected"}
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LOG_FILE, "w") as log:
        proc = subprocess.Popen([sys.executable, BRIDGE, "--facing", facing],
                                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                start_new_session=True)
    with open(PID_FILE, "w") as f:
        f.write(f"{proc.pid} {facing}")
    return {"ok": True, "running": True, "facing": facing}


def stop():
    pid, _ = bridge_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(30):
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(0.1)
    try:
        os.remove(PID_FILE)
    except OSError:
        pass
    return {"ok": True, "running": False}


def log_tail():
    try:
        with open(LOG_FILE) as f:
            return {"ok": True, "log": f.read()[-4000:]}
    except OSError:
        return {"ok": True, "log": ""}


def main():
    msg = read_message() or {}
    cmd = msg.get("cmd")
    try:
        if cmd == "status":
            reply = status()
        elif cmd == "connect":
            reply = connect(msg.get("address", "").strip())
        elif cmd == "pair":
            reply = pair(msg.get("address", "").strip(), msg.get("code", "").strip())
        elif cmd == "start":
            reply = start(msg.get("facing"))
        elif cmd == "stop":
            reply = stop()
        elif cmd == "log":
            reply = log_tail()
        else:
            reply = {"ok": False, "error": "unknown command"}
    except Exception as e:  # report instead of dying silently
        reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    send_message(reply)


if __name__ == "__main__":
    main()
