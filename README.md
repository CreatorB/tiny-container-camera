<p align="center">
  <img src="docs/demo.jpg" alt="Google Meet in Firefox inside Tiny Computer, using the tablet's own camera" width="100%">
</p>

<p align="center"><i>Google Meet running in Firefox inside Tiny Computer on a Galaxy Tab S8, with video from the tablet's camera.</i></p>

<p align="center">
  <img src="extension/icons/icon.svg" alt="" width="96">
</p>

<h1 align="center">Tiny Container Camera</h1>

<p align="center">
  Use your Android phone/tablet camera as a webcam on <b>any website</b>
  (Microsoft Teams, Google Meet, Zoom web, ...) in Firefox or Chrome running inside
  <a href="https://github.com/Cateners/tiny_container">Tiny Computer / tiny_container</a>
  or any other proot environment. No extra Android app, no root.
</p>

<p align="center">
  <a href="https://addons.mozilla.org/firefox/addon/tiny-container-camera/"><b>Get it for Firefox</b></a>
  &nbsp;·&nbsp;
  <a href="#3-extension"><b>Install in Chrome / Chromium</b></a>
</p>

## Browser extension

Running Linux on Android with Tiny Computer, Termux or another proot container
is great for coding, until you need to join a video call with your team:
Android does not let apps inside the container use the camera.

Tiny Container Camera fixes that. It reads the device camera over ADB
(wireless debugging) and turns it into a webcam that every website can use.

**Features**

- Virtual camera named "Android Camera (Tiny Container)" on every HTTPS site:
  Microsoft Teams, Google Meet, Zoom, Jitsi and others.
- No extra Android app: the camera is read over ADB with
  [scrcpy](https://github.com/Genymobile/scrcpy)'s server, started and stopped
  automatically when a site needs the camera.
- Works in Firefox and in Chrome / Chromium, from the same code.
- Asks before a site can use the camera, like the browser does for a real webcam.
  Decisions are remembered per site and can be changed on the options page.
- The device camera turns off by itself shortly after the last page stops
  using it.
- Toolbar button to connect or pair ADB and switch between the front and back
  camera.
- Also works with any MJPEG stream, such as the IP Webcam app.
- Your microphone keeps working as usual.
- No root, no kernel modules, no v4l2loopback.
- No data collection. Video only travels from your device to the page that
  asked for it.

**Quick start**

1. Enable **Wireless debugging** on Android and connect ADB from the container.
2. Run `sh camera-bridge/install.sh` from this repository (once).
3. Install the add-on and click **Save and grant access** on the options page.
4. Choose **Android Camera (Tiny Container)** in your meeting settings.

**Video calls in proot**: on Android 11 and newer, WebRTC calls from Firefox
or Chrome inside proot fail to connect because Android blocks netlink sockets. This
repository includes a small fix, [`webrtc-fix`](#4-webrtc-fix), that makes
calls work.

<p align="center">
  <img src="docs/screenshots/1-meet.jpg" alt="Google Meet call" width="49%">
  <img src="docs/screenshots/2-camera-check.png" alt="Camera check page showing the tablet camera over ADB" width="49%">
</p>

## Toolbar button

Pin the extension to the toolbar to control the camera without leaving the
meeting tab.

| | |
|---|---|
| <img src="docs/screenshots/3-popup-connect.png" alt="Popup after Connect: ADB device connected, camera off, WebRTC fix active" width="420"> | **Connect.** Finds the device over wireless debugging (or connects to the `HOST:PORT` you type) and shows it under *ADB device*. *Pair a new device* pairs with a 6-digit code the first time. *WebRTC fix* tells whether video calls can connect. |
| <img src="docs/screenshots/4-popup-camera-on.png" alt="Camera on: the tablet camera streams to the page while the popup shows Camera On (front)" width="420"> | **Start.** The camera also starts by itself when an allowed site asks for it. Choose the front or back camera here. |
| <img src="docs/screenshots/5-popup-camera-stop.png" alt="Popup after Stop: camera off and Camera stopped message" width="420"> | **Stop.** Turns the device camera off right away, and keeps it off even if a page still holds it, until you press *Start* again. |

## Tested on

| | |
|---|---|
| Device | Samsung Galaxy Tab S8 5G (SM-X706B) |
| Chipset | Qualcomm Snapdragon 8 Gen 1 (SM8450) |
| RAM | 8 GB |
| OS | Android 16, One UI 8.0 (not rooted) |
| Container | Tiny Computer (`com.fct.tc4`), Debian in proot |
| Browsers | Firefox ESR 153.5, Google Chrome 156 |
| Camera source | ADB + scrcpy 3.3.4 (1280x720, 30 fps); IP Webcam (`com.pas.webcam`) |
| Sites | Google Meet (call), webcamtoy.com |

## How it works

Inside proot, Android's `/dev/video*` devices are not accessible without root,
and `v4l2loopback` cannot be installed because kernel modules cannot be loaded.
So the camera cannot be passed through as a regular V4L2 device (this includes
`scrcpy --v4l2-sink`).

ADB still can reach the camera: `camera-bridge/tcc_camera.py` runs
scrcpy-server on the device with the camera as video source, decodes the
H.264 stream with ffmpeg and serves MJPEG on `http://127.0.0.1:8765/video`.
The extension reads that stream and exposes it to web pages as a virtual camera
through `getUserMedia()`. It starts the bridge through the browser's native
messaging when a page asks for the camera, and stops it 15 seconds after the
last page lets go of it.

```
camera ─▶ scrcpy-server ─adb─▶ ffmpeg ─MJPEG─▶ background.js ─▶ isolated.js ─▶ main.js
          (on the device)       (tcc_camera.py)                                 canvas.captureStream()
                                                                                → getUserMedia() on the page
```

Video calls need one more fix. Android 11+ forbids apps from using netlink
sockets, which Firefox and Chrome use to list local network addresses for
WebRTC. With no addresses, the browser gathers no ICE candidates and every call
fails ("Sorry, we encountered a problem joining this video call.").
`webrtc-fix/` is a small `LD_PRELOAD` library that answers those netlink
requests, and `getifaddrs()`, using ioctls that Android still allows.

The extension code in `extension/` is shared by both browsers; `manifests/`
holds a common manifest plus the Firefox and Chrome differences, merged by
`build.sh`.

## Setup

### 1. ADB

```sh
sudo apt install adb scrcpy ffmpeg
```

On Android, open **Settings → Developer options → Wireless debugging** and turn
it on. The first time, tap **Pair device with pairing code** and pair, either
from the extension's toolbar button (*Pair a new device*) or with:

```sh
adb pair HOST:PAIRING_PORT CODE
```

Then connect with the toolbar button (*Connect*) or with
`adb connect HOST:PORT`, using the port shown on the Wireless debugging screen.
With the address left empty, *Connect* tries the last address that worked,
then looks for the port by itself; that search can take up to 2 minutes inside
proot, so typing the address is faster after wireless debugging was turned off
and on.

### 2. Camera bridge

```sh
sh camera-bridge/install.sh
```

This copies the bridge to `~/.local/lib/tiny-container-camera/camera-bridge/`
and registers it with Firefox (`~/.mozilla/native-messaging-hosts/`), Chrome
(`~/.config/google-chrome/NativeMessagingHosts/`) and Chromium
(`~/.config/chromium/NativeMessagingHosts/`). Restart the browser afterwards.
To undo: `sh camera-bridge/install.sh --uninstall`.

Chrome only lets the extension IDs listed there use the bridge. The unpacked
Chrome build always has the ID `kcpfcipcfophknlglpnlgkepmimheeik` (fixed by the
public `key` in `manifests/chrome.json`), which is listed by default. For any
other ID, run `sh camera-bridge/install.sh --chrome-id ID`.

The bridge can also run on its own, for example to use it with other programs:

```sh
python3 camera-bridge/tcc_camera.py --facing back --size 1280 --fps 30
```

### 3. Extension

**Firefox (128+)**: install from
[addons.mozilla.org](https://addons.mozilla.org/firefox/addon/tiny-container-camera/).
It updates automatically. The same signed `.xpi` is also attached to each
[release](https://github.com/CreatorB/tiny-container-camera/releases)
(`about:addons` → gear icon → *Install Add-on From File…*).
The options page opens after installing: click **Save and grant access** to
let the extension read the stream from `127.0.0.1`.

**Chrome / Chromium (111+)**:

```sh
sh build.sh chrome
```

Open `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked** and select the `dist/chrome` folder. Pin the extension from
the puzzle-piece menu to keep its button on the toolbar.

### 4. WebRTC fix

Needed for video calls (Teams, Meet, ...); not needed for camera-only sites.
Requires `gcc` (`sudo apt install gcc`).

```sh
sh webrtc-fix/install.sh
```

This builds the library into `~/.local/lib/tiny-container-camera/` and makes
the installed browsers start with it:

- Firefox ESR: app menu, links opened from other apps, and the `firefox-esr`
  command.
- Chrome / Chromium: user copies of their app menu entries, with the library
  added to any `LD_PRELOAD` already there (Tiny Computer's Chrome entry
  preloads `unamefix.so`, which is kept).

Close every browser window and start it again from the app menu.
To undo: `sh webrtc-fix/install.sh --uninstall`.

To try it once without installing:

```sh
gcc -O2 -shared -fPIC -o /tmp/libnetlink_shim.so webrtc-fix/netlink_shim.c -ldl -lpthread
LD_PRELOAD=/tmp/libnetlink_shim.so firefox-esr
```

### 5. Join a meeting

Pick the **Android Camera (Tiny Container)** camera in the meeting settings.
The first time a site asks for the camera, the extension opens a small window:
choose **Allow**. The first frame takes a few seconds while the camera starts
on the device.

## Privacy

Because the virtual camera bypasses the browser's own camera prompt, the
extension asks for itself: a site gets no video, and the device camera is not
turned on, until you allow that site. The check runs in the extension's
background script against the address the browser reports for the page, so a
page cannot
grant itself access. Allowed and blocked sites are listed on the options page.

The camera bridge stops 15 seconds after the last page releases the camera,
and in any case after 30 seconds without viewers (even if the browser was closed).

## Using IP Webcam instead of ADB

If you prefer an Android app, install **IP Webcam** (`com.pas.webcam`), tap
**Start server**, then set the stream URL on the extension's options page to
`http://127.0.0.1:8080/video`. Steps 1 and 2 above are not needed in that case.

Make sure nothing else in the container listens on port 8080 (a local web
server, for example), or change the IP Webcam port.

## Troubleshooting

### The site says the camera is blocked

You chose **Block** for that site earlier. Open the extension options
(toolbar button → *Options*), remove the site under **Sites**, and reload the
page.

### The camera shows "No access to 127.0.0.1"

Open the extension options (toolbar button → *Options*) and click
**Save and grant access**, then reload the page.

### The camera shows "Camera bridge not installed"

Run `sh camera-bridge/install.sh` and restart the browser. In Chrome the
message also shows the extension ID: if it is not
`kcpfcipcfophknlglpnlgkepmimheeik` (for example a Chrome Web Store install),
register it with `sh camera-bridge/install.sh --chrome-id ID`.

### The camera shows "no ADB device connected"

Connect ADB from the toolbar button or with `adb connect HOST:PORT`. The
Wireless debugging port changes every time it is turned off and on.

### Camera bridge log

The bridge writes its log to `~/.cache/tiny-container-camera/bridge.log`.
Run it by hand with `--verbose` to see the frame rate every 5 seconds:

```sh
python3 camera-bridge/tcc_camera.py --verbose
```

### Samsung: IP Webcam stops in the background

One UI freezes background apps ("Freecess"), so the IP Webcam server stops as
soon as you switch back to Tiny Computer. Exclude it from battery optimization
(Settings → Battery → Background usage limits → *Never sleeping apps*), or via
ADB:

```sh
adb shell dumpsys deviceidle whitelist +com.pas.webcam
adb shell cmd appops set com.pas.webcam RUN_ANY_IN_BACKGROUND allow
```

### "Sorry, we encountered a problem joining this video call"

The browser was started without the WebRTC fix, so the call cannot connect even
though the camera works. Open the extension's toolbar button: **WebRTC fix**
shows *Not loaded* in that case.

The usual cause is the XFCE app menu or panel caching the old browser entry
from before `webrtc-fix/install.sh` was run, so it still starts the browser
directly. (`install.sh` now restarts the panel itself.) Fix it once with:

```sh
xfce4-panel -r
```

then quit the browser completely (Ctrl+Q) and start it again from the app
menu. To check a running browser:

```sh
tr '\0' '\n' < /proc/$(pgrep -o -f /usr/lib/firefox-esr/firefox-esr)/environ | grep LD_PRELOAD
tr '\0' '\n' < /proc/$(pgrep -o -f /opt/google/chrome/chrome)/environ | grep LD_PRELOAD
```

It should print a path ending in `libnetlink_shim.so`.

### Checking the WebRTC fix

```sh
LD_PRELOAD=~/.local/lib/tiny-container-camera/libnetlink_shim.so ip -4 addr
```

should list your interfaces (without the library it fails with
`Cannot bind netlink socket: Permission denied`). Set `NETLINK_SHIM_DEBUG=1`
to log the netlink requests the library answers.

## Development

```
extension/     shared code (background, content scripts, popup, options, prompt)
manifests/     base.json + firefox.json / chrome.json differences
camera-bridge/ ADB camera bridge and native messaging host
webrtc-fix/    LD_PRELOAD library for WebRTC in proot
amo/           addons.mozilla.org listing text and asset upload script
tools/         build script, mock camera, log server, test page
```

`sh build.sh` writes, for each browser, an unpacked copy to `dist/firefox/`
and `dist/chrome/`, and a store package
`dist/tiny-container-camera-<browser>-<version>.zip` (the Chrome one without
the `key`). `sh build.sh firefox` or `sh build.sh chrome` builds just one.

Load the unpacked copy to try changes: Firefox `about:debugging` →
*This Firefox* → *Load Temporary Add-on…* → `dist/firefox/manifest.json`
(removed when Firefox closes); Chrome `chrome://extensions` → *Load unpacked* →
`dist/chrome`. Rebuild after every change.

To publish on addons.mozilla.org, sign `dist/firefox` with
[`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign)
(`--source-dir dist/firefox --channel listed --amo-metadata amo/metadata.json`).
The listing text is kept in `amo/metadata.json`; `amo/upload_assets.py`
uploads the icon and screenshots.

`sh build.sh --debug` builds unpacked copies that send every
`getUserMedia`/`enumerateDevices` call made by pages to
`python3 tools/log_server.py` (written to `tcc.log`).

### Testing without a phone

```sh
python3 tools/mock_mjpeg.py --port 8765 image1.jpg image2.jpg
```

Then open `http://127.0.0.1:8765/tcc-test.html` and click **Start camera**.

## Limitations

- Firefox 128+ or Chrome / Chromium 111+ (uses `world: "MAIN"` content
  scripts).
- The ADB camera source needs Android 12+.
- Frames are decoded inside proot, so lower resolutions run smoother.
- The WebRTC fix reports IPv4 addresses only.
- Sites still ask for microphone permission as usual. No camera permission
  prompt appears because the camera is virtual.

## License

MIT, see [LICENSE](LICENSE).
