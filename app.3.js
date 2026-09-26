'use strict';

// ===== 配置（照搬荣耀 Cut App：每 0.5 秒一帧）=====
const FRAME = 0.5;            // PER_FRAME_TIME = 500ms
const CELL = 56;              // 缩略图宽度(px)，与 CSS --cell 一致
const THUMB_W = 112, THUMB_H = 132; // 抽帧画布(2x 清晰度)
const MIN_GAP = 0.2;          // 选段最小间隔(秒)

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const fileInput = $('file');
const stage = $('stage');
const preview = $('preview');
const previewWrap = $('previewWrap');
const timeline = $('timeline'), tlInner = $('tlInner'), ruler = $('ruler'), strip = $('strip'), track = $('track');
const maskL = $('maskL'), maskR = $('maskR');
const selBand = $('selBand');
const handleL = $('handleL'), handleR = $('handleR');
const playhead = $('playhead');
const coverBadge = $('coverBadge');
const hint = $('hint');
const btnPlay = $('play'), btnStepB = $('stepB'), btnStepF = $('stepF');
const btnSetCover = $('setCover'), btnExport = $('export');
const p3 = $('p3'), p5 = $('p5'), p10 = $('p10'), pAll = $('pAll');
const presetsBtn = $('presetsBtn'), presetsPop = $('presets');
const dragHint = $('dragHint');
const centerAxis = $('centerAxis');
const fsBtn = $('fsBtn'), fsRect = $('fsRect'), fsCanvas = $('fsCanvas');
const tStart = $('tStart'), tEnd = $('tEnd'), tDur = $('tDur');
const rePick = $('rePick'), workspace = $('workspace'), placeholder = $('placeholder');
const loading = $('loading'), loadingText = $('loadingText');
const exporting = $('exporting'), exText = $('exText'), exBar = $('exBar'), exPct = $('exPct');
const dlWrap = $('dlWrap'), dlLink = $('dlLink'), dlMsg = $('dlMsg'), dlClose = $('dlClose');

const BASE_PPS = CELL / FRAME;   // 56px / 0.5s = 112 px/秒（基础缩放）；胶片条每格 = 0.5s，与 CSS --cell 对齐
let pps = BASE_PPS;              // 当前像素/秒（双指放缩会改变）
let viewStart = 0;              // 视口左边缘对应的时间(秒)；拖动/放缩都围绕它

// ===== 状态 =====
let url = null;
let duration = 0;
let videoW = 0, videoH = 0;
let sel = { start: 0, end: 0 };
let fps = 30;           // 视频真实帧率（探测得到，用于标尺帧刻度）
let _rulerKey = '';     // 标尺去重键：pps/viewStart/fps 未变则不重绘
let playT = 0;          // 播放头时间
let coverT = 0;         // 封面帧时间
let seeker = null;      // 离屏抽帧用
let coverThumbEl = null;
let loadedName = 'livephoto';   // 记录导入文件名（拖拽导入时 fileInput.files 为空，需单独存）

// ===== 工具 =====
function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);   // 只显示到第 N 秒，不显示小数
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function setHint(msg, isErr) {
  hint.textContent = msg || '';
  hint.classList.toggle('err', !!isErr);
}
function contentWidth() { return duration * pps; }
function timeToX(t) { return t * pps; }                 // 内容坐标（视口平移由 tlInner 的 transform 承担）
function xToTime(x) { return Math.min(duration, Math.max(0, x / pps)); }  // x 已相对 #track 左缘（=内容时间 viewStart），无需再加

// 缩放范围：最小=整段刚好铺满视口；最大=单格(0.5s)约铺满视口（即“缩放到 1 帧”可逐帧查看）
function minPps() { return Math.max(8, (timeline.clientWidth || window.innerWidth) / Math.max(0.5, duration)); }
function maxPps() { return Math.max(BASE_PPS * 20, (timeline.clientWidth || window.innerWidth) / FRAME); }
function clampView(v) { const maxS = Math.max(0, duration - (timeline.clientWidth || 0) / pps); return Math.min(maxS, Math.max(0, v)); }
function applyPan() { tlInner.style.transform = 'translateX(' + (-viewStart * pps) + 'px)'; buildRuler(); }
function applyZoom() {
  const cw = pps * FRAME;
  strip.style.width = contentWidth() + 'px';
  Array.from(strip.children).forEach(c => { c.style.flex = '0 0 ' + cw + 'px'; });
  buildRuler();
}

// 主刻度间隔：选一个“巧数”秒数，使主刻度像素间距 >= minPx（放大时回到 1 秒，缩小到 60 秒/分钟级）
function niceStepSeconds(minStep) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 43200];
  for (const s of steps) if (s >= minStep) return s;
  return steps[steps.length - 1];
}

// ===== 探测真实帧率（解析 MP4/MOV 的 moov → vide trak → mdhd.timescale / stts.sampleDelta）=====
function read4(dv, off) { let s = ''; for (let i = 0; i < 4; i++) s += String.fromCharCode(dv.getUint8(off + i)); return s; }
function eachBox(dv, start, end, cb) {
  const e = Math.min(end, dv.byteLength);
  let p = start;
  while (p + 8 <= e) {
    let size = dv.getUint32(p); const type = read4(dv, p + 4); let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); header = 16; }
    else if (size === 0) size = e - p;
    if (size < 8) break;
    cb(type, p + header, size - header, dv);
    p += size;
  }
}
function trakFps(dv, start, size) {
  let hdlr = null, ts = 0, delta = 0;
  eachBox(dv, start, start + size, (t, ps, sz, v) => {
    if (t !== 'mdia') return;
    eachBox(v, ps, ps + sz, (t2, ps2, sz2, v2) => {
      if (t2 === 'hdlr') hdlr = read4(v2, ps2 + 8);
      else if (t2 === 'mdhd') { const ver = v2.getUint8(ps2); ts = ver === 1 ? v2.getUint32(ps2 + 20) : v2.getUint32(ps2 + 12); }
      else if (t2 === 'minf') eachBox(v2, ps2, ps2 + sz2, (t3, ps3, sz3, v3) => {
        if (t3 === 'stbl') eachBox(v3, ps3, ps3 + sz3, (t4, ps4, sz4, v4) => {
          if (t4 === 'stts') { const n = v4.getUint32(ps4 + 4); if (n > 0) delta = v4.getUint32(ps4 + 12); }
        });
      });
    });
  });
  if (hdlr !== 'vide' || !ts || !delta) return null;
  return ts / delta;
}
function parseMp4Fps(dv, len) {
  let moov = null;
  eachBox(dv, 0, len, (t, ps, sz, v) => { if (t === 'moov') moov = { ps, sz, v }; });
  if (!moov) return null;
  let r = null;
  eachBox(moov.v, moov.ps, moov.ps + moov.sz, (t, ps, sz, v) => {
    if (!r && t === 'trak') { const f = trakFps(v, ps, sz); if (f) r = f; }
  });
  return r;
}
async function detectFps(file) {
  try {
    const chunk = 8 * 1024 * 1024, sz = file.size;
    const reads = [file.slice(0, Math.min(chunk, sz)).arrayBuffer()];
    if (sz > chunk) reads.push(file.slice(Math.max(0, sz - chunk)).arrayBuffer());
    const bufs = await Promise.all(reads);
    const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
    for (const b of bufs) {
      const f = parseMp4Fps(new DataView(b), b.byteLength);
      if (!f) continue;
      let best = f, bd = 1e9;
      for (const c of common) { const d = Math.abs(c - f); if (d < bd) { bd = d; best = c; } }
      return bd <= Math.max(0.5, f * 0.03) ? best : f;   // 接近常用帧率则对齐，否则用原始值
    }
  } catch (e) {}
  return null;
}

// ===== 本地持久化（IndexedDB）：导入的视频存本地，刷新网页后自动恢复 =====
// 当前预览用的是 URL.createObjectURL(file) 生成的 blob: 临时链接，只在本页会话有效，
// 刷新即失效。IndexedDB 把文件本体存在浏览器本地（不上传服务器），刷新后重建链接恢复。
const DB_NAME = 'livephoto_web', DB_STORE = 'files';
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function dbSave(file) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put({ name: file.name, type: file.type, blob: file, ts: Date.now() }, 'last');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  }));
}
function dbGet() {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const rq = tx.objectStore(DB_STORE).get('last');
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  }));
}
// 页面加载后：若本地有上次导入的视频，自动恢复（不重新上传，纯本地）
dbGet().then(rec => {
  if (rec && rec.blob && stage.classList.contains('empty')) {
    const f = new File([rec.blob], rec.name || 'video.mp4', { type: rec.type || 'video/mp4' });
    loadFile(f);
  }
}).catch(() => {});

// ===== 加载视频 =====
function loadFile(f) {
  if (!f) return;
  if (!f.type.startsWith('video')) { setHint('请选择视频文件', true); return; }
  loadedName = f.name || 'livephoto';
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(f);
  preview.src = url;
  dbSave(f).catch(() => {});               // 本地持久化：刷新后仍能恢复视频
  stage.classList.remove('empty');
  [btnPlay, btnStepB, btnStepF, btnSetCover, btnExport, p3, p5, p10, pAll, presetsBtn].forEach(b => b.disabled = true);
  showLoading('读取视频中…');
  preview.addEventListener('loadedmetadata', () => {
    duration = preview.duration;
    videoW = preview.videoWidth; videoH = preview.videoHeight;
    fitPreview();                 // 预览框按视频真实比例自适应，杜绝竖屏视频的白色长条
    sel = { start: 0, end: Math.min(3, duration) };   // 默认 3 秒片段
    playT = 0; coverT = 0;
    tDur.textContent = fmt(duration);
    updateReadout();
    buildStrip();                 // 胶片条：先铺占位格
    layout();
    [btnPlay, btnStepB, btnStepF, btnSetCover, btnExport, p3, p5, p10, pAll, presetsBtn].forEach(b => b.disabled = false);
    showLoading('生成胶片条…');
    preview.pause();              // 抽帧期间暂停主预览，避免与主预览抢解码资源导致抽帧卡死
    prefetchVisible();            // 先抽最靠近视口的格，开局不黑
    const finalize = () => {
      hideLoading();
      checkStripSupport();        // 一帧都没抽到 → 提示编码不支持，而非黑条
      playSegment();              // 默认直接播放这 3 秒，作为预览
    };
    const t0 = setTimeout(finalize, 8000);   // 兜底：最多等 8s
    const iv = setInterval(() => {
      if (activeDecodes === 0 && cellQueue.length === 0) { clearTimeout(t0); clearInterval(iv); finalize(); }
    }, 200);
  }, { once: true });
  preview.addEventListener('error', () => { hideLoading(); setHint('无法解码该视频', true); }, { once: true });
  // 探测真实帧率（仅依赖文件字节，解析 moov；不阻塞解码）。得到后刷新标尺帧刻度
  detectFps(f).then(v => { if (v && Math.abs(v - fps) > 0.01) { fps = v; if (duration) buildRuler(); } });
}

fileInput.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  loadFile(f);
});

// 空态：点击整屏任意位置上传；手机上整屏即上传按钮
placeholder.addEventListener('click', () => fileInput.click());
rePick.addEventListener('click', () => fileInput.click());

// 拖拽导入（仅当尚未加载视频时；加载后只响应播放头指针拖动，不弹导入遮罩）
let _dragDepth = 0;
['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, (e) => {
  if (!stage.classList.contains('empty')) return;            // 已有视频：忽略，避免误触导入遮罩
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  _dragDepth++;
  stage.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, (e) => {
  if (!stage.classList.contains('empty')) return;
  if (ev === 'dragleave') { _dragDepth = Math.max(0, _dragDepth - 1); if (_dragDepth > 0) return; }
  e.preventDefault();
  stage.classList.remove('dragover');
  _dragDepth = 0;
}));
document.addEventListener('drop', (e) => {
  if (!stage.classList.contains('empty')) return;            // 已有视频：拖入不替换
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  loadFile(f);
});

// 整页拦截左右滑动，避免手机端触发浏览器“返回/前进”而关掉网页。
// 仅放行纵向滑动（页面纵向滚动），横向一律 preventDefault。
let _touchX = 0, _touchY = 0;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0]; _touchX = t.clientX; _touchY = t.clientY;
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (e.touches && e.touches.length >= 2) return;            // 双指放缩交给时间轴处理，整页不拦截
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const t = e.touches[0];
  const dx = Math.abs(t.clientX - _touchX), dy = Math.abs(t.clientY - _touchY);
  if (dx > dy && dx > 20) e.preventDefault();                  // 横向滑动：整页拦截，避免切走页面
}, { passive: false });

function showLoading(msg) { loadingText.textContent = msg || '加载中…'; loading.hidden = false; }
function hideLoading() { loading.hidden = true; }

// 导出下载弹窗：关闭 / 点遮罩关闭
dlClose.addEventListener('click', () => { dlWrap.hidden = true; });
dlWrap.addEventListener('click', (e) => { if (e.target === dlWrap) dlWrap.hidden = true; });

// 全分辨率抽封面帧（不缩放，避免导出封面模糊）
// 抽封面帧：必须先等视频就绪、seek 后再等“真实呈现帧”才画——否则首次导出时
// seeker 尚未解码，会画出空白/损坏 JPEG，导致相册报“图片已损坏”（第二次才正常）。
function grabCover(v, t) {
  return new Promise((resolve, reject) => {
    const ensureReady = () => new Promise((res, rej) => {
      if (v.readyState >= 1) return res();
      if (!v.src) return rej(new Error('封面视频无 src'));
      v.addEventListener('loadeddata', () => res(), { once: true });
      v.addEventListener('error', () => rej(new Error('封面视频加载失败')), { once: true });
    });
    const waitFrame = () => new Promise((res) => {
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => res());
      else requestAnimationFrame(() => requestAnimationFrame(res));   // 退回：两帧保呈现
    });
    const draw = () => {
      const vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) { requestAnimationFrame(() => waitFrame().then(draw).catch(reject)); return; }
      const c = document.createElement('canvas');
      c.width = vw; c.height = vh;
      c.getContext('2d').drawImage(v, 0, 0, vw, vh);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    ensureReady().then(() => {
      const target = Math.min(t, Math.max(0, (v.duration || t) - 0.001));
      if (Math.abs(v.currentTime - target) < 1e-3) { waitFrame().then(draw); return; }
      v.onseeked = () => waitFrame().then(draw);
      v.currentTime = target;
    }).catch(reject);
  });
}

// 预览框尺寸：按视频真实宽高比“贴合”可用区域，箱体比例 == 视频比例 → 永不出现 letterbox 白条/黑条；
// 同时限制高度（约半屏），保证下方时间轴始终可见（竖屏视频不会把时间轴顶出屏幕）。
function fitPreview() {
  if (!videoW || !videoH) return;
  const availW = Math.max(120, (workspace.clientWidth || window.innerWidth) - 24);
  const availH = Math.max(120, Math.round(window.innerHeight * 0.52));
  const s = Math.min(availW / videoW, availH / videoH);
  previewWrap.style.width = Math.round(videoW * s) + 'px';
  previewWrap.style.height = Math.round(videoH * s) + 'px';
}

// ===== 布局（时间轴：宽度 = 时长×PPS，可横向滚动）=====
function layout() {
  if (!duration) return;
  const w = contentWidth();
  tlInner.style.width = Math.max(w, timeline.clientWidth) + 'px';
  const xs = timeToX(sel.start), xe = timeToX(sel.end), xp = timeToX(playT);
  handleL.style.left = xs + 'px';
  handleR.style.left = xe + 'px';
  playhead.style.left = xp + 'px';
  maskL.style.width = xs + 'px';
  maskR.style.left = xe + 'px';   // 右遮罩锚定 xe→时间轴右缘，避免选段右侧露出未遮罩亮条（高亮一段再黑色）
  selBand.style.left = xs + 'px';
  selBand.style.width = (xe - xs) + 'px';
  applyPan();
}

// ===== 胶片条（真实抽帧缩略图，0.5s/帧，无缝平铺，滚动按需抽帧）=====
let thumbSeeker = null;
let stripObserver = null;
let cellQueue = [];
let activeDecodes = 0;
const MAX_PAR = 4;          // 并行抽帧数（大视频更快）
let decodedCount = 0;
let stripUnsupported = false;

function ensureThumbSeeker() {
  if (!thumbSeeker) {
    thumbSeeker = document.createElement('video');
    thumbSeeker.muted = true; thumbSeeker.playsInline = true; thumbSeeker.preload = 'auto';
    // 抽帧用 video：必须在“视口内”浏览器才解码（手机端尤甚）。
    // 关键：放在预览框内、位于可见预览之下（z-index:0 < #preview 的 1）。
    // 这样它仍在视口内可解码，但被不透明的预览完全遮挡 —— 页面上不会再出现任何浮层残影/白块
    // （之前 position:fixed + 独立合成层，部分机型不认 opacity:0.01，会把这一层画出来）。
    thumbSeeker.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;opacity:0.01;pointer-events:none;z-index:0;';
    previewWrap.insertBefore(thumbSeeker, previewWrap.firstChild);
  }
  if (thumbSeeker.src !== url) { thumbSeeker.src = url; try { thumbSeeker.load(); } catch (_) {} }
  return thumbSeeker;
}

function drawCell(cell, v) {
  try {
    const cw = THUMB_W, ch = THUMB_H;
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const cx = cv.getContext('2d');
    const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
    const scale = Math.max(cw / vw, ch / vh);     // cover 填充
    const dw = vw * scale, dh = vh * scale;
    cx.drawImage(v, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    cell.style.backgroundImage = 'url(' + cv.toDataURL('image/jpeg', 0.7) + ')';
    decodedCount++;
  } catch (e) { /* 抽帧失败保留占位 */ }
  cell.classList.remove('loading');
  cell.dataset.state = 'done';
}

function decodeCell(cell) {
  if (cell.dataset.state === 'done' || cell.dataset.state === 'queued') return;
  cell.dataset.state = 'queued';
  cell.classList.add('loading');
  cellQueue.push(cell);
  pumpThumbs();
}

function pumpThumbs() {
  while (activeDecodes < MAX_PAR && cellQueue.length) {
    const cell = cellQueue.shift();
    if (!cell || cell.dataset.state === 'done') continue;
    activeDecodes++;
    const t = parseFloat(cell.dataset.t);
    const v = ensureThumbSeeker();
    let settled = false;
    const settle = () => { if (settled) return; settled = true; activeDecodes--; drawCell(cell, v); pumpThumbs(); };
    const wd = setTimeout(settle, 2500);   // 看门狗：单格最长 2.5s，超时也落定 → 杜绝死锁黑条
    if (Math.abs(v.currentTime - t) < 1e-3) { clearTimeout(wd); requestAnimationFrame(settle); }
    else {
      v.onseeked = () => { clearTimeout(wd); settle(); };
      try { v.currentTime = Math.min(t, duration - 0.001); }
      catch (e) { clearTimeout(wd); settle(); }
    }
  }
}

function buildStrip() {
  strip.innerHTML = '';
  cellQueue = []; activeDecodes = 0; decodedCount = 0; stripUnsupported = false;
  strip.classList.remove('unsupported');
  const N = Math.max(1, Math.ceil(duration / FRAME));   // 每 0.5s 一格
  for (let i = 0; i < N; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.flex = '0 0 ' + (pps * FRAME) + 'px';   // 每格 = 一帧宽，随放缩同步变宽
    cell.dataset.t = ((i + 0.5) / N * duration).toFixed(3);   // 取该格中心时刻抽帧
    strip.appendChild(cell);
  }
  strip.style.width = Math.max(contentWidth(), timeline.clientWidth) + 'px';
  applyZoom();
  buildRuler();                 // 顶部秒刻度尺：0001 0002 0003…
  if (stripObserver) stripObserver.disconnect();
  stripObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { decodeCell(en.target); stripObserver.unobserve(en.target); }
    }
  }, { root: timeline, rootMargin: '240px' });
  Array.from(strip.children).forEach((c) => stripObserver.observe(c));
}

// 顶部秒刻度尺：整秒处标 0001 / 0002 / 0003…（长视频每 5s 标一个，避免拥挤）
function buildRuler() {
  if (!duration) return;
  // 去重：pps/viewStart/fps/视口宽度都没变就不重绘（拖动/缩放手势里频繁调用）
  const key = pps + '|' + viewStart + '|' + fps + '|' + (timeline.clientWidth | 0);
  if (key === _rulerKey) return;
  _rulerKey = key;

  const tw = timeline.clientWidth || window.innerWidth;
  const t0 = viewStart, t1 = viewStart + tw / pps;   // 仅渲染视口可见的时间窗
  ruler.style.width = contentWidth() + 'px';
  ruler.innerHTML = '';

  // —— 主刻度：每秒一个（放大时），缩小自动变 5s/10s/分钟级，标签 0000/0001… ——
  // 标签位于整秒位置；中心点（圆点）落在相邻两秒刻度的正中，而非标签正下方。
  const majorStep = niceStepSeconds(64 / pps);
  for (let s = Math.floor(t0 / majorStep) * majorStep; s <= t1 + majorStep; s += majorStep) {
    if (s < -1e-6) continue;
    const tk = document.createElement('div');
    tk.className = 'tick maj';
    const x = timeToX(s);
    tk.style.left = x + 'px';
    if (x < 12) tk.style.transform = 'none';   // 最左侧主刻度不被 overflow:hidden 裁掉
    tk.innerHTML = '<span class="lab">' + String(Math.max(0, Math.floor(s))).padStart(4, '0') + '</span>';
    ruler.appendChild(tk);
    // 中心点：两相邻秒刻度正中（半步处）
    const dm = document.createElement('div');
    dm.className = 'middot';
    dm.style.left = timeToX(s + majorStep / 2) + 'px';
    if (x + (majorStep / 2) * pps < 12) dm.style.transform = 'none';
    ruler.appendChild(dm);
  }

  // —— 帧刻度：放得够大才出现；每 5 帧标一次 5f/10f/15f/20f… ——
  const framePx = pps / fps;
  const halfFrame = Math.round(fps / 2);
  if (framePx >= 5) {
    const g0 = Math.floor(t0 * fps), g1 = Math.ceil(t1 * fps), ifps = Math.max(1, Math.round(fps));
    for (let gf = g0; gf <= g1; gf++) {
      const t = gf / fps;
      if (t < t0 - 1e-6 || t > t1 + 1e-6) continue;
      const inSec = ((gf % ifps) + ifps) % ifps;
      if (inSec === 0) continue;                 // 整秒已作主刻度
      if (majorStep === 1 && inSec === halfFrame) continue;   // 让位给主刻度中心点，避免重叠
      const tk = document.createElement('div');
      tk.className = 'tick frm';
      tk.style.left = timeToX(t) + 'px';
      tk.innerHTML = (framePx >= 7 && inSec % 5 === 0) ? '<span class="lab">' + inSec + 'f</span>' : '<span class="mark"></span>';
      ruler.appendChild(tk);
    }
  }
}

// 首屏最靠近视口的格优先抽（避免长视频开局整条黑）；其余随滚动按需抽
function prefetchVisible() {
  const cells = Array.from(strip.children);
  if (!cells.length) return;
  const tr = timeline.getBoundingClientRect();
  const mid = (tr.left + tr.right) / 2;
  cells.sort((a, b) => Math.abs((a.getBoundingClientRect().left + a.getBoundingClientRect().right) / 2 - mid) -
                      Math.abs((b.getBoundingClientRect().left + b.getBoundingClientRect().right) / 2 - mid));
  cells.slice(0, 24).forEach((c) => decodeCell(c));
}

// 全部落定后若一帧都没抽出来（编码浏览器不支持，如 HEVC）→ 明确提示，绝不留下“黑条”
function checkStripSupport() {
  if (decodedCount === 0 && strip.children.length) {
    stripUnsupported = true;
    strip.classList.add('unsupported');
    setHint('该视频编码（如 HEVC）浏览器无法解码，胶片条缩略图不可用；导出仍正常（WebCodecs 重新编码）', true);
  }
}

function updateReadout() {
  tStart.textContent = fmt(sel.start);
  tEnd.textContent = fmt(sel.end);
}

// ===== 统一时间轴交互：整条底部 = 一个同步层 =====
// 拖动任意位置：抓住的那一帧始终贴着手指，胶片条随之平移（拖 = 平移 + 拖动进度，同一层）。
// 双指放缩：以两指中点为焦点持续缩放，松手保持（不回弹）。
// 平移交互（原生编辑器手感）：屏幕中心为固定白色细长轴(#centerAxis)，拖动=胶片在轴下滑动，
// 轴始终显示当前位置帧（实时预览）；松手按速度惯性继续滑行后衰减。
let draggingPlay = false, draggingPan = false;
let panLastX = 0, panLastT = 0, panVX = 0, flingRAF = 0;
function centerTime() { return Math.min(duration, Math.max(0, viewStart + (timeline.clientWidth / 2) / pps)); }
function showCenterFrame() { playT = centerTime(); preview.currentTime = playT; }   // 中心轴所在帧实时显示
function onTimelineDown(e) {
  if (stage.classList.contains('empty')) return;
  if (e.target.closest('button, input, a')) return;   // 控件不触发平移（手柄/选段已 stopPropagation）
  if (e.target.closest('.handle')) return;        // 手柄自己处理
  if (e.target.closest('.sel-band')) return;      // 选段矩形自己处理
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (document.body.classList.contains('fs')) { startFsScrub(e); return; }   // 全屏模式：左右拖动=前进/后退
  if (dragHint) dragHint.hidden = true;        // 首次拖动后隐藏背景提示
  e.preventDefault();
  if (flingRAF) { cancelAnimationFrame(flingRAF); flingRAF = 0; }
  draggingPan = true; draggingPlay = true;
  preview.pause();
  try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  panLastX = e.clientX; panLastT = performance.now(); panVX = 0;
  showCenterFrame();
}
function movePan(e) {
  if (document.body.classList.contains('fs')) { fsScrubMove(e); return; }
  if (!draggingPan) return;
  const now = performance.now(), dt = now - panLastT;
  const dx = e.clientX - panLastX;
  if (dt > 0) panVX = dx / dt;            // px/ms，记录速度供惯性用
  panLastX = e.clientX; panLastT = now;
  viewStart = clampView(viewStart - dx / pps);   // 内容跟随手指
  showCenterFrame(); applyPan(); layout();
}
function upPan(e) {
  if (document.body.classList.contains('fs')) { fsScrubEnd(e); return; }
  draggingPan = false; draggingPlay = false;
  try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
  if (Math.abs(panVX) > 0.04) startFling();      // 松手惯性
}
function startFling() {
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(48, now - last); last = now;
    panVX *= 0.94;                     // 摩擦衰减
    const dx = panVX * dt;
    viewStart = clampView(viewStart - dx / pps);
    showCenterFrame(); applyPan(); layout();
    if (Math.abs(panVX) > 0.02) flingRAF = requestAnimationFrame(step);
    else flingRAF = 0;
  };
  flingRAF = requestAnimationFrame(step);
}
// ===== 全屏模式：视频铺满 + 矩形当前帧指示 + 左右拖动前进/后退（无需胶片条）=====
// 拖动时实时把当前帧画进矩形（canvas），即“实时播放”预览
function updateFsThumb() {
  if (!fsRect || fsRect.hidden || !fsCanvas) return;
  const cw = preview.videoWidth, ch = preview.videoHeight;
  if (!cw || !ch) return;
  if (fsCanvas.width !== cw) { fsCanvas.width = cw; fsCanvas.height = ch; }
  try { fsCanvas.getContext('2d').drawImage(preview, 0, 0, cw, ch); } catch (_) {}
}
fsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const on = document.body.classList.toggle('fs');
  fsRect.hidden = !on;
  if (on) updateFsThumb();
});
let fsDragging = false, fsStartX = 0, fsStartT = 0;
function startFsScrub(e) {
  fsDragging = true; fsStartX = e.clientX; fsStartT = playT;
  try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  preview.pause(); e.preventDefault(); updateFsThumb();
}
function fsScrubMove(e) {
  if (!fsDragging) return;
  const dx = e.clientX - fsStartX;
  const dt = (dx / window.innerWidth) * duration;   // 横向拖满一屏 = 整段视频
  playT = Math.min(duration, Math.max(0, fsStartT + dt));
  preview.currentTime = playT;            // 主视频实时跳到该帧
  updateFsThumb();                        // 矩形同步显示当前帧（实时）
}
function fsScrubEnd(e) { fsDragging = false; try { stage.releasePointerCapture(e.pointerId); } catch (_) {} }
// 整屏（含胶片条上方视频区、下方文字区）都可平移 / 缩放胶片条，视为同一同步层
stage.addEventListener('pointerdown', onTimelineDown);
stage.addEventListener('pointermove', movePan);
stage.addEventListener('pointerup', upPan);
stage.addEventListener('pointercancel', upPan);

// 双指放缩（移动端）：焦点帧保持原位，持续缩放——整屏任意位置起手均可
let pinch = null;
stage.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    draggingPan = false; draggingPlay = false;
    const [a, b] = e.touches;
    const midX = (a.clientX + b.clientX) / 2;
    const tl = timeline.getBoundingClientRect().left;
    pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
              startPps: pps,
              focalT: viewStart + (midX - tl) / pps };
  }
}, { passive: false });
stage.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinch) {
    e.preventDefault();
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const midX = (a.clientX + b.clientX) / 2;
    const tl = timeline.getBoundingClientRect().left;
    const np = Math.min(maxPps(), Math.max(minPps(), pinch.startPps * (dist / pinch.dist)));
    viewStart = clampView(pinch.focalT - (midX - tl) / np);
    pps = np; applyPan(); applyZoom(); layout();
  }
}, { passive: false });
stage.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });
stage.addEventListener('touchcancel', () => { pinch = null; });

// ===== 双滑块选段 =====
function bindHandle(el, which) {
  el.addEventListener('pointerdown', (e) => {
    if (stage.classList.contains('empty')) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const rect = track.getBoundingClientRect();
    const len = sel.end - sel.start;   // 当前选段时长（固定，拖动时不改变）
    const move = (ev) => {
      const t = xToTime(ev.clientX - rect.left);
      // 拖动左/右任一手柄 = 平移整段（保持时长不变），不再拉伸区间
      let ns = which === 'l' ? t : (t - len);
      ns = Math.max(0, Math.min(duration - len, ns));
      sel.start = ns; sel.end = ns + len;
      playT = sel.start;                 // 播放头跟随选段左缘，避免停在黑遮罩里变成“高亮一段”
      updateReadout(); layout();
      preview.currentTime = sel.start;   // 拖动选段时实时显示“起始帧”画面
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
      playSegment();                     // 松手即播放这段
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
bindHandle(handleL, 'l');
bindHandle(handleR, 'r');

// 拖动“保留段”矩形本体：整体平移选段（像拖动一个矩形）
selBand.addEventListener('pointerdown', (e) => {
  if (stage.classList.contains('empty')) return;
  e.stopPropagation();
  try { selBand.setPointerCapture(e.pointerId); } catch (_) {}
  const rect = track.getBoundingClientRect();
  const s0 = sel.start, e0 = sel.end, tDown = xToTime(e.clientX - rect.left);
  const move = (ev) => {
    const dt = xToTime(ev.clientX - rect.left) - tDown;
    let ns = Math.max(0, Math.min(duration - (e0 - s0), s0 + dt));
    sel.start = ns; sel.end = ns + (e0 - s0);
    playT = sel.start;                   // 播放头跟随选段左缘
    updateReadout(); layout();
    preview.currentTime = sel.start;     // 实时显示起始帧
  };
  const up = (ev) => {
    selBand.removeEventListener('pointermove', move);
    selBand.removeEventListener('pointerup', up);
    try { selBand.releasePointerCapture(ev.pointerId); } catch (_) {}
    playSegment();
  };
  selBand.addEventListener('pointermove', move);
  selBand.addEventListener('pointerup', up);
});

// ===== 播放选段 =====
function playSegment() {
  if (!duration) return;
  preview.currentTime = sel.start;
  // 首次自动播放没有用户手势时会被浏览器拦截（NotAllowedError）——吞掉即可，不弹未捕获异常
  const p = preview.play();
  if (p && p.catch) p.catch(() => {});
}
btnPlay.addEventListener('click', playSegment);
preview.addEventListener('timeupdate', () => {
  if (preview.currentTime >= sel.end) preview.pause();
  updateFsThumb();
  if (!draggingPan) {                       // 播放时中心白轴停在播放位置：胶片自动滚动跟随
    playT = preview.currentTime;
    viewStart = clampView(playT - (timeline.clientWidth / 2) / pps);
    applyPan(); layout();
  }
});

// 空格键 = 播放/暂停（在输入框/按钮上时不拦截，避免误触）
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if (e.target.closest && e.target.closest('button, input, a')) return;
  if (stage.classList.contains('empty')) return;
  e.preventDefault();
  if (preview.paused) {
    if (preview.currentTime >= sel.end) preview.currentTime = sel.start;
    const p = preview.play(); if (p && p.catch) p.catch(() => {});
  } else preview.pause();
});

// ===== 前进/后退「选段」（两个粉色轴同步整体移动一帧，画面实时跟随）=====
function stepSelection(dir) {   // dir = -1 后退 / +1 前进
  const dt = dir / fps;
  const len = sel.end - sel.start;            // 选段时长保持不变
  let ns = sel.start + dt;
  ns = Math.max(0, Math.min(duration - len, ns));   // 整段锁在 [0, duration] 内
  sel.start = ns; sel.end = ns + len;
  playT = sel.start;                          // 播放头跟随左轴
  preview.currentTime = sel.start;            // 实时展示选段当前帧画面
  updateReadout(); layout();
}
btnStepB.addEventListener('click', () => stepSelection(-1));
btnStepF.addEventListener('click', () => stepSelection(1));

// 选段预设：从当前「起点」取固定长度（起点可由左滑块拖到任意位置）
function applyPreset(sec) {
  if (!duration) return;
  sel.end = Math.min(duration, sel.start + sec);
  updateReadout(); layout();
}
p3.addEventListener('click', () => applyPreset(3));
p5.addEventListener('click', () => applyPreset(5));
p10.addEventListener('click', () => applyPreset(10));
pAll.addEventListener('click', () => { sel.end = duration; updateReadout(); layout(); });

// “时长”弹层：点击展开/收起预设，选完或点外部自动收起（收起控件让视频更大）
presetsBtn.addEventListener('click', (e) => { e.stopPropagation(); presetsPop.hidden = !presetsPop.hidden; });
[p3, p5, p10, pAll].forEach(b => b.addEventListener('click', () => { presetsPop.hidden = true; }));
document.addEventListener('pointerdown', (e) => {
  if (presetsPop.hidden) return;
  if (e.target.closest('.presets-wrap')) return;
  presetsPop.hidden = true;
}, true);

// ===== 设封面帧 =====
btnSetCover.addEventListener('click', () => setCoverAt(playT));
function setCoverAt(t) {
  coverT = t;                       // 封面帧时间（导出时按此抽高清帧）
  coverBadge.hidden = false;
  coverBadge.textContent = '封面 ' + fmt(t);
  setHint('封面帧已设为 ' + fmt(t));
}

// ===== 导出 LivePhoto（ffmpeg.wasm 裁段 + 纯 JS 拼 trailer）=====
btnExport.addEventListener('click', async () => {
  btnExport.disabled = true; setHint('准备导出…');
  exporting.hidden = false; exText.textContent = '准备导出…'; exBar.style.width = '0%'; exPct.textContent = '0%';
  try {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error('当前浏览器不支持 WebCodecs（请用 Chrome / Edge 等 Chromium 内核浏览器）');
    }
    const { Muxer, ArrayBufferTarget } = await import('./vendor/mp4-muxer.mjs');

    const w = videoW - (videoW % 2), h = videoH - (videoH % 2);
    const fps = 30;
    const bitrate = Math.min(8_000_000, Math.max(2_000_000, Math.round((w * h * 0.08))));
    let codec = 'avc1.42001f';            // 先试 baseline 3.1
    let sup = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps });
    if (!sup.supported) { codec = 'avc1.4d0028'; sup = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps }); }
    if (!sup.supported) throw new Error('浏览器不支持 H.264 编码（' + codec + '）');

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: w, height: h },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',   // 选段 start≠0 时首帧时间戳非0，mp4-muxer 要求首帧=0，offset 自动归零
    });
    let encodeError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encodeError = e; console.error('VideoEncoder 出错：', e); },
    });
    encoder.configure({ codec, width: w, height: h, bitrate, framerate: fps });

    // 隐藏视频：挂到 DOM 并真实渲染（opacity:0.01 而非 0，确保浏览器持续呈现帧，
    // requestVideoFrameCallback 才会触发）。全分辨率 canvas 抓帧编码。
    const v = document.createElement('video');
    v.src = url; v.muted = true; v.playsInline = true; v.crossOrigin = 'anonymous';
    v.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:270px;opacity:0.01;pointer-events:none;z-index:1;';
    document.body.appendChild(v);
    await new Promise((r, f) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', f, { once: true }); });

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;                  // 全分辨率，避免导出模糊
    const cx = cv.getContext('2d', { willReadFrequently: false });

    const start = sel.start, end = sel.end;
    let encoded = 0;
    // 定位到选段起点（seek 一次），再靠播放 + requestVideoFrameCallback 在实时播放中逐帧抓图编码。
    // 相比逐帧随机 seek，这快得多（约实时速度），且复用已验证的 canvas.drawImage 抓帧。
    v.currentTime = start;
    await new Promise((res, rej) => {
      const onSeeked = () => { v.removeEventListener('seeked', onSeeked); res(); };
      v.addEventListener('seeked', onSeeked);
      setTimeout(() => { v.removeEventListener('seeked', onSeeked); rej(new Error('定位选段起点超时')); }, 8000);
    });
    const totalFrames = Math.max(1, Math.ceil((end - start) * fps));
    exText.textContent = '编码准备就绪，开始编码…';
    try { await v.play(); } catch (_) {}
    await new Promise((resolve) => {
      let stopped = false;
      const finish = () => {
        if (stopped) return; stopped = true;
        try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (_) {}
        resolve();
      };
      let lastTs = -1;
      let firstMt = null;   // 以“实际捕获到的第一帧”为基准，保证首帧时间戳=0（避免 seek 竞态导致首帧非0）
      const onRvfc = (now, meta) => {
        if (encodeError) { finish(); return; }
        const ct = v.currentTime;
        if (ct >= end || v.ended) { finish(); return; }
        try {
          cx.drawImage(v, 0, 0, cv.width, cv.height);
          // 用帧的真实呈现时间(mediaTime)算 PTS —— 与源帧率解耦，避免导出播放速度失真(加速/变慢)
          const mt = (meta && typeof meta.mediaTime === 'number') ? meta.mediaTime : ct;
          if (firstMt === null) firstMt = mt;
          let ts = Math.round((mt - firstMt) * 1e6);
          if (ts <= lastTs) ts = lastTs + 1;   // 保证单调递增
          lastTs = ts;
          const frame = new VideoFrame(cv, { timestamp: ts });
          encoder.encode(frame, { keyFrame: encoded % (2 * fps) === 0 });
          frame.close();
          encoded++;
          const pct = Math.min(100, Math.round((encoded / totalFrames) * 100));
          if (exBar) exBar.style.width = pct + '%';
          if (exPct) exPct.textContent = pct + '%';
          if (exText) exText.textContent = '编码中 ' + encoded + '/' + totalFrames + ' 帧';
        } catch (e) { console.warn('帧编码异常', e); }
        v.requestVideoFrameCallback(onRvfc);
      };
      v.requestVideoFrameCallback(onRvfc);
      setTimeout(finish, 60000);   // 兜底超时
    });
    if (encodeError) throw encodeError;
    exText.textContent = '编码完成，封装中…';
    await encoder.flush();
    v.remove();
    muxer.finalize();
    exText.textContent = '生成封面…';

    const { buffer } = muxer.target;
    const mov = new Uint8Array(buffer);
    const name = (loadedName || 'livephoto').replace(/\.[^.]+$/, '');

    // 封面 JPEG：全分辨率抽帧（对齐 Python make_cover 的高清封面，避免模糊）
    if (!seeker) { seeker = document.createElement('video'); seeker.muted = true; seeker.preload = 'auto'; }
    if (!seeker.src) seeker.src = url;
    const coverB64 = await grabCover(seeker, coverT);
    const coverBytes = b64ToBytes(coverB64.split(',')[1]);
    // trailer 严格对齐 Python build_trailer：frame_pos / startMs / durMs / best_moment
    const framePos = Math.round(coverT / FRAME);
    const startMs = Math.round(sel.start * 1000);
    const durMs = Math.round((sel.end - sel.start) * 1000);
    const trailer = buildTrailer(mov, framePos, startMs, durMs, true);
    const blob = new Blob([coverBytes, mov, trailer], { type: 'application/octet-stream' });
    const objUrl = URL.createObjectURL(blob);
    dlLink.href = objUrl;
    dlLink.download = name + '.livephoto.jpg';
    dlMsg.textContent = '已生成：' + name + '.livephoto.jpg';
    dlWrap.hidden = false;
    dlLink.click();   // 仍自动触发一次，避免错过；弹窗提供“再次下载”
    setHint('已导出：' + name + '.livephoto.jpg（封面JPEG + MP4 + 60B trailer）。请在荣耀/华为相册验证是否识别为实况。');
  } catch (err) {
    console.error(err);
    setHint('导出失败：' + (err && err.message ? err.message : err), true);
  } finally {
    hideLoading();
    exporting.hidden = true;
    btnExport.disabled = false;
  }
});

// 严格对齐你提供的 Python build_trailer（荣耀原厂格式，已用真机样本自证）：
//   line1: "v2_f" + 两位帧位(f00..f99)，右侧空格填到 20 字节（best_moment 才写）
//   line2: "<startMs>:<durationMs>"，右侧空格填到 20 字节
//   line3: "LIVE_" + (mp4字节数 + 0x14)  十进制，右侧空格填到 20 字节
function buildTrailer(mp4bytes, framePos, startMs, durMs, bestMoment = true) {
  const FRAME_NUM = 0x14;
  const enc = new TextEncoder();
  const pad20 = (s) => {
    s = String(s);
    if (s.length > 20) s = s.slice(0, 20);
    return enc.encode(s + ' '.repeat(20 - s.length));
  };
  const out = new Uint8Array(60);
  let off = 0;
  if (bestMoment) {
    const fp = String(Math.min(99, Math.max(0, framePos)) % 100).padStart(2, '0');
    out.set(pad20('v2_f' + fp), off); off += 20;
  }
  out.set(pad20(startMs + ':' + durMs), off); off += 20;
  const live = bestMoment ? (mp4bytes.length + FRAME_NUM) : mp4bytes.length;
  out.set(pad20('LIVE_' + live), off);
  return out;
}

// ===== 小工具 =====
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function download(blob, fname) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

window.addEventListener('resize', () => { fitPreview(); layout(); });
