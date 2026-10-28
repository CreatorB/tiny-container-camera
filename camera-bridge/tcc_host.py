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
import socket
import struct
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "tcc_camera.py")
STATE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "tiny-container-camera")
PID_FILE = os.path.join(STATE_DIR, "bridge.pid")
LOG_FILE = os.path.join(STATE_DIR, "bridge.log")
LAST_ADDRESS_FILE = os.path.join(STATE_DIR, "adb-address")
ADDRESS_RE = re.compile(r"^[\w.\-]+:\d{1,5}$")
IDLE_EXIT = 30


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


def open_ports(host, ports, timeout=0.3, workers=512):
    """Returns the ports in `ports` that accept a TCP connection on `host`."""
    def probe(port):
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return port
        except OSError:
            return None
    with ThreadPoolExecutor(workers) as pool:
        return [p for p in pool.map(probe, ports) if p]


def known_addresses():
    """Addresses that worked before: ours, then Tiny Computer's adb scanner's."""
    found = []
    for path in (LAST_ADDRESS_FILE, os.path.expanduser("~/.config/tiny/adb-target")):
        try:
            with open(path) as f:
                address = f.read().strip()
        except OSError:
            continue
        if ADDRESS_RE.match(address) and address not in found:
            found.append(address)
    return found


def find_wireless_debugging():
    """Finds the wireless debugging address, or returns None."""
    # The port only changes when wireless debugging is turned off and on.
    for address in known_addresses():
        host, port = address.rsplit(":", 1)
        if speaks_adb(host, int(port)):
            return address
    # Wireless debugging advertises its port over mDNS, but multicast usually
    # does not work inside proot.
    match = re.search(r"_adb-tls-connect\._tcp\.?\s+([\d.]+:\d+)", adb("mdns", "services"))
    if match:
        return match.group(1)
    # Inside Tiny Computer and other proot containers the device is reachable
    # on 127.0.0.1, and Android picks the port from 30000-49999. Scanning is
    # slow under proot (every syscall is traced), up to a couple of minutes.
    for port in open_ports("127.0.0.1", range(30000, 50000)):
        if speaks_adb("127.0.0.1", port):
            return f"127.0.0.1:{port}"
    return None


ADB_COMMANDS = {b"CNXN", b"AUTH", b"STLS"}


def speaks_adb(host, port):
    """Sends an ADB CNXN packet and checks that adbd answers."""
    payload = b"host::\0"
    command = struct.unpack("<I", b"CNXN")[0]
    header = struct.pack("<6I", command, 0x01000001, 256 * 1024, len(payload),
                         sum(payload), command ^ 0xFFFFFFFF)
    try:
        with socket.create_connection((host, port), timeout=1) as s:
            s.sendall(header + payload)
            return s.recv(24)[:4] in ADB_COMMANDS
    except OSError:
        return False


def connect(address):
    if address:
        if not ADDRESS_RE.match(address):
            return {"ok": False, "error": "address must look like HOST:PORT"}
    else:
        ready = [d["serial"] for d in devices() if d["state"] == "device"]
        address = ready[0] if ready else find_wireless_debugging()
        if not address:
            return {"ok": False, "error": "no device found; turn on Developer options > Wireless "
                    "debugging, or enter the HOST:PORT it shows"}
    out = adb("connect", address)
    ok = "connected" in out
    if ok:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LAST_ADDRESS_FILE, "w") as f:
            f.write(address)
    return {"ok": ok, "output": out, "address": address, "devices": devices()}


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
        # --idle-exit turns the camera off even if the extension never sends
        # "stop" (e.g. Firefox was closed or its background script suspended).
        proc = subprocess.Popen([sys.executable, BRIDGE, "--facing", facing, "--idle-exit", str(IDLE_EXIT)],
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
