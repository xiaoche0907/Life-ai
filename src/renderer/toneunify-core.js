/* 批量色调统一核心（RT-08）：标准图商品区域 → 多张目标图的商品区域批量匹配。
   复用肤色统一的分位数匹配思想，但对象是商品主体（前景分割）而非皮肤规则。
   与批量改色的区别：改色是"换成参考颜色"，色调统一是"对齐标准图的曝光/白平衡/色彩倾向"，商品固有颜色保留（轻微全局色调修正）。
   纯算法、零依赖、确定性。 */
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

  // ---- 前景分割（复用比例卡的四角洪水填充）----
  function foregroundMask(p) {
    const W = p.width, H = p.height;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 400000)));
    const w2 = Math.ceil(W / step), h2 = Math.ceil(H / step);
    const bgLike = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const sx = Math.min(W - 1, x * step), sy = Math.min(H - 1, y * step), i = (sy * W + sx) * 4;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const bright = (r + g + b) / 3;
      bgLike[y * w2 + x] = (bright > 190 && sat < .3) ? 1 : 0;
    }
    const bg = new Uint8Array(w2 * h2), stack = [];
    for (const [sx0, sy0] of [[0, 0], [w2 - 1, 0], [0, h2 - 1], [w2 - 1, h2 - 1]]) {
      const s = sy0 * w2 + sx0;
      if (bgLike[s] && !bg[s]) { bg[s] = 1; stack.push(s); }
    }
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % w2, cy = (cur / w2) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue;
        const n = ny * w2 + nx;
        if (bgLike[n] && !bg[n]) { bg[n] = 1; stack.push(n); }
      }
    }
    const fg = new Uint8Array(w2 * h2);
    for (let s = 0; s < w2 * h2; s++) fg[s] = bg[s] ? 0 : 255;
    return { fg, w2, h2, step };
  }

  // ---- 商品区 Lab 统计（分位数）----
  function productStats(p, weight, opts = {}) {
    const W = p.width, H = p.height, thr = opts.weightThreshold || 128;
    const L = new Float64Array(101), A = new Float64Array(221), B = new Float64Array(221);
    let total = 0;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 450000)));
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const wi = y * W + x;
      if ((weight[wi] || 0) < thr) continue;
      const i = wi * 4;
      const [l, a, b] = rgbLab(p.data[i], p.data[i + 1], p.data[i + 2]);
      const lb = clamp(Math.round(l / 2), 0, 100), ab = clamp(Math.round(a) + 110, 0, 220), bb = clamp(Math.round(b) + 110, 0, 220);
      L[lb]++; A[ab]++; B[bb]++; total++;
    }
    if (total < 64) throw Error('商品样本不足（前景分割失败或商品过小）');
    const q = (hist, max, qs, scale, offset) => {
      const out = []; let acc = 0, idx = 0;
      for (let k = 0; k <= max; k++) {
        acc += hist[k];
        while (idx < qs.length && acc >= qs[idx] * total) { out.push(k * scale + offset); idx++; }
      }
      while (out.length < qs.length) out.push(max * scale + offset);
      return out;
    };
    return { samples: total, L: q(L, 100, [.05, .25, .5, .75, .95], 2, 0), a: q(A, 220, [.25, .5, .75], 1, -110), b: q(B, 220, [.25, .5, .75], 1, -110) };
  }

  // ---- 全图权重（fg放大）----
  function fgWeight(seg, W, H) {
    const w = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(seg.h2 - 1, (y / seg.step) | 0);
      for (let x = 0; x < W; x++) {
        const sx = Math.min(seg.w2 - 1, (x / seg.step) | 0);
        w[y * W + x] = seg.fg[sy * seg.w2 + sx];
      }
    }
    return w;
  }

  // ---- 匹配模型（亮度/色度分离，强度控制；保商品固有色的温和修正）----
  function fitModel(srcStats, refStats, options = {}) {
    const strength = clamp(options.strength === undefined ? .8 : options.strength, 0, 1);
    const lightStrength = clamp(options.lightStrength === undefined ? .7 : options.lightStrength, 0, 1);
    const lightDelta = refStats.L[2] - srcStats.L[2];
    const midL = srcStats.L[2] + lightDelta * lightStrength;
    const midA = srcStats.a[1] + (refStats.a[1] - srcStats.a[1]) * strength;
    const midB = srcStats.b[1] + (refStats.b[1] - srcStats.b[1]) * strength;
    const soft = (v, c, t, slope, room) => {
      const delta = (v - c) * slope;
      return t + room * Math.tanh(delta / Math.max(.01, room));
    };
    const lMap = x => soft(x, srcStats.L[2], midL, .9, 120);
    const aMap = v => soft(v, srcStats.a[1], midA, 1 - .1 * strength, 110);
    const bMap = v => soft(v, srcStats.b[1], midB, 1 - .1 * strength, 110);
    return { lightDelta, strength, lMap, aMap, bMap, src: srcStats, ref: refStats, method: 'tone-unify-quantile' };
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

  // ---- 渲染（商品区内应用；带可选商品色保护：接近参考商品色的像素减弱处理）----
  function render(p, seg, model, options = {}) {
    const W = p.width, H = p.height;
    const out = new Uint8ClampedArray(p.data);
    const refMid = model.ref;
    for (let y = 0; y < H; y++) {
      const sy = Math.min(seg.h2 - 1, (y / seg.step) | 0);
      for (let x = 0; x < W; x++) {
        const sx = Math.min(seg.w2 - 1, (x / seg.step) | 0);
        if (!seg.fg[sy * seg.w2 + sx]) continue;
        const i = (y * W + x) * 4;
        const [L, A, B] = rgbLab(p.data[i], p.data[i + 1], p.data[i + 2]);
        // 商品色保护：本像素色度接近参考商品中位色度 → 是商品标准色，减弱处理
        const nearRefColor = Math.abs(A - refMid.a[1]) < 8 && Math.abs(B - refMid.b[1]) < 8;
        const k = nearRefColor ? .3 : 1;
        const [r, g, b] = labRgb(model.lMap(L), model.aMap(A) * k + A * (1 - k), model.bMap(B) * k + B * (1 - k));
        out[i] = r; out[i + 1] = g; out[i + 2] = b;
      }
    }
    return { width: W, height: H, data: out };
  }

  // ---- 快捷入口 ----
  function analyzeRef(p) {
    const seg = foregroundMask(p);
    const w = fgWeight(seg, p.width, p.height);
    const stats = productStats(p, w);
    return { seg, stats };
  }
  function applyToTarget(p, refStats, options) {
    const seg = foregroundMask(p);
    const w = fgWeight(seg, p.width, p.height);
    const srcStats = productStats(p, w);
    const model = fitModel(srcStats, refStats, options);
    const out = render(p, seg, model, options);
    return { out, model, coverage: seg.fg.reduce((s, v) => s + (v ? 1 : 0), 0) / (seg.w2 * seg.h2) };
  }

  const api = { foregroundMask, productStats, fgWeight, fitModel, render, analyzeRef, applyToTarget, rgbLab };
  root.ToneUnify = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
