import { PRESETS, ViewerSession, loadConfig } from './common.js';
import { HostSession } from './host.js';
import { initCast, castRoom } from './cast.js';

const $ = (id) => document.getElementById(id);

// ---- tabs ----
function showTab(name) {
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  $('host').hidden = name !== 'host';
  $('view').hidden = name !== 'view';
}
for (const b of document.querySelectorAll('.tab')) b.onclick = () => showTab(b.dataset.tab);

// ---- host ----
const host = new HostSession();
for (const [key, p] of Object.entries(PRESETS)) {
  $('preset').append(new Option(`${p.label} (${p.fps}fps / ${p.kbps}kbps)`, key));
}
$('preset').value = 'standard';
$('preset').onchange = () => host.setPreset($('preset').value);
$('codec').onchange = () => host.setCodec($('codec').value);

const canCapture = !!navigator.mediaDevices?.getDisplayMedia;
if (!canCapture) {
  $('start').disabled = true;
  $('hostMsg').textContent =
    'このブラウザは画面共有の送信に対応していません(Android の Chrome など)。「見る」は使えます。';
}

let statsTimer;
function setSharing(on) {
  $('start').hidden = on;
  $('switch').hidden = !on;
  $('stop').hidden = !on;
  $('share').hidden = !on;
  $('preview').hidden = !on;
  clearInterval(statsTimer);
  if (on) statsTimer = setInterval(async () => ($('hostStats').textContent = await host.stats()), 2000);
}

function showPreview() {
  $('preview').srcObject = host.stream;
  $('preview').play().catch(() => {});
  $('surface').textContent = host.surfaceLabel();
}

$('start').onclick = async () => {
  $('hostMsg').textContent = '';
  try {
    await host.setPreset($('preset').value);
    await host.capture({ audio: $('audio').checked });
  } catch (e) {
    $('hostMsg').textContent = e.name === 'NotAllowedError' ? '共有がキャンセルされました' : `開始できません: ${e.message}`;
    return;
  }
  showPreview();
  setSharing(true);
  await host.start();
};

$('switch').onclick = async () => {
  try {
    await host.capture({ audio: $('audio').checked });
    showPreview();
  } catch {
    /* user cancelled: keep the current source */
  }
};

function stopHost() {
  host.stop();
  setSharing(false);
  $('viewers').textContent = '0';
}
$('stop').onclick = stopHost;
host.addEventListener('capture-ended', stopHost);

// When the page is opened as localhost, "localhost" means nothing to other
// devices, so show the address on the home network instead.
async function shareBase() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!local) return `${location.origin}${location.pathname}`;
  const config = await loadConfig();
  return config.lanUrls?.[0] || `${location.origin}${location.pathname}`;
}

host.addEventListener('hosted', async (e) => {
  const room = e.detail;
  $('code').textContent = room;
  $('link').value = `${await shareBase()}?room=${room}`;
});
host.addEventListener('viewers', (e) => ($('viewers').textContent = e.detail));
host.addEventListener('status', (e) => ($('hostMsg').textContent = e.detail));

$('copy').onclick = async () => {
  await navigator.clipboard?.writeText($('link').value).catch(() => {});
  $('link').select();
};

// ---- viewer ----
const viewer = new ViewerSession($('remote'));
let viewTimer;
viewer.addEventListener('status', (e) => ($('viewMsg').textContent = e.detail));

async function join(code) {
  code = code.trim().toUpperCase();
  if (!code) return;
  $('joinCode').value = code;
  $('viewMsg').textContent = '接続中…';
  await viewer.join(code);
  clearInterval(viewTimer);
  viewTimer = setInterval(async () => ($('viewStats').textContent = await viewer.stats()), 2000);
}
$('join').onclick = () => join($('joinCode').value);
$('joinCode').onkeydown = (e) => e.key === 'Enter' && join($('joinCode').value);
$('fullscreen').onclick = () => $('remote').requestFullscreen?.();

// ---- Chromecast ----
initCast().then((ok) => {
  if (!ok) return;
  $('castHost').hidden = false;
  $('castView').hidden = false;
});
$('castHost').onclick = () => host.room && castRoom(host.room).catch(() => {});
$('castView').onclick = () => $('joinCode').value && castRoom($('joinCode').value.toUpperCase()).catch(() => {});

// ---- deep link: ?room=CODE opens the viewer ----
const room = new URLSearchParams(location.search).get('room');
if (room) {
  showTab('view');
  join(room);
} else if (!canCapture) {
  showTab('view');
}
