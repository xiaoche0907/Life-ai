/* 比例测量核心（P1）：白底棚拍人体轮廓 → 几何关键点 → 比例指标。
   纯算法、零依赖、确定性。不使用AI关键点模型；输出带置信度，姿态差异大时降级为"仅显示不自动调整"。
   可测指标：头身比（头顶到下巴 vs 全身高）、肩宽/身高、腰胯比、腿长占比（胯到脚底/身高）。 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));

  // ---- 前景分割（白底假设）：亮度与低饱和为背景 ----
  // 返回 Uint8 蒙版（0=背景 255=前景），尺寸按 maxEdge 缩放
  function foregroundMask(p, options = {}) {
    const W = p.width, H = p.height;
    const step = Math.max(1, Math.floor(Math.sqrt(W * H / 400000)));
    const w2 = Math.ceil(W / step), h2 = Math.ceil(H / step);
    const m = new Uint8Array(w2 * h2);
    const bgLike = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const sx = Math.min(W - 1, x * step), sy = Math.min(H - 1, y * step), i = (sy * W + sx) * 4;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const bright = (r + g + b) / 3;
      // 白底判定一：高亮+低饱和（后续用四角种子洪水填充收敛为真背景）
      const isBgLike = bright > 215 && sat < .22 ? 1 : 0;
      bgLike[y * w2 + x] = isBgLike;
      m[y * w2 + x] = isBgLike ? 0 : 255;
    }
    // 四角种子亮度中位数 → 自适应阈值重判 + 洪水填充收敛背景
    const corners = [];
    const cs = Math.max(2, Math.floor(w2 * .05));
    for (const [cx0, cy0] of [[0, 0], [w2 - cs, 0], [0, h2 - cs], [w2 - cs, h2 - cs]]) {
      for (let y = cy0; y < cy0 + cs && y < h2; y++) for (let x = cx0; x < cx0 + cs && x < w2; x++) {
        const sx = Math.min(W - 1, x * step), sy = Math.min(H - 1, y * step), i = (sy * W + sx) * 4;
        corners.push((p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3);
      }
    }
    corners.sort((a, b) => a - b);
    const bgBright = corners.length ? corners[Math.floor(corners.length / 2)] : 245;
    const bgB = Math.max(190, bgBright - 18), bgS = .3;
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const sx = Math.min(W - 1, x * step), sy = Math.min(H - 1, y * step), i = (sy * W + sx) * 4;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const bright = (r + g + b) / 3;
      const like = (bright >= bgB && sat < bgS) ? 1 : 0;
      bgLike[y * w2 + x] = like;
      m[y * w2 + x] = like ? 0 : 255;
    }
    // 洪水填充：只保留与四角连通的背景（白衣虽像背景但不与四角连通 → 保留）
    const bg = new Uint8Array(w2 * h2), stk0 = [];
    for (const [sx0, sy0] of [[0, 0], [w2 - 1, 0], [0, h2 - 1], [w2 - 1, h2 - 1]]) {
      const s = sy0 * w2 + sx0;
      if (bgLike[s] && !bg[s]) { bg[s] = 1; stk0.push(s); }
    }
    while (stk0.length) {
      const cur = stk0.pop();
      const cx = cur % w2, cy = (cur / w2) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue;
        const n = ny * w2 + nx;
        if (bgLike[n] && !bg[n]) { bg[n] = 1; stk0.push(n); }
      }
    }
    for (let s = 0; s < w2 * h2; s++) m[s] = bg[s] ? 0 : 255;
    // 连通域：保留最大域（人体），清除噪点域
    const visited = new Uint8Array(w2 * h2), stack = [];
    let bestArea = 0, bestStart = -1;
    for (let s = 0; s < w2 * h2; s++) {
      if (!m[s] || visited[s]) continue;
      let area = 0;
      stack.length = 0; stack.push(s); visited[s] = 1;
      while (stack.length) {
        const cur = stack.pop(); area++;
        const cx = cur % w2, cy = (cur / w2) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue;
          const n = ny * w2 + nx;
          if (m[n] && !visited[n]) { visited[n] = 1; stack.push(n); }
        }
      }
      if (area > bestArea) { bestArea = area; bestStart = s; }
    }
    // 第二遍：只保留最大域
    visited.fill(0);
    const out = new Uint8Array(w2 * h2);
    if (bestStart >= 0) {
      stack.length = 0; stack.push(bestStart); visited[bestStart] = 1; out[bestStart] = 255;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % w2, cy = (cur / w2) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= w2 || ny >= h2) continue;
          const n = ny * w2 + nx;
          if (m[n] && !visited[n]) { visited[n] = 1; out[n] = 255; stack.push(n); }
        }
      }
    }
    // 贴边检测：只统计左右边+顶边（脚底贴底边是正常姿态）。过高 → 白底不可分离
    let edgeTouch = 0, edgeLen = 0;
    for (let y = 0; y < h2; y++) { edgeLen += 2; if (out[y * w2]) edgeTouch++; if (out[y * w2 + w2 - 1]) edgeTouch++; }
    for (let x = 0; x < w2; x++) { edgeLen++; if (out[x]) edgeTouch++; }
    const edgeRatio = edgeLen ? edgeTouch / edgeLen : 1;
    return { mask: out, w2, h2, step, coverage: bestArea / (w2 * h2), bgBright, edgeRatio, edgeUnsafe: edgeRatio > .12 };
  }

  // ---- 行列轮廓分析：每行的左右边界与宽度 ----
  function rowProfiles(seg) {
    const { mask, w2, h2 } = seg;
    const left = new Int32Array(h2).fill(-1), right = new Int32Array(h2).fill(-1), width = new Int32Array(h2);
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) if (mask[y * w2 + x]) { left[y] = x; break; }
      for (let x = w2 - 1; x >= 0; x--) if (mask[y * w2 + x]) { right[y] = x; break; }
      width[y] = (left[y] >= 0 && right[y] >= left[y]) ? right[y] - left[y] + 1 : 0;
    }
    return { left, right, width, h2, w2 };
  }

  // ---- 关键点提取（启发式）----
  // top=头顶尖，headBottom=下巴（头宽骤变点），shoulder=肩线（宽度第一个峰值平台），
  // waist=腰（肩下宽度局部极小），hip=胯（腰下宽度局部极大），bottom=脚底。
  function extractBody(seg, prof) {
    const { mask, w2, h2 } = seg;
    const { left, right, width } = prof;
    // top: 第一条有内容的行
    let top = -1;
    for (let y = 0; y < h2; y++) if (width[y] > 0) { top = y; break; }
    let bottom = -1;
    for (let y = h2 - 1; y >= 0; y--) if (width[y] > 0) { bottom = y; break; }
    if (top < 0 || bottom < 0 || bottom - top < 40) return { ok: false, reason: '前景区域过小' };
    const bodyH = bottom - top;
    // maxW 与所在行
    let maxW = 0, maxWy = top;
    for (let y = top; y <= bottom; y++) if (width[y] > maxW) { maxW = width[y]; maxWy = y; }
    // 下巴估计：头部区域（身高前12%）内最大宽度=头宽；再找宽度跳升点
    let headW = 0, headWy = top;
    for (let y = top; y < top + bodyH * .12 && y < h2; y++) {
      if (width[y] > headW) { headW = width[y]; headWy = y; }
    }
    let headBottom = -1;
    for (let y = headWy; y < top + bodyH * .25; y++) {
      if (width[y] > headW * 1.55) { headBottom = y; break; }
    }
    if (headBottom < 0) headBottom = Math.round(top + bodyH * .12); // 兜底：头顶下12%
    // 肩线：下巴下 0~15% 身高范围内的宽度最大值
    let shoulderY = headBottom, shoulderW = 0;
    for (let y = headBottom; y < Math.min(bottom, headBottom + bodyH * .18); y++) {
      if (width[y] > shoulderW) { shoulderW = width[y]; shoulderY = y; }
    }
    // 腰：肩下 15%~48% 身高范围的宽度极小值
    let waistY = -1, waistW = 1e9;
    for (let y = Math.round(shoulderY + bodyH * .15); y < Math.min(bottom, shoulderY + bodyH * .48); y++) {
      if (width[y] > 0 && width[y] < waistW) { waistW = width[y]; waistY = y; }
    }
    // 胯：腰下到70%身高范围的宽度极大值（需比腰宽出一定比例）
    let hipY = -1, hipW = 0;
    if (waistY > 0) {
      for (let y = waistY + 1; y < Math.min(bottom, shoulderY + bodyH * .7); y++) {
        if (width[y] > hipW) { hipW = width[y]; hipY = y; }
      }
      // 胯宽不明显（<腰宽1.05倍）则放弃胯点，取腰下沿
      if (hipW < waistW * 1.05 || hipY <= waistY) { hipY = -1; }
    }
    // 置信度：覆盖正常范围 5%~35%（全身人像覆盖率），各关键点齐全
    const cov = seg.coverage;
    let confidence = 0;
    if (cov > .04 && cov < .65) confidence = .7;
    if (headBottom > top && shoulderY > headBottom && waistY > shoulderY && hipY > waistY) confidence = Math.min(1, confidence + .2);
    if (maxWy > shoulderY && maxWy < bottom * 1) confidence = Math.min(1, confidence + .05);
    return {
      ok: confidence >= .6, confidence,
      top, bottom, bodyH,
      headTopY: top, chinY: headBottom, shoulderY, shoulderW, waistY, waistW, hipY, hipW,
      maxW, maxWy, headW,
    };
  }

  // ---- 比例指标 ----
  function ratios(body) {
    if (!body.ok) return null;
    const H = body.bottom - body.top;
    // 头长：用头宽 × 1.35（人类学均值：头长/头宽≈1.3~1.4），比“宽度跳升找下巴”更稳
    const headLen = Math.max(2, body.headW * 1.35);
    return {
      headBodyRatio: +(H / headLen).toFixed(2),                                   // 头身比（全身/头长）
      shoulderToHeight: +(body.shoulderW / H).toFixed(3),                          // 肩宽/身高
      shoulderToHead: +(body.shoulderW / headLen).toFixed(2),                      // 肩宽/头长
      waistToShoulder: +(body.waistW / Math.max(1, body.shoulderW)).toFixed(2),    // 腰肩比
      hipToWaist: +(body.hipW / Math.max(1, body.waistW)).toFixed(2),              // 胯腰比
      legRatio: +(((body.bottom - (body.hipY >= 0 ? body.hipY : body.waistY)) / H)).toFixed(2), // 腿长占比
      bodyHeight: H,
    };
  }

  // ---- 对比：参考与目标的差异 + 建议调整 ----
  // 返回 { comparable, reasons[], diffs{...}, suggestions[] }
  function compare(refBody, tgtBody) {
    const refR = ratios(refBody), tgtR = ratios(tgtBody);
    if (!refR || !tgtR) return { comparable: false, reasons: ['比例提取失败'], diffs: null, suggestions: [] };
    const reasons = [];
    // 姿态可比性：轮廓宽高比差>25% 视为姿态差异大
    const refAspect = refR.bodyHeight / Math.max(1, refBody.maxW);
    const tgtAspect = tgtR.bodyHeight / Math.max(1, tgtBody.maxW);
    if (Math.abs(refAspect - tgtAspect) / Math.max(1, refAspect) > .25) reasons.push('轮廓宽高比差异大（可能是姿态/透视不同），自动建议仅供参考');
    const diffs = {
      headBodyRatio: +(tgtR.headBodyRatio - refR.headBodyRatio).toFixed(2),
      shoulderToHeight: +(tgtR.shoulderToHeight - refR.shoulderToHeight).toFixed(3),
      waistToShoulder: +(tgtR.waistToShoulder - refR.waistToShoulder).toFixed(2),
      hipToWaist: +(tgtR.hipToWaist - refR.hipToWaist).toFixed(2),
      legRatio: +(tgtR.legRatio - refR.legRatio).toFixed(2),
    };
    const suggestions = [];
    if (diffs.headBodyRatio < -0.4) suggestions.push({ key: 'headScale', label: '头部相对尺寸', delta: +((diffs.headBodyRatio) * 40).toFixed(0), note: '目标头身比偏小（头偏大），建议缩小头部' });
    if (diffs.headBodyRatio > 0.4) suggestions.push({ key: 'headScale', label: '头部相对尺寸', delta: +(diffs.headBodyRatio * 40).toFixed(0), note: '目标头身比偏大（头偏小），建议放大头部' });
    if (Math.abs(diffs.shoulderToHeight) > .02) suggestions.push({ key: 'shoulder', label: '肩部视觉宽度', delta: +(diffs.shoulderToHeight * 200).toFixed(0), note: '肩宽占比差异 ' + (diffs.shoulderToHeight > 0 ? '+' : '') + diffs.shoulderToHeight });
    if (Math.abs(diffs.legRatio) > .015) suggestions.push({ key: 'legs', label: '腿部相对长度', delta: +(diffs.legRatio * 150).toFixed(0), note: '腿长占比差异 ' + (diffs.legRatio > 0 ? '+' : '') + diffs.legRatio });
    return {
      comparable: true, reasons,
      ref: refR, target: tgtR, diffs, suggestions,
      confidence: Math.min(refBody.confidence, tgtBody.confidence),
    };
  }

  // ---- 快捷入口：图片 → 分割 → 关键点 → 比例 ----
  function analyze(p, options = {}) {
    const seg = foregroundMask(p, options);
    if (seg.edgeUnsafe) return { ok: false, reason: '主体贴满画面边缘，白底不可分离（请提供留有背景空隙的图片）', confidence: 0, coverage: seg.coverage };
    const prof = rowProfiles(seg);
    const body = extractBody(seg, prof);
    if (!body.ok) return { ok: false, reason: body.reason, confidence: body.confidence || 0, coverage: seg.coverage };
    return { ok: true, confidence: body.confidence, coverage: seg.coverage, seg, body, ratios: ratios(body) };
  }

  // ---- P2：按建议参数生成形变图（身体区域缩放形变，背景锁定）----
  // deltas: { headScale, shoulder, waist, legs }（百分比，正=放大/拉长，负=缩小/缩短）
  // 思路：对前景区域内、各关键点控制的水平带做局部宽度/高度重映射（向后映射双线性采样），背景像素不动。
  function applyDeform(p, body, deltas) {
    const W = p.width, H = p.height;
    const seg = foregroundMask(p);
    const out = new Uint8ClampedArray(p.data);
    const headLen = Math.max(2, body.headW * 1.35);
    const chinY = body.top + headLen;
    const shoulderY = body.shoulderY, waistY = body.waistY >= 0 ? body.waistY : shoulderY + (body.bottom - shoulderY) * .35;
    const hipY = body.hipY >= 0 ? body.hipY : waistY + (body.bottom - waistY) * .4;
    
    const ax = W / 2;
    const fHead = clamp(1 + (deltas.headScale || 0) / 100, .5, 1.5);
    const fSh = clamp(1 + (deltas.shoulder || 0) / 100, .5, 1.5);
    const fWaist = clamp(1 + (deltas.waist || 0) / 100, .5, 1.5);
    const fLeg = clamp(1 + (deltas.legs || 0) / 100, .7, 1.3);
    // 源采样函数：目标(y,x) → 源(ys,xs)
    // 头部：以头顶为锚，头区高度缩放 fHead（头长变化）
    // 肩/腰：宽度水平缩放（以轴 ax 为中心）
    // 腿：hip以下垂直拉伸 fLeg（以hip为锚）
    function mapY(y) {
      if (y < body.top || y > body.bottom) return y;
      if (y < chinY) return body.top + (y - body.top) / Math.max(.0001, fHead);
      if (y < hipY) {
        // 头以下到hip：头部缩放占用的位移向上传导，身体段保持连续
        const headShift = (chinY - body.top) * (1 - 1 / fHead);
        return y - headShift * Math.max(0, 1 - (y - chinY) / Math.max(1, hipY - chinY));
      }
      // hip以下：腿拉伸
      return hipY + (y - hipY) * fLeg;
    }
    function scaleX(x, y) {
      let f = 1;
      if (y >= chinY && y < waistY + (hipY - waistY) * .5) {
        // 肩到腰中：从 fSh 过渡到 fWaist
        const t = clamp((y - chinY) / Math.max(1, waistY - chinY), 0, 1);
        const fs = 1 + (fSh - 1) * (1 - t) + (fWaist - 1) * t;
        f = fs;
      } else if (y >= waistY + (hipY - waistY) * .5 && y < hipY) {
        // 腰下到胯：fWaist 过渡回 1（胯保持）
        const t = clamp((y - waistY) / Math.max(1, hipY - waistY), 0, 1);
        f = 1 + (fWaist - 1) * (1 - t);
      } else if (y < chinY) {
        f = fHead;
      }
      return ax + (x - ax) / Math.max(.0001, f);
    }
    for (let y = 0; y < H; y++) {
      const ys = mapY(y);
      const y0 = clamp(Math.floor(ys), 0, H - 1), y1 = clamp(y0 + 1, 0, H - 1), fy = ys - y0;
      for (let x = 0; x < W; x++) {
        const xs = scaleX(x, y);
        const x0 = clamp(Math.floor(xs), 0, W - 1), x1 = clamp(x0 + 1, 0, W - 1), fx = xs - x0;
        for (let c = 0; c < 3; c++) {
          const v00 = p.data[(y0 * W + x0) * 4 + c], v01 = p.data[(y0 * W + x1) * 4 + c];
          const v10 = p.data[(y1 * W + x0) * 4 + c], v11 = p.data[(y1 * W + x1) * 4 + c];
          out[(y * W + x) * 4 + c] = v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
        }
      }
    }
    return { width: W, height: H, data: out };
  }

  const api = { foregroundMask, rowProfiles, extractBody, ratios, compare, analyze, applyDeform };
  root.Proportion = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
