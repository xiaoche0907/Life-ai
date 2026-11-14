// 精修质检核心回归：各检查项、白底图通过、模糊图拒绝、确定性
const core = require('../src/renderer/qualitycheck-core.js');

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

check('标准白底商品图：全部通过', () => {
  // 白底 + 中央清晰商品（边缘硬、无溢色）
  const p = makeImage(900, 900, (x, y) => {
    if (x > 200 && x < 700 && y > 200 && y < 700) { const v = 100 + ((x * 7 + y * 13) % 3) * 8; return [v, v + 10, v + 20]; }
    return [250, 250, 250];
  });
  const r = core.inspect(p);
  assert(r.summary.errors === 0, '应无硬性错误: ' + JSON.stringify(r.items.filter(i => i.level === 'error').map(i => i.name)));
  const size = r.items.find(i => i.id === 'size');
  assert(size.pass, '尺寸应通过');
});

check('小尺寸图：尺寸项报错', () => {
  const p = makeImage(400, 400, () => [250, 250, 250]);
  const r = core.inspect(p);
  const size = r.items.find(i => i.id === 'size');
  assert(!size.pass && size.level === 'error', '400px应报尺寸错误');
});

check('模糊图：清晰度项报错', () => {
  // 全图纯渐变（无边缘→拉普拉斯方差极低）
  const p = makeImage(900, 900, (x, y) => {
    if (x > 200 && x < 700 && y > 200 && y < 700) return [110, 110, 110];   // 纯色商品：无内部纹理
    return [245 + Math.round(8 * x / 900), 245, 245];   // 线性渐变底：无边缘能量
  });
  const r = core.inspect(p);
  const sharp = r.items.find(i => i.id === 'sharp');
  assert(!sharp.pass, '低纹理图应报清晰度问题: ' + sharp.detail);
});

check('灰底图：背景纯度警告', () => {
  const p = makeImage(900, 900, (x, y) => {
    if (x > 200 && x < 700 && y > 200 && y < 700) return [100, 110, 120];
    return [215, 218, 222];   // 灰底
  });
  const r = core.inspect(p);
  const bg = r.items.find(i => i.id === 'bg');
  assert(!bg.pass, '灰底应报背景纯度');
  assert(bg.level === 'warn', '灰底是警告不是错误');
});

check('主体贴边：越界警告', () => {
  // 商品直接顶到左右边缘
  const p = makeImage(900, 900, (x, y) => {
    if (y > 200 && y < 700) return [100, 110, 120];   // 全宽商品（贴左右边）
    return [250, 250, 250];
  });
  const r = core.inspect(p);
  const bound = r.items.find(i => i.id === 'bound');
  assert(!bound.pass, '贴边应报越界');
});

check('汇总统计与结论', () => {
  const p = makeImage(900, 900, (x, y) => {
    if (x > 200 && x < 700 && y > 200 && y < 700) return [100, 110, 120];
    return [250, 250, 250];
  });
  const r = core.inspect(p);
  assert(r.summary.total === 6, '应有6个检查项: ' + r.summary.total);
  assert(typeof r.verdict === 'string' && r.verdict.length > 0, '应有结论文本');
});

check('确定性：同输入两次一致', () => {
  const p = makeImage(600, 600, (x, y) => {
    if (x > 150 && x < 450 && y > 150 && y < 450) return [100, 110, 120];
    return [250, 250, 250];
  });
  const a1 = core.inspect(p), a2 = core.inspect(p);
  assert(JSON.stringify(a1.items) === JSON.stringify(a2.items), '结果不确定');
});

process.exit(failures ? 1 : 0);
