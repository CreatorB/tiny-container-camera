#!/usr/bin/env python3
"""Uploads the listing icon and screenshots to addons.mozilla.org.

web-ext sign uploads the listing text (amo/metadata.json) but not images.
Run this after the add-on is listed. Needs WEB_EXT_API_KEY and
WEB_EXT_API_SECRET in the environment (same keys as web-ext sign).

Usage: python3 amo/upload_assets.py [--icon]   (--icon: upload the icon again)
"""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

ADDON = "tiny-container-camera@creatorb"
SLUG = "tiny-container-camera"
API = "https://addons.mozilla.org/api/v5/addons/addon/" + urllib.request.quote(ADDON, safe="")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(ROOT, "extension", "icons", "icon-128.png")
SCREENSHOTS = [
    ("docs/screenshots/1-meet.jpg", "Google Meet call in Firefox inside Tiny Computer, with video from the tablet camera"),
    ("docs/screenshots/2-camera-check.png", "The virtual camera as seen by a web page, streamed over ADB at 1280x720"),
]


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt_token():
    key, secret = os.environ.get("WEB_EXT_API_KEY"), os.environ.get("WEB_EXT_API_SECRET")
    if not key or not secret:
        sys.exit("set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (e.g. . ~/.config/amo-keys)")
    now = int(time.time())
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps({"iss": key, "jti": str(uuid.uuid4()), "iat": now, "exp": now + 60}).encode())
    signing = f"{header}.{payload}".encode()
    sig = b64url(hmac.new(secret.encode(), signing, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def request(method, url, fields=None, files=None):
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in (fields or {}).items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                 f"{value}\r\n").encode()
    for name, path in (files or {}).items():
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            content = f.read()
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
                 f"filename=\"{os.path.basename(path)}\"\r\nContent-Type: {mime}\r\n\r\n").encode()
        body += content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": "JWT " + jwt_token(),
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    return send(req, method, url)


def request_json(method, url, data):
    req = urllib.request.Request(url, data=json.dumps(data).encode(), method=method, headers={
        "Authorization": "JWT " + jwt_token(),
        "Content-Type": "application/json",
    })
    return send(req, method, url)


def send(req, method, url):
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} failed: {e.code} {e.read().decode()[:500]}")


def get(url):
    req = urllib.request.Request(url, headers={"Authorization": "JWT " + jwt_token()})
    return send(req, "GET", url)


def main():
    # Only send what is missing: AMO rate-limits these requests.
    addon = get(API + "/")
    if "--icon" in sys.argv or "default" in (addon.get("icon_url") or "default"):
        addon = request("PATCH", API + "/", files={"icon": ICON})
        print("icon uploaded")
    if addon.get("slug") != SLUG:
        addon = request_json("PATCH", API + "/", {"slug": SLUG})
    print("listing:", addon.get("url"))
    # Screenshots are matched by position, so running this again only adds
    # the missing ones and fixes captions. The API limits preview requests;
    # if it answers 429, wait the time it gives and run this again.
    existing = {p.get("position"): p for p in addon.get("previews", [])}
    for i, (path, caption) in enumerate(SCREENSHOTS):
        preview = existing.get(i)
        if preview is None:
            preview = request("POST", API + "/previews/", fields={"position": i},
                              files={"image": os.path.join(ROOT, path)})
            print("uploaded:", path)
        if (preview.get("caption") or {}).get("en-US") != caption:
            request_json("PATCH", f"{API}/previews/{preview['id']}/", {"caption": {"en-US": caption}})
            print("caption set:", path)


if __name__ == "__main__":
    main()
