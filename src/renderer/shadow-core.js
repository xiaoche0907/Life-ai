/* 智能阴影核心（RT-09）：给商品生成接触阴影与方向投影。
   输入：商品 Alpha/蒙版（或前景分割）。算法：
   1. 接触阴影：商品底部边线向下的紧凑暗带（距离变换衰减）
   2. 方向投影：蒙版按偏移方向平移叠淡（高斯近似衰减+透明度场）
   输出：RGBA 阴影层（黑+透明度场），与商品分层。纯算法、零依赖、确定性。
   不声称恢复真实三维光照；复杂透明对象投影为近似。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // 前景蒙版（复用白底卡的四角洪水填充思路，这里聚焦商品区）
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
    // 前景=非连通背景（每列最上/最下前景行，用于定位底部接触线）
    const fg = new Uint8Array(w2 * h2);
    for (let s = 0; s < w2 * h2; s++) fg[s] = bg[s] ? 0 : 255;
    // 底部接触线：每列最后一个前景行
    const bottomY = new Int32Array(w2).fill(-1);
    for (let x = 0; x < w2; x++) for (let y = h2 - 1; y >= 0; y--) if (fg[y * w2 + x]) { bottomY[x] = y; break; }
    return { fg, w2, h2, step, bottomY };
  }

  // ---- 阴影生成 ----
  // options: { type:'contact'|'direction'|'both', direction:0..360(光源方向，阴影反向), length:px比例, blur, opacity:0..1 }
  function generate(p, options = {}) {
    const type = options.type || 'contact';
    const opacity = clamp(options.opacity === undefined ? .45 : options.opacity, 0, 1);
    const lengthPct = clamp(options.length === undefined ? .06 : options.length, .01, .3);
    const blurPct = clamp(options.blur === undefined ? .5 : options.blur, 0, 1);
    const color = options.color || [0, 0, 0];
    const W = p.width, H = p.height;
    const fg = foregroundMask(p);
    const { w2, h2, step } = fg;
    const out = new Uint8ClampedArray(W * H * 4);   // RGBA：黑+alpha
    const len = Math.round(Math.min(W, H) * lengthPct);
    const blurR = Math.max(1, Math.round(len * blurPct));

    // 按像素写入 alpha 场（商品本体像素不写——阴影只在背景区显示）
    function put(x, y, a) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const gx = Math.min(w2 - 1, (x / step) | 0), gy = Math.min(h2 - 1, (y / step) | 0);
      if (fg.fg[gy * w2 + gx]) return;   // 商品本体保护
      const i = (y * W + x) * 4;
      const na = Math.max(out[i + 3], a);
      out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2]; out[i + 3] = na;
    }

    // 接触阴影：底线上方小距离开始向下衰减
    function contactShadow() {
      for (let x2 = 0; x2 < w2; x2++) {
        const by = fg.bottomY[x2];
        if (by < 0) continue;
        const bx = x2 * step;
        const span = Math.max(2, Math.round(len * .25));   // 接触带宽度
        for (let d = -span; d <= len; d++) {
          const y = (by + d) * step;
          // 强度：接触点最强，向下/向外衰减
          let a;
          if (d < 0) a = 1 - (-d) / span;      // 商品底部上方一点
          else a = 1 - d / len;
          if (a <= 0) continue;
          // 水平扩散（越远越淡）
          for (let sx = -blurR; sx <= blurR; sx++) {
            const fall = 1 - Math.abs(sx) / (blurR + 1);
            put(Math.round(bx + sx), Math.round(y), Math.round(255 * opacity * a * fall * .8));
          }
        }
      }
    }

    // 方向投影：蒙版平移 dx,dy，边缘羽化
    function directionShadow() {
      const ang = (options.direction === undefined ? 115 : options.direction) * Math.PI / 180;   // 光源方向
      const dx = Math.round(Math.cos(ang) * len), dy = Math.round(Math.sin(ang) * len);
      for (let y2 = 0; y2 < h2; y2++) for (let x2 = 0; x2 < w2; x2++) {
        if (!fg.fg[y2 * w2 + x2]) continue;
        const px = x2 * step, py = y2 * step;
        // 商品每个像素投到 px+dx, py+dy，带羽化
        for (let sy = -blurR; sy <= blurR; sy += 1) for (let sx = -blurR; sx <= blurR; sx += 1) {
          const fall = 1 - (Math.abs(sx) + Math.abs(sy)) / (2 * blurR + 1);
          if (fall <= 0) continue;
          put(px + dx + sx, py + dy + sy, Math.round(255 * opacity * fall * .7));
        }
      }
    }

    if (type === 'contact' || type === 'both') contactShadow();
    if (type === 'direction' || type === 'both') directionShadow();

    return { width: W, height: H, data: out, hasShadow: true };
  }

  const api = { foregroundMask, generate };
  root.ShadowGen = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
