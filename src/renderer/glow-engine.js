// 辉光引擎（0912 新起炉灶，纯函数无 DOM）：输入 RGBA 像素 → 输出「黑底辉光层」RGBA。
// 黑底=滤色/线性减淡/变亮三种混合模式的中性色，贴进 PS 当独立图层，原图一个像素不动。
// 流水线五段，各段按参数脏标只重算自己那段（拖滑杆实时预览的关键）：
//   ① 提取高光：亮度 L 过阈值的像素保留本色（软膝盖，避免硬边）
//   ② 漫射辉光：三级盒式模糊金字塔（半径 r / 3r / 9r，各三次盒模糊≈高斯），柔和度=宽层权重；
//      色散=整片辉光三色径向错位 + 高光边缘细色边（红外/蓝内）——⚠改颜色分布的做法（半径差/峰值补偿/壳层/光谱分层）
//      四版都在柔光人像上看不见，色边只能靠**位置错开**且载体要细（0912 用户实报）
//   ③ 星芒条纹：把高光图旋转到条纹方向→逐行指数衰减 IIR（正反两向）→转回；条数 N = N/2 条线；色散=三色长度不同
//   ③b 镜头色散：整幅画面三色径向错位 + 过曝外沿紫边，出一层"正常混合"的底
//   ④ 合成：辉光 = 强度×漫射 + 条纹强度×星芒 → 着色（向指定色偏移）→ 输出层；预览另按混合模式/不透明度叠回底图
// 半径/长度都是"长边百分比"：预览缩小算、烘焙全分辨率算，观感一致。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GlowEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    thr: 0.50,        // 阈值 0..1：亮度高于它才发光（⚠面板上反着显示：滑杆=1−thr，越大发光范围越大）
    bloom: 4.5,       // 漫射强度 0..12（盒模糊能量守恒：小亮点摊开后峰值会掉，默认给足）
    radius: 2.5,      // 漫射半径：长边百分比 0.5..25
    soft: 0.35,       // 柔和 0..1：越大外圈越宽
    bloomCA: 0,       // 漫射色散 0..1：三色半径分离（红散得远、蓝收得紧）→ 光晕边缘光谱分离
    streaks: 0,       // 星芒条数 0/2/4/6/8（0=关）
    slen: 14,         // 星芒长度：长边百分比 1..40
    sangle: 0,        // 星芒角度 0..180
    sgain: 8,         // 星芒强度 0..20（IIR 直流归一后点光源峰值=1−k≈0.08，故量程放大）
    streakCA: 0,      // 星芒色散 0..1：三色条纹长度分离 → 尾端红蓝分叉
    lensCA: 0,        // 镜头色散·位移 0..1：整幅画面三色径向错位（红外扩/蓝内缩），最大 2% 长边（"低质镜头"要夸张，真镜头约 0.1%）
    lensFall: 0.5,    // 镜头色散·边缘集中 0..1：错位随离心距离的幂次 1..4（低=全画面均匀带，高=只炸四角）
    fringe: 0,        // 紫边 0..1：过曝区外沿一圈紫红晕（逆光树枝/发丝边那种）
    tint: '#ffd8a8',  // 着色
    tintAmt: 0.35,    // 着色量 0..1
    opacity: 100,     // 图层不透明度 0..100
    blend: 'screen',  // screen | linearDodge | lighten
  };
  const BLENDS = ['screen', 'linearDodge', 'lighten'];
  // 色散的三色分离系数（R 放大、G 不动、B 收紧）：ca=1 时 R 1.7×/B 0.45×（漫射）、R 1.6×/B 0.55×（星芒）
  const caMul = (ca, up, down, floor) => [1 + up * ca, 1, Math.max(floor, 1 - down * ca)];

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  function normParams(p) {
    const o = Object.assign({}, DEFAULTS, p || {});
    o.thr = clamp01(num(o.thr, DEFAULTS.thr));
    o.bloom = Math.max(0, Math.min(12, num(o.bloom, DEFAULTS.bloom)));
    o.radius = Math.max(0.2, Math.min(25, num(o.radius, DEFAULTS.radius)));
    o.soft = clamp01(num(o.soft, DEFAULTS.soft));
    o.bloomCA = clamp01(num(o.bloomCA, 0));
    o.streaks = [0, 2, 4, 6, 8].includes(Number(o.streaks)) ? Number(o.streaks) : DEFAULTS.streaks;
    o.slen = Math.max(1, Math.min(40, num(o.slen, DEFAULTS.slen)));
    o.sangle = ((num(o.sangle, 0) % 180) + 180) % 180;
    o.sgain = Math.max(0, Math.min(20, num(o.sgain, DEFAULTS.sgain)));
    o.streakCA = clamp01(num(o.streakCA, 0));
    o.lensCA = clamp01(num(o.lensCA, 0));
    o.lensFall = clamp01(num(o.lensFall, DEFAULTS.lensFall));
    o.fringe = clamp01(num(o.fringe, 0));
    o.tintAmt = clamp01(num(o.tintAmt, DEFAULTS.tintAmt));
    o.opacity = Math.max(0, Math.min(100, num(o.opacity, 100)));
    o.blend = BLENDS.includes(o.blend) ? o.blend : 'screen';
    if (!/^#[0-9a-fA-F]{6}$/.test(String(o.tint || ''))) o.tint = DEFAULTS.tint;
    return o;
  }
  function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  // ---------- ① 高光提取 ----------
  function extract(src, w, h, thr, out) {
    const knee = 0.12;
    const n = w * h;
    const R = out[0], G = out[1], B = out[2];
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const r = src[o] / 255, g = src[o + 1] / 255, b = src[o + 2] / 255;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let m = (L - thr) / knee;
      m = m < 0 ? 0 : m > 1 ? 1 : m;
      m = m * m * (3 - 2 * m);   // smoothstep 软膝盖
      R[i] = r * m; G[i] = g * m; B[i] = b * m;
    }
  }

  // ---------- ② 盒式模糊（运行和，O(N) 与半径无关；边缘复制） ----------
  function boxH(src, dst, w, h, r) {
    const span = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[row + (k < 0 ? 0 : k >= w ? w - 1 : k)];
      for (let x = 0; x < w; x++) {
        dst[row + x] = sum / span;
        const a = x + r + 1, b = x - r;
        sum += src[row + (a >= w ? w - 1 : a)] - src[row + (b < 0 ? 0 : b)];
      }
    }
  }
  function boxV(src, dst, w, h, r) {
    const span = 2 * r + 1;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[(k < 0 ? 0 : k >= h ? h - 1 : k) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = sum / span;
        const a = y + r + 1, b = y - r;
        sum += src[(a >= h ? h - 1 : a) * w + x] - src[(b < 0 ? 0 : b) * w + x];
      }
    }
  }
  // 三次盒模糊≈高斯；就地：plane → plane（tmp 同尺寸）
  function blur3(plane, tmp, w, h, r) {
    r = Math.max(0, Math.round(r));
    if (r === 0) return;
    for (let k = 0; k < 3; k++) { boxH(plane, tmp, w, h, r); boxV(tmp, plane, w, h, r); }
  }

  // ---------- ③ 星芒：旋转 → 行向 IIR → 转回 ----------
  function sampleBilinear(plane, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const x0 = x | 0, y0 = y | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const a = plane[y0 * w + x0], b = plane[y0 * w + x1], c = plane[y1 * w + x0], d = plane[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  // 把三个平面沿一条线（角度 a）做双向指数衰减 IIR，结果累加进 out[3]。ks=三通道各自的每像素衰减系数（色散=三色长度不同）
  // 乘 (1−k) 做直流归一：孤立亮点的星芒峰值=1−k、沿线按 k^d 衰减——增益不随分辨率/长度爆掉（第一版没归一，60px 处直接 255）
  function streakLine(planes, w, h, angleDeg, ks, out) {
    const a = angleDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const RW = Math.ceil(Math.abs(w * ca) + Math.abs(h * sa)) + 2;
    const RH = Math.ceil(Math.abs(w * sa) + Math.abs(h * ca)) + 2;
    const cx = w / 2, cy = h / 2, rcx = RW / 2, rcy = RH / 2;
    const rot = new Float32Array(RW * RH);
    for (let c = 0; c < 3; c++) {
      const P = planes[c];
      const k = ks[c], gain = 1 - k;
      // 旋转到条纹方向水平（rot(u,v) ← 原图 R(a)·(u',v')+c）
      for (let v = 0; v < RH; v++) {
        const vy = v - rcy;
        for (let u = 0; u < RW; u++) {
          const ux = u - rcx;
          rot[v * RW + u] = sampleBilinear(P, w, h, ca * ux - sa * vy + cx, sa * ux + ca * vy + cy);
        }
      }
      // 行向 IIR：正向扫描 fwd[u] = orig[u] + k·fwd[u−1]
      for (let v = 0; v < RH; v++) {
        const row = v * RW;
        let acc = 0;
        for (let u = 0; u < RW; u++) { acc = rot[row + u] + k * acc; rot[row + u] = acc; }
      }
      // 反向扫描需要原值：由 fwd 反推 orig[u] = fwd[u] − k·fwd[u−1]（右→左扫，左邻还是 fwd）；
      // 合并 y = fwd + bwd − orig（中心像素只计一次）
      for (let v = 0; v < RH; v++) {
        const row = v * RW;
        let acc = 0;
        for (let u = RW - 1; u >= 0; u--) {
          const fwd = rot[row + u];
          const orig = fwd - k * (u > 0 ? rot[row + u - 1] : 0);
          acc = orig + k * acc;
          rot[row + u] = (fwd + acc - orig) * gain;
        }
      }
      // 转回原图坐标累加
      const O = out[c];
      for (let y = 0; y < h; y++) {
        const yy = y - cy;
        for (let x = 0; x < w; x++) {
          const xx = x - cx;
          O[y * w + x] += sampleBilinear(rot, RW, RH, ca * xx + sa * yy + rcx, -sa * xx + ca * yy + rcy);
        }
      }
    }
  }

  // ---------- ③b 镜头色散：RGBA 单通道双线性采样（越界取边缘像素，不出黑边） ----------
  function sampleCh(src, w, h, ch, x, y) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    const x0 = x | 0, y0 = y | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const a = src[(y0 * w + x0) * 4 + ch], b = src[(y0 * w + x1) * 4 + ch], c = src[(y1 * w + x0) * 4 + ch], d = src[(y1 * w + x1) * 4 + ch];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  // 单平面同款（辉光色散错位用）
  function sampleClamp(plane, w, h, x, y) {
    if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
    if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
    const x0 = x | 0, y0 = y | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = x - x0, fy = y - y0;
    const a = plane[y0 * w + x0], b = plane[y0 * w + x1], c = plane[y1 * w + x0], d = plane[y1 * w + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  // ---------- 流水线（带阶段缓存） ----------
  function createPipeline(srcRGBA, w, h) {
    const n = w * h;
    const long = Math.max(w, h);
    const hi = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const bl = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const stk = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const tmp = new Float32Array(n);
    const tmp2 = new Float32Array(n);
    const gateP = new Float32Array(n);   // 色散门：该像素的辉光里「来自最亮光源」的占比
    const layer = new Uint8ClampedArray(n * 4);
    const view = new Uint8ClampedArray(n * 4);
    const base = new Uint8ClampedArray(n * 4);   // 镜头色散层（正常混合，盖在原图上、辉光下）；未启用时合成直接读原图
    let lensActive = false;
    const key = { hi: null, bl: null, stk: null, lens: null };
    const stats = { ms: 0, stages: '' };

    // 镜头色散：横向色差=三色以画面中心为轴径向错位（红从更靠中心处取样=外扩，蓝反之=内缩，绿不动），
    // 错位量 = 位移 × (离心距/半对角)^幂；紫边=过曝区外沿一圈晕（模糊高光掩膜减去本体）加紫红。
    // 与辉光独立：辉光从原图提取，这里只改"底"，拖这组滑杆只重算本段+合成
    function stageLens(p) {
      const k = [p.lensCA, p.lensFall, p.fringe].join('|');
      if (key.lens === k) return false;
      lensActive = p.lensCA > 0.001 || p.fringe > 0.001;
      if (lensActive) {
        const cx = (w - 1) / 2, cy = (h - 1) / 2, R = Math.hypot(cx, cy) || 1;
        const maxS = p.lensCA * 0.02 * long;
        const pw = 1 + p.lensFall * 3;
        for (let y = 0, o = 0; y < h; y++) {
          const dy = y - cy;
          for (let x = 0; x < w; x++, o += 4) {
            const dx = x - cx, d = Math.hypot(dx, dy);
            let ux = 0, uy = 0;
            if (d > 0.5 && maxS > 0) { const s = maxS * Math.pow(d / R, pw); ux = dx / d * s; uy = dy / d * s; }
            base[o] = ux || uy ? sampleCh(srcRGBA, w, h, 0, x - ux, y - uy) : srcRGBA[o];
            base[o + 1] = srcRGBA[o + 1];
            base[o + 2] = ux || uy ? sampleCh(srcRGBA, w, h, 2, x + ux, y + uy) : srcRGBA[o + 2];
            base[o + 3] = 255;
          }
        }
        if (p.fringe > 0.001) {
          // 高光掩膜（错位后的底）→ 小半径模糊 → 减本体 = 只剩外沿晕；tmp/tmp2 是各段共用的草稿区
          for (let i = 0, o = 0; i < n; i++, o += 4) {
            const L = (0.2126 * base[o] + 0.7152 * base[o + 1] + 0.0722 * base[o + 2]) / 255;
            let m = (L - 0.72) / 0.2; m = m < 0 ? 0 : m > 1 ? 1 : m;
            tmp2[i] = m * m * (3 - 2 * m);
          }
          const H = tmp2.slice();
          blur3(tmp2, tmp, w, h, 0.004 * long * (1 + p.fringe));   // 晕宽：640 预览≈5px、1568 烘焙≈12px（低质镜头口径，真镜头 3-10px/4K）
          const amt = p.fringe * 255;
          for (let i = 0, o = 0; i < n; i++, o += 4) {
            const f = tmp2[i] - H[i];
            if (f <= 0) continue;
            base[o] = base[o] + f * amt * 1.2;
            base[o + 1] = base[o + 1] + f * amt * 0.1;
            base[o + 2] = base[o + 2] + f * amt * 1.6;
          }
        }
      }
      key.lens = k;
      return true;
    }

    function stageHi(p) {
      const k = String(p.thr);
      if (key.hi === k) return false;
      extract(srcRGBA, w, h, p.thr, hi);
      key.hi = k; key.bl = null; key.stk = null;
      return true;
    }
    function stageBloom(p) {
      const k = [p.thr, p.radius, p.soft, p.bloomCA].join('|');
      if (key.bl === k) return false;
      const r = p.radius / 100 * long;
      // 色散（0912 第三版，定稿）：三色在**空间上错开**——红的辉光从更靠画面中心处取样（=向外推），蓝反之（=向内收），绿不动。
      //   错位量 = 色散 × (0.6×半径 + 1.5% 长边) × (0.35 + 0.65×离心距)：跟辉光本身的尺寸走，柔光人像那种大软光也错得开。
      // ⚠前两版不行的原因，用户实报"柔光人像拉色散没反应"：
      //   v1 只把三色模糊半径拉开——盒模糊能量守恒，红宽了就淡了，整片光只是偏暖；v2 补峰值=偏暖放大；
      //   v3 壳层(窄−宽)在大半径低振幅下差值≈0。三种都是"改亮度分布"，色边只能靠**位置错开**。
      const ca = p.bloomCA;
      // 宽层权重 0912=soft²×0.85：盒模糊能量守恒，宽层把高光能量摊成覆盖全画面的低振幅底噪
      // → 滤色叠回去整幅被抬起来 = 用户 0914 实报的"发灰、太油"。压到 0.35，能量回到核心层 = 高光更实
      const w1 = p.soft, w2 = p.soft * p.soft * 0.35;
      const norm = 1 / (1 + w1 + w2);
      for (let c = 0; c < 3; c++) {
        const H = hi[c], B = bl[c];
        // 金字塔：级 0（r）+ 级 1（≈3r）+ 级 2（≈9r），权重=柔和
        tmp2.set(H); blur3(tmp2, tmp, w, h, r);
        for (let i = 0; i < n; i++) B[i] = tmp2[i] * norm;
        if (w1 > 0.001) {
          blur3(tmp2, tmp, w, h, r * 2);
          for (let i = 0; i < n; i++) B[i] += tmp2[i] * w1 * norm;
          if (w2 > 0.001) {
            blur3(tmp2, tmp, w, h, r * 4);
            for (let i = 0; i < n; i++) B[i] += tmp2[i] * w2 * norm;
          }
        }
      }
      if (ca > 0.001) {
        const cx = (w - 1) / 2, cy = (h - 1) / 2, R = Math.hypot(cx, cy) || 1;
        // 色散门（0914 用户实报「色散应该只在最亮的高光上」，原来整片辉光都被染色=画面发虚）：
        //   分子 = 只留最亮那档（阈值抬到 thr 与全白的中点）的辉光亮度；分母 = 全部高光的辉光亮度；
        //   比值 = 这个像素的光里有多少来自真正的亮源。皮肤/布料那种刚过阈值的中等高光 → 门≈0，一点色边都不出。
        const thr2 = p.thr + (1 - p.thr) * 0.5;
        for (let i = 0, o = 0; i < n; i++, o += 4) {
          const L = (0.2126 * srcRGBA[o] + 0.7152 * srcRGBA[o + 1] + 0.0722 * srcRGBA[o + 2]) / 255;
          let m = (L - thr2) / 0.12;
          m = m < 0 ? 0 : m > 1 ? 1 : m;
          gateP[i] = L * m * m * (3 - 2 * m);
        }
        blur3(gateP, tmp, w, h, r);
        for (let i = 0; i < n; i++) tmp2[i] = 0.2126 * hi[0][i] + 0.7152 * hi[1][i] + 0.0722 * hi[2][i];
        blur3(tmp2, tmp, w, h, r);
        for (let i = 0; i < n; i++) {
          const d = tmp2[i];
          const g = d > 1e-5 ? gateP[i] / d : 0;
          gateP[i] = g > 1 ? 1 : g;
        }
        // (a) 整片辉光空间错位：红从内侧取样=外推、蓝从外侧取样=内收——紧凑的光（霓虹那类）靠这一手；错位量乘门
        const maxS = ca * (0.6 * r + 0.015 * long);
        for (const [c, sign] of [[0, -1], [2, 1]]) {
          tmp2.set(bl[c]);
          const B = bl[c];
          for (let y = 0, i = 0; y < h; y++) {
            const dy = y - cy;
            for (let x = 0; x < w; x++, i++) {
              const dx = x - cx, d = Math.hypot(dx, dy);
              if (d < 0.5 || gateP[i] < 0.002) continue;
              const s = sign * maxS * (0.35 + 0.65 * d / R) * gateP[i];
              B[i] = sampleClamp(tmp2, w, h, x + dx / d * s, y + dy / d * s);
            }
          }
        }
        // (b) 高光边缘色边（用户要的"高光边缘 RGB 分离"，专治柔光人像那种大软光）：
        //   载体 F = 高光亮度做小半径模糊（细窄、锐利，跟辉光半径/柔和无关）；红向外错位、蓝向内错位，
        //   只取"比原位多出来"的部分 → 每个高光外侧一圈红、朝画面中心那侧一圈蓝，宽度=错位量。
        //   前四版（半径差/峰值补偿/壳层/光谱分层）都在改辉光本身的颜色分布——辉光淡时怎么改都被底图淹没。
        for (let i = 0; i < n; i++) tmp2[i] = 0.2126 * hi[0][i] + 0.7152 * hi[1][i] + 0.0722 * hi[2][i];
        blur3(tmp2, tmp, w, h, Math.max(1, 0.005 * long));
        const F = tmp2, fs = ca * 0.008 * long + 0.5, gain = 0.7;
        const BR = bl[0], BB = bl[2];
        for (let y = 0, i = 0; y < h; y++) {
          const dy = y - cy;
          for (let x = 0; x < w; x++, i++) {
            const dx = x - cx, d = Math.hypot(dx, dy);
            if (d < 0.5 || gateP[i] < 0.002) continue;
            const ux = dx / d * fs, uy = dy / d * fs, f0 = F[i], gg = gain * gateP[i];
            const fr = sampleClamp(F, w, h, x - ux, y - uy) - f0;
            const fb = sampleClamp(F, w, h, x + ux, y + uy) - f0;
            if (fr > 0) BR[i] += fr * gg;
            if (fb > 0) BB[i] += fb * gg;
          }
        }
      }
      key.bl = k;
      return true;
    }
    function stageStreak(p) {
      const k = [p.thr, p.streaks, p.slen, p.sangle, p.streakCA].join('|');
      if (key.stk === k) return false;
      for (let c = 0; c < 3; c++) stk[c].fill(0);
      if (p.streaks > 0) {
        const lines = p.streaks / 2;
        const lenPx = Math.max(1, p.slen / 100 * long);
        const mul = caMul(p.streakCA, 0.6, 0.45, 0.2);   // 色散：三色条纹长度不同 → 尾端红长蓝短分叉
        const ks = mul.map((m) => Math.pow(0.05, 1 / Math.max(1, lenPx * m)));   // 距离=长度处衰减到 5%
        for (let i = 0; i < lines; i++) streakLine(hi, w, h, p.sangle + i * (180 / lines), ks, stk);
        // 每条线在高光本体处留了 (1−k)·hi 的芯，扣掉只保留拖尾（芯由漫射负责，避免中心叠加过曝）
        for (let c = 0; c < 3; c++) { const S = stk[c], H = hi[c], core = lines * (1 - ks[c]); for (let i = 0; i < n; i++) { S[i] -= H[i] * core; if (S[i] < 0) S[i] = 0; } }
      }
      key.stk = k;
      return true;
    }
    function composite(p) {
      const [tr, tg, tb] = hexRgb(p.tint);
      const ta = p.tintAmt, op = p.opacity / 100, mode = p.blend;
      const bA = p.bloom, sA = p.sgain;
      const S = lensActive ? base : srcRGBA;   // 预览的"底"：镜头色散层 or 原图
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        let r = bA * bl[0][i] + sA * stk[0][i];
        let g = bA * bl[1][i] + sA * stk[1][i];
        let b = bA * bl[2][i] + sA * stk[2][i];
        if (ta > 0) {
          // 着色=把亮度往光色偏，但保留大部分"色偏量"(r−L)：原来的 r+=(L·tr−r)·ta 会把色偏按 (1−ta) 压掉，
          // 着色量 35% 就吃掉三分之一色散（用户实报"柔光人像拉色散没反应"的另一半原因）
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const kc = 1 - ta * 0.55;
          r = L * (1 - ta + tr * ta) + (r - L) * kc;
          g = L * (1 - ta + tg * ta) + (g - L) * kc;
          b = L * (1 - ta + tb * ta) + (b - L) * kc;
          if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
        }
        r = r > 1 ? 1 : r; g = g > 1 ? 1 : g; b = b > 1 ? 1 : b;
        layer[o] = r * 255; layer[o + 1] = g * 255; layer[o + 2] = b * 255; layer[o + 3] = 255;
        // 预览叠回底图
        const sr = S[o] / 255, sg = S[o + 1] / 255, sb = S[o + 2] / 255;
        let vr, vg, vb;
        if (mode === 'linearDodge') { vr = sr + r; vg = sg + g; vb = sb + b; }
        else if (mode === 'lighten') { vr = sr > r ? sr : r; vg = sg > g ? sg : g; vb = sb > b ? sb : b; }
        else { vr = sr + r - sr * r; vg = sg + g - sg * g; vb = sb + b - sb * b; }
        view[o] = (sr + (vr - sr) * op) * 255; view[o + 1] = (sg + (vg - sg) * op) * 255; view[o + 2] = (sb + (vb - sb) * op) * 255; view[o + 3] = 255;
      }
    }
    return {
      width: w, height: h,
      render(params) {
        const p = normParams(params);
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const done = [];
        if (stageHi(p)) done.push('高光');
        if (stageBloom(p)) done.push('漫射');
        if (stageStreak(p)) done.push('星芒');
        if (stageLens(p)) done.push('镜头');
        composite(p); done.push('合成');
        stats.ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
        stats.stages = done.join('+');
        return { layer, view, lensLayer: lensActive ? base : null, lensActive, width: w, height: h, ms: stats.ms, stages: stats.stages };
      },
      // 把辉光层按当前混合模式/不透明度**焊进**色散层，出一层可直接以"正常"模式贴回的合并层。
      // 为什么等价而不是近似：辉光层是黑底层，把它以滤色/线性减淡叠在"色散图"上，与原来
      //   「色散层(正常100%) 在下 + 辉光层(滤色op%) 在上」两层叠出来的结果逐像素相同——
      //   黑底在滤色下对底色是恒等，所以合并只是把同一笔账提前算好，画质零损失。
      // 用户诉求（0916）：只要一个图层，且色散不能丢像素。
      merge(p) {
        const q = normParams(p);   // 调用方给的多半是原始参数（st.p 只 Object.assign 了默认值），不归一化会出 NaN
        const out = new Uint8ClampedArray(base.length);
        const op = q.opacity / 100, mode = q.blend;
        for (let i = 0; i < base.length; i += 4) {
          const sr = base[i] / 255, sg = base[i + 1] / 255, sb = base[i + 2] / 255;   // 底=色散图
          const r = layer[i] / 255, g = layer[i + 1] / 255, b = layer[i + 2] / 255;   // 顶=黑底辉光层
          let vr, vg, vb;
          if (mode === 'linearDodge') { vr = sr + r; vg = sg + g; vb = sb + b; }
          else if (mode === 'lighten') { vr = sr > r ? sr : r; vg = sg > g ? sg : g; vb = sb > b ? sb : b; }
          else { vr = sr + r - sr * r; vg = sg + g - sg * g; vb = sb + b - sb * b; }
          out[i] = (sr + (vr - sr) * op) * 255;
          out[i + 1] = (sg + (vg - sg) * op) * 255;
          out[i + 2] = (sb + (vb - sb) * op) * 255;
          out[i + 3] = 255;
        }
        return out;
      },
      source() { return srcRGBA; },
    };
  }

  const FACTORY_PRESETS = [
    { id: 'f_portrait', name: '柔光人像', factory: true, params: { thr: 0.7, bloom: 1.6, radius: 6, soft: 0.7, streaks: 0, tint: '#ffd8a8', tintAmt: 0.3, opacity: 80, blend: 'screen' } },
    { id: 'f_neon', name: '霓虹', factory: true, params: { thr: 0.55, bloom: 3.0, radius: 3, soft: 0.35, streaks: 0, tint: '#ff66cc', tintAmt: 0.15, opacity: 100, blend: 'linearDodge' } },
    { id: 'f_backlight', name: '逆光星芒', factory: true, params: { thr: 0.75, bloom: 2.0, radius: 4, soft: 0.5, streaks: 4, slen: 18, sangle: 0, sgain: 10, tint: '#ffe2b0', tintAmt: 0.4, opacity: 100, blend: 'screen' } },
    { id: 'f_dream', name: '梦幻', factory: true, params: { thr: 0.5, bloom: 2.4, radius: 12, soft: 0.9, streaks: 2, slen: 30, sangle: 90, sgain: 5, tint: '#c8b4ff', tintAmt: 0.45, opacity: 70, blend: 'lighten' } },
    { id: 'f_cheaplens', name: '低质镜头', factory: true, params: { thr: 0.7, bloom: 1.4, radius: 5, soft: 0.6, bloomCA: 0.6, streaks: 4, slen: 12, sangle: 0, sgain: 6, streakCA: 0.7, lensCA: 0.45, lensFall: 0.6, fringe: 0.55, tint: '#ffd8a8', tintAmt: 0.2, opacity: 100, blend: 'screen' } },
  ];

  return { DEFAULTS, BLENDS, FACTORY_PRESETS, normParams, createPipeline, hexRgb };
});
