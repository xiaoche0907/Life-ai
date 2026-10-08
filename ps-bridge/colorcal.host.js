// ============================================================
//  modules/mod-colorcal.host.js —— 校准色偏 host 端 v2
//  action: colorCalibrate
//  约定:当前选中图层 = 出图(待校正), 其正下方同级图层 = 原图(基准)
//  v2 升级:
//   ① 多选区采样:imaging.getSelection 取选区掩码,Shift加选的多块矩形
//      只统计掩码内像素(块间空隙不污染样本)
//   ② 双层校正:Levels(黑白点+gamma,吃大偏移) + Curves(残差,细修)
//   ③ 曲线暗部加密:16点非均匀采样(暗部每8级,人眼最敏感区)
//   ④ 校正前后平均色差报告(日志可见校准质量)
// ============================================================
var HostAPI = require('./host-api.js');
var photoshop = require('photoshop');
var psApp = photoshop.app;
var psCore = photoshop.core;
var imaging = photoshop.imaging;

// ---------- 统计工具 ----------
function _histMasked(buf, comp, ch, mask) {
    var h = new Float64Array(256), n = 0, pi = 0;
    for (var i = ch; i < buf.length; i += comp, pi++) {
        if (mask && mask[pi] < 128) continue;
        h[buf[i]]++; n++;
    }
    if (n > 0) for (var j = 0; j < 256; j++) h[j] /= n;
    return { h: h, n: n };
}
function _cdf(h) {
    var c = new Float64Array(256), s = 0;
    for (var i = 0; i < 256; i++) { s += h[i]; c[i] = s; }
    return c;
}
function _pct(c, p) { for (var i = 0; i < 256; i++) { if (c[i] >= p) return i; } return 255; }
function _matchLUT(srcC, refC) {
    var lut = new Uint8Array(256), j = 0;
    for (var v = 0; v < 256; v++) {
        var p = srcC[v];
        while (j < 255 && refC[j] < p) j++;
        lut[v] = j;
    }
    return lut;
}
// Levels 正向映射函数(和 PS levels 同公式)
function _levelsFn(bIn, wIn, g) {
    return function(v) {
        var x = (v - bIn) / Math.max(1, (wIn - bIn));
        if (x < 0) x = 0; if (x > 1) x = 1;
        return Math.round(Math.pow(x, 1 / g) * 255);
    };
}
// 暗部加密的16个曲线采样点(PS curves 每通道最多16点)
var CURVE_XS = [0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 152, 176, 200, 228, 255];

// ---------- 像素读取 ----------
async function _grab(docId, layerId, bounds, targetSize) {
    var opts = { documentID: docId, layerID: layerId,
        sourceBounds: bounds, componentSize: 8, colorSpace: 'RGB', applyAlpha: false };
    if (targetSize) opts.targetSize = targetSize;
    var pd;
    try { pd = await imaging.getPixels(opts); }
    catch (e) { delete opts.componentSize; pd = await imaging.getPixels(opts); }
    var img = pd.imageData || pd;
    var raw = (typeof img.getData === 'function') ? await img.getData({}) : img.data;
    var comp = img.components || 3;
    var buf;
    if (raw.BYTES_PER_ELEMENT === 2) {
        buf = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) { var t = raw[i] >> 7; buf[i] = t > 255 ? 255 : t; }
    } else buf = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
    var iw = img.width || 0, ih = img.height || 0;
    try { if (img.dispose) img.dispose(); } catch (e2) {}
    return { buf: buf, comp: comp, w: iw, h: ih };
}
async function _grabMask(docId, bounds) {
    try {
        var pd = await imaging.getSelection({ documentID: docId, sourceBounds: bounds, componentSize: 8 });
        var img = pd.imageData || pd;
        var raw = (typeof img.getData === 'function') ? await img.getData({}) : img.data;
        var mask = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
        try { if (img.dispose) img.dispose(); } catch (e) {}
        return mask;
    } catch (e2) { return null; } // 拿不到掩码就退化为整个包围盒
}

module.exports = {};

HostAPI.registerAction('colorCalibrate', async function(data, ctx) {
    var send = function(ok, msg) { ctx.sendToPanel('colorCalResult', { success: ok, message: msg }); };
    try {
        var doc = psApp.activeDocument;
        if (!doc) { send(false, '没有打开的文档'); return; }
        var err = null, report = '';
        await psCore.executeAsModal(async function() {
            // 1) 选区包围盒
            var bounds = null;
            try {
                var b = doc.selection.bounds;
                bounds = { left: Math.round(b.left), top: Math.round(b.top),
                           right: Math.round(b.right), bottom: Math.round(b.bottom) };
            } catch (eSel) { err = '请先用矩形选框工具框选对比区域(可Shift加选多块)'; return; }
            if (!bounds || bounds.right - bounds.left < 8 || bounds.bottom - bounds.top < 8) {
                err = '选区太小(至少8x8像素)'; return;
            }
            // 2) 图层定位:选中层=出图, 正下方同级=原图
            var al = (doc.activeLayers && doc.activeLayers[0]) || null;
            if (!al) { err = '请先选中出图图层'; return; }
            var sibs = doc.layers;
            try { if (al.parent && al.parent.layers) sibs = al.parent.layers; } catch (eP) {}
            var idx = -1;
            for (var i = 0; i < sibs.length; i++) { if (sibs[i].id === al.id) { idx = i; break; } }
            if (idx < 0 || idx + 1 >= sibs.length) { err = '选中图层下方没有基准图层'; return; }
            var refLayer = sibs[idx + 1];
            // 3) 掩码 + 两层像素
            var mask = await _grabMask(doc.id, bounds);
            var src = await _grab(doc.id, al.id, bounds);
            var ref = await _grab(doc.id, refLayer.id, bounds);
            // 4) 逐通道:统计 → Levels参数 → 残差曲线LUT
            var chNames = ['red', 'grain', 'blue'];
            var levelsAdj = [], curveLUTs = [], sampleN = 0;
            var dBefore = 0, dAfter = 0;
            for (var ch = 0; ch < 3; ch++) {
                var sH = _histMasked(src.buf, src.comp, ch, mask);
                var rH = _histMasked(ref.buf, ref.comp, ch, mask);
                if (ch === 0) sampleN = sH.n;
                if (sH.n < 500 || rH.n < 500) { err = '选区有效像素太少(' + sH.n + '),请框大一点'; return; }
                var sC = _cdf(sH.h), rC = _cdf(rH.h);
                // Levels: 黑白点(0.5%/99.5%分位) + gamma(中位数对齐)
                var bIn = _pct(sC, 0.005), wIn = _pct(sC, 0.995);
                var bOut = _pct(rC, 0.005), wOut = _pct(rC, 0.995);
                var g = 1;
                if (wIn - bIn > 5) {
                    var m = (_pct(sC, 0.5) - bIn) / (wIn - bIn);
                    var t = (_pct(rC, 0.5) - bOut) / Math.max(1, (wOut - bOut));
                    if (m > 0.01 && m < 0.99 && t > 0.01 && t < 0.99) {
                        g = Math.log(m) / Math.log(t);
                        if (g < 0.2) g = 0.2; if (g > 5) g = 5;
                    }
                } else { bIn = 0; wIn = 255; }
                g = Math.round(g * 100) / 100;
                levelsAdj.push({ _obj: 'levelsAdjustment',
                    channel: { _ref: 'channel', _enum: 'channel', _value: chNames[ch] },
                    input: [bIn, wIn], output: [bOut, wOut], gamma: g });
                // 残差曲线:对"Levels校正后的src分布"再做直方图匹配
                var lf = _levelsFn(bIn, wIn, g);
                var outScale = function(v) { return Math.round(bOut + v / 255 * (wOut - bOut)); };
                var postH = new Float64Array(256);
                for (var v0 = 0; v0 < 256; v0++) postH[outScale(lf(v0))] += sH.h[v0];
                var postC = _cdf(postH);
                curveLUTs.push(_matchLUT(postC, rC));
                // 色差统计(均值绝对差,校正前 vs 校正后)
                var meanS = 0, meanR = 0, meanA = 0;
                for (var v1 = 0; v1 < 256; v1++) {
                    meanS += v1 * sH.h[v1]; meanR += v1 * rH.h[v1];
                    meanA += curveLUTs[ch][outScale(lf(v1))] * sH.h[v1];
                }
                dBefore += Math.abs(meanS - meanR); dAfter += Math.abs(meanA - meanR);
            }
            report = '采样' + sampleN + '像素 | 平均色差 ' + (dBefore / 3).toFixed(1) + ' → ' + (dAfter / 3).toFixed(1);
            // 5) 取消选区(否则调整图层带选区蒙版)
            await psApp.batchPlay([{ _obj: 'set',
                _target: [{ _ref: 'channel', _property: 'selection' }],
                to: { _enum: 'ordinal', _value: 'none' } }], {});
            // 6) Levels 层(大偏移) + 剪贴
            await psApp.batchPlay([{ _obj: 'make', _target: [{ _ref: 'adjustmentLayer' }],
                using: { _obj: 'adjustmentLayer', name: '色偏校准-色阶',
                    type: { _obj: 'levels',
                        presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
                        adjustment: levelsAdj } } }], {});
            await psApp.batchPlay([{ _obj: 'groupEvent',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
            // 7) Curves 层(残差,暗部加密16点) + 剪贴
            function chCurve(name, lut) {
                var pts = [];
                for (var k = 0; k < CURVE_XS.length; k++) {
                    var x = CURVE_XS[k];
                    pts.push({ _obj: 'paint', horizontal: x, vertical: lut[x] });
                }
                return { _obj: 'curvesAdjustment',
                    channel: { _ref: 'channel', _enum: 'channel', _value: name },
                    curve: pts };
            }
            await psApp.batchPlay([{ _obj: 'make', _target: [{ _ref: 'adjustmentLayer' }],
                using: { _obj: 'adjustmentLayer', name: '色偏校准-曲线',
                    type: { _obj: 'curves',
                        presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
                        adjustment: [ chCurve('red', curveLUTs[0]), chCurve('grain', curveLUTs[1]), chCurve('blue', curveLUTs[2]) ] } } }], {});
            await psApp.batchPlay([{ _obj: 'groupEvent',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
        }, { commandName: '校准色偏' });
        if (err) { send(false, err); return; }
        send(true, '校准完成(' + report + '):已生成「色阶+曲线」双层剪贴校正,可开关/微调/删除');
    } catch (e) {
        send(false, '校准失败: ' + (e && e.message ? e.message : e));
    }
}, { moduleId: 'colorcal' });

// ============================================================
//  强校准 colorCalibrateStrong —— 频率分离逐像素色彩迁移
//  原理: 校正层 = 原图 - blur(出图) + blur(原图) 的低频差,
//  以线性光50%不透明度(等效线性加法)叠回出图 →
//  低频颜色逐像素回到原图,AI细节(高频)保留。
//  实现全用 batchPlay 原生操作(复制层/高斯模糊/应用图像/剪贴),
//  产物: 一个名为「强校准-颜色对齐」的像素层剪贴在出图层上,
//  自带白蒙版 —— 不想被拉回的区域用黑画笔涂掉即可豁免。
// ============================================================
HostAPI.registerAction('colorCalibrateStrong', async function(data, ctx) {
    var send = function(ok, msg) { ctx.sendToPanel('colorCalResult', { success: ok, message: msg }); };
    var BLUR_RADIUS = (data && data.radius) || 30; // 高斯模糊半径(px):越小贴得越死,越大只纠大关系
    try {
        var doc = psApp.activeDocument;
        if (!doc) { send(false, '没有打开的文档'); return; }
        var err = null;
        await psCore.executeAsModal(async function() {
            var al = (doc.activeLayers && doc.activeLayers[0]) || null;
            if (!al) { err = '请先选中出图图层'; return; }
            var sibs = doc.layers;
            try { if (al.parent && al.parent.layers) sibs = al.parent.layers; } catch (eP) {}
            var idx = -1;
            for (var i = 0; i < sibs.length; i++) { if (sibs[i].id === al.id) { idx = i; break; } }
            if (idx < 0 || idx + 1 >= sibs.length) { err = '选中图层下方没有基准图层'; return; }
            var refLayer = sibs[idx + 1];
            var bp = function(cmds) { return psApp.batchPlay(cmds, { synchronousExecution: true }); };
            var selLayerById = function(id) {
                return bp([{ _obj: 'select', _target: [{ _ref: 'layer', _id: id }],
                    makeVisible: false }]);
            };
            // 若有活动选区先取消(应用图像/模糊要作用全图)
            try { await bp([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }],
                to: { _enum: 'ordinal', _value: 'none' } }]); } catch (eS) {}

            // 1) 复制原图层 → blurRef(置于出图层上方)
            await selLayerById(refLayer.id);
            await bp([{ _obj: 'duplicate', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                name: '_cc_blurRef' }]);
            var blurRef = doc.activeLayers[0];
            await bp([{ _obj: 'move', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                to: { _ref: 'layer', _id: al.id }, adjustment: false }]);
            // 2) 复制出图层 → blurSrc
            await selLayerById(al.id);
            await bp([{ _obj: 'duplicate', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                name: '_cc_blurSrc' }]);
            var blurSrc = doc.activeLayers[0];
            // 3) 各自高斯模糊(只留低频颜色关系)
            await selLayerById(blurRef.id);
            await bp([{ _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: BLUR_RADIUS } }]);
            await selLayerById(blurSrc.id);
            await bp([{ _obj: 'gaussianBlur', radius: { _unit: 'pixelsUnit', _value: BLUR_RADIUS } }]);
            // 4) 差值层: blurRef 上用"应用图像"减去 blurSrc → 得 (blurRef - blurSrc + 128) 的偏差图
            //    subtract with scale=1 offset=128 → 灰128=无偏差
            await selLayerById(blurRef.id);
            await bp([{ _obj: 'applyImageEvent',
                with: { _obj: 'calculation',
                    to: { _ref: [{ _ref: 'channel', _enum: 'channel', _value: 'RGB' },
                                 { _ref: 'layer', _id: blurSrc.id }] },
                    calculation: { _obj: 'calculation', _value: 'subtract',
                        scale: 1, offset: 128 },
                    preserveTransparency: false } }]).catch(async function() {
                // 兼容写法:有的PS版本 calculation 直接是枚举
                await bp([{ _obj: 'applyImageEvent',
                    with: { _obj: 'calculation',
                        to: { _ref: [{ _ref: 'channel', _enum: 'channel', _value: 'RGB' },
                                     { _ref: 'layer', _id: blurSrc.id }] },
                        calculation: { _enum: 'calculationType', _value: 'subtract' },
                        scale: 1, offset: 128 } }]);
            });
            // 5) 删除 blurSrc,偏差层改名+线性光模式(50%不透明度=精确的线性加法)
            await selLayerById(blurSrc.id);
            await bp([{ _obj: 'delete', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }]);
            await selLayerById(blurRef.id);
            await bp([{ _obj: 'set', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                to: { _obj: 'layer', name: '强校准-颜色对齐',
                      mode: { _enum: 'blendMode', _value: 'linearLight' },
                      opacity: { _unit: 'percentUnit', _value: 50 } } }]);
            // 6) 白蒙版(可用黑画笔豁免不想拉回的区域) + 剪贴到出图层
            await bp([{ _obj: 'make', new: { _class: 'channel' },
                at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
                using: { _enum: 'userMaskEnabled', _value: 'revealAll' } }]);
            await bp([{ _obj: 'groupEvent',
                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }]);
            // 7) 回选出图层,方便继续操作
            await selLayerById(al.id);
        }, { commandName: '强校准色偏' });
        if (err) { send(false, err); return; }
        send(true, '强校准完成:已生成「强校准-颜色对齐」层(线性光50%),逐像素低频对色。不想被拉回的区域在其蒙版上用黑画笔涂掉');
    } catch (e) {
        send(false, '强校准失败: ' + (e && e.message ? e.message : e));
    }
}, { moduleId: 'colorcal' });

// ============================================================
//  色卡校准 chartStamp / chartFinish
//  stamp: 在画面(选区或全图)底部贴一条已知颜色的色卡层(占高4.5%)
//         截图流程自动把它带给AI;提示词由面板附加"保持色卡"指令
//  finish: 回图后找新增图层,采样色卡实测值 vs 已知值(纯净真值测量),
//          10级灰阶直接给出每通道曲线控制点 → 曲线校正层剪贴,
//          再用蒙版遮掉色卡区(透出底下原图),删除色卡层
// ============================================================
var CHART_GRAYS = [0, 28, 57, 85, 113, 142, 170, 198, 227, 255];
var CHART_COLORS = [[220, 40, 40], [40, 200, 60], [50, 80, 220], [240, 196, 166]];
// LUT精修:6灰阶 + 经典ColorChecker 18色(sRGB近似)
var LUT_GRAYS = [0, 51, 102, 153, 204, 255];
var LUT_COLORS = [
    [115,82,68],[194,150,130],[98,122,157],[87,108,67],[133,128,177],[103,189,170],
    [214,126,44],[80,91,166],[193,90,99],[94,60,108],[157,188,64],[224,163,46],
    [56,61,150],[70,148,73],[175,54,60],[231,199,31],[187,86,149],[8,133,161]
];
var CHART_N = 14; // basic: 10灰阶 + 红绿蓝 + 肤色
var _charts = {}; // 按文档id存: {stripId, rect, bandTop, stripH, existingIds, mode, known, ...}（v54：多张图并发跑各自结算，不再单槽互相覆盖）

// 切到指定文档（v54：贴回后 PS 会切回用户正在看的文档，结算必须自己定位到贴卡的那张）
async function _chartSelectDoc(docId) {
    if (!docId) return psApp.activeDocument;
    var cur = psApp.activeDocument;
    if (cur && cur.id === docId) return cur;
    await psApp.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: docId }] }], {});
    cur = psApp.activeDocument;
    if (!cur || cur.id !== docId) throw new Error('贴卡的文档已关闭或找不到(id=' + docId + ')');
    return cur;
}

// 色卡规格:basic=10灰阶+4色, lut=6灰阶+ColorChecker18色
function _chartSpec(mode) {
    var known = [], grayIdx = [], i;
    if (mode === 'lut') {
        for (i = 0; i < LUT_GRAYS.length; i++) { known.push([LUT_GRAYS[i], LUT_GRAYS[i], LUT_GRAYS[i]]); grayIdx.push(i); }
        for (i = 0; i < LUT_COLORS.length; i++) known.push(LUT_COLORS[i]);
        return { known: known, grayIdx: grayIdx, chkR: 6 + 14, chkG: 6 + 13, chkB: 6 + 12 };
    }
    for (i = 0; i < CHART_GRAYS.length; i++) { known.push([CHART_GRAYS[i], CHART_GRAYS[i], CHART_GRAYS[i]]); grayIdx.push(i); }
    for (i = 0; i < CHART_COLORS.length; i++) known.push(CHART_COLORS[i]);
    return { known: known, grayIdx: grayIdx, chkR: 10, chkG: 11, chkB: 12 };
}

function _chartKnown(i) {
    if (i < 10) { var g = CHART_GRAYS[i]; return [g, g, g]; }
    return CHART_COLORS[i - 10];
}

// 曲线校正后的颜色(mergedAll: 每通道曲线点)
function _applyCurve(mergedAll, c) {
    return [_interp(mergedAll[0], c[0]), _interp(mergedAll[1], c[1]), _interp(mergedAll[2], c[2])];
}
// 由色卡样本构建 17^3 LUT网格(Float32Array, [b][g][r]*3, 值0..1)
// 每格点按RGB空间距离对样本偏移做高斯加权平均;W0=恒等锚(远离样本处衰减为不动,防过拟合)
function _buildGrid(meas, KN, mergedAll) {
    var src = [], off = [], i;
    for (i = 0; i < KN.length; i++) {
        var c = _applyCurve(mergedAll, meas[i]);
        src.push([c[0] / 255, c[1] / 255, c[2] / 255]);
        off.push([(KN[i][0] - c[0]) / 255, (KN[i][1] - c[1]) / 255, (KN[i][2] - c[2]) / 255]);
    }
    var SZ = 17, s2 = 2 * 0.22 * 0.22, W0 = 0.15;
    var grid = new Float32Array(SZ * SZ * SZ * 3), p = 0;
    for (var b = 0; b < SZ; b++) {
        for (var g = 0; g < SZ; g++) {
            for (var r = 0; r < SZ; r++) {
                var pr = r / (SZ - 1), pg = g / (SZ - 1), pb = b / (SZ - 1);
                var sw = W0, oR = 0, oG = 0, oB = 0;
                for (var k = 0; k < src.length; k++) {
                    var dr = pr - src[k][0], dg = pg - src[k][1], db = pb - src[k][2];
                    var w = Math.exp(-(dr * dr + dg * dg + db * db) / s2);
                    sw += w; oR += w * off[k][0]; oG += w * off[k][1]; oB += w * off[k][2];
                }
                var vr = pr + oR / sw, vg = pg + oG / sw, vb = pb + oB / sw;
                grid[p++] = vr < 0 ? 0 : (vr > 1 ? 1 : vr);
                grid[p++] = vg < 0 ? 0 : (vg > 1 ? 1 : vg);
                grid[p++] = vb < 0 ? 0 : (vb > 1 ? 1 : vb);
            }
        }
    }
    return grid;
}
// 网格 → .cube 文本(存档用)
function _buildCube(grid) {
    var lines = ['TITLE "colorcal auto LUT"', 'LUT_3D_SIZE 17'];
    for (var p = 0; p < grid.length; p += 3) {
        lines.push(grid[p].toFixed(5) + ' ' + grid[p + 1].toFixed(5) + ' ' + grid[p + 2].toFixed(5));
    }
    return lines.join('\n') + '\n';
}
function _walkLayers(layers, out) {
    for (var i = 0; i < layers.length; i++) {
        out.push(layers[i]);
        try { if (layers[i].layers && layers[i].layers.length) _walkLayers(layers[i].layers, out); } catch (e) {}
    }
}
// 分段线性插值(points: [{h,v}...] 按h升序)
function _interp(pts, x) {
    if (x <= pts[0].h) return pts[0].v;
    for (var i = 1; i < pts.length; i++) {
        if (x <= pts[i].h) {
            var a = pts[i - 1], b = pts[i];
            return a.v + (b.v - a.v) * (x - a.h) / Math.max(1, b.h - a.h);
        }
    }
    return pts[pts.length - 1].v;
}

HostAPI.registerAction('chartStamp', async function(data, ctx) {
    var send = function(ok, msg) { ctx.sendToPanel('chartStampResult', { ok: ok, message: msg || '' }); };
    try {
        var doc = psApp.activeDocument;
        if (!doc) { send(false, '没有打开的文档'); return; }
        var mode = (data && data.lut) ? 'lut' : 'basic';
        var spec = _chartSpec(mode), known = spec.known, N = known.length;
        await psCore.executeAsModal(async function() {
            // 区域 = 选区(有则)否则全图
            var rect;
            try {
                var b = doc.selection.bounds;
                rect = { left: Math.round(b.left), top: Math.round(b.top),
                         right: Math.round(b.right), bottom: Math.round(b.bottom) };
            } catch (eS) {
                rect = { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) };
            }
            var W = rect.right - rect.left, H = rect.bottom - rect.top;
            if (W < 140 || H < 100) throw new Error('画面/选区太小,无法贴色卡');
            var stripH = Math.max(24, Math.round(H * 0.045));
            if (stripH > Math.round(H * 0.2)) stripH = Math.round(H * 0.2);
            var bandTop = rect.bottom - stripH;
            // 记录现有图层ID(结算时用差集找新图层)
            var all = []; _walkLayers(doc.layers, all);
            var ids = []; for (var i = 0; i < all.length; i++) ids.push(all[i].id);
            // 明度探针:先截一条"画面缩略条"(照片内容——模型对正片的明度/调子处理会同样施加于它)
            var thumbW = Math.min(Math.round(W * 0.45), Math.max(24, Math.round(stripH * (W / H) * 2.2)));
            if (mode === 'lut' && W - thumbW < N * 8) { mode = 'basic'; spec = _chartSpec(mode); known = spec.known; N = known.length; }
            if (W - thumbW < N * 8) thumbW = 0; // 色块空间不够→退回纯色块模式
            var thumb = null, thumbCdf = null;
            if (thumbW >= 24) {
                try {
                    var tOpts = { documentID: doc.id, sourceBounds: rect,
                        targetSize: { width: thumbW, height: stripH },
                        componentSize: 8, colorSpace: 'RGB', applyAlpha: false };
                    var tp;
                    try { tp = await imaging.getPixels(tOpts); }
                    catch (eT8) { delete tOpts.componentSize; tp = await imaging.getPixels(tOpts); }
                    var tImg = tp.imageData || tp;
                    var tRaw = (typeof tImg.getData === 'function') ? await tImg.getData({}) : tImg.data;
                    var tComp = tImg.components || 3;
                    var tBuf;
                    if (tRaw.BYTES_PER_ELEMENT === 2) {
                        tBuf = new Uint8Array(tRaw.length);
                        for (var ti = 0; ti < tRaw.length; ti++) { var tv = tRaw[ti] >> 7; tBuf[ti] = tv > 255 ? 255 : tv; }
                    } else tBuf = (tRaw instanceof Uint8Array) ? tRaw : new Uint8Array(tRaw);
                    try { if (tImg.dispose) tImg.dispose(); } catch (eTD) {}
                    thumb = { buf: tBuf, comp: tComp };
                    thumbCdf = [];
                    for (var tc = 0; tc < 3; tc++) thumbCdf.push(_cdf(_histMasked(tBuf, tComp, tc, null).h));
                } catch (eTh) { thumb = null; thumbCdf = null; thumbW = 0; }
            } else thumbW = 0;
            // 画色卡像素(RGBA): [缩略条 | 灰阶+彩块]
            var buf = new Uint8Array(W * stripH * 4);
            var pw = Math.floor((W - thumbW) / N);
            for (var y = 0; y < stripH; y++) {
                for (var x = 0; x < W; x++) {
                    var o = (y * W + x) * 4;
                    if (x < thumbW && thumb) {
                        var to2 = (y * thumbW + x) * thumb.comp;
                        buf[o] = thumb.buf[to2]; buf[o + 1] = thumb.buf[to2 + 1]; buf[o + 2] = thumb.buf[to2 + 2]; buf[o + 3] = 255;
                    } else {
                        var pi = Math.min(N - 1, Math.floor((x - thumbW) / pw));
                        var c = known[pi];
                        buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
                    }
                }
            }
            // 新建顶层图层并写入
            try { var top = doc.layers[0]; if (top) await psApp.batchPlay([{ _obj: 'select',
                _target: [{ _ref: 'layer', _id: top.id }], makeVisible: false }], {}); } catch (eT) {}
            await psApp.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }],
                using: { _obj: 'layer', name: '_色卡校准条' } }], {});
            var stripLayer = doc.activeLayers[0];
            var imgData = await imaging.createImageDataFromBuffer(buf, {
                width: W, height: stripH, components: 4, colorSpace: 'RGB', componentSize: 8, chunky: true });
            await imaging.putPixels({ documentID: doc.id, layerID: stripLayer.id,
                targetBounds: { left: rect.left, top: bandTop }, imageData: imgData, commandName: '贴色卡' });
            try { if (imgData.dispose) imgData.dispose(); } catch (eD) {}
            _charts[doc.id] = { docId: doc.id, stripId: stripLayer.id, rect: rect, bandTop: bandTop,
                       stripH: stripH, existingIds: ids,
                       thumbW: thumbW, patchW: pw, thumbCdf: thumbCdf,
                       mode: mode, known: known, grayIdx: spec.grayIdx,
                       chkR: spec.chkR, chkG: spec.chkG, chkB: spec.chkB };
        }, { commandName: '贴校准色卡' });
        if (!_charts[doc.id]) { send(false, '贴卡未完成'); return; }
        send(true, '色卡已贴');
    } catch (e) {
        try { delete _charts[psApp.activeDocument.id]; } catch (eD) {}
        send(false, e && e.message ? e.message : String(e));
    }
}, { moduleId: 'colorcal' });

HostAPI.registerAction('chartFinish', async function(data, ctx) {
    var send = function(ok, msg) { ctx.sendToPanel('chartFinishResult', { success: ok, message: msg }); };
    var origId = null;
    try {
        // 结算目标：软件端传来的发起文档id；没传（旧软件）就按当前文档；再没有就取唯一一张待结算的
        var wantId = (data && data.docId) || (psApp.activeDocument ? psApp.activeDocument.id : null);
        var st = _charts[wantId];
        if (!st) { var ks = Object.keys(_charts); if (ks.length === 1) st = _charts[ks[0]]; }
        if (!st) { send(false, '没有待结算的色卡任务'); return; }
        delete _charts[st.docId];
        try { origId = psApp.activeDocument ? psApp.activeDocument.id : null; } catch (eO) {}
        var doc = null;
        var okN = 0, skipN = 0, lutN = 0, report = '', maskFail = 0, maskErr = '', backErr = '';
        await psCore.executeAsModal(async function() {
            doc = await _chartSelectDoc(st.docId);
            // 找新增的像素/智能对象图层(排除色卡层自身)
            var all = []; _walkLayers(doc.layers, all);
            var seen = {}; for (var i = 0; i < st.existingIds.length; i++) seen[st.existingIds[i]] = 1;
            var newLayers = [];
            for (var j = 0; j < all.length; j++) {
                var L = all[j], k = '';
                try { k = String(L.kind); } catch (eK) {}
                if (L.id === st.stripId || seen[L.id]) continue;
                if (k === 'group' || k === 'groupEnd') continue;
                newLayers.push(L);
                if (newLayers.length >= 8) break;
            }
            var band = { left: st.rect.left, top: st.bandTop, right: st.rect.right, bottom: st.rect.bottom };
            var tW = st.thumbW || 0;
            var KN = st.known || _chartSpec('basic').known;
            var NP = KN.length;
            var gN = st.grayIdx ? st.grayIdx.length : 10;
            var iR = (st.chkR !== undefined) ? st.chkR : 10;
            var iG = (st.chkG !== undefined) ? st.chkG : 11;
            var iB = (st.chkB !== undefined) ? st.chkB : 12;
            var pw = st.patchW || Math.floor((st.rect.right - st.rect.left - tW) / NP);
            for (var n = 0; n < newLayers.length; n++) {
                var lay = newLayers[n];
                // 采样该层色卡带
                var px;
                try { px = await _grab(doc.id, lay.id, band); } catch (eG) { skipN++; continue; }
                var bw = st.rect.right - st.rect.left;
                // 若返回宽度与band不一致(层被裁),按实际宽度换算
                var actW = Math.round(px.buf.length / px.comp / st.stripH) || bw;
                var meas = [];
                for (var p = 0; p < NP; p++) {
                    var cx = Math.round((tW + (p + 0.5) * pw) * actW / bw);
                    var cy = Math.round(st.stripH / 2 * actW / bw * (bw / actW)); // 中心行
                    cy = Math.round(st.stripH / 2);
                    var sum = [0, 0, 0], cnt = 0;
                    for (var dy = -2; dy <= 2; dy++) {
                        for (var dx = -3; dx <= 3; dx++) {
                            var xx = cx + dx, yy = cy + dy;
                            if (xx < 0 || xx >= actW || yy < 0 || yy >= st.stripH) continue;
                            var oo = (yy * actW + xx) * px.comp;
                            sum[0] += px.buf[oo]; sum[1] += px.buf[oo + 1]; sum[2] += px.buf[oo + 2]; cnt++;
                        }
                    }
                    if (cnt === 0) { meas = null; break; }
                    meas.push([sum[0] / cnt, sum[1] / cnt, sum[2] / cnt]);
                }
                // 验卡:灰阶必须基本递增且跨度足够,彩块通道方向正确
                var valid = !!meas;
                if (valid) {
                    var inv = 0;
                    var lum = function(c) { return (c[0] + c[1] + c[2]) / 3; };
                    for (var g1 = 1; g1 < gN; g1++) { if (lum(meas[g1]) < lum(meas[g1 - 1]) - 6) inv++; }
                    if (inv > 1) valid = false;
                    if (lum(meas[gN - 1]) - lum(meas[0]) < 60) valid = false;
                    var cOK = 0;
                    if (meas[iR][0] > meas[iR][1] + 15 && meas[iR][0] > meas[iR][2] + 15) cOK++;
                    if (meas[iG][1] > meas[iG][0] + 10 && meas[iG][1] > meas[iG][2] + 10) cOK++;
                    if (meas[iB][2] > meas[iB][0] + 10 && meas[iB][2] > meas[iB][1] + 10) cOK++;
                    if (cOK < 2) valid = false;
                }
                if (valid) {
                    var adj = [], names = ['red', 'grain', 'blue'], mergedAll = [];
                    var dBefore = 0, dAfter = 0;
                    var twAct = Math.round(tW * actW / bw);
                    var useThumb = !!(st.thumbCdf && twAct >= 16);
                    for (var ch = 0; ch < 3; ch++) {
                        var merged = [];
                        if (useThumb) {
                            // 明度+颜色全量:回图缩略条 vs 原缩略条 直方图匹配(暗部加密采样)
                            var rh = new Float64Array(256), rn = 0;
                            for (var ty = 0; ty < st.stripH; ty++) {
                                for (var tx = 0; tx < twAct; tx++) {
                                    var ro = (ty * actW + tx) * px.comp;
                                    if (ro + ch < px.buf.length) { rh[px.buf[ro + ch]]++; rn++; }
                                }
                            }
                            if (rn > 0) for (var rz = 0; rz < 256; rz++) rh[rz] /= rn;
                            var lut2 = _matchLUT(_cdf(rh), st.thumbCdf[ch]);
                            for (var k2 = 0; k2 < CURVE_XS.length; k2++) {
                                merged.push({ h: CURVE_XS[k2], v: lut2[CURVE_XS[k2]] });
                            }
                            // 报告:均值偏移 校正前 vs 校正后
                            var mB = 0, mA = 0, mR = 0;
                            for (var rz2 = 0; rz2 < 256; rz2++) { mB += rz2 * rh[rz2]; mA += lut2[rz2] * rh[rz2]; }
                            for (var rz3 = 0; rz3 < 255; rz3++) mR += (1 - st.thumbCdf[ch][rz3]);
                            dBefore += Math.abs(mB - mR) / 3; dAfter += Math.abs(mA - mR) / 3;
                        } else {
                            // 纯色块模式:实测灰阶值→已知灰阶值
                            var pts = [];
                            for (var gi = 0; gi < gN; gi++) {
                                pts.push({ h: Math.round(meas[gi][ch]), v: KN[gi][ch] });
                            }
                            pts.sort(function(a, b2) { return a.h - b2.h; });
                            for (var m1 = 0; m1 < pts.length; m1++) {
                                if (merged.length && pts[m1].h - merged[merged.length - 1].h < 3) {
                                    merged[merged.length - 1].v = Math.round((merged[merged.length - 1].v + pts[m1].v) / 2);
                                } else merged.push({ h: pts[m1].h, v: pts[m1].v });
                            }
                            if (merged[0].h > 0) {
                                var a0 = merged[0], a1 = merged[1] || { h: a0.h + 10, v: a0.v + 10 };
                                var v0 = Math.round(a0.v - (a1.v - a0.v) / Math.max(1, a1.h - a0.h) * a0.h);
                                merged.unshift({ h: 0, v: Math.max(0, Math.min(255, v0)) });
                            }
                            var eN = merged.length - 1;
                            if (merged[eN].h < 255) {
                                var b1 = merged[eN], b0 = merged[eN - 1] || { h: b1.h - 10, v: b1.v - 10 };
                                var v255 = Math.round(b1.v + (b1.v - b0.v) / Math.max(1, b1.h - b0.h) * (255 - b1.h));
                                merged.push({ h: 255, v: Math.max(0, Math.min(255, v255)) });
                            }
                            for (var gj = 0; gj < gN; gj++) {
                                dBefore += Math.abs(meas[gj][ch] - KN[gj][ch]) / (gN * 3);
                                dAfter += Math.abs(_interp(merged, meas[gj][ch]) - KN[gj][ch]) / (gN * 3);
                            }
                        }
                        var curve = [];
                        for (var m2 = 0; m2 < merged.length && m2 < 16; m2++) {
                            curve.push({ _obj: 'paint', horizontal: merged[m2].h, vertical: merged[m2].v });
                        }
                        adj.push({ _obj: 'curvesAdjustment',
                            channel: { _ref: 'channel', _enum: 'channel', _value: names[ch] }, curve: curve });
                        mergedAll.push(merged);
                    }
                    // LUT模式:先复制出图层做只读源(此时曲线还没建,不会拆剪贴组)
                    var srcLayer = null;
                    if (st.mode === 'lut') {
                        try {
                            await psApp.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: lay.id }],
                                makeVisible: false }], {});
                            await psApp.batchPlay([{ _obj: 'duplicate',
                                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                                name: '_cc_lutsrc' }], {});
                            srcLayer = doc.activeLayers[0];
                            try { await psApp.batchPlay([{ _obj: 'rasterizeLayer',
                                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {}); } catch (eRz) {}
                        } catch (eDup) { srcLayer = null; }
                    }
                    // 选中该层→曲线校正层(剪贴,插在出图层正上方、只读源之下)
                    await psApp.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: lay.id }],
                        makeVisible: false }], {});
                    await psApp.batchPlay([{ _obj: 'make', _target: [{ _ref: 'adjustmentLayer' }],
                        using: { _obj: 'adjustmentLayer', name: '色卡校准-曲线',
                            type: { _obj: 'curves',
                                presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
                                adjustment: adj } } }], {});
                    await psApp.batchPlay([{ _obj: 'groupEvent',
                        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
                    var curveLayerRef = doc.activeLayers[0];
                    // LUT精修:24色卡样本 → 17³网格 → 像素烘焙层(80%),校曲线管不了的交叉色偏
                    // (batchPlay数据直载.cube在部分PS版本不支持,故直接在内存应用LUT后写像素层,全版本可用)
                    if (st.mode === 'lut') {
                        try {
                            var grid = _buildGrid(meas, KN, mergedAll);
                            try {
                                var fsL = require('uxp').storage.localFileSystem;
                                var df = await fsL.getDataFolder();
                                var cf = await df.createFile('colorcal_last.cube', { overwrite: true });
                                await cf.write(_buildCube(grid));
                            } catch (eW) {}
                            // 曲线预查表(256级)
                            var cl = [];
                            for (var cch = 0; cch < 3; cch++) {
                                var arr = new Uint8Array(256);
                                for (var cv = 0; cv < 256; cv++) {
                                    var vv = Math.round(_interp(mergedAll[cch], cv));
                                    arr[cv] = vv < 0 ? 0 : (vv > 255 ? 255 : vv);
                                }
                                cl.push(arr);
                            }
                            // 读出图层像素 → 曲线+LUT三线性 → 写入新像素层
                            var lb;
                            try { var bb2 = lay.bounds; lb = { left: Math.round(bb2.left), top: Math.round(bb2.top), right: Math.round(bb2.right), bottom: Math.round(bb2.bottom) }; }
                            catch (eB) { lb = { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) }; }
                            // 关键:AI回图图层常比画布大一圈,越界坐标会让写入报"No pixels in the requested area"
                            // 与画布求交集,只烘焙画布内可见部分
                            var dW = Math.round(doc.width), dH = Math.round(doc.height);
                            if (lb.left < 0) lb.left = 0;
                            if (lb.top < 0) lb.top = 0;
                            if (lb.right > dW) lb.right = dW;
                            if (lb.bottom > dH) lb.bottom = dH;
                            var bw2 = lb.right - lb.left, bh2 = lb.bottom - lb.top;
                            if (bw2 < 1 || bh2 < 1) throw new Error('图层边界无效');
                            var SZ2 = 17, SM = SZ2 - 1, sc2 = SM / 255, ROW = SZ2 * 3, PLANE = SZ2 * SZ2 * 3;
                            if (!srcLayer) throw new Error('只读源复制失败');
                            try { ctx.logToPanel('[色卡] LUT烘焙开始: ' + bw2 + 'x' + bh2 + ' (分层写入+合并)', 'info'); } catch (eLg0) {}
                            var STRIP = Math.max(64, Math.floor(1500000 / Math.max(1, bw2)));
                            var stripIds = [];
                            var stripsDone = 0;
                            for (var sy = lb.top; sy < lb.bottom; sy += STRIP) {
                                var sBot = Math.min(lb.bottom, sy + STRIP);
                                var sb = { left: lb.left, top: sy, right: lb.right, bottom: sBot };
                                var pOpts = { documentID: doc.id, layerID: srcLayer.id, sourceBounds: sb,
                                    componentSize: 8, colorSpace: 'RGB', applyAlpha: false };
                                var pd2;
                                try {
                                    try { pd2 = await imaging.getPixels(pOpts); }
                                    catch (eP8) { delete pOpts.componentSize; pd2 = await imaging.getPixels(pOpts); }
                                } catch (eRd) { throw new Error('读取条带@' + sy + ': ' + (eRd && eRd.message ? eRd.message : eRd)); }
                                var im2 = pd2.imageData || pd2;
                                var raw2 = (typeof im2.getData === 'function') ? await im2.getData({}) : im2.data;
                                var comp2 = im2.components || 3;
                                var pw2 = im2.width || (sb.right - sb.left), ph2 = im2.height || (sBot - sy);
                                try { if (im2.dispose) im2.dispose(); } catch (eD2) {}
                                var srcBuf;
                                if (raw2 && raw2.BYTES_PER_ELEMENT === 2) {
                                    srcBuf = new Uint8Array(raw2.length);
                                    for (var cv2 = 0; cv2 < raw2.length; cv2++) { var q = raw2[cv2] >> 7; srcBuf[cv2] = q > 255 ? 255 : q; }
                                } else srcBuf = (raw2 instanceof Uint8Array) ? raw2 : new Uint8Array(raw2);
                                // 统一转RGBA(写图层像素需带alpha;缺则补255)
                                var npx = pw2 * ph2;
                                var pbuf = new Uint8Array(npx * 4);
                                for (var px2 = 0; px2 < npx; px2++) {
                                    var si = px2 * comp2, di = px2 * 4;
                                    var rr = cl[0][srcBuf[si]] * sc2, gg = cl[1][srcBuf[si + 1]] * sc2, bb3 = cl[2][srcBuf[si + 2]] * sc2;
                                    var r1 = rr | 0, g1i = gg | 0, b1i = bb3 | 0;
                                    if (r1 >= SM) r1 = SM - 1;
                                    if (g1i >= SM) g1i = SM - 1;
                                    if (b1i >= SM) b1i = SM - 1;
                                    var xr = rr - r1, xg = gg - g1i, xb = bb3 - b1i;
                                    var i000 = b1i * PLANE + g1i * ROW + r1 * 3;
                                    var i100 = i000 + 3, i010 = i000 + ROW, i110 = i010 + 3;
                                    var i001 = i000 + PLANE, i101 = i001 + 3, i011 = i001 + ROW, i111 = i011 + 3;
                                    for (var cc = 0; cc < 3; cc++) {
                                        var v00 = grid[i000 + cc] + (grid[i100 + cc] - grid[i000 + cc]) * xr;
                                        var v10 = grid[i010 + cc] + (grid[i110 + cc] - grid[i010 + cc]) * xr;
                                        var v01 = grid[i001 + cc] + (grid[i101 + cc] - grid[i001 + cc]) * xr;
                                        var v11 = grid[i011 + cc] + (grid[i111 + cc] - grid[i011 + cc]) * xr;
                                        var v0 = v00 + (v10 - v00) * xg, v1 = v01 + (v11 - v01) * xg;
                                        var vf = (v0 + (v1 - v0) * xb) * 255;
                                        pbuf[di + cc] = vf < 0 ? 0 : (vf > 255 ? 255 : Math.round(vf));
                                    }
                                    pbuf[di + 3] = (comp2 === 4) ? srcBuf[si + 3] : 255;
                                }
                                var outImg = await imaging.createImageDataFromBuffer(pbuf, {
                                    width: pw2, height: ph2, components: 4,
                                    colorSpace: 'RGB', componentSize: 8, chunky: true });
                                try {
                                    // 每条带一个独立新图层,建在只读源正上方(即该出图层的局部堆栈内,天然落位正确)
                                    await psApp.batchPlay([{ _obj: 'select',
                                        _target: [{ _ref: 'layer', _id: srcLayer.id }], makeVisible: false }], {});
                                    await psApp.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }],
                                        using: { _obj: 'layer', name: '_cc_lut_' + sy } }], {});
                                    var stripLayer2 = doc.activeLayers[0];
                                    await imaging.putPixels({ documentID: doc.id, layerID: stripLayer2.id,
                                        targetBounds: { left: sb.left, top: sy },
                                        imageData: outImg, commandName: 'LUT烘焙' });
                                    stripIds.push(stripLayer2.id);
                                } catch (eWr) { throw new Error('写入条带@' + sy + ': ' + (eWr && eWr.message ? eWr.message : eWr)); }
                                try { if (outImg.dispose) outImg.dispose(); } catch (eOD) {}
                                stripsDone++;
                            }
                            if (!stripsDone || !stripIds.length) throw new Error('无条带写入');
                            // 删除只读源
                            try { await psApp.batchPlay([{ _obj: 'delete',
                                _target: [{ _ref: 'layer', _id: srcLayer.id }] }], {}); } catch (eDS) {}
                            // 选中全部条带层 → 合并为一层
                            await psApp.batchPlay([{ _obj: 'select',
                                _target: [{ _ref: 'layer', _id: stripIds[0] }], makeVisible: false }], {});
                            for (var si2 = 1; si2 < stripIds.length; si2++) {
                                await psApp.batchPlay([{ _obj: 'select',
                                    _target: [{ _ref: 'layer', _id: stripIds[si2] }],
                                    selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
                                    makeVisible: false }], {});
                            }
                            if (stripIds.length > 1) await psApp.batchPlay([{ _obj: 'mergeLayersNew' }], {});
                            var lutLayer = doc.activeLayers[0];
                            await psApp.batchPlay([{ _obj: 'set',
                                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                                to: { _obj: 'layer', name: '色卡校准-LUT' } }], {});
                            // 自检:读回中心16x16,确认合并层有像素
                            var cxm = lb.left + (bw2 >> 1), cym = lb.top + (bh2 >> 1);
                            var chk = await _grab(doc.id, lutLayer.id,
                                { left: cxm - 8, top: cym - 8, right: cxm + 8, bottom: cym + 8 });
                            var sAcc = 0;
                            for (var ck = 0; ck < chk.buf.length; ck++) sAcc += chk.buf[ck];
                            if (!chk.buf.length || sAcc === 0) throw new Error('合并后读回为空');
                            try { ctx.logToPanel('[色卡] LUT烘焙完成: ' + stripsDone + '条带合并,自检通过', 'info'); } catch (eLg1) {}
                            // 位置已天然正确(条带建在只读源上方,删源后合并层正落在曲线层上方) → 80% → 剪贴
                            await psApp.batchPlay([{ _obj: 'set',
                                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                                to: { _obj: 'layer', opacity: { _unit: 'percentUnit', _value: 80 } } }], {});
                            await psApp.batchPlay([{ _obj: 'groupEvent',
                                _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
                            lutN++;
                        } catch (eLut) {
                            // 失败清理:删掉只读源/条带层/残留LUT层,不留垃圾
                            try { if (typeof srcLayer !== 'undefined' && srcLayer) await psApp.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: srcLayer.id }] }], {}); } catch (eC0) {}
                            try {
                                if (typeof stripIds !== 'undefined' && stripIds) {
                                    for (var cx2 = 0; cx2 < stripIds.length; cx2++) {
                                        try { await psApp.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: stripIds[cx2] }] }], {}); } catch (eC2) {}
                                    }
                                }
                            } catch (eC3) {}
                            try { if (typeof lutLayer !== 'undefined' && lutLayer) await psApp.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: lutLayer.id }] }], {}); } catch (eC1) {}
                            try { ctx.logToPanel('[色卡] LUT精修失败(' + (eLut && eLut.message ? eLut.message : eLut) + '),已保留曲线校正', 'warn'); } catch (eL2) {}
                        }
                    }
                    report = '偏差 ' + dBefore.toFixed(1) + ' → ' + dAfter.toFixed(1);
                    okN++;
                } else skipN++;
                // 无论是否校准,都遮掉色卡带(透出底下原图)
                // v54：贴回的图层自 0908 起自带白蒙版(组内每层一张)，再 make 一张蒙版会被 PS 拒绝 → 色卡带一直露着(用户实报)。
                // 已有蒙版就在它上面把色卡带填黑，等价于 hideSelection
                try {
                    await psApp.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: lay.id }],
                        makeVisible: false }], {});
                    await psApp.batchPlay([{ _obj: 'set',
                        _target: [{ _ref: 'channel', _property: 'selection' }],
                        to: { _obj: 'rectangle',
                            top: { _unit: 'pixelsUnit', _value: band.top },
                            left: { _unit: 'pixelsUnit', _value: band.left },
                            bottom: { _unit: 'pixelsUnit', _value: band.bottom },
                            right: { _unit: 'pixelsUnit', _value: band.right } } }], {});
                    var hasMask = false;
                    try {
                        var hm = await psApp.batchPlay([{ _obj: 'get',
                            _target: [{ _property: 'hasUserMask' }, { _ref: 'layer', _id: lay.id }] }], {});
                        hasMask = !!(hm && hm[0] && hm[0].hasUserMask);
                    } catch (eHM) {}
                    if (!hasMask) {
                        await psApp.batchPlay([{ _obj: 'make', new: { _class: 'channel' },
                            at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
                            using: { _enum: 'userMaskEnabled', _value: 'hideSelection' } }], {});
                    } else {
                        await psApp.batchPlay([{ _obj: 'select',
                            _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }], makeVisible: false }], {});
                        await psApp.batchPlay([{ _obj: 'fill', using: { _enum: 'fillContents', _value: 'black' },
                            opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' } }], {});
                        await psApp.batchPlay([{ _obj: 'select',
                            _target: [{ _ref: 'channel', _enum: 'channel', _value: 'RGB' }], makeVisible: false }], {});
                    }
                } catch (eM) { maskFail++; maskErr = eM && eM.message ? eM.message : String(eM); }
            }
            // 取消选区 + 删除色卡层
            try { await psApp.batchPlay([{ _obj: 'set',
                _target: [{ _ref: 'channel', _property: 'selection' }],
                to: { _enum: 'ordinal', _value: 'none' } }], {}); } catch (eDS) {}
            try { await psApp.batchPlay([{ _obj: 'delete',
                _target: [{ _ref: 'layer', _id: st.stripId }] }], {}); } catch (eDel) {}
            // 切回用户正看着的文档（与桥接 placeBatch 同语义）
            if (origId && origId !== st.docId) {
                try { await _chartSelectDoc(origId); } catch (eBk) { backErr = eBk && eBk.message ? eBk.message : String(eBk); }
            }
            if (newLayers.length === 0) throw new Error('未检测到回图新图层(可能跑图失败)');
        }, { commandName: '色卡结算' });
        var maskNote = (maskFail ? ';⚠' + maskFail + '张遮卡失败(' + maskErr + ')' : '') + (backErr ? ';切回原文档失败(' + backErr + ')' : '');
        if (okN > 0) send(true, '色卡校准完成(' + report + (lutN ? ',含LUT精修' : '') + '):' + okN + '张已校正并遮卡' + (skipN ? ',' + skipN + '张色卡被模型改坏已跳过' : '') + maskNote);
        else send(false, '模型改动了色卡,无法可靠测量,本次跳过校准(色卡已清理)' + maskNote);
    } catch (e) {
        send(false, '结算失败: ' + (e && e.message ? e.message : e));
    }
}, { moduleId: 'colorcal' });

// ============================================================
//  LUT精修 lutCalibrate —— 满血全力对齐版:
//  无选区=自动全图配对,有选区=只采选区(可Shift多选)
//  永不降采样:分条带流式读取,每个像素都参与统计(内存安全)
//  全程 lutProgress 消息驱动面板进度浮窗
//  选中层=出图 vs 正下方层=原图 → 逐像素配对,按17³网格三线性splat统计
//  → 实测格直接用平均目标偏移(该颜色的精确映射,力度拉满)
//  → 空格才高斯外推(小σ+微恒等锚) → 残差迭代x2压干剩余误差
//  → .cube存dataFolder → 像素烘焙「LUT精修校色」层(100%剪贴)
//  不建曲线/色阶,纯LUT精准对色
// ============================================================
var LUTC_SIG2 = 2 * 0.12 * 0.12; // 空格外推高斯核宽度(RGB归一化距离)
var LUTC_W0 = 0.05;              // 恒等锚(只影响图里完全没出现过的颜色,微弱)
var LUTC_MINW = 3;               // 权重≥3的网格视为实测格→直接精确映射

// 17³网格三线性查值(输入输出均0..1)
function _lut3(grid, r, g, b) {
    var SZ = 17, SM = SZ - 1, ROW = SZ * 3, PLANE = SZ * SZ * 3;
    var fr = r * SM, fg = g * SM, fb = b * SM;
    var r0 = fr | 0, g0 = fg | 0, b0 = fb | 0;
    if (r0 >= SM) r0 = SM - 1;
    if (g0 >= SM) g0 = SM - 1;
    if (b0 >= SM) b0 = SM - 1;
    var xr = fr - r0, xg = fg - g0, xb = fb - b0;
    var i000 = b0 * PLANE + g0 * ROW + r0 * 3;
    var i100 = i000 + 3, i010 = i000 + ROW, i110 = i010 + 3;
    var i001 = i000 + PLANE, i101 = i001 + 3, i011 = i001 + ROW, i111 = i011 + 3;
    var out = [0, 0, 0];
    for (var c = 0; c < 3; c++) {
        var v00 = grid[i000 + c] + (grid[i100 + c] - grid[i000 + c]) * xr;
        var v10 = grid[i010 + c] + (grid[i110 + c] - grid[i010 + c]) * xr;
        var v01 = grid[i001 + c] + (grid[i101 + c] - grid[i001 + c]) * xr;
        var v11 = grid[i011 + c] + (grid[i111 + c] - grid[i011 + c]) * xr;
        var v0 = v00 + (v10 - v00) * xg, v1 = v01 + (v11 - v01) * xg;
        out[c] = v0 + (v1 - v0) * xb;
    }
    return out;
}

HostAPI.registerAction('lutCalibrate', async function(data, ctx) {
    var send = function(ok, msg) { ctx.sendToPanel('lutCalResult', { success: ok, message: msg }); };
    var prog = function(stage, done, total) {
        try { ctx.sendToPanel('lutProgress', { stage: stage, done: done || 0, total: total || 0 }); } catch (ePg) {}
    };
    try {
        var doc = psApp.activeDocument;
        if (!doc) { send(false, '没有打开的文档'); return; }
        var err = null, report = '', cubeSaved = false;
        await psCore.executeAsModal(async function() {
            // 1) 采样区:有选区用选区(可Shift多选,限定采样),没选区自动全图
            var bounds = null, hasSel = false;
            try {
                var b = doc.selection.bounds;
                bounds = { left: Math.round(b.left), top: Math.round(b.top),
                           right: Math.round(b.right), bottom: Math.round(b.bottom) };
                hasSel = true;
            } catch (eSel) {
                bounds = { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) };
            }
            // 2) 图层定位:选中层=出图, 正下方同级=原图
            var al = (doc.activeLayers && doc.activeLayers[0]) || null;
            if (!al) { err = '请先选中出图图层'; return; }
            var sibs = doc.layers;
            try { if (al.parent && al.parent.layers) sibs = al.parent.layers; } catch (eP) {}
            var idx = -1;
            for (var i = 0; i < sibs.length; i++) { if (sibs[i].id === al.id) { idx = i; break; } }
            if (idx < 0 || idx + 1 >= sibs.length) { err = '选中图层下方没有基准图层'; return; }
            var refLayer = sibs[idx + 1];
            // 3) 采样区与两层bounds及画布求交(全图模式防图层小于画布)
            var dW0 = Math.round(doc.width), dH0 = Math.round(doc.height);
            if (bounds.left < 0) bounds.left = 0;
            if (bounds.top < 0) bounds.top = 0;
            if (bounds.right > dW0) bounds.right = dW0;
            if (bounds.bottom > dH0) bounds.bottom = dH0;
            var isect = function(L) {
                try {
                    var bb = L.bounds;
                    if (Math.round(bb.left) > bounds.left) bounds.left = Math.round(bb.left);
                    if (Math.round(bb.top) > bounds.top) bounds.top = Math.round(bb.top);
                    if (Math.round(bb.right) < bounds.right) bounds.right = Math.round(bb.right);
                    if (Math.round(bb.bottom) < bounds.bottom) bounds.bottom = Math.round(bb.bottom);
                } catch (eI) {}
            };
            isect(al); isect(refLayer);
            var areaW = bounds.right - bounds.left, areaH = bounds.bottom - bounds.top;
            if (areaW < 8 || areaH < 8) { err = '两层重叠的对比区域太小'; return; }
            // 满血全分辨率:不降采样,分条带流式读取统计(每个像素都用上,内存安全)
            var SROWS = Math.max(32, Math.floor(4000000 / Math.max(1, areaW)));
            var nStrips = Math.ceil(areaH / SROWS);
            var readStrip = async function(top2, bot2) {
                var sb0 = { left: bounds.left, top: top2, right: bounds.right, bottom: bot2 };
                var m0 = hasSel ? await _grabMask(doc.id, sb0) : null;
                var s0g = await _grab(doc.id, al.id, sb0);
                var r0g = await _grab(doc.id, refLayer.id, sb0);
                var cnt0 = (sb0.right - sb0.left) * (bot2 - top2);
                var sN0 = Math.floor(s0g.buf.length / s0g.comp), rN0 = Math.floor(r0g.buf.length / r0g.comp);
                if (sN0 !== cnt0 || rN0 !== cnt0) throw new Error('条带@' + top2 + '像素不一致(出图' + sN0 + '/基准' + rN0 + '/应为' + cnt0 + '),请确认两层都覆盖对比区域');
                if (m0 && m0.length < cnt0) m0 = null;
                return { s: s0g, r: r0g, m: m0, cnt: cnt0 };
            };
            // 4) 逐像素配对,直接按17³网格三线性splat统计:
            //    实测格=平均目标偏移,即该颜色的精确映射(力度拉满不打折)
            var SZg = 17, SMg = SZg - 1, PLg = SZg * SZg;
            var nCell = SZg * SZg * SZg;
            var accO = new Float64Array(nCell * 3), accW = new Float64Array(nCell);
            var n = 0, dBefore = 0, scg = SMg / 255;
            var sDone = 0;
            prog('全分辨率采样配对', 0, nStrips);
            for (var st0 = bounds.top; st0 < bounds.bottom; st0 += SROWS) {
                var d0 = await readStrip(st0, Math.min(bounds.bottom, st0 + SROWS));
                var sBf = d0.s.buf, sCp = d0.s.comp, rBf = d0.r.buf, rCp = d0.r.comp, mBf = d0.m;
                for (var p = 0; p < d0.cnt; p++) {
                    if (mBf && mBf[p] < 128) continue;
                    var so = p * sCp, ro = p * rCp;
                    if (sCp === 4 && sBf[so + 3] < 200) continue;
                    if (rCp === 4 && rBf[ro + 3] < 200) continue;
                    var sr = sBf[so], sg = sBf[so + 1], sb = sBf[so + 2];
                    var oR2 = (rBf[ro] - sr) / 255, oG2 = (rBf[ro + 1] - sg) / 255, oB2 = (rBf[ro + 2] - sb) / 255;
                    dBefore += (Math.abs(oR2) + Math.abs(oG2) + Math.abs(oB2)) * 255;
                    var fr = sr * scg, fg = sg * scg, fb = sb * scg;
                    var r0 = fr | 0, g0 = fg | 0, b0 = fb | 0;
                    if (r0 >= SMg) r0 = SMg - 1;
                    if (g0 >= SMg) g0 = SMg - 1;
                    if (b0 >= SMg) b0 = SMg - 1;
                    var xr = fr - r0, xg = fg - g0, xb = fb - b0;
                    for (var db3 = 0; db3 < 2; db3++) {
                        var wb = db3 ? xb : 1 - xb;
                        for (var dg3 = 0; dg3 < 2; dg3++) {
                            var wg = wb * (dg3 ? xg : 1 - xg);
                            for (var dr3 = 0; dr3 < 2; dr3++) {
                                var w3 = wg * (dr3 ? xr : 1 - xr);
                                if (w3 <= 0) continue;
                                var ci = (b0 + db3) * PLg + (g0 + dg3) * SZg + (r0 + dr3);
                                accW[ci] += w3;
                                accO[ci * 3] += w3 * oR2; accO[ci * 3 + 1] += w3 * oG2; accO[ci * 3 + 2] += w3 * oB2;
                            }
                        }
                    }
                    n++;
                }
                sDone++; prog('全分辨率采样配对', sDone, nStrips);
            }
            if (n < 500) { err = '有效配对像素太少(' + n + '),请确认两层内容重叠'; return; }
            dBefore /= (n * 3);
            // 实测格清单(供空格外推) [r,g,b, offR,offG,offB, 权重]
            var filled = [];
            for (var ci2 = 0; ci2 < nCell; ci2++) {
                if (accW[ci2] < LUTC_MINW) continue;
                var rr3 = ci2 % SZg, gg3 = ((ci2 / SZg) | 0) % SZg, bb4 = (ci2 / PLg) | 0;
                filled.push([rr3 / SMg, gg3 / SMg, bb4 / SMg,
                             accO[ci2 * 3] / accW[ci2], accO[ci2 * 3 + 1] / accW[ci2], accO[ci2 * 3 + 2] / accW[ci2],
                             Math.min(accW[ci2], 10000)]);
            }
            if (!filled.length) { err = '样本异常,无实测色域格'; return; }
            try { ctx.logToPanel('[LUT] 采样' + n + '对像素,实测覆盖' + filled.length + '/' + nCell + '色域格,拟合+残差迭代...', 'info'); } catch (eLgA) {}
            prog('拟合17³ LUT网格', 0, 0);
            // 5) 建网格:实测格直接用平均偏移(精确);空格高斯外推(小σ+微恒等锚)
            var grid = new Float32Array(nCell * 3), gp = 0;
            for (var gb = 0; gb < SZg; gb++) {
                for (var gg = 0; gg < SZg; gg++) {
                    for (var gr = 0; gr < SZg; gr++) {
                        var pr = gr / SMg, pg = gg / SMg, pb = gb / SMg;
                        var ciG = gb * PLg + gg * SZg + gr;
                        var oR = 0, oG = 0, oB = 0;
                        if (accW[ciG] >= LUTC_MINW) {
                            oR = accO[ciG * 3] / accW[ciG]; oG = accO[ciG * 3 + 1] / accW[ciG]; oB = accO[ciG * 3 + 2] / accW[ciG];
                        } else {
                            var sw = LUTC_W0;
                            for (var k = 0; k < filled.length; k++) {
                                var bn = filled[k];
                                var dr = pr - bn[0], dg = pg - bn[1], db = pb - bn[2];
                                var w = Math.exp(-(dr * dr + dg * dg + db * db) / LUTC_SIG2) * bn[6];
                                sw += w; oR += w * bn[3]; oG += w * bn[4]; oB += w * bn[5];
                            }
                            oR /= sw; oG /= sw; oB /= sw;
                        }
                        var vr = pr + oR, vg = pg + oG, vb = pb + oB;
                        grid[gp++] = vr < 0 ? 0 : (vr > 1 ? 1 : vr);
                        grid[gp++] = vg < 0 ? 0 : (vg > 1 ? 1 : vg);
                        grid[gp++] = vb < 0 ? 0 : (vb > 1 ? 1 : vb);
                    }
                }
            }
            // 6) 残差迭代x2:把splat/插值的残余误差压回去,逼近完全一致(同样满血全分辨率)
            var dAfter = dBefore;
            for (var it = 0; it < 2; it++) {
                var rO = new Float64Array(nCell * 3), rW = new Float64Array(nCell);
                var residSum = 0, residN = 0, rDone = 0;
                prog('残差迭代 ' + (it + 1) + '/2', 0, nStrips);
                for (var st1 = bounds.top; st1 < bounds.bottom; st1 += SROWS) {
                    var d1 = await readStrip(st1, Math.min(bounds.bottom, st1 + SROWS));
                    var sBf2 = d1.s.buf, sCp2 = d1.s.comp, rBf2 = d1.r.buf, rCp2 = d1.r.comp, mBf2 = d1.m;
                    for (var p2 = 0; p2 < d1.cnt; p2++) {
                        if (mBf2 && mBf2[p2] < 128) continue;
                        var so2 = p2 * sCp2, ro3 = p2 * rCp2;
                        if (sCp2 === 4 && sBf2[so2 + 3] < 200) continue;
                        if (rCp2 === 4 && rBf2[ro3 + 3] < 200) continue;
                        var s0 = sBf2[so2], s1 = sBf2[so2 + 1], s2v = sBf2[so2 + 2];
                        var out = _lut3(grid, s0 / 255, s1 / 255, s2v / 255);
                        var eR = rBf2[ro3] / 255 - out[0], eG = rBf2[ro3 + 1] / 255 - out[1], eB = rBf2[ro3 + 2] / 255 - out[2];
                        residSum += (Math.abs(eR) + Math.abs(eG) + Math.abs(eB)) * 255; residN++;
                        var fr2 = s0 * scg, fg2 = s1 * scg, fb2 = s2v * scg;
                        var r02 = fr2 | 0, g02 = fg2 | 0, b02 = fb2 | 0;
                        if (r02 >= SMg) r02 = SMg - 1;
                        if (g02 >= SMg) g02 = SMg - 1;
                        if (b02 >= SMg) b02 = SMg - 1;
                        var xr2 = fr2 - r02, xg2 = fg2 - g02, xb2 = fb2 - b02;
                        for (var db4 = 0; db4 < 2; db4++) {
                            var wb2 = db4 ? xb2 : 1 - xb2;
                            for (var dg4 = 0; dg4 < 2; dg4++) {
                                var wg2 = wb2 * (dg4 ? xg2 : 1 - xg2);
                                for (var dr4 = 0; dr4 < 2; dr4++) {
                                    var w4 = wg2 * (dr4 ? xr2 : 1 - xr2);
                                    if (w4 <= 0) continue;
                                    var ci3 = (b02 + db4) * PLg + (g02 + dg4) * SZg + (r02 + dr4);
                                    rW[ci3] += w4;
                                    rO[ci3 * 3] += w4 * eR; rO[ci3 * 3 + 1] += w4 * eG; rO[ci3 * 3 + 2] += w4 * eB;
                                }
                            }
                        }
                    }
                    rDone++; prog('残差迭代 ' + (it + 1) + '/2', rDone, nStrips);
                }
                dAfter = residN ? residSum / (residN * 3) : dAfter;
                for (var ci4 = 0; ci4 < nCell; ci4++) {
                    if (rW[ci4] < LUTC_MINW) continue;
                    for (var c3 = 0; c3 < 3; c3++) {
                        var nv = grid[ci4 * 3 + c3] + rO[ci4 * 3 + c3] / rW[ci4] * 0.8;
                        grid[ci4 * 3 + c3] = nv < 0 ? 0 : (nv > 1 ? 1 : nv);
                    }
                }
            }
            report = '采样' + n + '对 | 实测' + filled.length + '格 | 平均色差 ' + dBefore.toFixed(1) + ' → ' + dAfter.toFixed(1);
            // .cube 存档(烘焙失败也保得住)
            prog('写入.cube存档', 0, 0);
            try {
                var fsL = require('uxp').storage.localFileSystem;
                var df = await fsL.getDataFolder();
                var cf = await df.createFile('colorcal_last.cube', { overwrite: true });
                await cf.write(_buildCube(grid));
                cubeSaved = true;
            } catch (eW) {}
            // 取消选区(烘焙作用于整层)
            try { await psApp.batchPlay([{ _obj: 'set',
                _target: [{ _ref: 'channel', _property: 'selection' }],
                to: { _enum: 'ordinal', _value: 'none' } }], {}); } catch (eDS) {}
            // 6) 像素烘焙(UXP硬坑套路:条带独立新层→删只读源→合并→剪贴,不用move)
            var srcLayer = null, stripIds = [], lutLayer = null;
            try {
                await psApp.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: al.id }],
                    makeVisible: false }], {});
                await psApp.batchPlay([{ _obj: 'duplicate',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                    name: '_cc_lutsrc' }], {});
                srcLayer = doc.activeLayers[0];
                try { await psApp.batchPlay([{ _obj: 'rasterizeLayer',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {}); } catch (eRz) {}
                // 图层bounds ∩ 画布(AI回图层常大于画布,越界读写必报错)
                var lb;
                try { var bb2 = al.bounds; lb = { left: Math.round(bb2.left), top: Math.round(bb2.top),
                    right: Math.round(bb2.right), bottom: Math.round(bb2.bottom) }; }
                catch (eB) { lb = { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) }; }
                var dW = Math.round(doc.width), dH = Math.round(doc.height);
                if (lb.left < 0) lb.left = 0;
                if (lb.top < 0) lb.top = 0;
                if (lb.right > dW) lb.right = dW;
                if (lb.bottom > dH) lb.bottom = dH;
                var bw2 = lb.right - lb.left, bh2 = lb.bottom - lb.top;
                if (bw2 < 1 || bh2 < 1) throw new Error('图层边界无效');
                var SZ2 = 17, SM = SZ2 - 1, sc2 = SM / 255, ROW = SZ2 * 3, PLANE = SZ2 * SZ2 * 3;
                try { ctx.logToPanel('[LUT] 烘焙开始: ' + bw2 + 'x' + bh2 + ' (分条带写入+合并)', 'info'); } catch (eLg0) {}
                var STRIP = Math.max(64, Math.floor(1500000 / Math.max(1, bw2)));
                var stripsDone = 0, bTotal = Math.ceil(bh2 / STRIP);
                prog('烘焙校色层', 0, bTotal);
                for (var sy = lb.top; sy < lb.bottom; sy += STRIP) {
                    var sBot = Math.min(lb.bottom, sy + STRIP);
                    var sb2 = { left: lb.left, top: sy, right: lb.right, bottom: sBot };
                    var pOpts = { documentID: doc.id, layerID: srcLayer.id, sourceBounds: sb2,
                        componentSize: 8, colorSpace: 'RGB', applyAlpha: false };
                    var pd2;
                    try {
                        try { pd2 = await imaging.getPixels(pOpts); }
                        catch (eP8) { delete pOpts.componentSize; pd2 = await imaging.getPixels(pOpts); }
                    } catch (eRd) { throw new Error('读取条带@' + sy + ': ' + (eRd && eRd.message ? eRd.message : eRd)); }
                    var im2 = pd2.imageData || pd2;
                    var raw2 = (typeof im2.getData === 'function') ? await im2.getData({}) : im2.data;
                    var comp2 = im2.components || 3;
                    var pw2 = im2.width || (sb2.right - sb2.left), ph2 = im2.height || (sBot - sy);
                    try { if (im2.dispose) im2.dispose(); } catch (eD2) {}
                    var srcBuf;
                    if (raw2 && raw2.BYTES_PER_ELEMENT === 2) {
                        srcBuf = new Uint8Array(raw2.length);
                        for (var cv2 = 0; cv2 < raw2.length; cv2++) { var q2 = raw2[cv2] >> 7; srcBuf[cv2] = q2 > 255 ? 255 : q2; }
                    } else srcBuf = (raw2 instanceof Uint8Array) ? raw2 : new Uint8Array(raw2);
                    // 三线性LUT逐像素映射(无曲线预处理,纯LUT) → RGBA
                    var npx = pw2 * ph2;
                    var pbuf = new Uint8Array(npx * 4);
                    for (var px2 = 0; px2 < npx; px2++) {
                        var si = px2 * comp2, di = px2 * 4;
                        var frr = srcBuf[si] * sc2, fgg = srcBuf[si + 1] * sc2, fbb = srcBuf[si + 2] * sc2;
                        var r1 = frr | 0, g1i = fgg | 0, b1i = fbb | 0;
                        if (r1 >= SM) r1 = SM - 1;
                        if (g1i >= SM) g1i = SM - 1;
                        if (b1i >= SM) b1i = SM - 1;
                        var xr = frr - r1, xg = fgg - g1i, xb = fbb - b1i;
                        var i000 = b1i * PLANE + g1i * ROW + r1 * 3;
                        var i100 = i000 + 3, i010 = i000 + ROW, i110 = i010 + 3;
                        var i001 = i000 + PLANE, i101 = i001 + 3, i011 = i001 + ROW, i111 = i011 + 3;
                        for (var cc = 0; cc < 3; cc++) {
                            var v00 = grid[i000 + cc] + (grid[i100 + cc] - grid[i000 + cc]) * xr;
                            var v10 = grid[i010 + cc] + (grid[i110 + cc] - grid[i010 + cc]) * xr;
                            var v01 = grid[i001 + cc] + (grid[i101 + cc] - grid[i001 + cc]) * xr;
                            var v11 = grid[i011 + cc] + (grid[i111 + cc] - grid[i011 + cc]) * xr;
                            var v0 = v00 + (v10 - v00) * xg, v1 = v01 + (v11 - v01) * xg;
                            var vf = (v0 + (v1 - v0) * xb) * 255;
                            pbuf[di + cc] = vf < 0 ? 0 : (vf > 255 ? 255 : Math.round(vf));
                        }
                        pbuf[di + 3] = (comp2 === 4) ? srcBuf[si + 3] : 255;
                    }
                    var outImg = await imaging.createImageDataFromBuffer(pbuf, {
                        width: pw2, height: ph2, components: 4,
                        colorSpace: 'RGB', componentSize: 8, chunky: true });
                    try {
                        // 每条带一个独立新图层(putPixels整层替换硬坑),建在只读源正上方天然落位
                        await psApp.batchPlay([{ _obj: 'select',
                            _target: [{ _ref: 'layer', _id: srcLayer.id }], makeVisible: false }], {});
                        await psApp.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }],
                            using: { _obj: 'layer', name: '_cc_lut_' + sy } }], {});
                        var stripLayer2 = doc.activeLayers[0];
                        await imaging.putPixels({ documentID: doc.id, layerID: stripLayer2.id,
                            targetBounds: { left: sb2.left, top: sy },
                            imageData: outImg, commandName: 'LUT烘焙' });
                        stripIds.push(stripLayer2.id);
                    } catch (eWr) { throw new Error('写入条带@' + sy + ': ' + (eWr && eWr.message ? eWr.message : eWr)); }
                    try { if (outImg.dispose) outImg.dispose(); } catch (eOD) {}
                    stripsDone++;
                    prog('烘焙校色层', stripsDone, bTotal);
                }
                if (!stripsDone || !stripIds.length) throw new Error('无条带写入');
                prog('合并条带收尾', 0, 0);
                // 删除只读源
                try { await psApp.batchPlay([{ _obj: 'delete',
                    _target: [{ _ref: 'layer', _id: srcLayer.id }] }], {}); } catch (eDS2) {}
                srcLayer = null;
                // 选中全部条带层 → 合并为一层
                await psApp.batchPlay([{ _obj: 'select',
                    _target: [{ _ref: 'layer', _id: stripIds[0] }], makeVisible: false }], {});
                for (var si2 = 1; si2 < stripIds.length; si2++) {
                    await psApp.batchPlay([{ _obj: 'select',
                        _target: [{ _ref: 'layer', _id: stripIds[si2] }],
                        selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
                        makeVisible: false }], {});
                }
                if (stripIds.length > 1) await psApp.batchPlay([{ _obj: 'mergeLayersNew' }], {});
                lutLayer = doc.activeLayers[0];
                await psApp.batchPlay([{ _obj: 'set',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
                    to: { _obj: 'layer', name: 'LUT精修校色' } }], {});
                // 自检:读回中心16x16,确认合并层有像素
                var cxm = lb.left + (bw2 >> 1), cym = lb.top + (bh2 >> 1);
                var chk = await _grab(doc.id, lutLayer.id,
                    { left: cxm - 8, top: cym - 8, right: cxm + 8, bottom: cym + 8 });
                var sAcc = 0;
                for (var ck = 0; ck < chk.buf.length; ck++) sAcc += chk.buf[ck];
                if (!chk.buf.length || sAcc === 0) throw new Error('合并后读回为空');
                // 100%不透明度(精准对色) → 剪贴到出图层
                await psApp.batchPlay([{ _obj: 'groupEvent',
                    _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
                try { ctx.logToPanel('[LUT] 烘焙完成: ' + stripsDone + '条带合并,自检通过', 'info'); } catch (eLg1) {}
            } catch (eLut) {
                // 失败清理:删只读源/条带层/残留LUT层,不留垃圾
                try { if (srcLayer) await psApp.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: srcLayer.id }] }], {}); } catch (eC0) {}
                for (var cx2 = 0; cx2 < stripIds.length; cx2++) {
                    try { await psApp.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: stripIds[cx2] }] }], {}); } catch (eC2) {}
                }
                try { if (lutLayer) await psApp.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: lutLayer.id }] }], {}); } catch (eC1) {}
                err = 'LUT烘焙失败(' + (eLut && eLut.message ? eLut.message : eLut) + ')' + (cubeSaved ? ',.cube已存档可手动加载' : '');
            }
        }, { commandName: 'LUT精修' });
        if (err) { send(false, err); return; }
        send(true, 'LUT精修完成(' + report + '):已烘焙「LUT精修校色」层(100%剪贴),可开关/删除' + (cubeSaved ? ';.cube已存dataFolder/colorcal_last.cube' : ''));
    } catch (e) {
        send(false, 'LUT精修失败: ' + (e && e.message ? e.message : e));
    }
}, { moduleId: 'colorcal' });
