'use strict';

const DEFAULT_URL = 'http://127.0.0.1:8765/video';
const input = document.getElementById('url');
const access = document.getElementById('access');
const msg = document.getElementById('msg');

// Match patterns have no port: http://127.0.0.1/* covers every port.
function originPattern(url) {
  const u = new URL(url);
  return u.protocol + '//' + u.hostname + '/*';
}

async function showAccess(url) {
  const granted = await browser.permissions.contains({ origins: [originPattern(url)] });
  access.textContent = granted
    ? 'Access to ' + new URL(url).host + ': granted'
    : 'Access to ' + new URL(url).host + ': not granted. Click the button below.';
  access.style.color = granted ? '#188038' : '#c5221f';
}

async function showSites() {
  const { sites } = await browser.storage.local.get({ sites: {} });
  const list = document.getElementById('sites');
  list.textContent = '';
  const origins = Object.keys(sites).sort();
  if (!origins.length) {
    const li = document.createElement('li');
    li.textContent = 'No sites yet.';
    list.appendChild(li);
  }
  for (const origin of origins) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = origin + ' ';
    const state = document.createElement('b');
    state.textContent = sites[origin] === 'allow' ? 'allowed' : 'blocked';
    state.className = sites[origin];
    label.appendChild(state);
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.onclick = async () => {
      const current = (await browser.storage.local.get({ sites: {} })).sites;
      delete current[origin];
      await browser.storage.local.set({ sites: current });
      showSites();
    };
    li.append(label, remove);
    list.appendChild(li);
  }
}

showSites();

browser.storage.local.get({ url: DEFAULT_URL }).then(({ url }) => {
  input.value = url;
  showAccess(url);
});

document.getElementById('save').addEventListener('click', async () => {
  const url = input.value.trim() || DEFAULT_URL;
  try {
    new URL(url);
  } catch (_) {
    msg.textContent = 'Invalid URL.';
    return;
  }
  const granted = await browser.permissions.request({ origins: [originPattern(url)] });
  await showAccess(url);
  if (!granted) {
    msg.textContent = 'Permission to access ' + new URL(url).origin + ' was denied.';
    return;
  }
  await browser.storage.local.set({ url });
  msg.textContent = 'Saved. Reload the meeting tab.';
});
