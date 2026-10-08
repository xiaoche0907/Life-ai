// COM自动化兜底通道（0904）：Windows上任何版本PS（CS6→2025）都自带COM接口
// (Photoshop.Application)，DoJavaScript塞ExtendScript = 零安装、全版本通吃。
// WS桥接未连接时 sendToPSAwait 自动降级走这里（bridge.js挂线）。
// 覆盖生成主链路：ping/listDocs/captureInput/placeBatch/placeImage/restoreSelection；
// 校色LUT等高级动作不覆盖→提示装UXP插件。像素经temp文件传递（COM传大字符串会卡）。
// 已知盲区：极少数绿色版PS没写COM注册表（ActiveXObject会失败）——那类只能装UXP插件。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const ctx = require('./ctx');

// WSH JScript转译器：附着运行中的PS执行jsx文件，结果写出文件（stdout中文编码不可靠，走UTF-16文件）
const RUNNER_SRC = [
  'var a = WScript.Arguments;',
  'var fso = new ActiveXObject("Scripting.FileSystemObject");',
  'function out(t) { try { var f = fso.OpenTextFile(a(1), 2, true, -1); f.Write(t); f.Close(); } catch (e) {} }',
  'try {',
  '  var ps = new ActiveXObject("Photoshop.Application");',
  '  var jsx = fso.OpenTextFile(a(0), 1, false, -1).ReadAll();',
  '  var r = ps.DoJavaScript(jsx);',
  '  out("OK" + r);',
  '} catch (e) { out("ERR" + (e.message || e.description || "COM失败")); }',
].join('\r\n');

const SEP1 = '\u0001', SEP2 = '\u0002';
let runnerPath = null;
function ensureRunner() {
  if (runnerPath && fs.existsSync(runnerPath)) return runnerPath;
  runnerPath = path.join(os.tmpdir(), 'orange-com-runner.js');
  fs.writeFileSync(runnerPath, RUNNER_SRC);
  return runnerPath;
}

function psProcessAlive() {
  return new Promise((res) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Photoshop.exe', '/NH'], { windowsHide: true }, (e, so) => {
      res(!e && /Photoshop\.exe/i.test(String(so || '')));
    });
  });
}

function runJsx(jsx, timeoutMs) {
  return new Promise((resolve) => {
    let jf = null, of_ = null;
    try {
      const runner = ensureRunner();
      const tag = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      jf = path.join(os.tmpdir(), 'orange_jsx_' + tag + '.jsx');
      of_ = path.join(os.tmpdir(), 'orange_jsxout_' + tag + '.txt');
      fs.writeFileSync(jf, '\uFEFF' + jsx, 'utf16le');
      execFile('cscript', ['//nologo', '//E:JScript', runner, jf, of_],
        { windowsHide: true, timeout: timeoutMs === 0 ? 0 : Math.max(10000, timeoutMs || 60000) }, () => {
          let out = '';
          try { out = fs.readFileSync(of_, 'utf16le').replace(/^\uFEFF/, ''); } catch (e) {}
          try { fs.rmSync(jf, { force: true }); fs.rmSync(of_, { force: true }); } catch (e) {}
          if (out.slice(0, 2) === 'OK') resolve({ ok: true, raw: out.slice(2) });
          else resolve({ ok: false, error: (out.slice(3) || 'COM执行无响应（PS忙/弹窗中？）') });
        });
    } catch (e) {
      try { fs.rmSync(jf, { force: true }); fs.rmSync(of_, { force: true }); } catch (e2) {}
      resolve({ ok: false, error: 'COM调用失败: ' + (e.message || e) });
    }
  });
}

// ---------- JSX动作集（全部ES3、单位钉px、finally还原） ----------
const jsStr = (s) => "'" + String(s).replace(/\\/g, '/').replace(/'/g, "\\'") + "'";

function jsxWrap(body) {
  return '(function(){var U=app.preferences.rulerUnits;app.preferences.rulerUnits=Units.PIXELS;'
    + 'try{' + body + '}finally{app.preferences.rulerUnits=U;}})()';
}
// 按docId切换文档；strict=找不到返回null（v54：指定了文档就不许悄悄落到当前文档——那是回图串图的来源）
const JSX_BYID = 'function byId(id,strict){if(!id)return app.activeDocument;'
  + 'for(var i=0;i<app.documents.length;i++){if(app.documents[i].id===id){app.activeDocument=app.documents[i];return app.activeDocument;}}'
  + 'return strict?null:app.activeDocument;}';

function jsxListDocs() {
  return jsxWrap('var s=[];for(var i=0;i<app.documents.length;i++){var d=app.documents[i];'
    + "s.push(d.id+'" + SEP1 + "'+d.name);}return s.join('" + SEP2 + "');");
}

function jsxCapture(docId, noSelFull, outPath) {
  return jsxWrap(JSX_BYID
    + "if(!app.documents.length)return 'NODOC';"
    + 'var d=byId(' + (docId || 'null') + ',true);'
    + "if(!d)return 'NODOCID';"
    + 'var sel=null;try{var b=d.selection.bounds;'
    + "sel=[Math.round(b[0].as('px')),Math.round(b[1].as('px')),Math.round(b[2].as('px')),Math.round(b[3].as('px'))];}catch(e){}"
    + "var img='';var note=sel?'':'未检测到选区';"
    + 'if(sel||' + (noSelFull ? 'true' : 'false') + '){'
    + "var dup=d.duplicate('orangetmp',true);"
    + 'if(sel)dup.crop(sel);'
    + 'try{if(dup.mode!==DocumentMode.RGB)dup.changeMode(ChangeMode.RGB);}catch(e2){}'
    + 'try{dup.bitsPerChannel=BitsPerChannelType.EIGHT;}catch(e3){}'
    + 'var f=new File(' + jsStr(outPath) + ');var o=new JPEGSaveOptions();o.quality=10;o.embedColorProfile=true;'
    + 'dup.saveAs(f,o,true,Extension.LOWERCASE);dup.close(SaveOptions.DONOTSAVECHANGES);'
    + "img=' 1';if(!sel)note='无选区，按全图输入';}"
    + 'app.activeDocument=d;'
    + "return d.id+'" + SEP1 + "'+(sel?sel.join(','):'')+'" + SEP1 + "'+img+'" + SEP1 + "'+note;");
}

// 置入+贴合选区+建组+白蒙版（描述符与UXP桥接件placeBatch一一对应；antiMode还原不支持=note说明）
function jsxPlaceBatch(paths, docId, selection, group) {
  const sel = (selection && Number.isFinite(selection.left))
    ? '[' + [selection.left, selection.top, selection.right, selection.bottom].map((n) => Math.round(n)).join(',') + ']'
    : 'null';
  return jsxWrap(JSX_BYID
    + "if(!app.documents.length)return 'NODOC';"
    + 'var orig=app.activeDocument;var d=byId(' + (docId || 'null') + ',' + (group ? 'true' : 'false') + ');'
    + "if(!d)return 'NODOCID';"
    + 'var sel=' + sel + ';var ids=[];'
    + 'function place(p){var ds=new ActionDescriptor();ds.putPath(charIDToTypeID("null"),new File(p));'
    + 'ds.putEnumerated(charIDToTypeID("FTcs"),charIDToTypeID("QCSt"),charIDToTypeID("Qcsa"));'
    + 'executeAction(charIDToTypeID("Plc "),ds,DialogModes.NO);return d.activeLayer;}'
    // 贴回原选区：非等比精确填满（宽高各自缩放到选区），不是 min 等比居中——等比会留边/对不齐（0908用户反馈）。
    // 两次收敛：第一次按 bounds 算比例+位移；bounds 含透明边时会偏，读回再纠一次
    + 'function fit(L){if(!sel)return;var sw=sel[2]-sel[0],sh=sel[3]-sel[1];'
    + 'for(var it=0;it<2;it++){var b=L.bounds;'
    + "var bw=b[2].as('px')-b[0].as('px'),bh=b[3].as('px')-b[1].as('px');"
    + 'if(bw<1||bh<1)return;'
    + 'var kx=sw/bw*100,ky=sh/bh*100;if(Math.abs(kx-100)>0.05||Math.abs(ky-100)>0.05)L.resize(kx,ky,AnchorPosition.TOPLEFT);'
    + "b=L.bounds;var dx=sel[0]-b[0].as('px'),dy=sel[1]-b[1].as('px');"
    + 'if(Math.abs(dx)>0.5||Math.abs(dy)>0.5)L.translate(dx,dy);}}'
    + 'var ps=[' + paths.map(jsStr).join(',') + '];'
    + 'for(var i=0;i<ps.length;i++){try{var L=place(ps[i]);fit(L);ids.push(L.id);}catch(e){}}'
    + 'function selLayer(id,add){var d1=new ActionDescriptor();var r1=new ActionReference();'
    + 'r1.putIdentifier(charIDToTypeID("Lyr "),id);d1.putReference(charIDToTypeID("null"),r1);'
    + 'if(add)d1.putEnumerated(stringIDToTypeID("selectionModifier"),stringIDToTypeID("selectionModifierType"),stringIDToTypeID("addToSelection"));'
    + 'd1.putBoolean(charIDToTypeID("MkVs"),false);executeAction(charIDToTypeID("slct"),d1,DialogModes.NO);}'
    + 'function mask(){var md=new ActionDescriptor();md.putClass(charIDToTypeID("Nw  "),charIDToTypeID("Chnl"));'
    + 'var mr=new ActionReference();mr.putEnumerated(charIDToTypeID("Chnl"),charIDToTypeID("Chnl"),charIDToTypeID("Msk "));'
    + 'md.putReference(charIDToTypeID("At  "),mr);'
    + 'md.putEnumerated(charIDToTypeID("Usng"),charIDToTypeID("UsrM"),charIDToTypeID("RvlA"));'
    + 'executeAction(charIDToTypeID("Mk  "),md,DialogModes.NO);}'
    // 0908用户裁定：每张置入图层各自白蒙版；第16轮再裁定：打完组在组上也加一张（两级并存）——与UXP桥接件placeBatch同步
    + 'for(var m=0;m<ids.length;m++){try{selLayer(ids[m],false);mask();}catch(e5){}}'
    + 'if(ids.length&&' + (group ? 'true' : 'false') + '){'
    + 'try{for(var g=0;g<ids.length;g++)selLayer(ids[g],g>0);'
    + 'var gd=new ActionDescriptor();var gr=new ActionReference();gr.putClass(stringIDToTypeID("layerSection"));'
    + 'gd.putReference(charIDToTypeID("null"),gr);var fr=new ActionReference();'
    + 'fr.putEnumerated(charIDToTypeID("Lyr "),charIDToTypeID("Ordn"),charIDToTypeID("Trgt"));'
    + 'gd.putReference(charIDToTypeID("From"),fr);gd.putString(charIDToTypeID("Nm  "),"橙子 生成组");'
    // 组名：顶层 Nm 在 PS27 读回"组 1"，Usng 里的 layerSection.name 才生效（0908 真机）
    + 'var ud=new ActionDescriptor();ud.putString(charIDToTypeID("Nm  "),"橙子 生成组");gd.putObject(charIDToTypeID("Usng"),stringIDToTypeID("layerSection"),ud);'
    + 'executeAction(charIDToTypeID("Mk  "),gd,DialogModes.NO);try{mask();}catch(e6){}}catch(e4){}}'
    // 自动回传贴完切回用户正看着的文档（与UXP桥接件v54同语义）
    + (group ? 'try{if(orig&&orig.id!==d.id)app.activeDocument=orig;}catch(e7){}' : '')
    + "return ''+ids.length;");
}

function jsxRestoreSel(docId, s) {
  if (!s || !Number.isFinite(s.left)) return jsxWrap('return "1";');
  const l = Math.round(s.left), t = Math.round(s.top), r = Math.round(s.right), b = Math.round(s.bottom);
  return jsxWrap(JSX_BYID + 'var d=byId(' + (docId || 'null') + ');'
    + 'd.selection.select([[' + l + ',' + t + '],[' + r + ',' + t + '],[' + r + ',' + b + '],[' + l + ',' + b + ']]);'
    + "return '1';");
}

// ---------- 动作分发：对齐WS桥接件的result契约 ----------
async function tryCall(cmd, timeoutMs) {
  const act = cmd.action;
  if (!(await psProcessAlive())) {
    return { ok: false, error: 'PS未连接：请先启动PS' };
  }
  if (act === 'ping') {
    // 诊断用：读PS版本（COM通）——装好插件却连不上时判定是否版本过低（坑63）
    const r = await runJsx(jsxWrap('return app.version;'), timeoutMs || 12000);
    return r.ok ? { ok: true, result: { version: r.raw } } : r;
  }
  if (act === 'listDocs') {
    const r = await runJsx(jsxListDocs(), timeoutMs);
    if (!r.ok) return r;
    const docs = r.raw ? r.raw.split(SEP2).map((s) => {
      const p = s.split(SEP1);
      return { id: Number(p[0]), name: p[1] || ('文档' + p[0]) };
    }) : [];
    return { ok: true, result: { docs } };
  }
  if (act === 'captureInput') {
    const p = cmd.params || {};
    const outPath = path.join(os.tmpdir(), 'orange_cap_' + Date.now() + '.jpg');
    const r = await runJsx(jsxCapture(p.docId, p.noSelFull !== false, outPath), timeoutMs);
    if (!r.ok) return r;
    if (r.raw === 'NODOC') return { ok: false, error: '没有打开的文档' };
    if (r.raw === 'NODOCID') return { ok: false, error: '指定的文档已关闭或找不到（id=' + p.docId + '）' };
    const seg = r.raw.split(SEP1);
    const sel = seg[1] ? (() => { const n = seg[1].split(',').map(Number); return { left: n[0], top: n[1], right: n[2], bottom: n[3] }; })() : null;
    let image = null;
    if (seg[2]) {
      try { image = fs.readFileSync(outPath).toString('base64'); } catch (e) {}
      try { fs.rmSync(outPath, { force: true }); } catch (e) {}
    }
    return { ok: true, result: { docId: Number(seg[0]), selection: sel, image, mime: 'image/jpeg', note: (seg[3] || '') + '（COM通道）' } };
  }
  if (act === 'placeBatch' || act === 'placeImage') {
    const p = cmd.params || {};
    const paths = act === 'placeImage' ? [p.path] : (p.paths || []);
    if (!paths.length) return { ok: false, error: '没有可置入的文件' };
    const r = await runJsx(jsxPlaceBatch(paths, p.docId, p.selection, act === 'placeBatch' ? p.group !== false : false), timeoutMs);
    if (!r.ok) return r;
    if (r.raw === 'NODOC') return { ok: false, error: '没有打开的文档' };
    if (r.raw === 'NODOCID') return { ok: false, error: '发起生成时的文档已关闭或找不到（id=' + p.docId + '），未贴回——重新打开原图后在进度卡点图手动贴回' };
    const note = (p.antiMode > 0 ? 'COM通道暂不支持抗截断自动还原，请手动翻转/反色；' : '') + 'COM通道置入';
    return { ok: true, result: { placed: Number(r.raw) || 0, note } };
  }
  if (act === 'restoreSelection') {
    const p = cmd.params || {};
    const r = await runJsx(jsxRestoreSel(p.docId, p.selection), timeoutMs);
    return r.ok ? { ok: true, result: {} } : r;
  }
  return { ok: false, error: 'COM兜底通道不支持「' + act + '」——此功能需要PS里装好桥接插件（设置→重新安装PS插件）' };
}

// ---------- 在线状态探测：WS没连上时每12秒探一次COM，可用就把连接点亮起来 ----------
let comOnline = false;
setInterval(async () => {
  try {
    if (ctx.psConnected && ctx.psConnected()) { comOnline = false; return; }   // WS在=不掺和
    const alive = await psProcessAlive();
    if (alive !== comOnline) {
      comOnline = alive;
      ctx.broadcast('ps-status', { connected: alive, bridgeVer: 0, via: 'com' });
      try { ctx.dlog('[com-bridge] COM兜底通道' + (alive ? '上线（零安装模式，PS v全版本）' : '下线')); } catch (e) {}
      if (alive) ctx.olog('🔌 PS插件未连接，已切换COM兜底通道（零安装·功能子集：生成/贴回/批处理可用）');
    }
  } catch (e) {}
}, 12000);

ctx.comBridge = { tryCall, psProcessAlive };
