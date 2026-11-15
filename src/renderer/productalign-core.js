/* 产品对齐核心（RT-05）：多图层/SKU 主体对齐到统一位置与视觉大小。
   输入：单张图（多商品场景分割）或多图层信息（每图层主体边界框由PS端提供）。
   算法：主体边界框 → 目标位置/占比计算 → 仿射变换参数（平移+等比缩放，禁拉伸）。
   输出：变换参数（PS端执行 move/scale，保留图层内容）；或单图重排渲染。
   纯算法、零依赖、确定性。不同类目不共享占比——占比由用户指定或以参考图层为准。 */
(function (root) {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- 单图前景边界框（复用四角洪水分割）----
  function foregroundBBox(p) {
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
    // 前景 bbox
    let minX = w2, minY = h2, maxX = -1, maxY = -1, count = 0;
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      if (bg[y * w2 + x]) continue;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < 0 || count < 16) return { ok: false, reason: '未检出主体' };
    return {
      ok: true,
      bbox: { x: minX * step, y: minY * step, w: (maxX - minX + 1) * step, h: (maxY - minY + 1) * step },
      coverage: count / (w2 * h2),
    };
  }

  // ---- 多图层变换参数计算 ----
  // layers: [{ id, name, bbox:{x,y,w,h} }]（bbox由PS端提供，图层实际内容范围）
  // canvas: { width, height }
  // target: { anchor:'center'|'bottom', occupy:0..1 (主体高度占画布比), marginX:0..1 }
  // 返回每图层的 move/scale 指令（等比缩放，禁拉伸）
  function planAlign(layers, canvas, target) {
    if (!layers.length) return { ok: false, reason: '无图层' };
    const occupy = clamp(target.occupy === undefined ? .8 : target.occupy, .1, 1);
    const marginX = clamp(target.marginX === undefined ? .1 : target.marginX, 0, .45);
    const anchor = target.anchor || 'center';
    const out = [];
    // 找最高主体作视觉基准（各主体等比缩放到统一高度占比）
    const maxH = Math.max(...layers.map(l => l.bbox.h));
    for (const layer of layers) {
      const { bbox } = layer;
      if (!bbox || bbox.w < 2 || bbox.h < 2) { out.push({ id: layer.id, name: layer.name, skip: true, reason: '主体过小或为空' }); continue; }
      // 目标高度 = 画布高 × occupy（所有图层统一），等比缩放
      const scale = clamp(occupy * canvas.height / bbox.h, .05, 5);
      const newW = bbox.w * scale, newH = bbox.h * scale;
      // 目标位置：水平按 marginX 排布（单图层=居中），垂直按锚点
      let tx, ty;
      if (anchor === 'bottom') {
        ty = canvas.height - canvas.height * .08 - newH;   // 底边留8%
      } else {
        ty = (canvas.height - newH) / 2;
      }
      tx = (canvas.width - newW) / 2;
      // bbox 中心 → 新中心
      const cx0 = bbox.x + bbox.w / 2, cy0 = bbox.y + bbox.h / 2;
      const cx1 = tx + newW / 2, cy1 = ty + newH / 2;
      out.push({
        id: layer.id, name: layer.name,
        scale: +scale.toFixed(4),
        translate: { dx: Math.round(cx1 - cx0), dy: Math.round(cy1 - cy0) },
        newBox: { x: Math.round(tx), y: Math.round(ty), w: Math.round(newW), h: Math.round(newH) },
        skip: false,
      });
    }
    return { ok: true, plan: out, target: { occupy, anchor } };
  }

  // ---- 单图重排（备用：单文件内多商品分割重排）----
  // 检出各连通域 bbox，水平等距重排到目标占比
  function rearrange(p, options = {}) {
    const occupy = clamp(options.occupy === undefined ? .8 : options.occupy, .1, 1);
    const W = p.width, H = p.height;
    const fb = foregroundBBox(p);
    if (!fb.ok) return { ok: false, reason: fb.reason };
    const { bbox } = fb;
    const scale = clamp(occupy * H / bbox.h, .05, 5);
    const newH = bbox.h * scale, newW = bbox.w * scale;
    const dx = Math.round((W - newW) / 2 - (bbox.x + bbox.w / 2));
    const dy = Math.round((H - newH) / 2 - (bbox.y + bbox.h / 2));
    return { ok: true, bbox, scale: +scale.toFixed(4), translate: { dx, dy }, newBox: { x: Math.round((W - newW) / 2), y: Math.round((H - newH) / 2), w: Math.round(newW), h: Math.round(newH) } };
  }

  const api = { foregroundBBox, planAlign, rearrange };
  root.ProductAlign = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
