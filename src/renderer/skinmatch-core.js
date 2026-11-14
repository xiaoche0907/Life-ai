/* 肤色统一核心 —— 皮肤分割（YCbCr/Lab 规则 + 连通域）与 Lab 分位数匹配。
   纯函数、零依赖、无随机：同输入必同输出。不使用语义 AI；分割结果带置信度，支持人工修正。
   输出为原生调整层配方（复用 recolor-native.js 的六类图层描述符）。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));
  const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const srgb = v => 255 * (v <= .0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - .055);

  function rgbLab(r, g, b) {
    r = lin(r); g = lin(g); b = lin(b);
    const f = v => v > .00885645168 ? Math.cbrt(v) : 7.787037 * v + 16 / 116;
    const x = f((.4124564 * r + .3575761 * g + .1804375 * b) / .95047),
      y = f(.2126729 * r + .7151522 * g + .072175 * b),
      z = f((.0193339 * r + .119192 * g + .9503041 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  // ---- 皮肤规则分割 ----
  // YCbCr (BT.601) 规则 + Lab 规则。规则分割不可能完全准确；输出 confidence 供 UI 提示人工修正。
  function skinProbability(r, g, b) {
    const Y = .299 * r + .587 * g + .114 * b,
      Cb = 128 - .168736 * r - .331264 * g + .5 * b,
      Cr = 128 + .5 * r - .418688 * g - .081312 * b;
    const [L, a, bch] = rgbLab(r, g, b);
    // 红布料判别：R/B 比值过高（红布料>3.2，皮肤一般<2.6）或饱和度过高时排除
    const rbRatio = r / Math.max(1, b);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (rbRatio > 3.0 && saturation > .5) return 0;   // 高饱和强红=布料
    // 交集策略：YCbCr 与 Lab 双重命中才高分，显著降低红布料误检
    const yccLoose = Y > 40 && 77 <= Cb && Cb <= 135 && 133 <= Cr && Cr <= 178;
    const yccTight = Y > 60 && 80 <= Cb && Cb <= 125 && 138 <= Cr && Cr <= 172;
    const labLoose = L > 25 && 8 <= a && a <= 36 && 8 <= bch && bch <= 42;
    if (yccTight && labLoose) return 1;
    if (yccLoose && labLoose) return .85;
    if (yccTight) return .6;
    if (yccLoose) return .45;
    return 0;
  }

  // 全图皮肤概率 + 连通域清理（一遍收集成员，小域成员清零）。
  // 返回 { probSmall(0..100 Uint8), w2, h2, step, confidence, coverage, keptDomains, domains }。
  function segmentSkin(p, options = {}) {
    const W = p.width, H = p.height;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 900000)));
    const w2 = Math.ceil(W / step), h2 = Math.ceil(H / step);
    const probSmall = new Uint8Array(w2 * h2);
    const probThreshold = (options.probThreshold === undefined ? 60 : options.probThreshold);   // 低于此概率直接排除
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const sx = Math.min(W - 1, x * step), sy = Math.min(H - 1, y * step), i = (sy * W + sx) * 4;
      if (p.data[i + 3] < 40) continue;
      const p100 = Math.round(skinProbability(p.data[i], p.data[i + 1], p.data[i + 2]) * 100);
      probSmall[y * w2 + x] = p100 >= probThreshold ? p100 : 0;
    }
    const minAreaSmall = Math.max(16, Math.round((options.minArea || Math.max(256, W * H * .0004)) / (step * step)));
    const visited = new Uint8Array(w2 * h2), stack = [], members = [];
    let totalPixels = 0, weightedSum = 0, keptPixels = 0, keptWeighted = 0, domains = 0, keptDomains = 0;
    for (let start = 0; start < w2 * h2; start++) {
      if (!probSmall[start] || visited[start]) continue;
      let area = 0, sum = 0;
      stack.length = 0; members.length = 0;
      stack.push(start); visited[start] = 1; members.push(start);
      while (stack.length) {
        const cur = stack.pop(); area++; sum += probSmall[cur];
        const cx = cur % w2, cy = (cur / w2) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue;
          const n = ny * w2 + nx;
          if (probSmall[n] && !visited[n]) { visited[n] = 1; stack.push(n); members.push(n); }
        }
      }
      totalPixels += area; weightedSum += sum; domains++;
      if (area >= minAreaSmall) { keptPixels += area; keptWeighted += sum; keptDomains++; }
      else for (const m of members) probSmall[m] = 0; // 清除噪点域
    }
    const coverage = totalPixels / (w2 * h2);
    const meanProb = keptPixels > 0 ? keptWeighted / keptPixels : 0;
    const keptRatio = totalPixels > 0 ? keptPixels / totalPixels : 0;
    const confidence = clamp(meanProb / 100 * (.5 + .5 * keptRatio), 0, 1);
    return { probSmall, w2, h2, step, confidence, coverage, keptDomains, domains, keptPixels };
  }

  // 概率图放大回全尺寸蒙版权重（0..255 Uint8），再叠加人工修正：
  //   userMask: 与源图同尺寸 Uint8（255=强制保留，0=强制排除，128=不干预）。可选。
  function upsampleMask(seg, W, H, userMask) {
    const out = new Uint8Array(W * H);
    const { probSmall, w2, h2, step } = seg;
    for (let y = 0; y < H; y++) {
      const sy = Math.min(h2 - 1, (y / step) | 0);
      for (let x = 0; x < W; x++) {
        const sx = Math.min(w2 - 1, (x / step) | 0);
        let v = probSmall[sy * w2 + sx];
        if (userMask) {
          const u = userMask[y * W + x];
          if (u === 255) v = 100; else if (u === 0) v = 0;
        }
        out[y * W + x] = v ? Math.round(v * 2.55) : 0;
      }
    }
    return out;
  }

  // ---- Lab 分位数统计（皮肤区域内）----
  // weight: Uint8 0..255 蒙版权重；weightThreshold 以下不参与统计
  function skinStats(p, weight, opts = {}) {
    const W = p.width, H = p.height, thr = opts.weightThreshold || 128;
    const L = new Float64Array(101), A = new Float64Array(221), B = new Float64Array(221); // L*2 bin / a+110 / b+110
    let total = 0;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 450000)));
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const wi = y * W + x;
      if ((weight[wi] || 0) < thr) continue;
      const i = wi * 4;
      if (p.data[i + 3] < 40) continue;
      const [l, a, b] = rgbLab(p.data[i], p.data[i + 1], p.data[i + 2]);
      const lb = clamp(Math.round(l / 2), 0, 100), ab = clamp(Math.round(a) + 110, 0, 220), bb = clamp(Math.round(b) + 110, 0, 220);
      const w = weight[wi] / 255;
      L[lb] += w; A[ab] += w; B[bb] += w;
      total += w;
    }
    if (total < 64) throw Error('皮肤样本不足：请扩大皮肤区域或降低蒙版阈值');
    const q = (hist, max, qs, scale, offset) => {
      const out = []; let acc = 0, idx = 0;
      for (let k = 0; k <= max; k++) {
        acc += hist[k];
        while (idx < qs.length && acc >= qs[idx] * total) { out.push(k * scale + offset); idx++; }
      }
      while (out.length < qs.length) out.push(max * scale + offset);
      return out;
    };
    return {
      samples: Math.round(total),
      L: q(L, 100, [.05, .25, .5, .75, .95], 2, 0),          // L 分位 p05..p95
      a: q(A, 220, [.25, .5, .75], 1, -110),                  // a 分位
      b: q(B, 220, [.25, .5, .75], 1, -110),                  // b 分位
    };
  }

  // ---- 匹配模型：把源皮肤分布映射到参考皮肤分布 ----
  // 分位数对齐 + 强度混合。亮/色分离：亮度只映射 L，颜色只映射 a/b。
  // 光照差异过大时（refL05 与 srcL05 差 > 25）建议 hueOnly，由调用方决定。
  function fitSkinModel(srcStats, refStats, options = {}) {
    const cs = clamp(options.colorStrength === undefined ? .8 : options.colorStrength, 0, 1);
    const ls = clamp(options.lightStrength === undefined ? .7 : options.lightStrength, 0, 1);
    const lightDelta = refStats.L[2] - srcStats.L[2]; // 中位 L 差
    const hueShiftOnly = options.hueOnly === true;
    const slopeL = hueShiftOnly ? 1 : clamp(1 + ((refStats.L[3] - refStats.L[1]) / Math.max(1, srcStats.L[3] - srcStats.L[1]) - 1) * ls, .6, 1.5);
    const midL = hueShiftOnly ? srcStats.L[2] : srcStats.L[2] + lightDelta * ls;
    // L 映射：p25/p50/p75 三点软对齐（ tanh 软限幅避免高光变灰/阴影变脏 ）
    const srcL = [srcStats.L[1], srcStats.L[2], srcStats.L[3]], refL = [srcStats.L[1] + (refStats.L[1] - srcStats.L[1]) * ls, midL, srcStats.L[3] + (refStats.L[3] - srcStats.L[3]) * ls];
    const lMap = x => {
      const c = srcL[1], target = refL[1];
      const slope = slopeL;
      const delta = (x - c) * slope;
      const room = delta < 0 ? Math.max(.01, target) : Math.max(.01, 255 - target); // L 上限 100，够用
      return target + room * Math.tanh(delta / room);
    };
    // a/b 映射：中位平移 + 软限幅
    const midA = srcStats.a[1] + (refStats.a[1] - srcStats.a[1]) * cs,
      midB = srcStats.b[1] + (refStats.b[1] - srcStats.b[1]) * cs;
    const abMap = (v, srcMid, refMid) => {
      const delta = (v - srcMid) * (1 - .12 * cs);
      const target = refMid;
      const room = delta < 0 ? Math.max(.01, target + 110) : Math.max(.01, 110 - target);
      return target + room * Math.tanh(delta / Math.max(1, room));
    };
    const aMap = v => abMap(v, srcStats.a[1], midA);
    const bMap = v => abMap(v, srcStats.b[1], midB);
    return {
      lightDelta, hueShiftOnly, cs, ls,
      lMap, aMap, bMap,
      src: srcStats, ref: refStats,
      method: 'skin-quantile-soft',
    };
  }

  // 像素预览：逐像素应用模型（仅权重处），供卡片预览
  function renderToImageData(src, weight, model) {
    const W = src.width, H = src.height, out = new Uint8ClampedArray(src.data);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const wi = y * W + x, w = weight[wi] / 255;
      const i = wi * 4, a = src.data[i + 3] / 255;
      if (w <= 0 || a <= 0) continue;
      const [L, A, B] = rgbLab(src.data[i], src.data[i + 1], src.data[i + 2]);
      const [r, g, b] = labRgb(model.lMap(L), model.aMap(A), model.bMap(B));
      out[i] = Math.round(src.data[i] + (r - src.data[i]) * w);
      out[i + 1] = Math.round(src.data[i + 1] + (g - src.data[i + 1]) * w);
      out[i + 2] = Math.round(src.data[i + 2] + (b - src.data[i + 2]) * w);
    }
    return { width: W, height: H, data: out };
  }

  function labRgb(L, a, b) {
    const fy = (L + 16) / 116, inv = t => t > .2068965517 ? t * t * t : (t - 16 / 116) / 7.787037;
    function convert(scale) {
      const x = .95047 * inv(fy + a * scale / 500), y = inv(fy), z = 1.08883 * inv(fy - b * scale / 200);
      return [3.2404542 * x - 1.5371385 * y - .4985314 * z, -.969266 * x + 1.8760108 * y + .041556 * z, .0556434 * x - .2040259 * y + 1.0572252 * z];
    }
    let c = convert(1);
    if (c.some(v => v < -.00005 || v > 1.00005)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2, tryC = convert(mid);
        if (tryC.every(v => v >= 0 && v <= 1)) lo = mid; else hi = mid;
      }
      c = convert(lo);
    }
    return c.map(v => Math.round(clamp(srgb(clamp(v, 0, 1)), 0, 255)));
  }

  // ---- 原生调整层配方 ----
  // 肤色专用：将 Lab 映射转换为 RGB 查表，再表达为 PS 原生层。
  // 结构（从底到顶）：明度曲线（luminosity）→ 颜色曲线（color 模式 RGB 曲线）。
  // 不用纯色填充/通道混合器：肤色匹配要求保留纹理与高光层次，逐灰阶查表比全屏混色更温和。
  function buildNativeRecipe(model, options = {}) {
    const strength = clamp(options.strength === undefined ? 1 : options.strength, 0, 1);
    // 源皮肤亮度范围（p05..p95）之外不动：保护背景/头发/暗部
    const lo = clamp(model.src.L[0] - 10, 0, 100), hi = clamp(model.src.L[4] + 10, 0, 100);
    const lo255 = Math.max(0, Math.round(labRgb(lo, 0, 0)[1] - 6)), hi255 = Math.min(255, Math.round(labRgb(hi, 0, 0)[1] + 6));
    // 采样源皮肤中位 a/b 处的 RGB 色调，建立 256 级 LUT
    const lutR = new Float64Array(256), lutG = new Float64Array(256), lutB = new Float64Array(256);
    for (let v = 0; v < 256; v++) {
      // 以该灰度为近似 L，源皮肤中位色度作为 a/b 采样点
      const L = clamp(Math.round((v / 255) * 100), 0, 100);
      const target = labRgb(model.lMap(L), model.aMap(model.src.a[1]), model.bMap(model.src.b[1]));
      const source = labRgb(L, model.src.a[1], model.src.b[1]);
      // 只取色度差（RGB 差值），混合 strength；并减去源亮度基准使色度差在自身灰阶上叠加
      lutR[v] = v + (target[0] - source[0]) * strength;
      lutG[v] = v + (target[1] - source[1]) * strength;
      lutB[v] = v + (target[2] - source[2]) * strength;
    }
    // 转曲线点：采样 17 个等距点 + 边界；区间外强制恒等（保护非皮肤亮度）
    const sample = lut => {
      const xs = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];
      return xs.map(x => {
        let out;
        if (x <= lo255 || x >= hi255) out = x;
        else out = Math.round(clamp(lut[x], 0, 255));
        return { input: x, output: clamp(out, 0, 255) };
      });
    };
    const channels = [sample(lutR), sample(lutG), sample(lutB)];
    // 单调性修正：输出必须非降（曲线描述符要求可渲染；PS 容忍轻微非单调但安全优先）
    for (const ch of channels) for (let i = 1; i < ch.length; i++) if (ch[i].output < ch[i - 1].output) ch[i].output = ch[i - 1].output;
    const identityCurve = () => [{ input: 0, output: 0 }, { input: 255, output: 255 }];
    const layers = [];
    if (!options.skipLight) layers.push({ name: '肤色明度—曲线', kind: 'curves', blend: 'luminosity', opacity: 1, fillOpacity: 1, channels: [sampleL(model, lo255, hi255)] });
    layers.push({ name: '肤色颜色—RGB曲线', kind: 'curves', blend: 'color', opacity: 1, fillOpacity: 1, channels: [identityCurve(), ...channels] });
    return { version: 1, mode: 'mode1', algorithm: 'skinmatch-native-v1', layers };
  }

  // L 曲线：Lab 亮度映射 → RGB 合成通道曲线（luminosity 混合下只影响明度）
  function sampleL(model, lo255, hi255) {
    const xs = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];
    const pts = xs.map(x => {
      if (x <= lo255 || x >= hi255) return { input: x, output: x };
      const L = clamp(Math.round((x / 255) * 100), 0, 100);
      const srcRgb = labRgb(L, 0, 0); // 中性灰基准
      const mapped = labRgb(model.lMap(L), 0, 0);
      const srcLum = Math.round((srcRgb[0] + srcRgb[1] + srcRgb[2]) / 3);
      const mappedLum = Math.round((mapped[0] + mapped[1] + mapped[2]) / 3);
      return { input: x, output: clamp(x + (mappedLum - srcLum), 0, 255) };
    });
    for (let i = 1; i < pts.length; i++) if (pts[i].output < pts[i - 1].output) pts[i].output = pts[i - 1].output;
    return pts;
  }

  const api = { skinProbability, segmentSkin, upsampleMask, skinStats, fitSkinModel, renderToImageData, buildNativeRecipe, rgbLab, labRgb };
  root.SkinMatch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
