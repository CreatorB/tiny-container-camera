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
  else if (e.data.type === 'permission') askPermission(e.data.id);
});

// Uses a port with keepalive pings rather than sendMessage: the user may take
// a while to answer the prompt, and an idle background script would be
// suspended, dropping a pending sendMessage reply.
function askPermission(id) {
  const p = browser.runtime.connect({ name: 'tcc-permission' });
  const ping = setInterval(() => p.postMessage({ type: 'ping' }), KEEPALIVE_MS);
  let answered = false;
  const answer = (allowed) => {
    if (answered) return;
    answered = true;
    clearInterval(ping);
    p.disconnect();
    post({ type: 'permission', id, allowed });
  };
  p.onMessage.addListener((msg) => {
    if (msg.type === 'permission') answer(!!msg.allowed);
  });
  p.onDisconnect.addListener(() => answer(false));
}

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

// Pages kept in the back/forward cache do not drop their ports, which would
// keep the camera streaming after the user navigated away.
window.addEventListener('pagehide', () => stop());

function stop() {
  wanted = false;
  clearInterval(keepalive);
  if (port) port.disconnect();
  port = null;
}
