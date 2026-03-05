// ═══════════════════════════════════════════════════════════════════
//  app.js
//  UI 状态管理、事件绑定、直方图绘制
//  依赖：glRenderer.js（GLRenderer）、filmAnalyzer.js（analyzeFilm）
// ═══════════════════════════════════════════════════════════════════

import { GLRenderer }  from './glRenderer.js';
import { analyzeFilm } from './filmAnalyzer.js';

// ── DOM 引用 ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const glCanvas   = $('glCanvas');
const cpuCanvas  = $('cpuCanvas');
const histCanvas = $('histCanvas');
const ctxCpu     = cpuCanvas.getContext('2d', { willReadFrequently: true });
const ctxHist    = histCanvas.getContext('2d');

// ── 渲染器实例 ───────────────────────────────────────────────────
const renderer = new GLRenderer(glCanvas);

// ── 应用状态 ─────────────────────────────────────────────────────
// state.maskAdj 是色罩 RGB 绝对值，直接由滑块或分析结果写入。
// render() 直接把它传给 renderer，不做额外乘法。
// （之前版本用 maskAdj * p.maskR 做乘法是 Bug 根源）
const state = {
  loaded: false,

  // 由 filmAnalyzer 写入
  maskRaw:      [0.95, 0.85, 0.72],
  maskAdj:      [0.95, 0.85, 0.72],
  densityScale: [1, 1, 1],
  crossMat:     new Float32Array([1,0,0, 0,1,0, 0,0,1]),
  wb:           [1, 1, 1],
  filmType:     'unknown',

  // 用户调节参数（与 slider 一一对应）
  p: {
    exp:   0,
    con:   1.0,
    temp:  0,
    tint:  0,
    sat:   1.15,
    gamma: 1.8,
  },
};

// ── 渲染 ─────────────────────────────────────────────────────────
function render() {
  if (!state.loaded) return;
  renderer.render({
    maskAdj:      state.maskAdj,      // 直接传绝对值，无额外乘法
    densityScale: state.densityScale,
    crossMat:     state.crossMat,
    wb:           state.wb,
    gamma:        state.p.gamma,
    exp:          state.p.exp,
    con:          state.p.con,
    temp:         state.p.temp,
    tint:         state.p.tint,
    sat:          state.p.sat,
  });
  drawHistogram();
}

// ── 直方图 ───────────────────────────────────────────────────────
function drawHistogram() {
  const w = histCanvas.width;
  const h = histCanvas.height;

  // 只读左下角一小块像素，开销极小
  const pw = Math.min(120, glCanvas.width);
  const ph = Math.min(60,  glCanvas.height);
  const pixels = renderer.readPixels(pw, ph);

  const hist = [
    new Uint32Array(64),
    new Uint32Array(64),
    new Uint32Array(64),
  ];
  for (let i = 0; i < pixels.length; i += 4) {
    hist[0][pixels[i]   >> 2]++;
    hist[1][pixels[i+1] >> 2]++;
    hist[2][pixels[i+2] >> 2]++;
  }

  const maxV = Math.max(1, ...hist.flatMap(b => [...b]));

  ctxHist.clearRect(0, 0, w, h);
  ctxHist.fillStyle = 'rgba(0,0,0,0.5)';
  ctxHist.fillRect(0, 0, w, h);

  const colors = [
    'rgba(255,80,80,0.75)',
    'rgba(80,220,80,0.75)',
    'rgba(80,130,255,0.75)',
  ];
  colors.forEach((color, ci) => {
    ctxHist.beginPath();
    ctxHist.strokeStyle = color;
    ctxHist.lineWidth = 1;
    for (let i = 0; i < 64; i++) {
      const x = (i / 63) * w;
      const y = h - (hist[ci][i] / maxV) * h;
      i === 0 ? ctxHist.moveTo(x, y) : ctxHist.lineTo(x, y);
    }
    ctxHist.stroke();
  });
}

// ── 底片分析 ─────────────────────────────────────────────────────
function runAnalysis() {
  if (!state.loaded) return;
  setStatus('ANALYZING', 'active');
  showToast('⚡ 正在分析底片特性...');

  // setTimeout 让浏览器先刷新 UI，再跑 CPU 密集计算
  setTimeout(() => {
    const result = analyzeFilm(cpuCanvas);

    state.maskRaw      = result.maskRaw;
    state.maskAdj      = [...result.maskAdj];   // 深拷贝，避免后续手调污染原始分析值
    state.densityScale = result.densityScale;
    state.crossMat     = result.crossMat;
    state.wb           = result.wb;
    state.filmType     = result.filmType;
    state.p.gamma      = result.gamma;

    syncMaskSliders(state.maskAdj);
    syncGammaSlider(state.p.gamma);
    updateDebugPanel();

    setStatus('READY', 'ready');
    showToast('✅ ' + filmTypeLabel(result.filmType));
    render();
  }, 60);
}

// ── 滑块同步 ─────────────────────────────────────────────────────
// 把分析结果写回 FILM 面板的三个色罩滑块
// 滑块 value = 色罩绝对值（0.3~0.999），所见即所得
function syncMaskSliders(mask) {
  [['MR', 0], ['MG', 1], ['MB', 2]].forEach(([s, i]) => {
    const v = Math.min(0.998, Math.max(0.3, mask[i]));
    $('sl' + s).value     = v.toFixed(3);
    $('v'  + s).textContent = v.toFixed(3);
  });
}

function syncGammaSlider(g) {
  $('slGamma').value      = g.toFixed(2);
  $('vGamma').textContent = g.toFixed(2);
}

// ── Debug 面板 ───────────────────────────────────────────────────
function updateDebugPanel() {
  const fmt  = arr => arr.map(v => v.toFixed(3)).join(', ');
  const Dbase = state.maskAdj.map(m => -Math.log(Math.max(m, 0.001)));
  const m     = state.crossMat;

  $('dbType').textContent     = filmTypeLabel(state.filmType);
  $('dbMaskRaw').textContent  = fmt(state.maskRaw);
  $('dbMaskAdj').textContent  = fmt(state.maskAdj);
  $('dbDBase').textContent    = fmt(Dbase);
  $('dbDScale').textContent   = fmt(state.densityScale);
  $('dbWB').textContent       = fmt(state.wb);
  $('dbCross').textContent    = `[${m[0].toFixed(2)}, ${m[4].toFixed(2)}, ${m[8].toFixed(2)}]`;
}

function filmTypeLabel(t) {
  return {
    c41_color:   'C41 彩色负片',
    c41_expired: 'C41 过期/特殊',
    bw_or_slide: '黑白/正片',
  }[t] || t;
}

// ── 状态 Pill ────────────────────────────────────────────────────
function setStatus(text, cls) {
  const el = $('statusPill');
  el.textContent = text;
  el.className   = 'status-pill' + (cls ? ' ' + cls : '');
}

// ── Toast ────────────────────────────────────────────────────────
function showToast(msg) {
  const t = $('toast');
  t.textContent  = msg;
  t.style.opacity = 1;
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.style.opacity = 0, 2500);
}

// ═══════════════════════════════════════════════════════════════════
//  事件绑定
// ═══════════════════════════════════════════════════════════════════

// ── 文件上传 ─────────────────────────────────────────────────────
$('fileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      // uploadImage 内部会更新 glCanvas.width/height 为图片原始尺寸（上限 4096）
      renderer.uploadImage(img);

      // 分析用小图（长边 600px 足够做统计）
      const s = Math.min(1, 600 / Math.max(img.width, img.height));
      cpuCanvas.width  = Math.max(1, (img.width  * s) | 0);
      cpuCanvas.height = Math.max(1, (img.height * s) | 0);
      ctxCpu.drawImage(img, 0, 0, cpuCanvas.width, cpuCanvas.height);

      state.loaded = true;
      $('emptyState').style.display = 'none';

      runAnalysis();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

// ── 重分析 ───────────────────────────────────────────────────────
$('btnReAnalyze').addEventListener('click', runAnalysis);

// ── BASIC 面板滑块 ────────────────────────────────────────────────
function bindSlider(slId, key, valId, decimals) {
  $(slId).addEventListener('input', e => {
    state.p[key]          = parseFloat(e.target.value);
    $(valId).textContent  = state.p[key].toFixed(decimals);
    render();
  });
}
bindSlider('slExp',  'exp',  'vExp',  2);
bindSlider('slCon',  'con',  'vCon',  2);
bindSlider('slTemp', 'temp', 'vTemp', 0);
bindSlider('slTint', 'tint', 'vTint', 0);
bindSlider('slSat',  'sat',  'vSat',  2);

// ── FILM 面板：Gamma ──────────────────────────────────────────────
$('slGamma').addEventListener('input', e => {
  state.p.gamma           = parseFloat(e.target.value);
  $('vGamma').textContent = state.p.gamma.toFixed(2);
  render();
});

// ── FILM 面板：Mask 滑块 ──────────────────────────────────────────
// 直接写 state.maskAdj 的绝对值，不做任何乘法
// 这是修复"拖动后画面变全绿"Bug 的核心
[['slMR', 'vMR', 0], ['slMG', 'vMG', 1], ['slMB', 'vMB', 2]].forEach(([slId, valId, ch]) => {
  $(slId).addEventListener('input', e => {
    const v             = parseFloat(e.target.value);
    state.maskAdj[ch]   = v;              // 直接设绝对值
    $(valId).textContent = v.toFixed(3);
    render();
  });
});

// ── 重置 ─────────────────────────────────────────────────────────
$('btnReset').addEventListener('click', () => {
  // 只重置 BASIC 面板参数，保留 Film 分析结果
  state.p.exp  = 0;    $('slExp').value  = 0;    $('vExp').textContent  = '0.00';
  state.p.con  = 1.0;  $('slCon').value  = 1.0;  $('vCon').textContent  = '1.00';
  state.p.temp = 0;    $('slTemp').value = 0;    $('vTemp').textContent = '0';
  state.p.tint = 0;    $('slTint').value = 0;    $('vTint').textContent = '0';
  state.p.sat  = 1.15; $('slSat').value  = 1.15; $('vSat').textContent  = '1.15';
  render();
});

// ── Tab 切换 ──────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.querySelectorAll('.panel').forEach(p => p.style.display = 'none');
    const name    = tab.dataset.tab;
    const panelId = 'panel' + name.charAt(0).toUpperCase() + name.slice(1);
    $(panelId).style.display = 'flex';
  });
});

// ── 导出 & Modal ──────────────────────────────────────────────────
const modal   = $('saveModal');
const saveImg = $('saveImg');

$('btnSave').addEventListener('click', () => {
  if (!state.loaded) { showToast('请先上传图片'); return; }
  showToast('正在生成图片...');
  render();
  setTimeout(() => {
    saveImg.src = renderer.exportJPEG(0.95);
    modal.classList.add('open');
  }, 100);
});

$('closeModal').addEventListener('click', () => {
  modal.classList.remove('open');
  setTimeout(() => { saveImg.src = ''; }, 300);
});
