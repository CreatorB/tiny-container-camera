#!/bin/sh
# Builds dist/firefox/ and dist/chrome/ plus store zips. See tools/build.py.
# Usage: sh build.sh [firefox|chrome] [--debug]
exec python3 "$(dirname "$0")/tools/build.py" "$@"
