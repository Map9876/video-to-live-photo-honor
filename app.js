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
const tStart = $('tStart'), tEnd = $('tEnd'), tDur = $('tDur');
const rePick = $('rePick'), workspace = $('workspace'), placeholder = $('placeholder');
const loading = $('loading'), loadingText = $('loadingText');
const exporting = $('exporting'), exText = $('exText'), exBar = $('exBar'), exPct = $('exPct');
const dlWrap = $('dlWrap'), dlLink = $('dlLink'), dlMsg = $('dlMsg'), dlClose = $('dlClose');

const PPS = CELL / FRAME;   // 56px / 0.5s = 112 px/秒；胶片条每格 = 0.5s，与 CSS --cell 对齐

// ===== 状态 =====
let url = null;
let duration = 0;
let videoW = 0, videoH = 0;
let sel = { start: 0, end: 0 };
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
function contentWidth() { return duration * PPS; }
function timeToX(t) { return t * PPS; }
function xToTime(x) { return Math.min(duration, Math.max(0, x / PPS)); }

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
  [btnPlay, btnStepB, btnStepF, btnSetCover, btnExport, p3, p5, p10, pAll].forEach(b => b.disabled = true);
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
    [btnPlay, btnStepB, btnStepF, btnSetCover, btnExport, p3, p5, p10, pAll].forEach(b => b.disabled = false);
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
function grabCover(v, t) {
  return new Promise((resolve) => {
    const done = () => {
      const vw = v.videoWidth, vh = v.videoHeight;
      const c = document.createElement('canvas');
      c.width = vw; c.height = vh;
      c.getContext('2d').drawImage(v, 0, 0, vw, vh);
      resolve(c.toDataURL('image/jpeg', 0.92));
    };
    if (Math.abs(v.currentTime - t) < 1e-3) requestAnimationFrame(done);
    else { v.onseeked = done; v.currentTime = Math.min(t, duration - 0.001); }
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
  maskR.style.width = (contentWidth() - xe) + 'px';
  selBand.style.left = xs + 'px';
  selBand.style.width = (xe - xs) + 'px';
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
    cell.dataset.t = ((i + 0.5) / N * duration).toFixed(3);   // 取该格中心时刻抽帧
    strip.appendChild(cell);
  }
  strip.style.width = Math.max(contentWidth(), timeline.clientWidth) + 'px';
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
  ruler.innerHTML = '';
  ruler.style.width = Math.max(contentWidth(), timeline.clientWidth) + 'px';
  const step = duration > 600 ? 5 : 1;
  for (let s = 0; s <= duration + 0.001; s += step) {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style.left = (s * PPS) + 'px';
    // 首个刻度(0s)左对齐，避免被时间轴左边缘裁掉成“00”
    if (s < step / 2) t.style.transform = 'none';
    t.innerHTML = '<span class="lab">' + String(Math.floor(s)).padStart(4, '0') + '</span>';
    ruler.appendChild(t);
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

// ===== 播放头拖动（scrub 预览）：拖进度条 / 刻度尺(0001,0002…) = 预览该帧 =====
let draggingPlay = false;
function movePlayhead(e) {
  const rect = track.getBoundingClientRect();
  playT = xToTime(e.clientX - rect.left);
  preview.currentTime = playT;
  layout();
}
// 进度条与刻度尺都绑定 scrub（刻度尺之前是平移区、导致“拖动范围太小/只能拖选框”）
function bindScrub(el) {
  el.addEventListener('pointerdown', (e) => {
    if (stage.classList.contains('empty')) return;
    if (e.target.closest('.handle')) return;       // 让手柄自己处理
    if (e.target.closest('.sel-band')) return;     // 让选段矩形自己处理
    e.preventDefault();                            // 阻止文本选择/原生拖拽抢走手势
    draggingPlay = true;
    preview.pause();                               // 拖动先暂停，避免“一点就从头播”
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    movePlayhead(e);
  });
  el.addEventListener('pointermove', (e) => { if (draggingPlay) movePlayhead(e); });
  el.addEventListener('pointerup', (e) => { draggingPlay = false; try { el.releasePointerCapture(e.pointerId); } catch (_) {} });
  el.addEventListener('pointercancel', () => { draggingPlay = false; });
}
bindScrub(track);

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
  if (!draggingPlay) { playT = preview.currentTime; layout(); }   // 播放时蓝线跟随
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

// ===== 帧步进 =====
function fps() { return (videoW && videoH) ? 30 : 30; } // 近似
btnStepB.addEventListener('click', () => { playT = Math.max(0, playT - 1 / fps()); preview.currentTime = playT; layout(); });
btnStepF.addEventListener('click', () => { playT = Math.min(duration, playT + 1 / fps()); preview.currentTime = playT; layout(); });

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
