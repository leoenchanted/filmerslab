// ═══════════════════════════════════════════════════════════════════
//  filmAnalyzer.js
//  CPU 端底片特性分析
//
//  流程：
//  1. estimateBaseDensity   → 找橙色基底（色罩）
//  2. detectFilmType        → 判断胶片类型（C41 / 过期 / 黑白正片）
//  3. getCrosstalkMatrix    → 获取 CMY 染料串扰校正矩阵
//  4. computeDensityScale   → 密度归一化（等价于 Levels 拉伸）
//  5. computeWhiteBalance   → 灰世界白平衡
// ═══════════════════════════════════════════════════════════════════

const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = v => clamp(v, 0, 1);

// ── 1. 基底密度（色罩）估算 ─────────────────────────────────────
/**
 * 原理：
 *   负片上曝光最少的区域（片基+色罩）会在扫描图像中呈现为最亮（透过率最高）。
 *   取亮度直方图最亮 0.5% 的像素，它们代表"空白片基"颜色。
 *   用它们的 RGB 均值作为色罩基底。
 *
 *   注意：用"最亮 1%"反而容易被过爆高光污染，0.5% 更稳健。
 */
export function estimateBaseDensity(imgData) {
  const d = imgData.data;
  const n = d.length >> 2;

  // 10-bit 亮度直方图，精度更高
  const histL = new Uint32Array(1024);
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    histL[Math.min(1023, (lum * 4) | 0)]++;
  }

  // 找亮度 99.5% 分位点作为采样阈值
  let accum = 0;
  let threshold = 1023;
  for (let i = 1023; i >= 0; i--) {
    accum += histL[i];
    if (accum >= n * 0.005) { threshold = i; break; }
  }
  const thrFloat = threshold / 1023 * 255; // 换算回 0-255

  // 收集该亮度范围内的 RGB 均值
  let sR = 0, sG = 0, sB = 0, cnt = 0;
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
    if (lum >= thrFloat) {
      sR += d[i]; sG += d[i+1]; sB += d[i+2]; cnt++;
    }
  }

  if (cnt < 5) {
    // Fallback：典型 C41 橙色基底的经验值
    return [0.95, 0.85, 0.72];
  }

  return [
    Math.min(0.998, sR / cnt / 255),
    Math.min(0.998, sG / cnt / 255),
    Math.min(0.998, sB / cnt / 255),
  ];
}

// ── 2. 胶片类型识别 ─────────────────────────────────────────────
/**
 * 基于色罩 R/G/B 比例差异判断胶片工艺：
 *
 *  c41_color   : 标准彩色负片（Kodak Gold, Fuji 200 等）
 *                特征：R >> G >> B（橙色基底）
 *
 *  c41_expired : 过期或特殊彩色负片
 *                特征：R 极高，B 偏低，色罩更深
 *
 *  bw_or_slide : 黑白负片 / 彩色正片（幻灯片）
 *                特征：R ≈ G ≈ B（中性透明基底）
 */
export function detectFilmType(maskRaw) {
  const [r, g, b] = maskRaw;
  const rg = r - g;
  const gb = g - b;

  if (rg > 0.08 && gb > 0.04) return 'c41_color';
  if (rg > 0.20)              return 'c41_expired';
  if (Math.abs(rg) < 0.06 && Math.abs(gb) < 0.06) return 'bw_or_slide';
  return 'c41_color'; // 默认当彩色负片处理
}

// ── 3. CMY 染料串扰校正矩阵 ─────────────────────────────────────
/**
 * 原理：
 *   彩色负片由三层染料叠加：Cyan（吸收 R）、Magenta（吸收 G）、Yellow（吸收 B）
 *   但每层染料并非纯色，存在"副吸收"（串扰）：
 *     - Cyan 还会吸收少量 G（约 12%）
 *     - Magenta 还会吸收少量 R 和 B（各约 8-10%）
 *     - Yellow 还会吸收少量 G（约 10%）
 *
 *   这个矩阵在密度域将三通道解耦，减少串扰导致的偏色。
 *   数值参考 Kodak / Fuji 官方技术文档典型值，已转为列主序供 WebGL 使用。
 *
 *   矩阵是列主序（column-major），即：
 *     输出.r = 1.00*D.r + (-0.12)*D.g + (-0.01)*D.b
 *     输出.g = (-0.08)*D.r + 1.00*D.g + (-0.10)*D.b
 *     输出.b = (-0.02)*D.r + (-0.04)*D.g + 1.00*D.b
 */
export function getCrosstalkMatrix(filmType) {
  switch (filmType) {
    case 'c41_color':
      // col0        col1        col2
      return new Float32Array([
         1.00, -0.08, -0.02,   // → 对 D.r 的响应
        -0.12,  1.00, -0.04,   // → 对 D.g 的响应
        -0.01, -0.10,  1.00,   // → 对 D.b 的响应
      ]);

    case 'c41_expired':
      // 过期胶片串扰更严重，蓝通道额外补偿
      return new Float32Array([
         1.05, -0.10, -0.03,
        -0.12,  1.00, -0.06,
         0.02, -0.12,  1.08,
      ]);

    case 'bw_or_slide':
    default:
      // 单位矩阵，不做串扰校正
      return new Float32Array([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]);
  }
}

// ── 4. 密度缩放（Levels 归一化） ─────────────────────────────────
/**
 * 原理：
 *   去色罩后，各通道的密度分布范围不同。
 *   用直方图找出每个通道的有效密度范围 [D_min, D_max]，
 *   然后 scale = 1 / (D_max - D_min) 把它拉伸到 [0, 1]。
 *   等价于 Lightroom 的黑白场 Levels 调整，但在密度域更准确。
 */
export function computeDensityScale(imgData, maskAdj) {
  const d = imgData.data;
  const n = d.length >> 2;
  const BINS = 512;
  const D_RANGE = 3.0; // 密度值上限（实际胶片很少超过 D=3）

  const bins = [
    new Uint32Array(BINS),
    new Uint32Array(BINS),
    new Uint32Array(BINS)
  ];

  // 色罩基底密度
  const Dbase = maskAdj.map(m => -Math.log(Math.max(m, 0.001)));

  for (let i = 0; i < d.length; i += 4) {
    const r = Math.max(d[i]   / 255, 0.001);
    const g = Math.max(d[i+1] / 255, 0.001);
    const b = Math.max(d[i+2] / 255, 0.001);

    // 转密度域并去基底
    const Dr = Math.max(-Math.log(r) - Dbase[0], 0);
    const Dg = Math.max(-Math.log(g) - Dbase[1], 0);
    const Db = Math.max(-Math.log(b) - Dbase[2], 0);

    bins[0][Math.min(BINS-1, (Dr / D_RANGE * BINS) | 0)]++;
    bins[1][Math.min(BINS-1, (Dg / D_RANGE * BINS) | 0)]++;
    bins[2][Math.min(BINS-1, (Db / D_RANGE * BINS) | 0)]++;
  }

  // 取 0.5% ~ 99.5% 分位点，裁掉极端噪声
  const getPercentile = (bin, p) => {
    let acc = 0;
    const target = n * p;
    for (let i = 0; i < BINS; i++) {
      acc += bin[i];
      if (acc >= target) return (i / (BINS - 1)) * D_RANGE;
    }
    return D_RANGE;
  };

  return [0, 1, 2].map(ch => {
    const dMin = getPercentile(bins[ch], 0.005);
    const dMax = getPercentile(bins[ch], 0.995);
    const range = Math.max(dMax - dMin, 0.05);
    return clamp(1.0 / range, 0.1, 8.0);
  });
}

// ── 5. 白平衡（灰世界改进版） ───────────────────────────────────
/**
 * 原理：
 *   在去色罩、应用 gamma 之后的线性光域中，选取「中间调灰色区域」的像素：
 *     - 亮度在 15%~90%（排除纯黑/纯白）
 *     - 色彩饱和度（chroma）低于阈值（接近灰色）
 *   计算这些像素的 RGB 均值，求各通道增益让均值趋近相等（即"灰色"）。
 *
 *   用多个饱和度阈值尝试，确保能找到足够多的灰色像素。
 *   增益归一化到均值为 1，防止整体过曝。
 */
export function computeWhiteBalance(imgData, maskAdj, densityScale, gamma) {
  const d = imgData.data;
  const Dbase = maskAdj.map(m => -Math.log(Math.max(m, 0.001)));
  const sampleStep = Math.max(1, (d.length >> 2) / 50000 | 0);

  const thresholds = [0.04, 0.07, 0.12, 0.18, 0.25];

  for (const thr of thresholds) {
    let sR = 0, sG = 0, sB = 0, cnt = 0;

    for (let i = 0; i < d.length; i += 4 * sampleStep) {
      const r = Math.max(d[i]   / 255, 0.001);
      const g = Math.max(d[i+1] / 255, 0.001);
      const b = Math.max(d[i+2] / 255, 0.001);

      // 密度域处理（与 shader 保持一致）
      const Dr = clamp01(Math.max(-Math.log(r) - Dbase[0], 0) * densityScale[0]);
      const Dg = clamp01(Math.max(-Math.log(g) - Dbase[1], 0) * densityScale[1]);
      const Db = clamp01(Math.max(-Math.log(b) - Dbase[2], 0) * densityScale[2]);

      // 应用 gamma
      const gR = Math.pow(Dr, 1 / gamma);
      const gG = Math.pow(Dg, 1 / gamma);
      const gB = Math.pow(Db, 1 / gamma);

      const luma   = gR * 0.2126 + gG * 0.7152 + gB * 0.0722;
      const chroma = Math.max(gR, gG, gB) - Math.min(gR, gG, gB);

      if (luma > 0.15 && luma < 0.90 && chroma < thr) {
        sR += gR; sG += gG; sB += gB; cnt++;
      }
    }

    if (cnt > 150) {
      const avgR = sR / cnt, avgG = sG / cnt, avgB = sB / cnt;
      const mean = (avgR + avgG + avgB) / 3;

      let gainR = mean / Math.max(avgR, 0.001);
      let gainG = mean / Math.max(avgG, 0.001);
      let gainB = mean / Math.max(avgB, 0.001);

      // 归一化，防止整体亮度漂移
      const mg = (gainR + gainG + gainB) / 3;
      return [
        clamp(gainR / mg, 0.5, 2.5),
        clamp(gainG / mg, 0.5, 2.5),
        clamp(gainB / mg, 0.5, 2.5),
      ];
    }
  }

  return [1, 1, 1]; // 无法找到灰色区域时不做白平衡
}

// ── 主分析入口 ───────────────────────────────────────────────────
/**
 * 对 cpuCanvas 的中央 80% 区域进行底片分析
 * 返回所有分析结果，供 app.js 更新 state 并传给 render()
 */
export function analyzeFilm(cpuCanvas) {
  const ctx = cpuCanvas.getContext('2d', { willReadFrequently: true });
  const w = cpuCanvas.width, h = cpuCanvas.height;

  // 取中间 80% 避免边框/片孔干扰
  const x0 = (w * 0.1) | 0, y0 = (h * 0.1) | 0;
  const rw = (w * 0.8) | 0, rh = (h * 0.8) | 0;
  const imgData = ctx.getImageData(x0, y0, rw, rh);

  const maskRaw    = estimateBaseDensity(imgData);
  const filmType   = detectFilmType(maskRaw);
  const crossMat   = getCrosstalkMatrix(filmType);

  // 根据胶片类型微调色罩（过期胶片额外加强蓝通道恢复）
  const maskAdj = [...maskRaw];
  if (filmType === 'c41_expired') {
    maskAdj[2] = Math.min(0.998, maskAdj[2] * 1.08);
  }

  const gamma        = filmType === 'c41_expired' ? 2.2 : 1.8;
  const densityScale = computeDensityScale(imgData, maskAdj);
  const wb           = computeWhiteBalance(imgData, maskAdj, densityScale, gamma);

  return { maskRaw, maskAdj, filmType, crossMat, gamma, densityScale, wb };
}
