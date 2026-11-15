/* 抠图边缘净化核心（RT-04）：去白边/黑边/溢色。
   对象：已有透明通道的图层（RGBA）。算法：
   1. 边缘带检测：alpha 半透明带（0<a<255）+ 与不透明区的过渡圈
   2. 溢色判定：边缘带像素的颜色与"内部颜色"（沿法线向内采样）差异大 → 溢色
   3. 去污染：溢色像素颜色向内部颜色收敛（保持 alpha），可选 alpha 收缩
   纯算法、零依赖、确定性。毛发/纱类保留半透明结构——只改色不删像素（alpha收缩为可选参数）。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // ---- 边缘带检测 + 溢色修复 ----
  // options: { strength:0..1 溢色收敛强度, shrink:0..2 alpha收缩(px), whiteThresh 亮溢色阈值, darkThresh 暗溢色阈值 }
  function cleanEdges(p, options = {}) {
    const strength = clamp(options.strength === undefined ? 1 : options.strength, 0, 1);
    const shrink = clamp(options.shrink === undefined ? 0 : options.shrink, 0, 2);
    const W = p.width, H = p.height;
    const out = new Uint8ClampedArray(p.data);
    // 内部颜色估计：每个半透明像素沿8方向找最近的不透明像素，取色均值
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let fixed = 0;
    const positions = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, i = k * 4;
      const a = p.data[i + 3];
      if (a === 0 || a === 255) continue;   // 只处理边缘半透明带
      // 沿方向采样内部不透明颜色
      let sr = 0, sg = 0, sb = 0, sn = 0;
      for (const [dx, dy] of dirs) {
        let cx = x, cy = y;
        for (let d = 0; d < 12; d++) {
          cx += dx; cy += dy;
          if (cx < 0 || cy < 0 || cx >= W || cy >= H) break;
          const j = (cy * W + cx) * 4;
          if (p.data[j + 3] === 255) { sr += p.data[j]; sg += p.data[j + 1]; sb += p.data[j + 2]; sn++; break; }
        }
      }
      if (!sn) continue;   // 周围无实体（孤立半透明点），不动
      const ir = sr / sn, ig = sg / sn, ib = sb / sn;
      const cr = p.data[i], cg = p.data[i + 1], cb = p.data[i + 2];
      // 溢色判定：与内部色差大（亮边：边缘比内部亮得多；暗边：暗得多）
      const edgeBright = (cr + cg + cb) / 3, innerBright = (ir + ig + ib) / 3;
      const isLightFringe = edgeBright - innerBright > 25;
      const isDarkFringe = innerBright - edgeBright > 25;
      if (!isLightFringe && !isDarkFringe) continue;
      // 去污染：颜色向内部收敛（保持alpha与纹理）
      const t = strength * clamp(Math.abs(edgeBright - innerBright) / 60, .3, 1);
      out[i] = clamp(cr + (ir - cr) * t);
      out[i + 1] = clamp(cg + (ig - cg) * t);
      out[i + 2] = clamp(cb + (ib - cb) * t);
      // alpha 微收缩：强溢色处略减alpha（可选）
      if (shrink > 0 && (isLightFringe || isDarkFringe)) {
        out[i + 3] = clamp(a - shrink * 40 * t);
      }
      fixed++;
      if (positions.length < 12) positions.push([x, y]);
    }
    return { width: W, height: H, data: out, fixed, positions };
  }

  // ---- 透明底合成预览：棋盘格/指定底色 ----
  function compositeOn(p, bgRGB) {
    const W = p.width, H = p.height;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let k = 0; k < W * H; k++) {
      const i = k * 4;
      const a = p.data[i + 3] / 255;
      out[i] = clamp(p.data[i] * a + bgRGB[0] * (1 - a));
      out[i + 1] = clamp(p.data[i + 1] * a + bgRGB[1] * (1 - a));
      out[i + 2] = clamp(p.data[i + 2] * a + bgRGB[2] * (1 - a));
      out[i + 3] = 255;
    }
    return { width: W, height: H, data: out };
  }

  const api = { cleanEdges, compositeOn };
  root.EdgeClean = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
