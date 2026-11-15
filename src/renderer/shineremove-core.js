/* 智能去油光核心（RT-07）：局部高光检测 + 亮度压制 + 纹理保留。
   原理：油光=局部区域显著亮于周围环境（局部对比异常）且高饱和反射。用"像素亮度 - 局部均值"检测异常亮点，
   对超阈值部分按强度压向局部均值（漫反射估计），纹理通过保留中频细节维持。
   纯算法、零依赖、确定性。金属/珠宝的镜面反射靠"保护高亮区"参数（用户排除区）处理。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // ---- 局部均值场（盒滤波近似，两遍积分图）----
  function boxMean(p, radius) {
    const W = p.width, H = p.height;
    // 灰度积分图
    const integral = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let rowSum = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        rowSum += (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
        integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + rowSum;
      }
    }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - radius), y1 = Math.min(H - 1, y + radius);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(W - 1, x + radius);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const s = integral[(y1 + 1) * (W + 1) + x1 + 1] - integral[y0 * (W + 1) + x1 + 1]
          - integral[(y1 + 1) * (W + 1) + x0] + integral[y0 * (W + 1) + x0];
        out[y * W + x] = s / area;
      }
    }
    return out;
  }

  // ---- 主函数：去油光 ----
  // sensitivity: 0..1 检测灵敏度（越高越多像素被判定为油光）
  // strength: 0..1 压制强度（0=不动）
  // textureKeep: 0..1 纹理保留（压向均值时保留多少中频细节）
  // protectSpecular: 保护极亮镜面区（亮度>248 不动，金属/珠宝反射）
  function removeShine(p, options = {}) {
    const sensitivity = clamp(options.sensitivity === undefined ? .5 : options.sensitivity, 0, 1);
    const strength = clamp(options.strength === undefined ? .8 : options.strength, 0, 1);
    const textureKeep = clamp(options.textureKeep === undefined ? .6 : options.textureKeep, 0, 1);
    const protectSpecular = options.protectSpecular !== false;
    const W = p.width, H = p.height;
    // 双层均值：大半径=全局照明基准（油光斑再大也抬不动它），小半径=局部环境
    const bigR = options.bigRadius || Math.max(20, Math.round(Math.min(W, H) * .3));
    const radius = options.radius || Math.max(6, Math.round(Math.min(W, H) * .06));
    const meanBig = boxMean(p, bigR);
    const meanSmall = boxMean(p, radius);
    // 异常基准：全图“亮-大均值”的偏差 σ（油光在全局尺度上是离群值）
    let sum = 0, sum2 = 0, n = 0;
    for (let k = 0; k < W * H; k++) {
      const i = k * 4;
      const b = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
      const d = b - meanBig[k];
      sum += d; sum2 += d * d; n++;
    }
    const std = Math.sqrt(Math.max(0, sum2 / n - (sum / n) * (sum / n)));
    const threshold = Math.max(8, std * (2.2 - sensitivity * 1.7));   // 2.2σ → 0.5σ
    const out = new Uint8ClampedArray(p.data);
    let touched = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, i = k * 4;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const bright = (r + g + b) / 3;
      const excess = bright - meanBig[k];          // 相对全局照明的超出量
      if (excess <= threshold) continue;           // 非油光
      if (protectSpecular && bright > 248) continue;   // 镜面保护
      // 压制目标：全局照明水平（斑污染不了大半径均值基准）；小均值仅用于保留局部纹理
      const env = meanBig[k];
      const press = (bright - env) * strength;
      if (press <= 0) continue;
      // 纹理保留：保留部分压制的量（相对小均值的波动不抹平）
      const keep = press * textureKeep;
      const target = bright - press + keep;
      const ratio = bright > 0 ? target / bright : 1;
      out[i] = clamp(r * ratio);
      out[i + 1] = clamp(g * ratio);
      out[i + 2] = clamp(b * ratio);
      touched++;
    }
    return { width: W, height: H, data: out, touched, threshold: Math.round(threshold), radius };
  }

  // ---- 像素预览辅助：油光区域掩码（供卡片叠加显示）----
  function shineMask(p, options = {}) {
    const r = removeShine(p, { ...options, strength: 1 });
    const W = r.width, H = r.height;
    const mask = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
      const i = k * 4;
      const diff = Math.abs(r.data[i] - p.data[i]) + Math.abs(r.data[i + 1] - p.data[i + 1]) + Math.abs(r.data[i + 2] - p.data[i + 2]);
      mask[k] = diff > 6 ? 255 : 0;
    }
    return { mask, width: W, height: H };
  }

  const api = { boxMean, removeShine, shineMask };
  root.ShineRemove = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
