// Canopy Ranger — phone app.
// Talks to the Ranger (firmware/src/ranger) over BLE UART (Nordic UART Service,
// same as the v2 dashboard PWA), GPS-stamps every ping, keeps the session in
// localStorage, exports CSV/GeoJSON. ?demo=1 runs a fake Ranger for testing.
'use strict';

const { parseLine, LineSplitter, cleanName, distanceM } = window.RangerParse;

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write to device
const NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify from device

const FIX_MAX_AGE_MS = 20000;   // older than this, a ping gets no position
const STALE_MS = 12000;         // pings are every 5 s; nothing for 12 s = something's wrong
const LOG_KEEP = 400;

const DEMO = new URLSearchParams(location.search).has('demo');
const STORE_KEY = DEMO ? 'canopy_ranger_demo_v1' : 'canopy_ranger_session_v1';   // demo never touches real data

// ------------------------------------------------------------
//  Session (persisted)
// ------------------------------------------------------------
function freshSession() {
  return { started: new Date().toISOString(), base: null, pings: [], spots: [], log: [], nextTrap: 1,
           thresholds: { good: -5, marginal: -10 } };   // replaced by what the Ranger reports on connect
}

let S = load();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return Object.assign(freshSession(), JSON.parse(raw));
  } catch (e) { /* private mode / blocked storage: run without persistence */ }
  return freshSession();
}

let saveTimer = null;
function save(now) {
  clearTimeout(saveTimer);
  const write = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { toast('Could not save to phone storage'); } };
  if (now) write(); else saveTimer = setTimeout(write, 1500);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) save(true); });
window.addEventListener('pagehide', () => save(true));

// ------------------------------------------------------------
//  GPS
// ------------------------------------------------------------
let fix = null;              // latest {lat, lon, acc, t}
let surveyFixes = null;      // fixes collected while a spot survey runs

function onFix(p) {
  fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: Date.now() };
  if (surveyFixes) surveyFixes.push(fix);
  renderGps();
  renderLive();
  renderMap();
}

function startGps() {
  if (DEMO) return;   // demo feeds its own positions
  if (!('geolocation' in navigator)) { setPill('gpsPill', 'No GPS', 'bad'); return; }
  navigator.geolocation.watchPosition(onFix, err => {
    setPill('gpsPill', err.code === 1 ? 'GPS blocked' : 'No GPS fix', 'bad');
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

function freshFix() {
  return fix && Date.now() - fix.t < FIX_MAX_AGE_MS ? fix : null;
}

// Best (smallest accuracy circle) fix taken while standing still for the survey.
function bestFix(list) {
  const good = (list || []).filter(f => f);
  if (!good.length) return freshFix();
  return good.reduce((a, b) => (b.acc < a.acc ? b : a));
}

// ------------------------------------------------------------
//  BLE
// ------------------------------------------------------------
let device = null, rxChar = null, connected = false, wantConnected = false;
let split = LineSplitter();

async function connect() {
  if (DEMO) { Demo.start(); return; }
  if (!navigator.bluetooth) {
    toast('This browser has no Web Bluetooth. Use Chrome on Android.');
    return;
  }
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Canopy Ranger' }, { services: [NUS_SERVICE] }],
      optionalServices: [NUS_SERVICE],
    });
    device.addEventListener('gattserverdisconnected', onDisconnected);
    wantConnected = true;
    await openGatt();
  } catch (e) {
    if (e.name !== 'NotFoundError') toast('Connect failed: ' + e.message);   // NotFoundError = picker cancelled
    setBle('Not connected', '');
  }
}

async function openGatt() {
  setBle('Connecting…', 'warn');
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(NUS_SERVICE);
  rxChar = await svc.getCharacteristic(NUS_RX_CHAR);
  const txChar = await svc.getCharacteristic(NUS_TX_CHAR);
  split = LineSplitter();
  txChar.addEventListener('characteristicvaluechanged', ev => {
    for (const line of split(new Uint8Array(ev.target.value.buffer))) onLine(line);
  });
  await txChar.startNotifications();
  connected = true;
  setBle('Live', 'ok');
  setTimeout(() => send('HELP'), 800);   // the reply includes the board's verdict thresholds
  keepAwake();
  renderControls();
}

// The Ranger keeps advertising after a drop, so walking out of Bluetooth range
// and back just needs a retry loop — no new picker.
async function onDisconnected() {
  connected = false; rxChar = null;
  renderControls();
  if (!wantConnected) { setBle('Not connected', ''); return; }
  setBle('Reconnecting…', 'bad');
  logLine('! Bluetooth dropped, retrying', 'w');
  for (let i = 0; wantConnected && !connected; i++) {
    await sleep(Math.min(2000 + i * 1000, 8000));
    if (!wantConnected) break;
    try { await openGatt(); logLine('reconnected', 's'); } catch (e) { /* keep trying */ }
  }
}

function disconnect() {
  wantConnected = false;
  if (DEMO) { Demo.stop(); return; }
  if (device && device.gatt.connected) device.gatt.disconnect();
}

async function send(cmd) {
  logLine('> ' + cmd, 's');
  if (DEMO) { Demo.command(cmd); return; }
  if (!rxChar) { toast('Not connected'); return; }
  try { await rxChar.writeValue(new TextEncoder().encode(cmd + '\n')); }
  catch (e) { toast('Send failed: ' + e.message); }
}

// Screen off = Chrome throttles the page and BLE notifications stall.
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } } catch (e) { /* not allowed here; the screen may sleep */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && (connected || DEMO)) keepAwake(); });

// ------------------------------------------------------------
//  Incoming lines
// ------------------------------------------------------------
let current = null;          // name of the spot being surveyed
let lastPingAt = 0;
let pingGap = 5000;            // measured time between pings; the firmware's PING_INTERVAL_MS is 5 s

function onLine(line) {
  const e = parseLine(line);
  logLine(line, e.kind === 'warn' ? 'w' : (e.kind === 'summary' || e.kind === 'start') ? 's' : '');

  switch (e.kind) {
    case 'ping': {
      const f = freshFix();
      S.pings.push({
        t: new Date().toISOString(), seq: e.seq, heard: e.heard, snr: e.snr, rssi: e.rssi,
        verdict: e.verdict, spot: e.survey ? e.survey.name : '',
        lat: f ? f.lat : null, lon: f ? f.lon : null, acc: f ? f.acc : null,
      });
      if (lastPingAt) pingGap = Math.min(15000, Math.max(1000, Date.now() - lastPingAt));
      lastPingAt = Date.now();
      pulse();
      if (e.survey) showSurvey(e.survey.name, e.survey.n, e.survey.of);
      renderLive(); renderMap(); save();
      break;
    }
    case 'start':
      current = e.name;
      surveyFixes = fix ? [fix] : [];
      showSurvey(e.name, 0, e.samples);
      buzz([60]);
      break;
    case 'summary': {
      const f = bestFix(surveyFixes);
      surveyFixes = null; current = null;
      S.spots.push({
        t: new Date().toISOString(), name: e.name, verdict: e.verdict, heard: e.heard, sent: e.sent,
        snrWorst: e.snrWorst, snrAvg: e.snrAvg, note: '',
        lat: f ? f.lat : null, lon: f ? f.lon : null, acc: f ? f.acc : null,
      });
      hideSurvey();
      buzz(e.verdict === 'GOOD' ? [200] : e.verdict === 'MARGINAL' ? [150, 100, 150] : [400, 150, 400, 150, 400]);
      toast(e.name + ': ' + e.verdict);
      renderSpots(); renderMap(); save(true);
      break;
    }
    case 'status':
      setPill('battPill', e.batt.toFixed(2) + ' V', e.batt < 3.4 ? 'bad' : e.batt < 3.7 ? 'warn' : 'ok');
      break;
    case 'thresholds':
      S.thresholds = { good: e.good, marginal: e.marginal };
      renderScale(); renderSpark(); save();
      break;
    case 'warn':
      toast(e.text);
      buzz([300, 100, 300]);
      break;
  }
}

// Between pings the card would sit still for 5 s and look frozen, so show
// the time since the last reading and a bar filling towards the next one.
function renderTicker() {
  if (!lastPingAt) { $('ago').textContent = '–'; $('nextFill').style.width = '0'; return; }
  const since = Date.now() - lastPingAt;
  $('ago').textContent = since < 1500 ? 'just now' : Math.round(since / 1000) + ' s ago';
  $('nextFill').style.width = Math.min(100, 100 * since / pingGap) + '%';
}
setInterval(renderTicker, 200);

function pulse() {
  const el = $('live');
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}

// ------------------------------------------------------------
//  Rendering
// ------------------------------------------------------------
const $ = id => document.getElementById(id);
const cls = v => (v || 'NO LINK').replace(' ', '');

function setPill(id, text, state) {
  const el = $(id); el.hidden = false; el.textContent = text; el.className = 'pill ' + (state || '');
}
function setBle(text, state) { setPill('blePill', text, state); $('connectBtn').textContent = (connected || wantConnected) ? 'Disconnect' : 'Connect to Ranger'; }

function renderGps() {
  if (!fix) return;
  setPill('gpsPill', 'GPS ±' + fix.acc + ' m', fix.acc <= 10 ? 'ok' : fix.acc <= 25 ? 'warn' : 'bad');
}

function renderLive() {
  const last = S.pings[S.pings.length - 1];
  const live = $('live');
  if (!last) { live.className = 'NOLINK stale'; return; }
  const stale = Date.now() - lastPingAt > STALE_MS;
  live.className = cls(last.verdict) + (stale ? ' stale' : '');
  $('snr').innerHTML = (last.heard ? (last.snr > 0 ? '+' : '') + last.snr : '–') + '<small>dB SNR</small>';
  $('verdict').textContent = stale ? 'NO DATA' : last.heard ? last.verdict : 'NO REPLY';
  $('rssi').textContent = last.heard ? last.rssi + ' dBm' : '–';
  const tail = S.pings.slice(-10);
  $('last10').textContent = tail.filter(p => p.heard).length + '/' + tail.length;
  const here = freshFix();
  $('dist').textContent = S.base && here ? Math.round(distanceM(S.base, here)) + ' m' : S.base ? 'no fix' : 'set base';
  renderSpark();
}

// Fixed SNR window: -20 (below the SF10 floor) to +12 (where the chip's SNR
// estimate tops out). Zones come from the board's own thresholds.
const SCALE_LO = -20, SCALE_HI = 12;
const scalePct = v => 100 * (Math.max(SCALE_LO, Math.min(SCALE_HI, v)) - SCALE_LO) / (SCALE_HI - SCALE_LO);
function renderScale() {
  const T = S.thresholds;
  $('zPoor').style.width = scalePct(T.marginal) + '%';
  $('zMarg').style.width = (scalePct(T.good) - scalePct(T.marginal)) + '%';
  $('zGood').style.width = (100 - scalePct(T.good)) + '%';
  const lab = (v, t) => `<span style="left:${scalePct(v)}%">${t}</span>`;
  $('scaleLabels').innerHTML = lab(T.marginal, fmt(T.marginal)) + lab(T.good, fmt(T.good)) +
    `<span style="left:4%;transform:none">POOR</span><span style="right:0;left:auto;transform:none">GOOD</span>`;
  const last = S.pings[S.pings.length - 1], m = $('scaleMark');
  if (last && last.heard) { m.style.display = 'block'; m.style.left = scalePct(last.snr) + '%'; }
  else m.style.display = 'none';
}

function renderSpark() {
  const c = $('spark'), ctx = sizeCanvas(c);
  const W = c.clientWidth, H = c.clientHeight;
  const pts = S.pings.slice(-60);
  const lo = -20, hi = 12, y = v => H - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * H;
  ctx.clearRect(0, 0, W, H);
  const T = S.thresholds;
  // same zones as the scale bar: red below MARGINAL, amber up to GOOD, green above
  ctx.fillStyle = '#991b1b'; ctx.fillRect(0, y(T.marginal), W, H - y(T.marginal));
  ctx.fillStyle = '#c2620a'; ctx.fillRect(0, y(T.good), W, y(T.marginal) - y(T.good));
  ctx.fillStyle = '#166534'; ctx.fillRect(0, 0, W, y(T.good));
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  for (const t of [T.good, T.marginal]) { ctx.beginPath(); ctx.moveTo(0, y(t)); ctx.lineTo(W, y(t)); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = '10px system-ui';
  ctx.fillText(fmt(T.good) + ' GOOD', 4, y(T.good) - 3); ctx.fillText(fmt(T.marginal) + ' POOR', 4, y(T.marginal) + 11);
  const step = W / 59;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.beginPath();
  let pen = false;
  pts.forEach((p, i) => {
    const x = (i + 60 - pts.length) * step;
    if (!p.heard) { pen = false; ctx.fillStyle = '#fff'; ctx.fillRect(x - 2, H - 6, 4, 6); return; }
    if (pen) ctx.lineTo(x, y(p.snr)); else ctx.moveTo(x, y(p.snr));
    pen = true;
  });
  ctx.stroke();
}

function showSurvey(name, n, of) {
  $('surveyBar').classList.add('on');
  $('surveyTitle').textContent = 'Surveying ' + name + ' (' + n + '/' + of + ')';
  $('surveyFill').style.width = (100 * n / of) + '%';
  renderControls();
}
function hideSurvey() { $('surveyBar').classList.remove('on'); renderControls(); }

function renderSpots() {
  const box = $('spots');
  if (!S.spots.length) { box.innerHTML = '<div class="empty">No spots yet. Stand where a trap will sit and press MARK, or swipe the magnet past the Ranger.</div>'; return; }
  box.innerHTML = '';
  S.spots.slice().reverse().forEach(s => {
    const i = S.spots.indexOf(s);
    const d = S.base && s.lat != null ? Math.round(distanceM(S.base, s)) + ' m from base · ' : '';
    const el = document.createElement('div'); el.className = 'spot';
    el.innerHTML = `<div class="top"><span class="name"></span><span class="chip ${cls(s.verdict)}">${s.verdict}</span></div>
      <div class="meta">${d}${s.heard}/${s.sent} heard${s.snrWorst != null ? ' · worst ' + fmt(s.snrWorst) + ' · avg ' + fmt(s.snrAvg) : ''}${s.lat == null ? ' · no GPS' : ' · ±' + s.acc + ' m'} · ${hhmm(s.t)}</div>
      <div class="note"></div>
      <div class="row"><button data-act="note">Note</button><button data-act="rename">Rename</button><button data-act="delete">Delete</button></div>`;
    el.querySelector('.name').textContent = s.name;
    el.querySelector('.note').textContent = s.note;
    el.querySelector('[data-act=note]').onclick = () => {
      const v = prompt('What\'s between here and the base? (trees, ridge, wall…)', s.note);
      if (v != null) { S.spots[i].note = v; save(true); renderSpots(); }
    };
    el.querySelector('[data-act=rename]').onclick = () => {
      const v = prompt('Rename spot (the Ranger\'s own LIST keeps the old name)', s.name);
      if (v) { S.spots[i].name = cleanName(v) || s.name; save(true); renderSpots(); renderMap(); }
    };
    el.querySelector('[data-act=delete]').onclick = () => {
      if (!confirm('Delete spot "' + s.name + '"? Its pings stay in the walk log.')) return;
      S.spots.splice(i, 1); save(true); renderSpots(); renderMap(); renderSession();
    };
    box.appendChild(el);
  });
}
const fmt = v => (v > 0 ? '+' : '') + v;
const hhmm = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });   // stored UTC, shown local

// ------------------------------------------------------------
//  Site map: an optional background image with lat/lon bounds, loaded from a
//  file on the phone. Kept in IndexedDB so it doesn't eat the session's
//  localStorage, and never shipped with the (public) app.
// ------------------------------------------------------------
let baseMap = null;   // {name, bounds {n,s,e,w}, marks [{name,lat,lon,kind}], img}
function mapDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('canopy_ranger_maps', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('maps');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function mapStore(pack) {
  try {
    const db = await mapDb();
    await new Promise((res, rej) => {
      const t = db.transaction('maps', 'readwrite'), st = t.objectStore('maps');
      if (pack) st.put(pack, 'current'); else st.delete('current');
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
  } catch (e) { toast('Could not save the map on this phone'); }
}
async function mapRestore() {
  try {
    const db = await mapDb();
    const pack = await new Promise((res, rej) => {
      const r = db.transaction('maps').objectStore('maps').get('current');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (pack) useMap(pack, false);
  } catch (e) { /* no IndexedDB: run without a map */ }
}
function useMap(pack, store) {
  const b = pack && pack.bounds;
  if (!pack || pack.canopyMap !== 1 || !b || !(b.n > b.s) || !(b.e > b.w) || !/^data:image\//.test(pack.image || '')) {
    toast('That file isn\'t a Canopy map'); return;
  }
  const img = new Image();
  img.onload = () => {
    baseMap = { name: pack.name || 'Site map', bounds: b, marks: pack.marks || [], steps: Array.isArray(pack.steps) ? pack.steps : [], img };
    if (store) { mapStore(pack); toast('Map loaded: ' + baseMap.name); }
    renderMapControls(); renderMap();
  };
  img.onerror = () => toast('Could not read the map image');
  img.src = pack.image;
}
function renderMapControls() {
  $('mapName').textContent = baseMap ? baseMap.name : '';
  $('mapClear').hidden = !baseMap;
  $('map').classList.toggle('hasBase', !!baseMap);
  const ol = $('mapSteps'); ol.innerHTML = '';
  (baseMap ? baseMap.steps : []).forEach(t => { const li = document.createElement('li'); li.textContent = t; ol.appendChild(li); });
  ol.hidden = !(baseMap && baseMap.steps.length);
}

// North-up plot in local metres. Frames the site map if one is loaded,
// otherwise the data. No tiles: works offline.
function renderMap() {
  const c = $('map');
  if (!c.offsetParent) return;   // tab hidden
  const ctx = sizeCanvas(c), W = c.clientWidth, H = c.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const pts = S.pings.filter(p => p.lat != null);
  const all = pts.concat(S.spots.filter(s => s.lat != null), S.base ? [S.base] : []);
  const css = getComputedStyle(document.documentElement);
  const col = v => css.getPropertyValue({ GOOD: '--good', MARGINAL: '--marg', POOR: '--poor' }[v] || '--none');
  ctx.fillStyle = css.getPropertyValue('--muted'); ctx.font = '13px system-ui';
  const me = freshFix();
  if (!all.length && !baseMap) { ctx.fillText('Nothing with a GPS fix yet.', 16, 28); return; }

  const bb = baseMap && baseMap.bounds;
  const ref = bb ? [{ lat: bb.n, lon: bb.w }, { lat: bb.s, lon: bb.e }] : all;
  const lat0 = ref.reduce((a, p) => a + p.lat, 0) / ref.length;
  const lon0 = ref.reduce((a, p) => a + p.lon, 0) / ref.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const xy = p => [(p.lon - lon0) * kx, (p.lat - lat0) * ky];
  const xs = ref.map(p => xy(p)[0]), ys = ref.map(p => xy(p)[1]);
  const spanX = Math.max(40, Math.max(...xs) - Math.min(...xs)), spanY = Math.max(40, Math.max(...ys) - Math.min(...ys));
  const pad = bb ? 4 : 28;
  const scale = bb ? Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY) : (Math.min(W, H) - 2 * pad) / Math.max(spanX, spanY);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const P = p => { const [x, y] = xy(p); return [W / 2 + (x - cx) * scale, H / 2 - (y - cy) * scale]; };

  if (bb) {
    const [x1, y1] = P({ lat: bb.n, lon: bb.w }), [x2, y2] = P({ lat: bb.s, lon: bb.e });
    ctx.drawImage(baseMap.img, x1, y1, x2 - x1, y2 - y1);
    const kcol = { hub: '#1f4e79', relay: '#7b3fa0', test: '#b4371f', check: '#0b6e99', weak: '#b4371f', meet: '#d4380d' };
    ctx.font = 'bold 11px system-ui'; ctx.lineJoin = 'round';
    baseMap.marks.forEach(m => {
      const [x, y] = P(m);
      ctx.fillStyle = kcol[m.kind] || '#333'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(x - 4, y - 4, 8, 8); ctx.fill(); ctx.stroke();
      const tw = ctx.measureText(m.name).width, tx = x + 7 + tw > W - 4 ? x - 7 - tw : x + 7;   // keep labels on the canvas
      ctx.lineWidth = 3; ctx.strokeText(m.name, tx, y + 4); ctx.fillText(m.name, tx, y + 4);
    });
  }

  pts.forEach(p => { const [x, y] = P(p); ctx.fillStyle = col(p.verdict); ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); });
  ctx.font = 'bold 12px system-ui';
  S.spots.filter(s => s.lat != null).forEach(s => {
    const [x, y] = P(s);
    ctx.fillStyle = col(s.verdict); ctx.strokeStyle = css.getPropertyValue('--ink'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = css.getPropertyValue('--ink');
    const tw = ctx.measureText(s.name).width;
    ctx.fillText(s.name, x + 11 + tw > W - 4 ? x - 11 - tw : x + 11, y + 4);   // keep labels on the canvas
  });
  if (S.base) {
    const [x, y] = P(S.base);
    ctx.font = '22px system-ui'; ctx.fillStyle = css.getPropertyValue('--accent'); ctx.fillText('★', x - 8, y + 8);
  }
  if (me) {   // you are here
    const [x, y] = P(me);
    ctx.fillStyle = 'rgba(26,115,232,.15)'; ctx.beginPath(); ctx.arc(x, y, Math.max(6, me.acc * scale), 0, 7); ctx.fill();
    ctx.fillStyle = '#1a73e8'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.stroke();
  }
  // scale bar
  const nice = [10, 20, 50, 100, 200, 500, 1000].find(m => m * scale > 60) || 1000;
  ctx.strokeStyle = css.getPropertyValue('--ink'); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(12, H - 14); ctx.lineTo(12 + nice * scale, H - 14); ctx.stroke();
  ctx.font = '12px system-ui'; ctx.fillStyle = css.getPropertyValue('--ink'); ctx.fillText(nice + ' m', 12, H - 20);
  ctx.fillText('N ↑', W - 34, 20);
}

function sizeCanvas(c) {
  const r = window.devicePixelRatio || 1;
  if (c.width !== c.clientWidth * r || c.height !== c.clientHeight * r) { c.width = c.clientWidth * r; c.height = c.clientHeight * r; }
  const ctx = c.getContext('2d'); ctx.setTransform(r, 0, 0, r, 0, 0); return ctx;
}

function logLine(text, kind) {
  S.log.push({ t: Date.now(), text, kind: kind || '' });
  if (S.log.length > LOG_KEEP) S.log.splice(0, S.log.length - LOG_KEEP);
  appendLog(S.log[S.log.length - 1]);
}
function appendLog(l) {
  const box = $('log'), el = document.createElement('div');
  el.textContent = new Date(l.t).toTimeString().slice(0, 8) + '  ' + l.text;
  if (l.kind) el.className = l.kind;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(el);
  while (box.childNodes.length > LOG_KEEP) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderControls() {
  const on = connected || (DEMO && Demo.running);
  const surveying = $('surveyBar').classList.contains('on');
  $('markBtn').disabled = !on || surveying;
  $('statusBtn').disabled = !on;
  $('cmdBtn').disabled = !on;
  document.querySelectorAll('[data-cmd]').forEach(b => { b.disabled = !on; });
  $('spotName').placeholder = 'Spot name, e.g. trap' + S.nextTrap;
}

function renderSession() {
  const heard = S.pings.filter(p => p.heard).length;
  $('sessionInfo').textContent = `Started ${new Date(S.started).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · ${S.pings.length} pings (${heard} heard) · ${S.spots.length} spots` +
    (S.base ? ` · base set ±${S.base.acc} m` : ' · no base set');
}

function renderAll() { renderScale(); renderLive(); renderSpots(); renderMap(); renderControls(); renderSession(); renderGps(); }

// ------------------------------------------------------------
//  Exports
// ------------------------------------------------------------
function csv(rows, cols) {
  const q = v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => q(r[c])).join(',')).join('\n') + '\n';
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const stamp = () => S.started.slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
const baseCols = s => s.base ? { base_lat: S.base.lat, base_lon: S.base.lon } : {};

function exportPings() {
  const rows = S.pings.map(p => Object.assign({}, p, { dist_m: S.base && p.lat != null ? Math.round(distanceM(S.base, p)) : null }));
  download(`ranger_pings_${stamp()}.csv`, csv(rows, ['t', 'seq', 'heard', 'snr', 'rssi', 'verdict', 'spot', 'lat', 'lon', 'acc', 'dist_m']), 'text/csv');
}
function exportSpots() {
  const rows = S.spots.map(s => Object.assign({}, s, { dist_m: S.base && s.lat != null ? Math.round(distanceM(S.base, s)) : null }));
  download(`ranger_spots_${stamp()}.csv`, csv(rows, ['t', 'name', 'verdict', 'heard', 'sent', 'snrWorst', 'snrAvg', 'lat', 'lon', 'acc', 'dist_m', 'note']), 'text/csv');
}
function exportGeo() {
  const feat = (p, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: props });
  const fs = [];
  if (S.base) fs.push(feat(S.base, { type: 'base', acc: S.base.acc, t: S.base.t }));
  S.spots.filter(s => s.lat != null).forEach(s => fs.push(feat(s, Object.assign({ type: 'spot' }, s))));
  S.pings.filter(p => p.lat != null).forEach(p => fs.push(feat(p, Object.assign({ type: 'ping' }, p))));
  download(`ranger_${stamp()}.geojson`, JSON.stringify({ type: 'FeatureCollection', features: fs }), 'application/geo+json');
}

// ------------------------------------------------------------
//  UI wiring
// ------------------------------------------------------------
$('connectBtn').onclick = () => (connected || wantConnected || (DEMO && Demo.running)) ? disconnect() : connect();

$('markBtn').onclick = () => {
  const typed = cleanName($('spotName').value);
  const name = typed || 'trap' + S.nextTrap;
  if (!typed || name === 'trap' + S.nextTrap) S.nextTrap++;
  $('spotName').value = '';
  send('MARK ' + name);
  save();
};
$('spotName').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('markBtn').disabled) $('markBtn').click(); });

$('baseBtn').onclick = () => {
  const f = freshFix();
  if (!f) { toast('No GPS fix yet. Wait for the GPS pill to go green.'); return; }
  if (S.base && !confirm('Move the base to where you are standing now?')) return;
  S.base = { lat: f.lat, lon: f.lon, acc: f.acc, t: new Date(f.t).toISOString() };
  save(true); renderAll(); toast('Base set here (±' + f.acc + ' m)');
};
$('statusBtn').onclick = () => send('STATUS');
$('cmdBtn').onclick = () => { const v = $('cmd').value.trim(); if (v) { send(v); $('cmd').value = ''; } };
$('cmd').addEventListener('keydown', e => { if (e.key === 'Enter') $('cmdBtn').click(); });
document.querySelectorAll('[data-cmd]').forEach(b => { b.onclick = () => send(b.dataset.cmd); });

document.querySelectorAll('nav button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('section.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'map') renderMap();
    if (b.dataset.tab === 'log') { const l = $('log'); l.scrollTop = l.scrollHeight; }
  };
});

$('mapFile').onchange = e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { useMap(JSON.parse(r.result), true); } catch (x) { toast('That file isn\'t a Canopy map'); } };
  r.onerror = () => toast('Could not read that file');
  r.readAsText(f);
};
$('mapClear').onclick = () => {
  if (!confirm('Remove the site map from this phone? Your pings and spots stay.')) return;
  baseMap = null; mapStore(null); renderMapControls(); renderMap();
};
$('exportPings').onclick = exportPings;
$('exportSpots').onclick = exportSpots;
$('exportGeo').onclick = exportGeo;
$('newSession').onclick = () => {
  if (!S.pings.length && !S.spots.length) { S = freshSession(); save(true); renderAll(); return; }
  if (!confirm('Start a new session? The current one is downloaded first (spots CSV, pings CSV, GeoJSON), then cleared from this phone.')) return;
  exportSpots(); exportPings(); exportGeo();
  setTimeout(() => { S = freshSession(); $('log').innerHTML = ''; save(true); renderAll(); toast('New session started'); }, 800);
};

window.addEventListener('resize', () => { renderSpark(); renderMap(); });
setInterval(() => { renderLive(); renderSession(); }, 2000);

let toastTimer = null;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3000); }
function buzz(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* no vibration */ } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------
//  Demo: a fake Ranger walking away from a base. Same line formats as the
//  firmware, fed through the same parser — so it exercises the real path.
// ------------------------------------------------------------
const Demo = {
  running: false, timer: null, seq: 0, step: 0, survey: null, auto: 0,
  base: { lat: 54.2512, lon: -3.0331 },
  start() {
    this.running = true; wantConnected = true; connected = false;
    setBle('Demo', 'warn'); renderControls(); keepAwake();
    if (!S.base) { S.base = Object.assign({ acc: 4, t: new Date().toISOString() }, this.base); }
    onLine('CANOPY RANGER 3.0.0 | 868.000 MHz SF10 | pinging');
    setTimeout(() => this.command('HELP'), 800);
    this.timer = setInterval(() => this.tick(), 5000);   // the real Ranger's pace
  },
  stop() { this.running = false; wantConnected = false; clearInterval(this.timer); setBle('Not connected', ''); renderControls(); },
  pos() {
    // wander north-east, a slow loop out to ~350 m and back
    const a = this.step / 40, r = 30 + 160 * (1 - Math.cos(a));
    return { lat: this.base.lat + (r * Math.sin(a * 1.3)) / 110540, lon: this.base.lon + (r * Math.cos(a)) / (111320 * Math.cos(this.base.lat * Math.PI / 180)) };
  },
  tick() {
    if (!this.survey) this.step += 4;   // keep the demo walk moving at the slower real ping pace
    const p = this.pos();
    onFix({ coords: { latitude: p.lat, longitude: p.lon, accuracy: 4 + Math.random() * 6 } });
    const d = distanceM(this.base, p);
    const snr = Math.round(10 - d * 0.075 + (Math.random() - 0.5) * 6);
    const heard = snr > -16 && Math.random() > (snr < -12 ? 0.4 : 0.03);
    this.seq++;
    const T = S.thresholds, v = snr >= T.good ? 'GOOD' : snr >= T.marginal ? 'MARGINAL' : 'POOR';
    let line = heard ? `#${this.seq}  SNR ${snr >= 0 ? '+' : ''}${snr}  ${v}  (${Math.round(-80 - d * 0.12)} dBm)` : `#${this.seq}  no reply`;
    const sv = this.survey;
    if (sv) {
      line += `  [${sv.name} ${sv.sent + 1}/10]`;
      sv.sent++; if (heard) { sv.heard++; sv.snrs.push(snr); }
    }
    onLine(line);
    if (sv && sv.sent >= 10) {
      this.survey = null;
      if (!sv.heard) { onLine(`== ${sv.name}: NO LINK — 0/10 heard`); return; }
      const worst = Math.min(...sv.snrs), avg = Math.round(sv.snrs.reduce((a, b) => a + b, 0) / sv.snrs.length);
      const T = S.thresholds;
      let verdict = worst >= T.good ? 'GOOD' : worst >= T.marginal ? 'MARGINAL' : 'POOR';
      if (sv.heard * 2 < sv.sent) verdict = 'POOR'; else if (sv.heard < sv.sent && verdict === 'GOOD') verdict = 'MARGINAL';
      onLine(`== ${sv.name}: ${verdict} — ${sv.heard}/${sv.sent} heard, worst SNR ${worst >= 0 ? '+' : ''}${worst}, average ${avg >= 0 ? '+' : ''}${avg}`);
    }
  },
  command(cmd) {
    const [verb, ...rest] = cmd.trim().split(/\s+/);
    const V = verb.toUpperCase();
    if (V === 'MARK') {
      if (this.survey) { onLine('! already surveying — wait for the summary'); return; }
      const name = rest.join(' ') || 'SPOT_' + (++this.auto);
      this.survey = { name, sent: 0, heard: 0, snrs: [] };
      onLine(`>> Surveying ${name} — hold still, 10 pings (~50 s)`);
    } else if (V === 'STATUS') {
      onLine(`868.000 MHz SF10 22 dBm | pinging | heard ${this.seq}/${this.seq} | spots 0 | batt 3.96 V`);
    } else {
      onLine('MARK [name] | LIST | CLEAR | STOP | START | STATUS');
      onLine('SNR -5 or better GOOD, -10 to -5 MARGINAL, below -10 POOR');
    }
  },
};

// ------------------------------------------------------------
//  Boot
// ------------------------------------------------------------
if (DEMO) { $('demoBanner').style.display = 'block'; $('connectBtn').textContent = 'Start demo'; }
S.log.forEach(appendLog);
if (S.pings.length) lastPingAt = 0;   // restored data shows as stale until live pings arrive
startGps();
renderAll();
mapRestore();
if (DEMO) window.useMap = useMap;   // lets a test load a map pack from the console
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // A new version activates and takes over straight away; reload once so the
  // page runs it, but never on the very first install (no previous controller).
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) { save(true); location.reload(); } });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
