// 比例测量核心回归：分割、关键点、比例、对比、确定性
const core = require('../src/renderer/proportion-core.js');

function makeImage(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fill(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a === undefined ? 255 : a;
  }
  return { width: w, height: h, data };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '：' + e.message); }
}
function assert(cond, msg) { if (!cond) throw Error(msg); }

// 构造简化人形：白底 + 灰色人形（头圆、颈细、肩宽、腰收、胯宽、腿双条）
function buildFigure(W, H, opts = {}) {
  const s = opts.shoulderRatio ?? .18;     // 肩宽/身高
  const headR = opts.headRatio ?? .055;    // 头半径/身高
  return makeImage(W, H, (x, y) => {
    const t = (y - H * .04) / (H * .92);   // 0=头顶 1=脚底
    if (t < 0 || t > 1) return [255, 255, 255];
    const cx = W / 2;
    const cy = H * .04;
    // 头（圆）+颈（连接条，保证头与身体连续）
    const dyH = y - cy;
    if (t * H * .92 < headR * H * 2.1) {
      const dx = x - cx;
      if (dyH * dyH + dx * dx < (headR * H) * (headR * H)) return [150, 150, 150];
      if (dyH >= headR * H * 0.82 && Math.abs(dx) < headR * H * .38) return [150, 150, 150];
      return [255, 255, 255];
    }
    // 身体：宽度按比例函数
    let halfW = 0;
    if (t < .22) halfW = s * .55 * H * (0.5 + t / .22 * .5);           // 颈→肩
    else if (t < .38) halfW = s * .55 * H * (1 - .18 * (t - .22) / .16); // 肩→腰收
    else if (t < .52) halfW = s * .55 * H * (.82 + .25 * (t - .38) / .14); // 腰→胯
    else halfW = s * .30 * H;                                           // 腿（双条合计宽）
    // 腿部分叉
    if (t >= .52) {
      const inGap = Math.abs(x - cx) < W * .035;
      if (inGap) return [255, 255, 255];
    }
    if (Math.abs(x - cx) <= halfW) return [150, 150, 150];
    return [255, 255, 255];
  });
}

check('前景分割：人形保留、白底清除', () => {
  const p = buildFigure(300, 600);
  const seg = core.foregroundMask(p);
  assert(seg.coverage > .05 && seg.coverage < .6, '覆盖率异常: ' + seg.coverage.toFixed(2));
  const { w2 } = seg;
  const topRow = Math.floor(600 * .04 / seg.step) + 1;
  // 头部中心应是前景
  assert(seg.mask[topRow * w2 + Math.floor(w2 / 2)] === 255, '头部中心未识别为前景');
});

check('关键点提取：顺序合理', () => {
  const r = core.analyze(buildFigure(300, 600));
  assert(r.ok, '分析失败: confidence=' + r.confidence);
  const b = r.body;
  assert(b.top < b.chinY, '下巴应在头顶下方');
  assert(b.chinY <= b.shoulderY, '肩应在下巴下');
  assert(b.shoulderY < b.waistY, '腰应在肩下');
  if (b.hipY > 0) { assert(b.waistY < b.hipY, '胯应在腰下'); assert(b.hipY < b.bottom, '脚底在胯下'); }
});

check('比例指标：头身比在合理范围', () => {
  const r = core.analyze(buildFigure(300, 600));
  // 简化人形头偏大，头身比应在 4~9
  assert(r.ratios.headBodyRatio > 3.5 && r.ratios.headBodyRatio < 10, '头身比异常: ' + r.ratios.headBodyRatio);
  assert(r.ratios.legRatio > .2 && r.ratios.legRatio < .7, '腿占比异常: ' + r.ratios.legRatio);
});

check('对比：同类人形可比且差异接近0', () => {
  const ref = core.analyze(buildFigure(300, 600));
  const tgt = core.analyze(buildFigure(300, 600));
  const c = core.compare(ref.body, tgt.body);
  assert(c.comparable, '同类应可比');
  assert(c.diffs.headBodyRatio === 0, '同人形头身比差应为0');
  assert(c.suggestions.length === 0, '无差异应无建议');
});

check('对比：头大的人形触发头部建议', () => {
  const ref = core.analyze(buildFigure(300, 600, { headRatio: .03 }));
  const tgt = core.analyze(buildFigure(300, 600, { headRatio: .10 }));
  const c = core.compare(ref.body, tgt.body);
  assert(c.comparable, '应可比: ' + JSON.stringify(c.reasons || c));
  // 头更大 → 头长更长 → 头身比更小 → diffs = target - ref < 0
  assert(c.diffs.headBodyRatio < 0, '头大者头身比应更小: ' + c.diffs.headBodyRatio);
  const head = c.suggestions.find(s => s.key === 'headScale');
  assert(head, '应产生头部建议');
});

check('对比：肩宽差异触发肩部建议', () => {
  const ref = core.analyze(buildFigure(300, 600, { shoulderRatio: .14 }));
  const tgt = core.analyze(buildFigure(300, 600, { shoulderRatio: .20 }));
  const c = core.compare(ref.body, tgt.body);
  assert(c.diffs.shoulderToHeight > .02, '肩宽占比应显著更大: ' + c.diffs.shoulderToHeight);
  assert(c.suggestions.some(s => s.key === 'shoulder'), '应产生肩部建议');
});

check('非人形图片：置信度拒绝', () => {
  // 纯白图
  const r = core.analyze(makeImage(200, 400, () => [255, 255, 255]));
  assert(!r.ok, '纯白图应拒绝');
  // 全灰图（覆盖率过高）
  const r2 = core.analyze(makeImage(200, 400, () => [120, 120, 120]));
  assert(!r2.ok, '全前景图应拒绝: confidence=' + (r2.confidence ?? 1));
});

check('确定性：同输入两次一致', () => {
  const p = buildFigure(300, 600);
  const a1 = core.analyze(p), a2 = core.analyze(p);
  assert(JSON.stringify(a1.ratios) === JSON.stringify(a2.ratios), '结果不确定');
});

process.exit(failures ? 1 : 0);
