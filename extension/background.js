// Fetches the MJPEG stream with the extension's host permissions (no page
// CORS/CSP) and sends each JPEG frame to the content script over a port.
'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8765/video';
const RECONNECT_MS = 2000;
// Debug builds set this to a local endpoint that collects page logs.
const LOG_URL = '';

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'log') return;
  console.debug('[tiny-container-camera]', msg.text);
  if (LOG_URL) fetch(LOG_URL, { method: 'POST', body: msg.text }).catch(() => {});
});

// MV3 host permissions are not always granted at install time (e.g. when
// installed from a file or by policy), so ask for them on the options page.
async function hasAccess(url) {
  // Match patterns have no port: http://127.0.0.1/* covers every port.
  const u = new URL(url);
  return browser.permissions.contains({ origins: [u.protocol + '//' + u.hostname + '/*'] });
}

browser.runtime.onInstalled.addListener(async () => {
  if (!(await hasAccess(DEFAULT_URL))) browser.runtime.openOptionsPage();
});

// The ADB camera bridge (camera-bridge/ in the repository) is started through
// native messaging when a page needs the camera, and stopped when no page has
// used it for a while so the device camera is not left on.
const NATIVE_HOST = 'tiny_container_camera';
const BRIDGE_STOP_DELAY_MS = 15000;
let streams = 0;
let stopTimer = null;

function isBridgeUrl(url) {
  return url === DEFAULT_URL;
}

async function nativeCommand(msg) {
  try {
    return await browser.runtime.sendNativeMessage(NATIVE_HOST, msg);
  } catch (err) {
    return { ok: false, error: 'Camera bridge not installed (camera-bridge/install.sh): ' + err.message };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'native') return nativeCommand(msg.body);
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tcc-stream') return;
  const ctrl = new AbortController();
  streams++;
  clearTimeout(stopTimer);
  port.onDisconnect.addListener(() => {
    ctrl.abort();
    if (--streams === 0) stopTimer = setTimeout(stopBridgeIfIdle, BRIDGE_STOP_DELAY_MS);
  });
  // Keepalive pings from isolated.js; receiving them resets the idle timer.
  port.onMessage.addListener(() => {});
  run(port, ctrl.signal);
});

async function stopBridgeIfIdle() {
  const { url, autoStop } = await browser.storage.local.get({ url: DEFAULT_URL, autoStop: true });
  if (streams === 0 && autoStop && isBridgeUrl(url)) nativeCommand({ cmd: 'stop' });
}

async function run(port, signal) {
  const { url, facing } = await browser.storage.local.get({ url: DEFAULT_URL, facing: 'front' });
  const status = (text) => port.postMessage({ type: 'status', text });
  if (!(await hasAccess(url))) {
    status('No access to ' + new URL(url).host + '. Open the extension options.');
    browser.runtime.openOptionsPage();
    return;
  }
  let bridgeError = '';
  while (!signal.aborted) {
    if (isBridgeUrl(url)) {
      // Idempotent: returns at once if the bridge is already running.
      const res = await nativeCommand({ cmd: 'start', facing });
      bridgeError = res.ok ? '' : res.error;
    }
    try {
      status(bridgeError || (isBridgeUrl(url) ? 'Starting camera over ADB...' : 'Connecting to ' + url));
      await readStream(url, signal, (frame) => port.postMessage({ type: 'frame', data: frame }));
      status('Stream ended, reconnecting...');
    } catch (err) {
      if (signal.aborted) break;
      status(bridgeError || 'Camera unreachable: ' + url);
      console.warn('[tiny-container-camera]', url, err);
    }
    await new Promise((r) => setTimeout(r, RECONNECT_MS));
  }
}

// Splits the multipart MJPEG byte stream into JPEG frames by scanning for the
// SOI (FF D8) and EOI (FF D9) markers.
async function readStream(url, signal, onFrame) {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  let buf = new Uint8Array(0);
  let start = -1;
  let scanFrom = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf = concat(buf, value);
    for (;;) {
      if (start < 0) {
        start = indexOfMarker(buf, 0xd8, scanFrom);
        if (start < 0) {
          // Keep only a trailing 0xFF that may start the next marker.
          buf = buf.subarray(Math.max(0, buf.length - 1));
          scanFrom = 0;
          break;
        }
        scanFrom = start + 2;
      }
      const end = indexOfMarker(buf, 0xd9, scanFrom);
      if (end < 0) {
        scanFrom = Math.max(start + 2, buf.length - 1);
        break;
      }
      onFrame(buf.slice(start, end + 2).buffer);
      buf = buf.subarray(end + 2);
      start = -1;
      scanFrom = 0;
    }
  }
}

function indexOfMarker(buf, second, from) {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === second) return i;
  }
  return -1;
}

function concat(a, b) {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
