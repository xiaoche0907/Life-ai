// 批处理逐图判定（纯函数）：给定一次 captureInput 的结果，决定这张图跑还是跳过。
// 抽出来的理由（0918）：判定逻辑埋在 gen.js 的循环里没法单测，"无选区静默跳过"这种
// 回归一旦发生，用户看到的现象是"批处理少跑了几张但一声不吭"——极难察觉。放这里由 smoke 直测。
// 返回 { run:true } 或 { run:false, why:'中文原因' }
function batchDocGate(probe) {
  if (!probe) return { run: false, why: '桥接无响应' };
  if (!probe.ok) return { run: false, why: probe.error || '读取失败' };
  const pc = probe.result || null;
  if (!pc) return { run: false, why: '桥接没有返回数据' };
  if (!pc.selection) return { run: false, why: '这张图没有选区' };
  if (!pc.image) return { run: false, why: '截图失败' + (pc.note ? '：' + pc.note : '') };
  return { run: true };
}
module.exports = { batchDocGate };
