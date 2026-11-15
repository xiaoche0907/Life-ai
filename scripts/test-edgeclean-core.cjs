// 边缘净化核心回归：白边/黑边修复、正常边缘不动、透明结构保留、确定性
const core = require('../src/renderer/edgeclean-core.js');

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

check('白边修复：亮边向内部颜色收敛', () => {
  // 深色商品 + 边缘带白边（半透明且偏白）
  const p = makeImage(150, 150, (x, y) => {
    if (x > 50 && x < 100 && y > 50 && y < 100) {
      const edge = (x < 55 || x > 95 || y < 55 || y > 95);
      return edge ? [250, 250, 250, 120] : [60, 60, 70, 255];   // 白边半透明 + 深色实体
    }
    return [0, 0, 0, 0];
  });
  const r = core.cleanEdges(p, { strength: 1 });
  const i = (52 * 150 + 52) * 4;   // 白边像素
  assert(r.data[i] < 200, '白边未收敛: ' + r.data[i] + '（内部色60）');
  assert(r.fixed > 0, '未处理任何像素');
});

check('黑边修复：暗边提亮', () => {
  const p = makeImage(150, 150, (x, y) => {
    if (x > 50 && x < 100 && y > 50 && y < 100) {
      const edge = (x < 55 || x > 95 || y < 55 || y > 95);
      return edge ? [10, 10, 10, 120] : [220, 220, 225, 255];   // 黑边 + 白色商品
    }
    return [0, 0, 0, 0];
  });
  const r = core.cleanEdges(p, { strength: 1 });
  const i = (52 * 150 + 52) * 4;
  assert(r.data[i] > 60, '黑边未提亮: ' + r.data[i]);
});

check('正常半透明边缘（颜色接近内部）：不动', () => {
  const p = makeImage(150, 150, (x, y) => {
    if (x > 50 && x < 100 && y > 50 && y < 100) {
      const edge = (x < 55 || x > 95 || y < 55 || y > 95);
      return edge ? [70, 70, 80, 120] : [60, 60, 70, 255];   // 边缘色接近内部
    }
    return [0, 0, 0, 0];
  });
  const orig = new Uint8ClampedArray(p.data);
  const r = core.cleanEdges(p, { strength: 1 });
  const i = (52 * 150 + 52) * 4;
  assert(Math.abs(r.data[i] - orig[i]) < 10, '正常边缘被误改: ' + r.data[i] + ' vs ' + orig[i]);
});

check('不透明区与全透明区：不动', () => {
  const p = makeImage(100, 100, (x, y) => (x > 30 && x < 70 && y > 30 && y < 70) ? [100, 100, 100, 255] : [0, 0, 0, 0]);
  const orig = new Uint8ClampedArray(p.data);
  const r = core.cleanEdges(p, { strength: 1 });
  for (let i = 0; i < orig.length; i += 4) {
    if (orig[i + 3] === 255 || orig[i + 3] === 0) {
      assert(r.data[i] === orig[i] && r.data[i + 3] === orig[i + 3], '非边缘区被改动@' + i);
    }
  }
});

check('合成预览：棋盘底色混合正确', () => {
  const p = makeImage(50, 50, (x, y) => [200, 100, 50, 128]);   // 半透明单色
  const r = core.compositeOn(p, [255, 255, 255]);
  const i = (25 * 50 + 25) * 4;
  // 200*0.5+255*0.5=227.5 ≈ 228
  assert(Math.abs(r.data[i] - 228) <= 1, '合成错误: ' + r.data[i]);
  assert(r.data[i + 3] === 255, '合成后应为不透明');
});

check('确定性：同输入两次一致', () => {
  const p = makeImage(120, 120, (x, y) => {
    if (x > 40 && x < 80 && y > 40 && y < 80) {
      const edge = (x < 45 || x > 75 || y < 45 || y > 75);
      return edge ? [240, 240, 240, 130] : [70, 70, 80, 255];
    }
    return [0, 0, 0, 0];
  });
  const a1 = core.cleanEdges(p, { strength: 1 }), a2 = core.cleanEdges(p, { strength: 1 });
  for (let i = 0; i < a1.data.length; i++) if (a1.data[i] !== a2.data[i]) throw Error('不确定@' + i);
});

process.exit(failures ? 1 : 0);
