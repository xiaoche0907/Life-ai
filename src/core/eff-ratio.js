// 出图比例裁决（纯函数、无 electron 依赖，smoke 直测）
// 拆出来的原因：这套规则是核心功能（比例不对＝回贴必然拉伸变形），必须能被机测钉住；
// gen.js 一 require 就注册 ipcMain 处理器，在 Electron 主进程外跑不起来。
//
// 「跟原图」：把宽高就近吸附到 API 支持的比例枚举（对数空间最近邻，横竖对称）
// 吸附档位 = img-size.js 的 SIZE_TABLE 实际支持的全部比例（两处必须一致，改一处要两处一起看）。
// ⚠0916 用户实报"无选区跑全图比例不跟原图"：机制其实是生效的（日志实证 1:1→16:9(跟原图)），
//   真凶是这张表原来只有 8 档、少了尺寸表里明明支持的 5:4/4:5/2:1/1:2 → 5:4 的相机原图被吸到 4:3、
//   贴回再非等比拉满画布 = 6.7% 变形；2:1 更狠，吸到 16:9 差 11.1%。补齐后这些都归零。
const RATIO_SNAP = ['1:1', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '16:9', '9:16', '21:9', '9:21', '2:1', '1:2'];
function nearestRatio(w, h) {
  const t = Math.log(w / h);
  let best = '1:1', bd = Infinity;
  for (const r of RATIO_SNAP) {
    const [a, b] = r.split(':').map(Number);
    const d = Math.abs(Math.log(a / b) - t);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}
// 比例 Auto = 跟选区：把选区宽高吸附到最近的受支持比例并显式下发。
// ⚠旧写法 Auto=请求里不带 aspectRatio 字段=交给渠道自定，不少网关默认横版→1:1选区回来一张长方形
//   （0908 多用户实锤，核心功能）。
// 0911 用户裁定（防蠢设计）：**没框选区跑全图时，比例一律跟原图**，连卡上显式选的比例也覆盖——
//   全图模式的回贴是"把出图非等比拉满整幅画布"，比例与画布不符必然变形，
//   没有哪种情况下用户会想要这个结果。full=true 即"这张是无选区跑全图"（桥接 v56 的 fullMode）。
function effRatio(ratio, sel, full) {
  const snap = (box) => {
    if (!box) return null;
    const w = box.right - box.left, h = box.bottom - box.top;
    return (w > 0 && h > 0) ? nearestRatio(w, h) : null;
  };
  if (full) return snap(sel) || 'Auto';          // 全图：无条件跟原图（sel 此时就是整幅画布）
  if (ratio && ratio !== 'Auto') return ratio;   // 有选区：显式比例照用户选的
  return snap(sel) || 'Auto';                    // 有选区 + Auto：跟选区；纯文生图：Auto
}
module.exports = { effRatio, nearestRatio, RATIO_SNAP };
