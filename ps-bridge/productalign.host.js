// 产品对齐辅助桥接：列出组内图层与各自主体边界框（bbox）
// bbox 通过每图层的 bounds（PS DOM layer.bounds，基于像素内容）获得
const { app, action, core } = require('photoshop');
const host = require('./recolor.host');

async function listLayerBBoxes(params) {
  const doc = (app.documents || []).find(d => d.id === params.docId);
  if (!doc) throw Error('源文档已关闭');
  const target = await host.targetGroup(doc, params.layerId);
  const layers = [];
  function walk(ls) {
    for (const l of ls) {
      if (l.kind === 'group') { if (l.layers) walk(l.layers); continue; }
      try {
        const b = l.bounds;   // 图层内容边界（DOM）
        if (!b) continue;
        const w = Math.round(b.right - b.left), h = Math.round(b.bottom - b.top);
        if (w < 4 || h < 4) continue;   // 空层
        layers.push({ id: l.id, name: l.name, bbox: { x: Math.round(b.left), y: Math.round(b.top), w, h } });
      } catch (e) { /* 隐藏空层等 */ }
    }
  }
  walk(target.layers || []);
  return { ok: true, docId: doc.id, canvas: { width: Math.round(doc.width), height: Math.round(doc.height) }, layers };
}

module.exports = { listLayerBBoxes };
