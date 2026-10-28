'use strict';

const $ = (id) => document.getElementById(id);

function native(body) {
  return browser.runtime.sendMessage({ type: 'native', body });
}

function say(text) {
  $('msg').textContent = text || '';
}

function setValue(el, text, good) {
  el.textContent = text;
  el.className = 'value ' + (good ? 'ok' : 'bad');
}

async function refresh() {
  const res = await native({ cmd: 'status' });
  if (!res.ok) {
    setValue($('device'), 'Bridge not installed', false);
    setValue($('camera'), '-', false);
    say(res.error);
    return;
  }
  const dev = res.devices.find((d) => d.state === 'device');
  setValue($('device'), dev ? (dev.model || 'Device') + ' (' + dev.serial + ')' : 'Not connected', !!dev);
  setValue($('camera'), res.running ? 'On (' + res.facing + ')' : 'Off', res.running);
}

async function run(button, body, done, working = 'Working...') {
  button.disabled = true;
  say(working);
  const res = await native(body);
  button.disabled = false;
  say(res.ok ? done : res.error || res.output);
  await refresh();
}

$('connect').onclick = () => {
  const address = $('address').value.trim();
  run($('connect'), { cmd: 'connect', address }, 'Connected.',
    address ? 'Connecting...' : 'Searching for the device. A full search can take up to 2 minutes...');
};

$('pair').onclick = () =>
  run($('pair'), { cmd: 'pair', address: $('pairAddress').value, code: $('pairCode').value },
    'Paired. Now connect with the port shown under Wireless debugging.');

$('start').onclick = async () => {
  await browser.storage.local.set({ facing: $('facing').value });
  run($('start'), { cmd: 'start', facing: $('facing').value }, 'Camera started. Reload the meeting tab if it shows no video.');
};

$('stop').onclick = () => run($('stop'), { cmd: 'stop' }, 'Camera stopped.');

$('facing').onchange = () => browser.storage.local.set({ facing: $('facing').value });

$('options').onclick = (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
};

browser.storage.local.get({ facing: 'front' }).then(({ facing }) => {
  $('facing').value = facing;
});
refresh();
