/* 精修质检核心（RT-14 基础版）：交付前技术检查，纯只读分析。
   检查项：尺寸/分辨率、背景纯度、边缘溢色（白边/黑边）、过曝/欠曝、主体越界、清晰度（模糊检测）。
   每项输出独立结果 + 严重程度 + 定位。不修改图像，不声称审美结论。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // 单项结果构造
  function item(id, name, pass, level, detail, positions) {
    return { id, name, pass, level, detail, positions: positions || [] };   // level: ok/warn/error
  }

  // ---- 尺寸检查：电商主图常规要求 ----
  function checkSize(p, options) {
    const min = options.minSize || 800;
    const max = options.maxSize || 8000;
    const pass = p.width >= min && p.height >= min && p.width <= max && p.height <= max;
    return item('size', '尺寸', pass, pass ? 'ok' : (p.width < min || p.height < min ? 'error' : 'warn'),
      p.width + '×' + p.height + (pass ? '（≥' + min + 'px 达标）' : '（低于 ' + min + 'px 建议规格）'));
  }

  // ---- 背景纯度：四角采样 + 背景方差 ----
  function checkBackground(p, options) {
    const W = p.width, H = p.height;
    const cs = Math.max(4, Math.floor(Math.min(W, H) * .04));
    const samples = [];
    for (const [cx0, cy0] of [[0, 0], [W - cs, 0], [0, H - cs], [W - cs, H - cs]]) {
      for (let y = cy0; y < cy0 + cs; y += 2) for (let x = cx0; x < cx0 + cs; x += 2) {
        const i = (y * W + x) * 4;
        samples.push([p.data[i], p.data[i + 1], p.data[i + 2]]);
      }
    }
    const mean = [0, 1, 2].map(k => samples.reduce((s, v) => s + v[k], 0) / samples.length);
    // 四角一致性：各角均值与总体均值差
    let maxDev = 0;
    const cornerCount = Math.max(1, Math.floor(samples.length / 4));
    for (let q = 0; q < 4; q++) {
      const seg = samples.slice(q * cornerCount, (q + 1) * cornerCount);
      if (!seg.length) continue;
      const m = [0, 1, 2].map(k => seg.reduce((s, v) => s + v[k], 0) / seg.length);
      const dev = Math.sqrt(m.reduce((s, v, k) => s + (v - mean[k]) * (v - mean[k]), 0) / 3);
      if (dev > maxDev) maxDev = dev;
    }
    const isWhite = mean.every(v => v > 235);
    const uniform = maxDev < 6;
    const pass = isWhite && uniform;
    return item('bg', '背景纯度', pass, pass ? 'ok' : (isWhite ? 'warn' : 'warn'),
      '四角均值 RGB(' + mean.map(v => Math.round(v)).join(',') + ')' + (isWhite ? ' 已白' : ' 不足白') + (uniform ? ' 均匀' : ' 四角差异 ' + maxDev.toFixed(1)));
  }

  // ---- 边缘溢色：主体边界带内的亮暗异常像素 ----
  function checkEdge(p, options) {
    const W = p.width, H = p.height;
    const band = options.edgeBand || 3;
    // 简化版：全图边界一圈（画幅边缘）不算；这里检测"主体边缘"需要分割——用亮度突变带近似：
    // 扫描全图，找强边缘（梯度>40）像素中，与亮背景相邻且比背景亮的（白边）或比背景暗的（黑边）
    let whiteEdge = 0, blackEdge = 0;
    const positions = [];
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 300000)));
    for (let y = step; y < H - step; y += step) for (let x = step; x < W - step; x += step) {
      const i = (y * W + x) * 4;
      const b = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
      // 4邻域梯度
      const bL = (p.data[i - 4] + p.data[i - 3] + p.data[i - 2]) / 3, bR = (p.data[i + 4] + p.data[i + 5] + p.data[i + 6]) / 3;
      const bT = (p.data[i - W * 4] + p.data[i - W * 4 + 1] + p.data[i - W * 4 + 2]) / 3;
      const bB = (p.data[i + W * 4] + p.data[i + W * 4 + 1] + p.data[i + W * 4 + 2]) / 3;
      const nb = [bL, bR, bT, bB];
      const maxNb = Math.max(...nb), minNb = Math.min(...nb);
      if (b - minNb > 60 && maxNb - b > 60) continue;   // 强双边（正常边缘）不算
      if (b - minNb > 45 && b > 200 && minNb < 160) { whiteEdge++; if (positions.length < 12) positions.push([x, y]); }
      else if (maxNb - b > 45 && b < 60 && maxNb > 160) { blackEdge++; if (positions.length < 12) positions.push([x, y]); }
    }
    const total = Math.floor((W / step) * (H / step));
    const whitePct = whiteEdge / Math.max(1, total), blackPct = blackEdge / Math.max(1, total);
    const pass = whitePct < .002 && blackPct < .002;
    return item('edge', '边缘溢色', pass, pass ? 'ok' : (whitePct + blackPct > .01 ? 'error' : 'warn'),
      '疑似白边 ' + (whitePct * 100).toFixed(2) + '% · 疑似黑边 ' + (blackPct * 100).toFixed(2) + '%', positions);
  }

  // ---- 过曝/欠曝 ----
  function checkExposure(p) {
    const W = p.width, H = p.height;
    let over = 0, under = 0, total = 0;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 250000)));
    const positions = [];
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      const b = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
      total++;
      if (b > 252) { over++; if (positions.length < 12) positions.push([x, y]); }
      else if (b < 8) under++;
    }
    const overPct = over / Math.max(1, total), underPct = under / Math.max(1, total);
    // 过曝>3% 或 欠曝>2% 提示（白底图高背景占比是正常的，只看极值）
    const pass = overPct < .15 && underPct < .05;
    return item('expo', '曝光极值', pass, pass ? 'ok' : 'warn',
      '纯白像素 ' + (overPct * 100).toFixed(1) + '% · 纯黑像素 ' + (underPct * 100).toFixed(1) + '%（白底图高白占比正常）', positions);
  }

  // ---- 清晰度（模糊检测）：拉普拉斯方差近似 ----
  function checkSharpness(p) {
    const W = p.width, H = p.height;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 200000)));
    let sum = 0, sum2 = 0, n = 0;
    for (let y = step; y < H - step; y += step) for (let x = step; x < W - step; x += step) {
      const i = (y * W + x) * 4;
      const b = (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3;
      const bL = (p.data[i - 4] + p.data[i - 3] + p.data[i - 2]) / 3;
      const bR = (p.data[i + 4] + p.data[i + 5] + p.data[i + 6]) / 3;
      const bT = (p.data[i - W * 4] + p.data[i - W * 4 + 1] + p.data[i - W * 4 + 2]) / 3;
      const bB = (p.data[i + W * 4] + p.data[i + W * 4 + 1] + p.data[i + W * 4 + 2]) / 3;
      const lap = 4 * b - bL - bR - bT - bB;   // 标准4邻域拉普拉斯
      if (Math.abs(lap) > 80) continue;   // 强边界（商品轮廓）不计入——只测平坦区的纹理能量
      sum += lap * lap; n++;
    }
    const variance = n ? sum / n : 0;
    // 经验阈值：方差<50 明显模糊；50~150 偏软；>150 清晰（仅对2000px级图可靠，缩略图会偏低）
    const pass = variance > 50;
    return item('sharp', '清晰度', pass, pass ? (variance > 150 ? 'ok' : 'warn') : 'error',
      '边缘能量 ' + Math.round(variance) + (variance < 50 ? '（明显模糊）' : variance < 150 ? '（偏软）' : '（清晰）'));
  }

  // ---- 主体越界：前景（与背景差异大的像素）触碰画幅左右/顶边 ----
  function checkBound(p) {
    const W = p.width, H = p.height;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 300000)));
    const top = Math.floor(H * .02), bottom = Math.floor(H * .98);
    let touchL = 0, touchR = 0, touchT = 0;
    let bgL = 0, bgR = 0, bgT = 0;
    for (let y = top; y < bottom; y += step) {
      const iL = (y * W + 2) * 4, iL2 = (y * W + 8) * 4;
      const bL = (p.data[iL] + p.data[iL + 1] + p.data[iL + 2]) / 3;
      const bL2 = (p.data[iL2] + p.data[iL2 + 1] + p.data[iL2 + 2]) / 3;
      if (bL < 215 && bL2 < 215) touchL++; else bgL++;
      const iR = (y * W + W - 3) * 4, iR2 = (y * W + W - 9) * 4;
      const bR = (p.data[iR] + p.data[iR + 1] + p.data[iR + 2]) / 3;
      const bR2 = (p.data[iR2] + p.data[iR2 + 1] + p.data[iR2 + 2]) / 3;
      if (bR < 215 && bR2 < 215) touchR++; else bgR++;
    }
    for (let x = Math.floor(W * .1); x < W * .9; x += step) {
      const iT = (top * W + x) * 4, iT2 = ((top + 6) * W + x) * 4;
      const bT = (p.data[iT] + p.data[iT + 1] + p.data[iT + 2]) / 3;
      const bT2 = (p.data[iT2] + p.data[iT2 + 1] + p.data[iT2 + 2]) / 3;
      if (bT < 215 && bT2 < 215) touchT++; else bgT++;
    }
    const rows = Math.floor((bottom - top) / step);
    const touching = (touchL / Math.max(1, rows) > .3) || (touchR / Math.max(1, rows) > .3) || (touchT > 5);
    return item('bound', '主体越界', !touching, touching ? 'warn' : 'ok',
      touching ? '主体疑似触碰画幅边缘（左' + Math.round(touchL / Math.max(1, rows) * 100) + '% / 右' + Math.round(touchR / Math.max(1, rows) * 100) + '% 行）' : '主体四周留有空隙');
  }

  // ---- 总入口 ----
  function inspect(p, options = {}) {
    const items = [];
    items.push(checkSize(p, options));
    items.push(checkBackground(p, options));
    items.push(checkBound(p));
    items.push(checkEdge(p, options));
    items.push(checkExposure(p));
    items.push(checkSharpness(p));
    const errors = items.filter(i => i.level === 'error').length;
    const warns = items.filter(i => i.level === 'warn').length;
    return {
      items,
      summary: { errors, warns, passed: items.filter(i => i.pass).length, total: items.length },
      verdict: errors ? '存在 ' + errors + ' 项硬性错误' : warns ? '有 ' + warns + ' 项建议关注' : '基础检查全部通过',
    };
  }

  const api = { inspect, checkSize, checkBackground, checkEdge, checkExposure, checkSharpness, checkBound };
  root.QualityCheck = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
