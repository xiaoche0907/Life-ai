/* P2 高级局部精修核心：多尺度频率分解共享底座。
   RT-11 褶皱优化：低频亮度修正（压平褶皱暗斑）+ 高频纹理保留
   RT-12 皮肤质感：色斑均匀（低频）+ 瑕疵修复 + 高频纹理保留（防塑料感）
   RT-13 材质增强：高频细节放大（局部对比度增强）+ 边缘保护
   共享：引导滤波近似（盒均值分解）/ 频率重组 / 确定性。
   限制：不改版型/缝线/设计褶皱——通过"处理强度区域化"（褶皱特征=狭长暗带，与设计特征区分弱，最终靠用户预览确认）。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // ---- 盒均值（积分图）----
  function boxMeanGray(gray, W, H, radius) {
    const integral = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let rowSum = 0;
      for (let x = 0; x < W; x++) {
        rowSum += gray[y * W + x];
        integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + rowSum;
      }
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(H - 1, y + radius);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(W - 1, x + radius);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const s = integral[(y1 + 1) * (W + 1) + x1 + 1] - integral[y0 * (W + 1) + x1 + 1] - integral[(y1 + 1) * (W + 1) + x0] + integral[y0 * (W + 1) + x0];
        out[y * W + x] = s / area;
      }
    }
    return out;
  }

  function toGray(p) {
    const W = p.width, H = p.height, g = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) { const i = k * 4; g[k] = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3; }
    return g;
  }

  // ---- RT-11 褶皱优化：低频压平 + 高频纹理保留 ----
  // 狭长暗褶皱=中尺度（radius 3~6%边长）的低频凹陷。将中低频向背景水平提拉，高频（布纹）保留。
  function wrinkleReduce(p, options = {}) {
    const strength = clamp(options.strength === undefined ? .6 : options.strength, 0, 1);
    const textureKeep = clamp(options.textureKeep === undefined ? .8 : options.textureKeep, 0, 1);
    const W = p.width, H = p.height;
    const gray = toGray(p);
    const r1 = Math.max(4, Math.round(Math.min(W, H) * .02));
    const r2 = Math.max(10, Math.round(Math.min(W, H) * .07));
    const small = boxMeanGray(gray, W, H, r1);    // 保留布纹的基线
    const large = boxMeanGray(gray, W, H, r2);    // 大尺度照明/褶皱趋势
    // 褶皱暗斑 = large 与背景水平的差。修正：把 large 中的凹陷（相对区域高分位）抬回
    // 简化实现：out = small + (large - flat)，flat = large 的局部最大（对暗褶皱提亮）
    // 更稳做法：detail = gray - small（高频布纹）；base = small；
    //   褶皱修正：base' = base + (large - base) * strength * (large < base ? 提亮 : 保留)
    //   即暗的低频凹陷按 strength 向 small 收敛。
    const out = new Uint8ClampedArray(p.data);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, i = k * 4;
      const detail = gray[k] - small[k];                          // 高频布纹
      const low = small[k] - large[k];                            // 低频偏差（负=暗斑）
      // 暗褶皱修正：低频暗偏差按 strength 收敛
      const corrected = low * (low < 0 ? (1 - strength) : 1);
      const newBase = large[k] + corrected;
      const newGray = newBase + detail * textureKeep + (1 - textureKeep) * 0;
      const ratio = gray[k] > 0 ? newGray / gray[k] : 1;
      out[i] = clamp(p.data[i] * ratio);
      out[i + 1] = clamp(p.data[i + 1] * ratio);
      out[i + 2] = clamp(p.data[i + 2] * ratio);
    }
    return { width: W, height: H, data: out, touched: W * H };
  }

  // ---- RT-12 皮肤质感：色斑均匀 + 瑕疵修复 + 纹理保留 ----
  // 频率分离：低频（色斑/暗沉）轻度均匀化 + 高频（毛孔纹理）全保留；明显孤立瑕疵点修复。
  function skinTexture(p, options = {}) {
    const evenness = clamp(options.evenness === undefined ? .5 : options.evenness, 0, 1);
    const textureKeep = clamp(options.textureKeep === undefined ? .9 : options.textureKeep, 0, 1);
    const defectFix = options.defectFix !== false;
    const W = p.width, H = p.height;
    const gray = toGray(p);
    const rLow = Math.max(6, Math.round(Math.min(W, H) * .045));
    const low = boxMeanGray(gray, W, H, rLow);
    // 先做孤立瑕疵修复（复用去油光的缺陷检测思路——局部离群且小）
    let inpainted = p;
    if (defectFix) {
      const DC = (typeof root !== 'undefined' && root.DefectClean) ? root.DefectClean : (typeof module !== 'undefined' && module.exports ? require('./defectclean-core.js') : null);
      if (DC) {
        const det = DC.detect(p, { sensitivity: .6 });
        inpainted = DC.inpaint(p, det.mask);
      }
    }
    // 低频均匀化：把 low 的波动向其均值收敛 evenness（只动色斑不动纹理）
    let s = 0, n = 0;
    for (let k = 0; k < W * H; k++) { s += low[k]; n++; }
    const meanLow = s / n;
    const out = new Uint8ClampedArray(inpainted.data);
    const grayNew = toGray(inpainted);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, i = k * 4;
      const detail = grayNew[k] - low[k];
      const corrected = meanLow + (low[k] - meanLow) * (1 - evenness);
      const newGray = corrected + detail * textureKeep + (detail) * (1 - textureKeep) * 0;
      const ratio = grayNew[k] > 0 ? newGray / grayNew[k] : 1;
      out[i] = clamp(inpainted.data[i] * ratio);
      out[i + 1] = clamp(inpainted.data[i + 1] * ratio);
      out[i + 2] = clamp(inpainted.data[i + 2] * ratio);
    }
    return { width: W, height: H, data: out };
  }

  // ---- RT-13 材质增强：高频细节放大（非锐化掩模思想）+ 强边缘保护 ----
  function materialEnhance(p, options = {}) {
    const strength = clamp(options.strength === undefined ? .5 : options.strength, 0, 1);
    const W = p.width, H = p.height;
    const gray = toGray(p);
    const r = Math.max(2, Math.round(Math.min(W, H) * .008));
    const low = boxMeanGray(gray, W, H, r);
    const out = new Uint8ClampedArray(p.data);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, i = k * 4;
      const detail = gray[k] - low[k];
      // 强边缘保护：|detail|过大的轮廓不放大（防光晕）
      const boosted = Math.abs(detail) > 40 ? detail : detail * (1 + strength * 1.2);
      const newGray = low[k] + boosted;
      const ratio = gray[k] > 0 ? newGray / gray[k] : 1;
      out[i] = clamp(p.data[i] * ratio);
      out[i + 1] = clamp(p.data[i + 1] * ratio);
      out[i + 2] = clamp(p.data[i + 2] * ratio);
    }
    return { width: W, height: H, data: out };
  }

  const api = { boxMeanGray, toGray, wrinkleReduce, skinTexture, materialEnhance };
  root.RetouchP2 = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
