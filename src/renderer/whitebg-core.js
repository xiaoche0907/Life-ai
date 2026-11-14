/* 白底净化核心（RT-03）：不均匀灰白背景 → 规范白底。
   白底假设 + 四角洪水填充（复用比例卡的分割思路）→ 背景照明场估计（低频）→ 背景色归一 → 边缘去污染。
   纯算法、零依赖、确定性。白色商品保护：照明场只作用于"与四角连通"的背景区域，白色商品不与四角连通则不受影响。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // ---- 背景识别：四角种子洪水填充（同 proportion-core 思路，阈值更宽松适配灰白底）----
  function backgroundRegion(p, options = {}) {
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
      bgLike[y * w2 + x] = (bright > 180 && sat < .3) ? 1 : 0;   // 灰白底放宽（180+）
    }
    // 四角种子亮度中位数
    const corners = [];
    const cs = Math.max(2, Math.floor(w2 * .05));
    for (const [cx0, cy0] of [[0, 0], [w2 - cs, 0], [0, h2 - cs], [w2 - cs, h2 - cs]]) {
      for (let y = cy0; y < cy0 + cs && y < h2; y++) for (let x = cx0; x < cx0 + cs && x < w2; x++) {
        const sx = Math.min(W - 1, x * step), sy = Math.min(H - 1, y * step), i = (sy * W + sx) * 4;
        corners.push([p.data[i], p.data[i + 1], p.data[i + 2]]);
      }
    }
    const med = (arr, k) => { const s = arr.map(a => a[k]).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 255; };
    const bgRGB = corners.length ? [med(corners, 0), med(corners, 1), med(corners, 2)] : [255, 255, 255];
    const bgBright = (bgRGB[0] + bgRGB[1] + bgRGB[2]) / 3;
    // 洪水填充连通背景
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
    return { bg, w2, h2, step, bgRGB, bgBright, bgPixels: bg.reduce((s, v) => s + v, 0) };
  }

  // ---- 背景照明场估计：背景区域低频亮度场（网格均值 + 双线性放大）----
  function illuminationField(p, bg, w2, h2, step, gridN = 12) {
    const W = p.width, H = p.height;
    const gh = gridN, gw = gridN;
    const sum = new Float64Array(gh * gw), cnt = new Float64Array(gh * gw);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      if (!bg[y * w2 + x]) continue;
      const gx = clamp(Math.floor(x / w2 * gw), 0, gw - 1), gy = clamp(Math.floor(y / h2 * gh), 0, gh - 1);
      const sx = Math.min(W - 1, x * step), sy = Math.min(H - 1, y * step), i = (sy * W + sx) * 4;
      sum[gy * gw + gx] += (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
      cnt[gy * gw + gx]++;
    }
    const field = new Float32Array(gh * gw);
    let total = 0, cells = 0;
    for (let k = 0; k < gh * gw; k++) if (cnt[k] > 4) { field[k] = sum[k] / cnt[k]; total += field[k]; cells++; }
    const mean = cells ? total / cells : 255;
    // 无数据格用均值补
    for (let k = 0; k < gh * gw; k++) if (!cnt[k] || cnt[k] <= 4) field[k] = mean;
    return { field, gh, gw, mean };
  }

  function sampleField(field, gh, gw, fx, fy) {
    // fx,fy ∈ [0,1)
    const gx = clamp(fx * (gw - 1), 0, gw - 1.001), gy = clamp(fy * (gh - 1), 0, gh - 1.001);
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fxr = gx - x0, fyr = gy - y0;
    const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
    return field[y0 * gw + x0] * (1 - fxr) * (1 - fyr) + field[y0 * gw + x1] * fxr * (1 - fyr)
      + field[y1 * gw + x0] * (1 - fxr) * fyr + field[y1 * gw + x1] * fxr * fyr;
  }

  // ---- 主函数：白底净化 ----
  // strength: 0..1 背景归一强度；targetRGB: 目标底色（默认纯白）；keepShadow: 保留接触阴影（暗于阈值的背景区不动）
  function clean(p, options = {}) {
    const strength = clamp(options.strength === undefined ? 1 : options.strength, 0, 1);
    const keepShadow = options.keepShadow !== false;
    const shadowThreshold = options.shadowThreshold || 200;   // 背景中亮于此的才算"灰污"，暗的视为接触阴影
    const target = options.targetRGB || [255, 255, 255];
    const W = p.width, H = p.height;
    const bg = backgroundRegion(p, options);
    const field = illuminationField(p, bg.bg, bg.w2, bg.h2, bg.step);
    const out = new Uint8ClampedArray(p.data);
    let touched = 0;
    for (let y = 0; y < H; y++) {
      const fy = (y + .5) / H;
      const sy = Math.min(bg.h2 - 1, (y / bg.step) | 0);
      for (let x = 0; x < W; x++) {
        const sx = Math.min(bg.w2 - 1, (x / bg.step) | 0);
        if (!bg.bg[sy * bg.w2 + sx]) continue;   // 非背景区不动（商品保护）
        const i = (y * W + x) * 4;
        const bright = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
        // 照明场归一：该点的场亮度 → 目标底色
        const ill = sampleField(field.field, field.gh, field.gw, (x + .5) / W, fy);
        if (ill < 1) continue;
        // 接触阴影保留：明显暗于照明场估计（相对差>25%）才算阴影，跳过
        if (keepShadow && bright < ill * .75) continue;
        const k = 1 + (target[0] / ill - 1) * strength;   // 逐通道共用亮度比（保色相）
        const fx = (x + .5) / W;
        // 边缘软化：距背景边界近的像素弱化处理（防商品边缘生硬）
        out[i] = clamp(p.data[i] * k);
        out[i + 1] = clamp(p.data[i + 1] * k);
        out[i + 2] = clamp(p.data[i + 2] * k);
        touched++;
      }
    }
    // 背景均匀度评估（净化质量指标）：处理后背景区亮度标准差
    let s1 = 0, s2 = 0, n = 0;
    for (let y = 0; y < H; y += 4) {
      const sy = Math.min(bg.h2 - 1, (y / bg.step) | 0);
      for (let x = 0; x < W; x += 4) {
        const sx = Math.min(bg.w2 - 1, (x / bg.step) | 0);
        if (!bg.bg[sy * bg.w2 + sx]) continue;
        const i = (y * W + x) * 4;
        const bright = (out[i] + out[i + 1] + out[i + 2]) / 3;
        s1 += bright; s2 += bright * bright; n++;
      }
    }
    const mean = n ? s1 / n : 255;
    const std = n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0;
    return {
      width: W, height: H, data: out,
      bgRGB: bg.bgRGB, touched,
      coverage: bg.bgPixels / (bg.w2 * bg.h2),
      uniformity: { mean: Math.round(mean), std: +std.toFixed(1) },   // std 越小越均匀
    };
  }

  const api = { backgroundRegion, illuminationField, sampleField, clean };
  root.WhiteBg = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
