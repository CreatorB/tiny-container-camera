<p align="center">
  <img src="docs/demo.jpg" alt="Google Meet in Firefox inside Tiny Computer, using the tablet's own camera" width="100%">
</p>

<h1 align="center">Tiny Container Camera</h1>

<p align="center">
  Use your Android phone/tablet camera as a webcam on <b>any website</b>
  (Microsoft Teams, Google Meet, Zoom web, ...) in Firefox running inside
  <a href="https://github.com/Cateners/tiny_container">Tiny Computer / tiny_container</a>
  or any other proot environment.
</p>

<p align="center"><i>Google Meet running in Firefox inside Tiny Computer on a Galaxy Tab S8, with video from the tablet's camera.</i></p>

## Tested on

| | |
|---|---|
| Device | Samsung Galaxy Tab S8 5G (SM-X706B) |
| Chipset | Qualcomm Snapdragon 8 Gen 1 (SM8450) |
| RAM | 8 GB |
| OS | Android 16, One UI 8.0 (not rooted) |
| Container | Tiny Computer (`com.fct.tc4`), Debian in proot |
| Browser | Firefox ESR 153.5 |
| Camera app | IP Webcam (`com.pas.webcam`), 1280x720 MJPEG |
| Sites | Google Meet (call), webcamtoy.com |

It has two parts:

1. **Firefox extension**: exposes the Android camera as a virtual webcam.
2. **WebRTC fix** (`webrtc-fix/`): makes video calls actually connect from
   Firefox inside proot on Android 11+.

## Why?

Inside proot, Android's `/dev/video*` devices are not accessible without root,
and `v4l2loopback` cannot be installed because kernel modules cannot be loaded.
So the camera cannot be passed through as a regular V4L2 device (this includes
`scrcpy --v4l2-sink`).

The extension takes a different route: the **IP Webcam** app on Android
serves an MJPEG stream at `http://127.0.0.1:8080/video`, and the extension
exposes that stream to web pages as a virtual camera through
`getUserMedia()`. The microphone still uses the real audio input (PulseAudio).

```
IP Webcam (Android) ──MJPEG──▶ background.js ──port──▶ isolated.js ──postMessage──▶ main.js
                               (fetch, no CORS/CSP)                                 canvas.captureStream()
                                                                                    → getUserMedia() on the page
```

Video calls need one more fix. Android 11+ forbids apps from using netlink
sockets, which Firefox uses to list local network addresses for WebRTC. With
no addresses, Firefox gathers no ICE candidates and every call fails ("Sorry,
we encountered a problem joining this video call."). `webrtc-fix/` is a small
`LD_PRELOAD` library that answers those netlink requests using ioctls that
Android still allows.

## Usage

### 1. IP Webcam on Android

Install **IP Webcam** (`com.pas.webcam`) from the Play Store, or via ADB:

```sh
adb shell am start -a android.intent.action.VIEW -d "market://details?id=com.pas.webcam"
```

Open IP Webcam, set **Video preferences → Video resolution** to 640x480
(recommended), then tap **Start server**.

### 2. Extension

Download the signed `.xpi` from the
[Releases](https://github.com/CreatorB/tiny-container-camera/releases) page,
then in Firefox (128+) open `about:addons` → gear icon →
*Install Add-on From File…*

The options page opens after installing: click **Save and grant access** to
let the extension read the stream from `127.0.0.1`.

### 3. WebRTC fix

Needed for video calls (Teams, Meet, ...); not needed for camera-only sites.
Requires `gcc` (`sudo apt install gcc`).

```sh
sh webrtc-fix/install.sh
```

This builds the library into `~/.local/lib/tiny-container-camera/` and makes
Firefox ESR start with it (app menu, links opened from other apps, and the
`firefox-esr` command). Close every Firefox window and start it again.
To undo: `sh webrtc-fix/install.sh --uninstall`.

To try it once without installing:

```sh
gcc -O2 -shared -fPIC -o /tmp/libnetlink_shim.so webrtc-fix/netlink_shim.c -ldl -lpthread
LD_PRELOAD=/tmp/libnetlink_shim.so firefox-esr
```

### 4. Join a meeting

Pick the **Android Camera (Tiny Container)** camera in the meeting settings.

## Troubleshooting

### Samsung: IP Webcam stops in the background

One UI freezes background apps ("Freecess"), so the IP Webcam server stops as
soon as you switch back to Tiny Computer. Exclude it from battery optimization
(Settings → Battery → Background usage limits → *Never sleeping apps*), or via
ADB:

```sh
adb shell dumpsys deviceidle whitelist +com.pas.webcam
adb shell cmd appops set com.pas.webcam RUN_ANY_IN_BACKGROUND allow
```

### The camera shows "No access to 127.0.0.1:8080"

Open the extension options in `about:addons` and click
**Save and grant access**, then reload the page.

### Changing the stream URL

Open the extension options in `about:addons` (for example, to use IP Webcam
on another phone: `http://192.168.1.10:8080/video`). For hosts other than
`127.0.0.1`/`localhost`, Firefox will ask for access permission.

### Checking the WebRTC fix

```sh
LD_PRELOAD=~/.local/lib/tiny-container-camera/libnetlink_shim.so ip -4 addr
```

should list your interfaces (without the library it fails with
`Cannot bind netlink socket: Permission denied`). Set `NETLINK_SHIM_DEBUG=1`
to log the netlink requests the library answers.

## Development

To try code changes without signing: `about:debugging` → *This Firefox* →
*Load Temporary Add-on…* → select `extension/manifest.json`.
Temporary add-ons are removed when Firefox closes.

`sh build.sh` builds `dist/tiny-container-camera.xpi` (unsigned). To sign it,
use [`web-ext sign`](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign).

`sh build.sh --debug` also writes `dist/debug-extension/`, which sends every
`getUserMedia`/`enumerateDevices` call made by pages to
`python3 tools/log_server.py` (written to `tcc.log`).

### Testing without a phone

```sh
python3 tools/mock_mjpeg.py --port 8080 image1.jpg image2.jpg
```

Then open `http://127.0.0.1:8080/tcc-test.html` and click **Start camera**.

## Limitations

- Firefox 128+ only (uses `world: "MAIN"` content scripts).
- Frames are decoded from JPEG inside proot, so lower resolutions run smoother.
- The WebRTC fix reports IPv4 addresses only.
- Sites still ask for microphone permission as usual. No camera permission
  prompt appears because the camera is virtual.

## License

MIT, see [LICENSE](LICENSE).
