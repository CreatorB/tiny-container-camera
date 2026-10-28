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

// Messages from the popup, options and prompt pages, as opposed to content
// scripts, whose sender.url is the web page they run in. (The prompt window
// counts as a tab, so sender.tab cannot be used to tell them apart.)
function fromExtensionPage(sender) {
  return !!sender.url && sender.url.startsWith(browser.runtime.getURL(''));
}

// The virtual camera bypasses Firefox's own camera prompt, so every site has
// to be allowed here first. The site is taken from sender.url, which Firefox
// sets, never from the message, so a page cannot pretend to be another one.
function senderOrigin(sender) {
  try {
    return new URL(sender.url).origin;
  } catch (_) {
    return '';
  }
}

const prompts = new Map(); // origin -> { promise, resolve, windowId }

async function siteDecision(origin) {
  const { sites } = await browser.storage.local.get({ sites: {} });
  return sites[origin];
}

async function isAllowed(origin) {
  if (!origin || origin === 'null') return false;
  const decision = await siteDecision(origin);
  if (decision) return decision === 'allow';
  if (!prompts.has(origin)) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const entry = { promise, resolve, windowId: null };
    prompts.set(origin, entry);
    const win = await browser.windows.create({
      type: 'popup',
      url: 'prompt.html?origin=' + encodeURIComponent(origin),
      width: 460,
      height: 260,
    });
    entry.windowId = win.id;
  }
  return prompts.get(origin).promise;
}

async function decide(origin, allow) {
  const { sites } = await browser.storage.local.get({ sites: {} });
  sites[origin] = allow ? 'allow' : 'block';
  await browser.storage.local.set({ sites });
  const entry = prompts.get(origin);
  if (entry) {
    prompts.delete(origin);
    entry.resolve(allow);
  }
}

// Closing the prompt without choosing denies this request only.
browser.windows.onRemoved.addListener((windowId) => {
  for (const [origin, entry] of prompts) {
    if (entry.windowId === windowId) {
      prompts.delete(origin);
      entry.resolve(false);
    }
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tcc-permission' || fromExtensionPage(port.sender)) return;
  // Keepalive pings while the prompt is open.
  port.onMessage.addListener(() => {});
  isAllowed(senderOrigin(port.sender)).then((allowed) => {
    try {
      port.postMessage({ type: 'permission', allowed });
    } catch (_) {
      // The page went away before the user answered.
    }
  });
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!fromExtensionPage(sender)) return;
  if (msg.type === 'native') return nativeCommand(msg.body);
  if (msg.type === 'permission-decision') return decide(msg.origin, !!msg.allow);
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
  const origin = senderOrigin(port.sender);
  isAllowed(origin).then((allowed) => {
    if (ctrl.signal.aborted) return;
    if (allowed) run(port, ctrl.signal);
    else port.postMessage({ type: 'status', text: 'Camera blocked for ' + origin });
  });
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
