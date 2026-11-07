'use strict';
/* ReefLens – live color-corrected aquarium camera, time-lapse projects, presets. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtDate = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ---------- storage (IndexedDB: meta+thumb in "media", full file in "blobs") ---------- */
const DB = (() => {
  let db;
  const open = () => db ? Promise.resolve(db) : new Promise((res, rej) => {
    const r = indexedDB.open('reeflens', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('media', { keyPath: 'id' });
      d.createObjectStore('blobs', { keyPath: 'id' });
      d.createObjectStore('projects', { keyPath: 'id' });
    };
    r.onsuccess = () => { db = r.result; res(db); };
    r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r && r.result);
      t.onerror = t.onabort = () => rej(t.error);
    });
  };
  return {
    put: (s, v) => tx(s, 'readwrite', o => o.put(v)),
    get: (s, id) => tx(s, 'readonly', o => o.get(id)),
    del: (s, id) => tx(s, 'readwrite', o => o.delete(id)),
    all: s => tx(s, 'readonly', o => o.getAll()),
    clear: s => tx(s, 'readwrite', o => o.clear()),
  };
})();

async function makeThumb(source) {
  const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
  const k = 256 / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
}

async function saveMedia({ kind, blob, thumb, w, h, projectId }) {
  const id = uid();
  const rec = { id, kind, created: Date.now(), w, h, type: blob.type, size: blob.size, thumb, projectId: projectId || null };
  await DB.put('blobs', { id, blob });
  await DB.put('media', rec);
  try { navigator.storage?.persist?.(); } catch {}
  return rec;
}

async function deleteMedia(id) {
  await DB.del('media', id); await DB.del('blobs', id);
  for (const p of await DB.all('projects')) {
    if (p.shots.includes(id) || p.refId === id) {
      p.shots = p.shots.filter(s => s !== id);
      if (p.refId === id) p.refId = p.shots[0] || null;
      await DB.put('projects', p);
      if (activeProject && activeProject.id === p.id) { activeProject = p; await syncProjectUI(); }
    }
  }
}

/* ---------- state ---------- */
const DEF_ADJ = { auto: false, temp: 0, tint: 0, r: 0, g: 0, b: 0, gelHue: 30, gelInt: 0, ev: 0, contrast: 0, sat: 0, zoom: 1 };
const adj = { ...DEF_ADJ, ...load('rl.adj', {}) };
const settings = { res: '1080', q: 92, grid: false, hist: false, split: false, wake: true, refOpacity: 40, ...load('rl.settings', {}) };
const persistAdj = () => save('rl.adj', adj);
const persistSettings = () => save('rl.settings', settings);

let presets = load('rl.presets', null);
if (!presets) {
  presets = [
    { name: 'Blue light – strong', adj: { r: 60, g: 20, b: -20, ev: 0.2 } },
    { name: 'Blue light – mild', adj: { r: 35, g: 10, b: -10 } },
  ];
  save('rl.presets', presets);
}

let mode = 'photo';
let camActive = false, stream = null, currentDeviceId = null;
let autoG = [1, 1, 1];
let rec = null; // active video recording
let activeProject = null;
let wakeLock = null;

/* ---------- WebGL color pipeline ---------- */
const video = document.createElement('video');
video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;

const glc = $('#gl');
const gl = glc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false }) ||
           glc.getContext('experimental-webgl', { preserveDrawingBuffer: true });
let U = {};
if (gl) {
  const vs = `attribute vec2 p; varying vec2 v; void main(){ v=p*.5+.5; gl_Position=vec4(p,0.,1.); }`;
  const fs = `precision highp float; varying vec2 v; uniform sampler2D tex;
    uniform vec3 gain; uniform vec3 gel; uniform float ev, contrast, sat, zoom, splitX, splitOn;
    void main(){
      vec2 uv = (v-.5)/zoom+.5;
      vec3 raw = texture2D(tex, uv).rgb;
      if(splitOn>.5 && v.x<splitX){ gl_FragColor=vec4(raw,1.); return; }
      vec3 c = pow(raw, vec3(2.2));
      c *= gain*gel*exp2(ev);
      c = pow(clamp(c,0.,1.), vec3(1./2.2));
      float l = dot(c, vec3(.2126,.7152,.0722));
      c = mix(vec3(l), c, 1.+sat);
      c = (c-.5)*(1.+contrast)+.5;
      gl_FragColor = vec4(clamp(c,0.,1.),1.);
    }`;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  for (const n of ['gain', 'gel', 'ev', 'contrast', 'sat', 'zoom', 'splitX', 'splitOn']) U[n] = gl.getUniformLocation(prog, n);
}

function hsv2rgb(h, s, v) {
  const f = n => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
function currentGains() {
  const B = 6;
  let g = [Math.pow(B, adj.r / 100), Math.pow(B, adj.g / 100), Math.pow(B, adj.b / 100)];
  const t = adj.temp / 100; g[0] *= Math.pow(1.6, t); g[2] *= Math.pow(1.6, -t);
  const ti = adj.tint / 100; g[1] *= Math.pow(1.5, -ti); g[0] *= Math.pow(1.5, ti * .5); g[2] *= Math.pow(1.5, ti * .5);
  if (adj.auto) g = g.map((x, i) => x * autoG[i]);
  return g;
}
function gelRGB() {
  const [r, g, b] = hsv2rgb(adj.gelHue / 360, 1, 1), k = adj.gelInt / 100 * .85;
  return [1 + (r - 1) * k, 1 + (g - 1) * k, 1 + (b - 1) * k];
}

const frameEl = $('#frame');
function draw(clean) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!gl || !vw) return false;
  if (glc.width !== vw || glc.height !== vh) {
    glc.width = vw; glc.height = vh; gl.viewport(0, 0, vw, vh);
    frameEl.style.aspectRatio = vw + ' / ' + vh;
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  const g = currentGains(), gel = gelRGB();
  gl.uniform3f(U.gain, g[0], g[1], g[2]);
  gl.uniform3f(U.gel, gel[0], gel[1], gel[2]);
  gl.uniform1f(U.ev, adj.ev);
  gl.uniform1f(U.contrast, adj.contrast / 100);
  gl.uniform1f(U.sat, adj.sat / 100);
  gl.uniform1f(U.zoom, adj.zoom);
  gl.uniform1f(U.splitX, splitX);
  gl.uniform1f(U.splitOn, (settings.split && !clean && !rec) ? 1 : 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return true;
}

/* auto color: gray-world on a tiny sample of the RAW frame, smoothed over time */
const sc = document.createElement('canvas'); sc.width = 48; sc.height = 27;
const sctx = sc.getContext('2d', { willReadFrequently: true });
function sampleAuto() {
  sctx.drawImage(video, 0, 0, 48, 27);
  const d = sctx.getImageData(0, 0, 48, 27).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 765;
    if (l < .03 || l > .97) continue;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  if (!n) return;
  r /= n; g /= n; b /= n;
  const gray = (r + g + b) / 3;
  let t = [gray / Math.max(r, 1), gray / Math.max(g, 1), gray / Math.max(b, 1)].map(x => clamp(x, .4, 5));
  const gm = Math.cbrt(t[0] * t[1] * t[2]);
  t = t.map(x => x / gm);
  autoG = autoG.map((x, i) => x + (t[i] - x) * .2);
}

/* histogram of the corrected output */
const hc = document.createElement('canvas'); hc.width = 64; hc.height = 36;
const hctx = hc.getContext('2d', { willReadFrequently: true });
const hist = $('#hist'), hg = hist.getContext('2d');
function drawHist() {
  hctx.drawImage(glc, 0, 0, 64, 36);
  const d = hctx.getImageData(0, 0, 64, 36).data;
  const bins = [new Float32Array(32), new Float32Array(32), new Float32Array(32)];
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) bins[c][d[i + c] >> 3]++;
  const mx = Math.max(...bins.flatMap(b => [...b]), 1);
  hg.clearRect(0, 0, hist.width, hist.height);
  hg.globalCompositeOperation = 'lighter';
  const cols = ['#e03030', '#30e030', '#3070ff'];
  for (let c = 0; c < 3; c++) {
    hg.fillStyle = cols[c];
    for (let i = 0; i < 32; i++) {
      const h = Math.sqrt(bins[c][i] / mx) * (hist.height - 4);
      hg.fillRect(2 + i * 4, hist.height - 2 - h, 3, h);
    }
  }
  hg.globalCompositeOperation = 'source-over';
}

/* ---------- render loop ---------- */
let fcount = 0, splitX = 0.5;
let recCanvas, recCtx;
function loop() {
  requestAnimationFrame(loop);
  if (!camActive || document.hidden || video.readyState < 2) return;
  if (!draw(false)) return;
  fcount++;
  if (fcount % 5 === 0) {
    if (adj.auto) sampleAuto();
    if (settings.hist && fcount % 10 === 0) drawHist();
  }
  if (rec) {
    recCtx.drawImage(glc, 0, 0, recCanvas.width, recCanvas.height);
    $('#recTime').textContent = fmtDur((Date.now() - rec.start) / 1000);
  }
}
const fmtDur = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
requestAnimationFrame(loop);

/* ---------- camera ---------- */
async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) return camMessage('This browser cannot access the camera. Open the app in Safari over https.');
  stopCamera(true);
  const dims = settings.res === '4k' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 };
  const base = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...base, width: { ideal: dims.w }, height: { ideal: dims.h }, frameRate: { ideal: 30 } },
    });
  } catch (e) {
    return camMessage(e && e.name === 'NotAllowedError'
      ? 'Camera permission is off. In iPhone Settings > Safari > Camera (or Settings > ReefLens), allow the camera, then tap Start.'
      : 'Could not start the camera: ' + (e && e.message || e));
  }
  video.srcObject = stream;
  try { await video.play(); } catch {}
  const s = stream.getVideoTracks()[0].getSettings();
  currentDeviceId = s.deviceId || deviceId || null;
  camActive = true;
  $('#camMsg').hidden = true;
  await refreshLenses();
  requestWake();
}
function stopCamera(keepUI) {
  camActive = false;
  if (rec) stopRecording();
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; video.srcObject = null;
  releaseWake();
}
function camMessage(text) {
  $('#camMsgText').textContent = text; $('#camMsg').hidden = false; camActive = false;
}
$('#camStart').onclick = () => startCamera(currentDeviceId);

async function refreshLenses() {
  const box = $('#lenses'); box.innerHTML = '';
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch {}
  const pick = new Map();
  for (const d of devs) {
    const lab = d.label || '';
    let key = '1×';
    if (/ultra/i.test(lab)) key = '0.5×';
    else if (/tele/i.test(lab)) key = 'Tele';
    else if (/front|user|selfie/i.test(lab)) key = 'Front';
    else if (/dual|triple/i.test(lab) && pick.has('1×')) continue;
    if (!pick.has(key) || /^back camera$/i.test(lab)) pick.set(key, d);
  }
  if (pick.size < 2) { box.hidden = true; return; }
  box.hidden = false;
  for (const key of ['0.5×', '1×', 'Tele', 'Front']) {
    const d = pick.get(key); if (!d) continue;
    const b = document.createElement('button');
    b.className = 'chip' + (d.deviceId === currentDeviceId ? ' active' : '');
    b.textContent = key;
    b.onclick = () => startCamera(d.deviceId);
    box.appendChild(b);
  }
}

/* keep screen awake while shooting */
async function requestWake() {
  if (!settings.wake || !('wakeLock' in navigator) || !camActive) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (currentView === 'camera') {
    const t = stream && stream.getVideoTracks()[0];
    if (!t || t.readyState !== 'live') startCamera(currentDeviceId); else requestWake();
  }
});

/* ---------- capture ---------- */
function flashEffect() { const f = $('#flash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 60); }

async function takePhoto() {
  if (!camActive || !draw(true)) return toast('Camera not ready');
  const blob = await new Promise(r => glc.toBlob(r, 'image/jpeg', settings.q / 100));
  const thumb = await makeThumb(glc);
  flashEffect();
  const recd = await saveMedia({ kind: 'photo', blob, thumb, w: glc.width, h: glc.height, projectId: activeProject && activeProject.id });
  if (activeProject) {
    activeProject.shots.push(recd.id);
    if (!activeProject.refId) activeProject.refId = recd.id;
    await DB.put('projects', activeProject);
    await syncProjectUI();
  }
  setLastThumb(recd);
  toast(activeProject ? 'Added to ' + activeProject.name : 'Saved to gallery');
}

function pickMime() {
  const list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
async function startRecording() {
  if (!camActive) return toast('Camera not ready');
  if (!window.MediaRecorder) return toast('Video recording is not supported here');
  recCanvas = document.createElement('canvas'); recCanvas.width = glc.width; recCanvas.height = glc.height;
  recCtx = recCanvas.getContext('2d');
  recCtx.drawImage(glc, 0, 0);
  const mimeType = pickMime();
  const out = recCanvas.captureStream(30);
  const mr = new MediaRecorder(out, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: settings.res === '4k' ? 30e6 : 12e6 });
  const chunks = [];
  mr.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    const blob = new Blob(chunks, { type: mr.mimeType || mimeType || 'video/mp4' });
    const thumb = await makeThumb(recCanvas);
    const r = await saveMedia({ kind: 'video', blob, thumb, w: recCanvas.width, h: recCanvas.height, projectId: null });
    setLastThumb(r); toast('Video saved to gallery');
  };
  rec = { mr, start: Date.now() };
  mr.start(1000);
  $('#rec').hidden = false; $('#shutter').classList.add('recording');
}
function stopRecording() {
  if (!rec) return;
  const r = rec; rec = null;
  try { r.mr.stop(); } catch {}
  $('#rec').hidden = true; $('#shutter').classList.remove('recording');
}
$('#shutter').onclick = () => {
  if (mode === 'photo') takePhoto();
  else if (rec) stopRecording(); else startRecording();
};
$('#modeBtn').onclick = () => {
  if (rec) return;
  mode = mode === 'photo' ? 'video' : 'photo';
  $('#modeBtn').textContent = mode === 'photo' ? 'Photo' : 'Video';
  $('#shutter').classList.toggle('video', mode === 'video');
};

let lastThumbUrl;
function setLastThumb(r) {
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = r ? URL.createObjectURL(r.thumb) : null;
  $('#lastThumb').style.backgroundImage = lastThumbUrl ? `url(${lastThumbUrl})` : '';
  $('#lastThumb').dataset.id = r ? r.id : '';
}
$('#lastThumb').onclick = async () => {
  const all = (await DB.all('media')).sort((a, b) => b.created - a.created);
  if (all.length) openViewer(all, 0);
};

/* ---------- toggles ---------- */
function syncToggles() {
  $('#tAuto').classList.toggle('active', adj.auto);
  $('#tSplit').classList.toggle('active', settings.split);
  $('#tGrid').classList.toggle('active', settings.grid);
  $('#tHist').classList.toggle('active', settings.hist);
  $('#grid').hidden = !settings.grid;
  $('#hist').hidden = !settings.hist;
  $('#splitline').hidden = !settings.split;
  $('#splitline').style.left = (splitX * 100) + '%';
  $('#bAuto').textContent = 'Auto: ' + (adj.auto ? 'on' : 'off');
  $('#bAuto').classList.toggle('primary', adj.auto);
}
$('#tAuto').onclick = $('#bAuto').onclick = () => { adj.auto = !adj.auto; persistAdj(); syncToggles(); };
$('#tSplit').onclick = () => { settings.split = !settings.split; persistSettings(); syncToggles(); };
$('#tGrid').onclick = () => { settings.grid = !settings.grid; persistSettings(); syncToggles(); };
$('#tHist').onclick = () => { settings.hist = !settings.hist; persistSettings(); syncToggles(); if (settings.hist) drawHist(); };

// drag the split divider (anywhere on the frame while split is on)
{
  let drag = false;
  const move = e => {
    const r = frameEl.getBoundingClientRect();
    splitX = clamp((e.clientX - r.left) / r.width, 0.02, 0.98);
    $('#splitline').style.left = (splitX * 100) + '%';
  };
  frameEl.addEventListener('pointerdown', e => { if (!settings.split || e.target.closest('.mk')) return; drag = true; frameEl.setPointerCapture(e.pointerId); move(e); });
  frameEl.addEventListener('pointermove', e => { if (drag) move(e); });
  frameEl.addEventListener('pointerup', () => drag = false);
  frameEl.addEventListener('pointercancel', () => drag = false);
}

/* ---------- adjust sheet ---------- */
const SLIDERS = [
  { grp: 'color', key: 'temp', label: 'Temperature', min: -100, max: 100, step: 1 },
  { grp: 'color', key: 'tint', label: 'Tint', min: -100, max: 100, step: 1 },
  { grp: 'color', key: 'r', label: 'Red', min: -100, max: 100, step: 1, cls: 'r' },
  { grp: 'color', key: 'g', label: 'Green', min: -100, max: 100, step: 1, cls: 'g' },
  { grp: 'color', key: 'b', label: 'Blue', min: -100, max: 100, step: 1, cls: 'b' },
  { grp: 'color', key: 'gelHue', label: 'Gel color', min: 0, max: 360, step: 1, hue: true },
  { grp: 'color', key: 'gelInt', label: 'Gel strength', min: 0, max: 100, step: 1 },
  { grp: 'light', key: 'ev', label: 'Exposure', min: -2, max: 2, step: .05, fmt: v => (v > 0 ? '+' : '') + (+v).toFixed(2) },
  { grp: 'light', key: 'contrast', label: 'Contrast', min: -50, max: 50, step: 1 },
  { grp: 'light', key: 'sat', label: 'Saturation', min: -50, max: 100, step: 1 },
  { grp: 'light', key: 'zoom', label: 'Zoom', min: 1, max: 5, step: .05, fmt: v => (+v).toFixed(1) + '×' },
];
const sliderEls = {};
function buildSliders() {
  for (const s of SLIDERS) {
    const row = document.createElement('div'); row.className = 'row ' + (s.cls || '');
    const lab = document.createElement('label'); lab.textContent = s.label; lab.title = 'Double-tap to reset';
    const inp = document.createElement('input'); inp.type = 'range';
    inp.min = s.min; inp.max = s.max; inp.step = s.step; if (s.hue) inp.className = 'hue';
    const out = document.createElement('output');
    const show = () => { out.textContent = s.fmt ? s.fmt(adj[s.key]) : (adj[s.key] > 0 && s.min < 0 ? '+' : '') + Math.round(adj[s.key]); };
    inp.oninput = () => { adj[s.key] = +inp.value; show(); persistAdj(); };
    lab.ondblclick = () => { adj[s.key] = DEF_ADJ[s.key]; syncSliders(); persistAdj(); };
    row.append(lab, inp, out); $('#sl-' + s.grp).appendChild(row);
    sliderEls[s.key] = { inp, show };
  }
}
function syncSliders() { for (const s of SLIDERS) { sliderEls[s.key].inp.value = adj[s.key]; sliderEls[s.key].show(); } syncToggles(); }
buildSliders(); syncSliders();

$('#adjBtn').onclick = () => { const sh = $('#sheet'); sh.hidden = !sh.hidden; $('#adjBtn').classList.toggle('active', !sh.hidden); };
$$('#sheetTabs button').forEach(b => b.onclick = () => {
  $$('#sheetTabs button').forEach(x => x.classList.toggle('active', x === b));
  for (const n of ['color', 'light', 'presets']) $('#pane-' + n).hidden = n !== b.dataset.sheet;
});
$('#bLock').onclick = () => {
  // fold the current automatic gains into the manual R/G/B sliders, then turn auto off
  const f = x => clamp(Math.round(Math.log(x) / Math.log(6) * 100), -100, 100);
  adj.r = clamp(adj.r + f(autoG[0]), -100, 100); adj.g = clamp(adj.g + f(autoG[1]), -100, 100); adj.b = clamp(adj.b + f(autoG[2]), -100, 100);
  adj.auto = false; autoG = [1, 1, 1]; syncSliders(); persistAdj(); toast('Auto locked into R / G / B');
};
$('#bReset').onclick = () => { Object.assign(adj, DEF_ADJ, { zoom: adj.zoom }); autoG = [1, 1, 1]; syncSliders(); persistAdj(); };

/* presets */
function renderPresets() {
  const box = $('#presetList'); box.innerHTML = '';
  presets.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'preset';
    const n = document.createElement('button'); n.className = 'name'; n.textContent = p.name;
    n.onclick = () => {
      Object.assign(adj, DEF_ADJ, { zoom: adj.zoom }, p.adj, { auto: false }); autoG = [1, 1, 1];
      syncSliders(); persistAdj(); toast('Applied: ' + p.name);
    };
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '✕';
    x.onclick = () => { presets.splice(i, 1); save('rl.presets', presets); renderPresets(); };
    d.append(n, x); box.appendChild(d);
  });
}
$('#presetSave').onclick = () => {
  const name = $('#presetName').value.trim(); if (!name) return toast('Name your preset first');
  const keep = {}; for (const k of ['temp', 'tint', 'r', 'g', 'b', 'gelHue', 'gelInt', 'ev', 'contrast', 'sat']) keep[k] = adj[k];
  // if auto is on, bake it in so the preset reproduces what you see
  if (adj.auto) { const f = x => clamp(Math.round(Math.log(x) / Math.log(6) * 100), -100, 100); keep.r = clamp(keep.r + f(autoG[0]), -100, 100); keep.g = clamp(keep.g + f(autoG[1]), -100, 100); keep.b = clamp(keep.b + f(autoG[2]), -100, 100); }
  const i = presets.findIndex(p => p.name === name);
  if (i >= 0) presets[i] = { name, adj: keep }; else presets.push({ name, adj: keep });
  save('rl.presets', presets); renderPresets(); $('#presetName').value = ''; toast('Preset saved');
};
$('#presetShare').onclick = async () => {
  const json = JSON.stringify({ reeflens: 1, presets });
  try { if (navigator.share) { await navigator.share({ text: json }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(json); toast('Presets copied'); } catch { toast('Could not copy'); }
};
$('#presetImport').onclick = async () => {
  const txt = await askText('Import presets', 'Paste presets text here', '', true);
  if (txt == null) return;
  try {
    const j = JSON.parse(txt); const list = j.presets || (Array.isArray(j) ? j : null);
    if (!list) throw 0;
    let n = 0;
    for (const p of list) if (p && p.name && p.adj) { const i = presets.findIndex(x => x.name === p.name); if (i >= 0) presets[i] = p; else presets.push(p); n++; }
    save('rl.presets', presets); renderPresets(); toast('Imported ' + n + ' preset(s)');
  } catch { toast('That is not valid preset text'); }
};
renderPresets();

/* ---------- modal helper ---------- */
function askText(title, placeholder, def, multiline) {
  return new Promise(res => {
    $('#mTitle').textContent = title;
    const el = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) el.type = 'text';
    el.placeholder = placeholder || ''; el.value = def || '';
    $('#mBody').replaceChildren(el);
    $('#modal').hidden = false; setTimeout(() => el.focus(), 50);
    const done = v => { $('#modal').hidden = true; $('#modalForm').onsubmit = null; $('#mCancel').onclick = null; res(v); };
    $('#modalForm').onsubmit = e => { e.preventDefault(); done(el.value); };
    $('#mCancel').onclick = () => done(null);
  });
}
function askConfirm(title, text, okLabel) {
  return new Promise(res => {
    $('#mTitle').textContent = title;
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = text;
    $('#mBody').replaceChildren(p); $('#mOk').textContent = okLabel || 'OK';
    $('#modal').hidden = false;
    const done = v => { $('#modal').hidden = true; $('#mOk').textContent = 'OK'; $('#modalForm').onsubmit = null; $('#mCancel').onclick = null; res(v); };
    $('#modalForm').onsubmit = e => { e.preventDefault(); done(true); };
    $('#mCancel').onclick = () => done(false);
  });
}

/* ---------- views / tabs ---------- */
let currentView = 'camera';
function showView(name) {
  const prev = currentView; currentView = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'camera') { if (!camActive) startCamera(currentDeviceId); }
  else if (prev === 'camera') stopCamera();
  if (name === 'gallery') renderGallery();
  if (name === 'projects') { $('#projDetail').hidden = true; $('#projList').hidden = false; renderProjects(); }
  if (name === 'settings') renderSettings();
}
$$('#tabs button').forEach(b => b.onclick = () => showView(b.dataset.view));

/* ---------- gallery + viewer ---------- */
let galFilter = 'all';
$$('#galFilter button').forEach(b => b.onclick = () => {
  galFilter = b.dataset.f; $$('#galFilter button').forEach(x => x.classList.toggle('active', x === b)); renderGallery();
});
const thumbUrls = [];
function clearThumbUrls() { while (thumbUrls.length) URL.revokeObjectURL(thumbUrls.pop()); }
function thumbButton(r, onclick, extra) {
  const b = document.createElement('button');
  const u = URL.createObjectURL(r.thumb); thumbUrls.push(u);
  b.style.backgroundImage = `url(${u})`;
  if (r.kind === 'video') { const s = document.createElement('span'); s.className = 'badge'; s.textContent = '▶'; b.appendChild(s); }
  if (extra) b.appendChild(extra);
  b.onclick = onclick; return b;
}
async function renderGallery() {
  clearThumbUrls();
  let all = (await DB.all('media')).sort((a, b) => b.created - a.created);
  if (galFilter !== 'all') all = all.filter(r => r.kind === galFilter);
  const g = $('#galGrid'); g.replaceChildren();
  $('#galEmpty').hidden = all.length > 0;
  all.forEach((r, i) => g.appendChild(thumbButton(r, () => openViewer(all, i))));
}

let vList = [], vIdx = 0, vUrl = null, vCtx = null;
async function openViewer(list, idx, ctx) {
  vList = list; vIdx = idx; vCtx = ctx || null; $('#viewer').hidden = false; await showViewerItem();
}
async function showViewerItem() {
  const r = vList[vIdx]; if (!r) return closeViewer();
  if (vUrl) URL.revokeObjectURL(vUrl);
  const row = await DB.get('blobs', r.id); if (!row) return;
  vUrl = URL.createObjectURL(row.blob);
  const el = document.createElement(r.kind === 'video' ? 'video' : 'img');
  el.src = vUrl;
  if (r.kind === 'video') { el.controls = true; el.playsInline = true; el.loop = true; }
  $('#vBody').replaceChildren(el);
  $('#vInfo').textContent = `${vIdx + 1} / ${vList.length} · ${fmtDate(r.created)} · ${r.w}×${r.h} · ${(r.size / 1048576).toFixed(1)} MB`;
  $('#vPrev').disabled = vIdx <= 0; $('#vNext').disabled = vIdx >= vList.length - 1;
  $('#vRef').hidden = !(vCtx && vCtx.project && r.kind === 'photo');
}
function closeViewer() {
  $('#viewer').hidden = true; $('#vBody').replaceChildren();
  if (vUrl) { URL.revokeObjectURL(vUrl); vUrl = null; }
  if (currentView === 'gallery') renderGallery();
  if (currentView === 'projects') renderProjects();
}
$('#vClose').onclick = closeViewer;
$('#vPrev').onclick = () => { if (vIdx > 0) { vIdx--; showViewerItem(); } };
$('#vNext').onclick = () => { if (vIdx < vList.length - 1) { vIdx++; showViewerItem(); } };
$('#vDel').onclick = async () => {
  const r = vList[vIdx];
  if (!await askConfirm('Delete this ' + r.kind + '?', 'This cannot be undone.', 'Delete')) return;
  await deleteMedia(r.id); vList.splice(vIdx, 1);
  if (!vList.length) return closeViewer();
  vIdx = Math.min(vIdx, vList.length - 1); showViewerItem();
  if (vCtx && vCtx.project) { vCtx.project = await DB.get('projects', vCtx.project.id); }
};
$('#vRef').onclick = async () => {
  const p = vCtx.project; p.refId = vList[vIdx].id; await DB.put('projects', p);
  if (activeProject && activeProject.id === p.id) { activeProject = p; await syncProjectUI(); }
  toast('Reference image set');
};
async function shareMedia(r) {
  const row = await DB.get('blobs', r.id); if (!row) return;
  const ext = r.kind === 'video' ? (r.type.includes('mp4') ? 'mp4' : 'webm') : 'jpg';
  const file = new File([row.blob], `reeflens-${new Date(r.created).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type: row.blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  toast('Downloaded');
}
$('#vShare').onclick = () => shareMedia(vList[vIdx]);

/* ---------- time-lapse projects ---------- */
async function renderProjects() {
  clearThumbUrls();
  const list = (await DB.all('projects')).sort((a, b) => b.created - a.created);
  $('#projEmpty').hidden = list.length > 0;
  const box = $('#projCards'); box.replaceChildren();
  for (const p of list) {
    const b = document.createElement('button'); b.className = 'pcard';
    const cover = p.refId ? await DB.get('media', p.refId) : null;
    const c = document.createElement('div'); c.className = 'pc';
    if (cover) { const u = URL.createObjectURL(cover.thumb); thumbUrls.push(u); c.style.backgroundImage = `url(${u})`; }
    const t = document.createElement('div');
    t.innerHTML = '<b></b><span class="muted"></span>';
    t.firstChild.textContent = p.name;
    t.lastChild.textContent = `${p.shots.length} shot${p.shots.length === 1 ? '' : 's'} · started ${fmtDate(p.created)}`;
    b.append(c, t); b.onclick = () => openProject(p.id); box.appendChild(b);
  }
}
$('#newProject').onclick = async () => {
  const name = (await askText('New time-lapse project', 'e.g. Frag rack growth', ''))?.trim(); if (!name) return;
  const p = { id: uid(), name, created: Date.now(), shots: [], refId: null, markers: [] };
  await DB.put('projects', p); openProject(p.id);
};
let openProj = null;
async function openProject(id) {
  openProj = await DB.get('projects', id); if (!openProj) return;
  $('#projList').hidden = true; $('#projDetail').hidden = false; await renderProjectDetail();
}
async function renderProjectDetail() {
  clearThumbUrls();
  const p = openProj = await DB.get('projects', openProj.id);
  $('#pdTitle').textContent = p.name;
  $('#pdInfo').textContent = p.shots.length ? `${p.shots.length} shots · the starred one is the reference ghost shown when you shoot.` : 'No shots yet. Tap Shoot, line up the view, and capture. The first shot becomes the reference.';
  const metas = (await Promise.all(p.shots.map(id => DB.get('media', id)))).filter(Boolean);
  const g = $('#pdThumbs'); g.replaceChildren();
  metas.forEach((r, i) => {
    let star; if (p.refId === r.id) { star = document.createElement('span'); star.className = 'star'; star.textContent = '★'; }
    g.appendChild(thumbButton(r, () => openViewer(metas, i, { project: p }), star));
  });
}
$('#pdBack').onclick = () => { $('#projDetail').hidden = true; $('#projList').hidden = false; renderProjects(); };
$('#pdShoot').onclick = async () => { activeProject = await DB.get('projects', openProj.id); await syncProjectUI(); showView('camera'); };
$('#pdRename').onclick = async () => {
  const n = (await askText('Rename project', '', openProj.name))?.trim(); if (!n) return;
  const p = await DB.get('projects', openProj.id); p.name = n; await DB.put('projects', p);
  if (activeProject && activeProject.id === p.id) { activeProject = p; await syncProjectUI(); }
  renderProjectDetail();
};
$('#pdDelete').onclick = async () => {
  const p = openProj;
  if (!await askConfirm('Delete project?', `Deletes "${p.name}" and its ${p.shots.length} shots from this app.`, 'Delete')) return;
  for (const id of p.shots) await DB.del('media', id), await DB.del('blobs', id);
  await DB.del('projects', p.id);
  if (activeProject && activeProject.id === p.id) { activeProject = null; await syncProjectUI(); }
  $('#pdBack').onclick();
};

/* camera-side project controls */
let refUrl = null;
async function syncProjectUI() {
  const p = activeProject;
  $('#projbar').hidden = !p;
  if (refUrl) { URL.revokeObjectURL(refUrl); refUrl = null; }
  const img = $('#ref');
  if (p && p.refId && settings.showRef !== false) {
    const row = await DB.get('blobs', p.refId);
    if (row) { refUrl = URL.createObjectURL(row.blob); img.src = refUrl; img.hidden = false; }
  } else img.hidden = true;
  if (p) { $('#projName').textContent = p.name; $('#pOpacity').value = settings.refOpacity; img.style.opacity = settings.refOpacity / 100; $('#pRef').classList.toggle('active', settings.showRef !== false); }
  renderMarkers();
}
$('#pOpacity').oninput = e => { settings.refOpacity = +e.target.value; $('#ref').style.opacity = settings.refOpacity / 100; persistSettings(); };
$('#pRef').onclick = () => { settings.showRef = settings.showRef === false; persistSettings(); syncProjectUI(); };
$('#pClose').onclick = () => { activeProject = null; syncProjectUI(); };
$('#pMark').onclick = async () => {
  if (!activeProject) return;
  const n = activeProject.markers.length; if (n >= 6) return toast('6 markers max');
  activeProject.markers.push({ x: 0.5 + (n % 3 - 1) * 0.15, y: 0.5 + (Math.floor(n / 3) - 0.5) * 0.2 });
  await DB.put('projects', activeProject); renderMarkers();
};
$('#pClear').onclick = async () => { if (!activeProject) return; activeProject.markers = []; await DB.put('projects', activeProject); renderMarkers(); };
function renderMarkers() {
  const box = $('#markers'); box.replaceChildren();
  if (!activeProject) return;
  activeProject.markers.forEach(m => {
    const d = document.createElement('div'); d.className = 'mk'; d.style.left = m.x * 100 + '%'; d.style.top = m.y * 100 + '%';
    let drag = false;
    d.addEventListener('pointerdown', e => { drag = true; d.setPointerCapture(e.pointerId); e.preventDefault(); });
    d.addEventListener('pointermove', e => {
      if (!drag) return; const r = frameEl.getBoundingClientRect();
      m.x = clamp((e.clientX - r.left) / r.width, 0, 1); m.y = clamp((e.clientY - r.top) / r.height, 0, 1);
      d.style.left = m.x * 100 + '%'; d.style.top = m.y * 100 + '%';
    });
    const end = async () => { if (drag) { drag = false; await DB.put('projects', activeProject); } };
    d.addEventListener('pointerup', end); d.addEventListener('pointercancel', end);
    box.appendChild(d);
  });
}

/* compare first vs latest */
$('#pdCompare').onclick = async () => {
  const p = await DB.get('projects', openProj.id);
  if (p.shots.length < 2) return toast('Need at least two shots');
  const [a, b] = await Promise.all([DB.get('blobs', p.shots[0]), DB.get('blobs', p.shots[p.shots.length - 1])]);
  const [ma, mb] = await Promise.all([DB.get('media', p.shots[0]), DB.get('media', p.shots[p.shots.length - 1])]);
  const ua = URL.createObjectURL(a.blob), ub = URL.createObjectURL(b.blob);
  $('#cA').src = ua; $('#cB').src = ub; $('#cRange').value = 50; setCompare(50);
  $('#cLa').textContent = 'First · ' + fmtDate(ma.created); $('#cLb').textContent = 'Latest · ' + fmtDate(mb.created);
  $('#cInfo').textContent = p.name; $('#compare').hidden = false;
  $('#compare').dataset.urls = ua + ' ' + ub;
};
function setCompare(v) { $('#cB').style.clipPath = `inset(0 0 0 ${v}%)`; $('#cLine').style.left = v + '%'; }
$('#cRange').oninput = e => setCompare(+e.target.value);
$('#cClose').onclick = () => { $('#compare').hidden = true; ($('#compare').dataset.urls || '').split(' ').forEach(u => u && URL.revokeObjectURL(u)); };

/* export time-lapse video */
$('#pdExport').onclick = async () => {
  const p = await DB.get('projects', openProj.id);
  if (p.shots.length < 2) return toast('Need at least two shots');
  if (!window.MediaRecorder) return toast('Video export is not supported here');
  const body = document.createElement('div');
  body.innerHTML = `<label class="muted" style="display:block;margin:8px 0 4px">Seconds per shot</label>
    <input type="range" id="xHold" min="2" max="30" value="8" style="width:100%">
    <div id="xHoldV" style="text-align:right">0.8 s</div>
    <label style="display:flex;gap:10px;align-items:center;margin-top:8px"><input type="checkbox" id="xFade" checked> Smooth crossfades</label>`;
  $('#mTitle').textContent = 'Export time-lapse video'; $('#mBody').replaceChildren(body); $('#mOk').textContent = 'Export';
  $('#modal').hidden = false;
  const hold = body.querySelector('#xHold'); hold.oninput = () => body.querySelector('#xHoldV').textContent = (hold.value / 10).toFixed(1) + ' s';
  const ok = await new Promise(res => {
    $('#modalForm').onsubmit = e => { e.preventDefault(); res(true); };
    $('#mCancel').onclick = () => res(false);
  });
  const holdSec = hold.value / 10, fade = body.querySelector('#xFade').checked;
  $('#modal').hidden = true; $('#mOk').textContent = 'OK'; $('#modalForm').onsubmit = null; $('#mCancel').onclick = null;
  if (!ok) return;
  try { await exportTimelapse(p, holdSec, fade); } catch (e) { toast('Export failed: ' + (e && e.message || e)); }
};
async function exportTimelapse(p, hold, fade) {
  const metas = (await Promise.all(p.shots.map(id => DB.get('media', id)))).filter(Boolean);
  const imgs = [];
  const prog = (i) => toast(`Preparing ${i}/${metas.length}…`);
  for (let i = 0; i < metas.length; i++) { prog(i + 1); imgs.push(await createImageBitmap((await DB.get('blobs', metas[i].id)).blob)); }
  const k = Math.min(1, 1920 / Math.max(imgs[0].width, imgs[0].height));
  const W = Math.round(imgs[0].width * k / 2) * 2, H = Math.round(imgs[0].height * k / 2) * 2;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d');
  const drawImg = (im, a) => {
    cx.globalAlpha = a; const s = Math.max(W / im.width, H / im.height);
    cx.drawImage(im, (W - im.width * s) / 2, (H - im.height * s) / 2, im.width * s, im.height * s);
  };
  const mimeType = pickMime();
  const mr = new MediaRecorder(cv.captureStream(30), { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 10e6 });
  const chunks = []; mr.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
  const done = new Promise(r => mr.onstop = r);
  const total = imgs.length * hold, fadeLen = Math.min(0.5, hold * 0.45);
  mr.start(500);
  releaseWake(); try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  const t0 = performance.now();
  await new Promise(res => {
    const step = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= total) return res();
      const i = Math.min(imgs.length - 1, Math.floor(t / hold)), into = t - i * hold;
      cx.globalAlpha = 1; cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
      drawImg(imgs[i], 1);
      if (fade && i < imgs.length - 1 && into > hold - fadeLen) drawImg(imgs[i + 1], (into - (hold - fadeLen)) / fadeLen);
      cx.globalAlpha = 1;
      toastProgress(Math.round(t / total * 100));
      requestAnimationFrame(step);
    };
    step();
  });
  // hold the last frame briefly so it isn't cut
  cx.globalAlpha = 1; drawImg(imgs[imgs.length - 1], 1);
  await new Promise(r => setTimeout(r, 400));
  mr.stop(); await done; releaseWake();
  imgs.forEach(i => i.close && i.close());
  const blob = new Blob(chunks, { type: mr.mimeType || mimeType || 'video/mp4' });
  const thumb = await makeThumb(cv);
  const r = await saveMedia({ kind: 'video', blob, thumb, w: W, h: H, projectId: null });
  toast('Video saved to gallery'); openViewer([r], 0);
}
let lastProg = -1;
function toastProgress(pct) { if (pct !== lastProg) { lastProg = pct; toast(`Rendering video ${pct}% – keep this screen open`); } }

/* ---------- settings ---------- */
async function renderSettings() {
  $('#setRes').value = settings.res; $('#setQ').value = settings.q; $('#setQVal').textContent = settings.q + '%';
  $('#setWake').checked = settings.wake;
  try {
    const e = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    $('#storInfo').textContent = `Using ${(e.usage / 1048576).toFixed(0)} MB of about ${(e.quota / 1073741824).toFixed(1)} GB available. ${persisted ? 'Protected from automatic cleanup.' : 'Not yet protected from automatic cleanup.'}`;
  } catch { $('#storInfo').textContent = 'Storage info is not available here.'; }
}
$('#setRes').onchange = e => { settings.res = e.target.value; persistSettings(); toast('Applies next time the camera starts'); };
$('#setQ').oninput = e => { settings.q = +e.target.value; $('#setQVal').textContent = settings.q + '%'; persistSettings(); };
$('#setWake').onchange = e => { settings.wake = e.target.checked; persistSettings(); };
$('#storPersist').onclick = async () => { try { const ok = await navigator.storage.persist(); toast(ok ? 'Storage protected' : 'iPhone declined – installing to Home Screen helps'); renderSettings(); } catch { toast('Not supported here'); } };
$('#wipe').onclick = async () => {
  if (!await askConfirm('Delete everything?', 'All photos, videos and projects in this app will be removed. Presets are kept.', 'Delete all')) return;
  await Promise.all(['media', 'blobs', 'projects'].map(s => DB.clear(s)));
  activeProject = null; await syncProjectUI(); setLastThumb(null); toast('All data deleted');
};

/* ---------- boot ---------- */
(async function boot() {
  syncToggles();
  try {
    const all = (await DB.all('media')).sort((a, b) => b.created - a.created);
    if (all[0]) setLastThumb(all[0]);
    const saved = load('rl.activeProject', null);
    if (saved) { activeProject = await DB.get('projects', saved); await syncProjectUI(); }
  } catch {}
  startCamera();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
window.addEventListener('pagehide', () => save('rl.activeProject', activeProject && activeProject.id));
document.addEventListener('visibilitychange', () => { if (document.hidden) save('rl.activeProject', activeProject && activeProject.id); });
