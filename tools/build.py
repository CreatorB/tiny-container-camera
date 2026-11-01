#!/usr/bin/env python3
"""Builds the extension for Firefox and Chrome.

The code in extension/ is shared; manifests/base.json is merged with
manifests/<browser>.json. For each browser this writes an unpacked copy to
dist/<browser>/ (load it for development) and a zip for the store:

  dist/tiny-container-camera-firefox-<version>.zip  (addons.mozilla.org)
  dist/tiny-container-camera-chrome-<version>.zip   (Chrome Web Store, no "key")

Usage: python3 tools/build.py [firefox|chrome ...] [--debug]
--debug makes the unpacked copies send page logs to tools/log_server.py.
"""
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "extension"
DIST = ROOT / "dist"
BROWSERS = ("firefox", "chrome")
DEBUG_LOG_URL = "http://127.0.0.1:8091/log"
SKIP = {".amo-upload-uuid", "__pycache__"}


def manifest_for(browser):
    manifest = json.loads((ROOT / "manifests" / "base.json").read_text())
    manifest.update(json.loads((ROOT / "manifests" / f"{browser}.json").read_text()))
    return manifest


def build(browser, debug):
    manifest = manifest_for(browser)
    out = DIST / browser
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SRC, out, ignore=lambda _dir, names: [n for n in names if n in SKIP])
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if debug:
        bg = out / "background.js"
        code = bg.read_text()
        if "const LOG_URL = '';" not in code:
            sys.exit("LOG_URL line not found in background.js")
        bg.write_text(code.replace("const LOG_URL = '';", f"const LOG_URL = '{DEBUG_LOG_URL}';"))
        print(f"{out}/ (debug)")
        return

    store = dict(manifest)
    store.pop("key", None)
    package = DIST / f"tiny-container-camera-{browser}-{manifest['version']}.zip"
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(out.rglob("*")):
            rel = path.relative_to(out).as_posix()
            if rel == "manifest.json":
                z.writestr(rel, json.dumps(store, indent=2) + "\n")
            elif path.is_file():
                z.write(path, rel)
    print(f"{out}/")
    print(package)


def main():
    args = sys.argv[1:]
    debug = "--debug" in args
    browsers = [a for a in args if a != "--debug"] or list(BROWSERS)
    for browser in browsers:
        if browser not in BROWSERS:
            sys.exit(f"unknown browser {browser!r}; expected one of {', '.join(BROWSERS)}")
        build(browser, debug)


if __name__ == "__main__":
    main()
