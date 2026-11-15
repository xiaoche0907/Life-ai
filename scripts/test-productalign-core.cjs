// 产品对齐核心回归：边界框、变换参数、等比约束、确定性
const core = require('../src/renderer/productalign-core.js');

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

check('前景边界框：偏置商品检出', () => {
  const p = makeImage(400, 500, (x, y) => (x > 100 && x < 260 && y > 120 && y < 420) ? [90, 90, 100] : [250, 250, 250]);
  const fb = core.foregroundBBox(p);
  assert(fb.ok, '未检出');
  assert(Math.abs(fb.bbox.x - 100) < 6 && Math.abs(fb.bbox.y - 120) < 6, 'bbox偏移: ' + JSON.stringify(fb.bbox));
  assert(Math.abs(fb.bbox.w - 160) < 8 && Math.abs(fb.bbox.h - 300) < 8, 'bbox尺寸: ' + JSON.stringify(fb.bbox));
});

check('空图/纯背景：明确拒绝', () => {
  const p = makeImage(300, 400, () => [250, 250, 250]);
  const fb = core.foregroundBBox(p);
  assert(!fb.ok, '纯背景应拒绝');
});

check('planAlign：等比缩放约束（禁拉伸）', () => {
  const layers = [
    { id: 1, name: 'A', bbox: { x: 50, y: 100, w: 120, h: 300 } },
    { id: 2, name: 'B', bbox: { x: 220, y: 180, w: 90, h: 200 } },
  ];
  const canvas = { width: 800, height: 800 };
  const r = core.planAlign(layers, canvas, { occupy: .8, anchor: 'bottom' });
  assert(r.ok && r.plan.length === 2, '计划失败');
  for (const p of r.plan) {
    assert(!p.skip, '不应跳过');
    // 等比：newBox.w / bbox.w === newBox.h / bbox.h === scale
    const sx = p.newBox.w / layers.find(l => l.id === p.id).bbox.w;
    const sy = p.newBox.h / layers.find(l => l.id === p.id).bbox.h;
    assert(Math.abs(sx - sy) < .01, '出现拉伸: ' + sx + ' vs ' + sy);
  }
  // 统一高度占比
  for (const p of r.plan) {
    assert(Math.abs(p.newBox.h - 800 * .8) < 2, '高度占比未统一: ' + p.newBox.h);
  }
});

check('planAlign：底部锚点位置正确', () => {
  const layers = [{ id: 1, name: 'A', bbox: { x: 0, y: 0, w: 200, h: 400 } }];
  const r = core.planAlign(layers, { width: 800, height: 800 }, { occupy: .8, anchor: 'bottom' });
  const p = r.plan[0];
  // 底边留8%：ty + newH = 800 - 64 = 736
  assert(Math.abs(p.newBox.y + p.newBox.h - 736) < 3, '底边位置: ' + (p.newBox.y + p.newBox.h));
  assert(Math.abs(p.newBox.x + p.newBox.w / 2 - 400) < 3, '水平应居中');
});

check('rearrange：单图重排居中', () => {
  const p = makeImage(400, 500, (x, y) => (x > 40 && x < 180 && y > 60 && y < 400) ? [90, 90, 100] : [250, 250, 250]);
  const r = core.rearrange(p, { occupy: .8 });
  assert(r.ok, '重排失败');
  // 新框应水平居中
  assert(Math.abs(r.newBox.x + r.newBox.w / 2 - 200) < 6, '未居中: ' + JSON.stringify(r.newBox));
  assert(Math.abs(r.newBox.h - 400) < 8, '高度占比: ' + r.newBox.h);
});

check('确定性：同输入两次一致', () => {
  const layers = [{ id: 1, name: 'A', bbox: { x: 10, y: 20, w: 100, h: 200 } }];
  const a1 = core.planAlign(layers, { width: 800, height: 800 }, { occupy: .8 });
  const a2 = core.planAlign(layers, { width: 800, height: 800 }, { occupy: .8 });
  assert(JSON.stringify(a1) === JSON.stringify(a2), '不确定');
});

process.exit(failures ? 1 : 0);
