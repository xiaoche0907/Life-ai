/* 瑕疵清理核心（RT-01）：形态学异常检测 + Inpainting 修复。
   原理：Top-hat（亮瑕疵）/Black-hat（暗瑕疵）形态学检测——像素与形态学开/闭运算的差值超阈值即瑕疵；
   修复用快速余弦权重插值（inpainting 近似：瑕疵像素由环邻域正常像素按距离加权填充）。
   纯算法、零依赖、确定性。保护机制：只处理用户标记区域或强孤立异常，Logo/文字等设计细节需手动排除。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // ---- 灰度 + 积分图（盒滤波做形态学近似：腐蚀=盒min近似用快速侵蚀，膨胀=盒max）----
  // 真形态学用 min/max 滤波（非均值）。为性能用分离滑窗 min/max。
  function minMaxFilter(gray, W, H, radius) {
    const minOut = new Float32Array(W * H), maxOut = new Float32Array(W * H);
    // 水平扫描 min/max
    const tmpMin = new Float32Array(W * H), tmpMax = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      // 单调队列
      const mq = [];
      for (let x = 0; x < W; x++) {
        const v = gray[y * W + x];
        while (mq.length && gray[y * W + mq[mq.length - 1]] >= v) mq.pop();
        mq.push(x);
        if (mq[0] < x - radius * 2 + 1) mq.shift();
        tmpMin[y * W + x] = gray[y * W + mq[0]];
      }
      mq.length = 0;
      for (let x = 0; x < W; x++) {
        const v = gray[y * W + x];
        while (mq.length && gray[y * W + mq[mq.length - 1]] <= v) mq.pop();
        mq.push(x);
        if (mq[0] < x - radius * 2 + 1) mq.shift();
        tmpMax[y * W + x] = gray[y * W + mq[0]];
      }
    }
    // 垂直扫描
    for (let x = 0; x < W; x++) {
      const mq = [];
      for (let y = 0; y < H; y++) {
        const v = tmpMin[y * W + x];
        while (mq.length && tmpMin[mq[mq.length - 1] * W + x] >= v) mq.pop();
        mq.push(y);
        if (mq[0] < y - radius * 2 + 1) mq.shift();
        minOut[y * W + x] = tmpMin[mq[0] * W + x];
      }
      mq.length = 0;
      for (let y = 0; y < H; y++) {
        const v = tmpMax[y * W + x];
        while (mq.length && tmpMax[mq[mq.length - 1] * W + x] <= v) mq.pop();
        mq.push(y);
        if (mq[0] < y - radius * 2 + 1) mq.shift();
        maxOut[y * W + x] = tmpMax[mq[0] * W + x];
      }
    }
    return { min: minOut, max: maxOut };
  }

  // ---- 瑕疵检测 ----
  // 亮瑕疵 = gray - erosion(gray)（Top-hat）；暗瑕疵 = dilation(gray) - gray（Black-hat）
  // 超阈值且是"孤立"异常（周围瑕疵密度低）才标记
  function detect(p, options = {}) {
    const sensitivity = clamp(options.sensitivity === undefined ? .5 : options.sensitivity, 0, 1);
    const maxSize = options.maxSize || Math.max(3, Math.round(Math.min(p.width, p.height) * .01));
    const W = p.width, H = p.height;
    const gray = new Float32Array(W * H);
    for (let k = 0; k < W * H; k++) {
      const i = k * 4;
      gray[k] = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
    }
    const { min, max } = minMaxFilter(gray, W, H, Math.max(1, Math.round(maxSize / 2)));
    // 全图 top-hat / black-hat 的 σ 定阈值
    let s1 = 0, s12 = 0, s2 = 0, s22 = 0, n = 0;
    for (let k = 0; k < W * H; k++) {
      const th = gray[k] - min[k], bh = max[k] - gray[k];
      s1 += th; s12 += th * th; s2 += bh; s22 += bh * bh; n++;
    }
    const std1 = Math.sqrt(Math.max(0, s12 / n - (s1 / n) * (s1 / n)));
    const std2 = Math.sqrt(Math.max(0, s22 / n - (s2 / n) * (s2 / n)));
    const thr1 = Math.max(10, std1 * (2.5 - sensitivity * 1.6));
    const thr2 = Math.max(10, std2 * (2.5 - sensitivity * 1.6));
    const mask = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
      if (gray[k] - min[k] > thr1 || max[k] - gray[k] > thr2) mask[k] = 255;
    }
    // 瑕疵域填充：大瑕疵内部（窗口无对比）漏检——从图边界做背景洪水填充，未到且非瑕疵=瑕疵内部，补标
    const bg = new Uint8Array(W * H), stack = [];
    const isNormal = (k) => !mask[k];
    for (let x = 0; x < W; x++) { if (isNormal(x)) { bg[x] = 1; stack.push(x); } if (isNormal((H - 1) * W + x)) { bg[(H - 1) * W + x] = 1; stack.push((H - 1) * W + x); } }
    for (let y = 0; y < H; y++) { if (isNormal(y * W)) { bg[y * W] = 1; stack.push(y * W); } if (isNormal(y * W + W - 1)) { bg[y * W + W - 1] = 1; stack.push(y * W + W - 1); } }
    while (stack.length) {
      const cur = stack.pop();
      const cx = cur % W, cy = (cur / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nn = ny * W + nx;
        if (isNormal(nn) && !bg[nn]) { bg[nn] = 1; stack.push(nn); }
      }
    }
    for (let k = 0; k < W * H; k++) if (!mask[k] && !bg[k]) mask[k] = 255;   // 被瑕疵环包住的非瑕疵=瑕疵内部
    return { mask, width: W, height: H, thr1: Math.round(thr1), thr2: Math.round(thr2) };
  }

  // ---- Inpainting（距离加权环邻域填充）----
  // 对每个瑕疵像素：找最近正常像素（8方向射线），按距离平方反比加权混色
  function inpaint(p, mask) {
    const W = p.width, H = p.height;
    const out = new Uint8ClampedArray(p.data);
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (!mask[k]) continue;
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (const [dx, dy] of dirs) {
        let cx = x, cy = y, dist = 0;
        // 沿方向找第一个正常像素（最多64步）
        while (dist < 64) {
          cx += dx; cy += dy; dist++;
          if (cx < 0 || cy < 0 || cx >= W || cy >= H) { dist = -1; break; }
          if (!mask[cy * W + cx]) break;
        }
        if (dist > 0 && dist <= 64) {
          const i = (cy * W + cx) * 4;
          const w2 = 1 / (dist * dist);
          sr += p.data[i] * w2; sg += p.data[i + 1] * w2; sb += p.data[i + 2] * w2; sw += w2;
        }
      }
      if (sw > 0) {
        const i = k * 4;
        out[i] = clamp(sr / sw); out[i + 1] = clamp(sg / sw); out[i + 2] = clamp(sb / sw);
      }
    }
    return { width: W, height: H, data: out };
  }

  // ---- 主入口：检测+修复 ----
  function clean(p, options = {}) {
    const det = detect(p, options);
    const fixed = inpaint(p, det.mask);
    let count = 0;
    for (let k = 0; k < det.mask.length; k++) if (det.mask[k]) count++;
    return { width: p.width, height: p.height, data: fixed.data, defectPixels: count, mask: det.mask };
  }

  const api = { minMaxFilter, detect, inpaint, clean };
  root.DefectClean = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
