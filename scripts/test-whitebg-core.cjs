// 白底净化核心回归：背景识别、照明场、净化、白商品保护、确定性
const core = require('../src/renderer/whitebg-core.js');

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

check('背景识别：不均匀灰白底全检出', () => {
  // 左暗右亮的灰白底 + 中央深色商品
  const p = makeImage(300, 300, (x, y) => {
    if (x > 100 && x < 200 && y > 100 && y < 200) return [80, 80, 80];   // 商品
    const v = 190 + Math.round(50 * x / 300);   // 190~240 渐变
    return [v, v, v];
  });
  const bg = core.backgroundRegion(p);
  assert(bg.bgPixels > 30000, '背景检出过少: ' + bg.bgPixels);
  // 商品中心不是背景
  const cx = Math.floor(150 / bg.step), cy = Math.floor(150 / bg.step);
  assert(!bg.bg[cy * bg.w2 + cx], '商品中心被误判为背景');
});

check('净化：不均匀底变均匀且趋向目标白', () => {
  const p = makeImage(300, 300, (x) => {
    if (x > 100 && x < 200 && x !== undefined && Math.abs(x - 150) < 50 && Math.abs(y_default_guard()) < 50) return [80, 80, 80];
    const v = 190 + Math.round(50 * x / 300);
    return [v, v, v];
    function y_default_guard() { return 150 - 150; }
  });
  const r = core.clean(p, { strength: 1 });
  assert(r.touched > 30000, '处理像素过少: ' + r.touched);
  // 净化后背景标准差显著下降（原约18，目标<6）
  assert(r.uniformity.std < 8, '净化后仍不均匀: std=' + r.uniformity.std);
  // 均值趋近255
  assert(r.uniformity.mean > 245, '均值未到白: ' + r.uniformity.mean);
});

check('商品保护：深色商品像素不被修改', () => {
  const p = makeImage(200, 200, (x, y) => {
    if (x > 70 && x < 130 && y > 70 && y < 130) return [60, 90, 120];   // 蓝色商品
    return [220, 220, 220];
  });
  const orig = new Uint8ClampedArray(p.data);
  const r = core.clean(p, { strength: 1 });
  // 商品中心像素不变
  const i = (100 * 200 + 100) * 4;
  assert(r.data[i] === orig[i] && r.data[i + 1] === orig[i + 1], '商品像素被改动');
});

check('白色商品保护：白商品不与四角连通时不被当成背景', () => {
  // 白色商品（250亮）浮在纯白底(252)上——同亮度时洪水填充会连通，测试隔离场景：
  // 商品四周有深色描边圈住（模拟实际拍摄的白商品边缘阴影）
  const p = makeImage(200, 200, (x, y) => {
    if (x > 60 && x < 140 && y > 60 && y < 140) {
      if (x < 65 || x > 135 || y < 65 || y > 135) return [150, 150, 150];  // 描边
      return [248, 248, 248];  // 白商品
    }
    return [235, 235, 235];
  });
  const bg = core.backgroundRegion(p);
  const cx = Math.floor(100 / bg.step), cy = Math.floor(100 / bg.step);
  assert(!bg.bg[cy * bg.w2 + cx], '描边圈内的白商品被误判为背景');
});

check('接触阴影保留：keepShadow时暗背景不动', () => {
  const p = makeImage(200, 200, (x, y) => {
    if (x > 80 && x < 120 && y > 150 && y < 170) return [140, 140, 140];  // 接触阴影
    return [230, 230, 230];
  });
  const r = core.clean(p, { strength: 1, keepShadow: true, shadowThreshold: 200 });
  const i = (160 * 200 + 100) * 4;
  assert(Math.abs(r.data[i] - 140) < 8, '接触阴影被抹除: ' + r.data[i]);
});

check('strength=0：背景基本不变', () => {
  const p = makeImage(150, 150, (x) => [200 + Math.round(40 * x / 150), 200, 200]);
  const orig = new Uint8ClampedArray(p.data);
  const r = core.clean(p, { strength: 0 });
  let diff = 0;
  for (let i = 0; i < orig.length; i += 4) if (Math.abs(r.data[i] - orig[i]) > 2) diff++;
  assert(diff < 100, 'strength=0仍有大量改动: ' + diff);
});

check('确定性：同输入两次一致', () => {
  const p = makeImage(150, 150, (x, y) => [200 + Math.round(40 * x / 150), 200, 200]);
  const a1 = core.clean(p, { strength: 1 }), a2 = core.clean(p, { strength: 1 });
  for (let i = 0; i < a1.data.length; i += 4) {
    if (a1.data[i] !== a2.data[i]) throw Error('结果不确定@' + i);
  }
});

process.exit(failures ? 1 : 0);
