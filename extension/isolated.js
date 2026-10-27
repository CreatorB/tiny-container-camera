// Runs in the extension's isolated world: relays frames between the
// background script (which fetches the stream) and main.js (the page world).
'use strict';

// Firefox suspends idle MV3 background scripts after ~30s; messages from the
// content script count as activity and keep it (and the stream) alive.
const KEEPALIVE_MS = 10000;
const RECONNECT_MS = 1000;

let wanted = false;
let port = null;
let keepalive = null;

function post(msg, transfer) {
  window.postMessage({ __tcc: 'to-main', ...msg }, '*', transfer || []);
}

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__tcc !== 'to-isolated') return;
  if (e.data.type === 'start') start();
  else if (e.data.type === 'stop') stop();
  else if (e.data.type === 'log') browser.runtime.sendMessage({ type: 'log', text: String(e.data.text) });
});

function start() {
  wanted = true;
  connect();
}

function connect() {
  if (port || !wanted) return;
  port = browser.runtime.connect({ name: 'tcc-stream' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'frame') post({ type: 'frame', data: msg.data }, [msg.data]);
    else if (msg.type === 'status') post({ type: 'status', text: msg.text });
  });
  port.onDisconnect.addListener(() => {
    clearInterval(keepalive);
    port = null;
    if (wanted) setTimeout(connect, RECONNECT_MS);
  });
  keepalive = setInterval(() => port && port.postMessage({ type: 'ping' }), KEEPALIVE_MS);
}

function stop() {
  wanted = false;
  clearInterval(keepalive);
  if (port) port.disconnect();
  port = null;
}
