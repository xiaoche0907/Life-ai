const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../src/renderer/recolor.html'), 'utf8');

async function run(source, success = false) {
  const nodes = new Map();
  for (const match of source.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    assert(!nodes.has(match[1]), '重复控件ID：' + match[1]);
    const listeners = {};
    nodes.set(match[1], {
      value: /\bvalue="([^"]*)"/.exec(tag)?.[1] || '',
      disabled: /\bdisabled\b/.test(tag), checked: false, textContent: '',
      classList: { add() {}, remove() {} },
      appendChild() {},
      addEventListener(name, fn) { listeners[name] = fn; }, listeners,
    });
  }
  const calls = [];
  const sandbox = {
    document: { getElementById: id => nodes.get(id) || null, createElement: () => ({ value: '', textContent: '', disabled: false }) },
    window: {
      ORANGE_ICONS: {}, ColorRecolor: {}, addEventListener() {},
      orange: {
        glassLog() {},
        async inspectRecolorDocument() { calls.push('document'); return success ? { ok: true, docId: 7, name: '样本.psd', width: 2, height: 2, groups: [{ id: 22, path: '父组 / 服装', enabled: true }] } : { ok: false, error: '请先打开PS文档' }; },
        async readMaskGroup(p) { calls.push('mask:' + p.docId + ':' + p.layerId); return { ok: false, error: '目标组已删除，请重新读取' }; },
        async pickFiles() { calls.push('files'); return []; },
      },
    },
    setTimeout, clearTimeout, console,
  };
  vm.createContext(sandbox);
  for (const script of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], sandbox);
  assert.equal(typeof nodes.get('btnCap').listeners.click, 'function');
  assert.equal(typeof nodes.get('btnAdd').listeners.click, 'function');
  await nodes.get('btnCap').listeners.click();
  assert.deepEqual(calls, ['document']);
  if (!success) {
    assert(nodes.get('stat').textContent.includes('请先打开PS文档'));
    assert.equal(nodes.get('stat').className, 'err');
  } else {
    assert(nodes.get('documentInfo').textContent.includes('样本.psd'));
    assert.equal(nodes.get('targetGroup').disabled, false);
  }
  await nodes.get('btnAdd').listeners.click();
  assert.deepEqual(calls, ['document', 'files']);
  nodes.get('pColorize').checked = true;
  if (success) {
    nodes.get('targetGroup').value = '22';
    await nodes.get('targetGroup').listeners.change();
    assert.deepEqual(calls, ['document', 'files', 'mask:7:22']);
    assert(nodes.get('stat').textContent.includes('目标组已删除'));
    assert.equal(nodes.get('btnGo').disabled, true);
  }
  nodes.get('pColorize').listeners.change();
  assert.equal(nodes.get('pColOp').disabled, false);
  assert.equal(nodes.get('pColOpN').disabled, false);
  nodes.get('pColorize').checked = false;
  nodes.get('pColorize').listeners.change();
  assert.equal(nodes.get('pColOpN').disabled, true);
}

(async () => {
  // 旧版缺少数字框，会在初始化时抛错，验证本测试能抓到同一回归。
  const broken = html.replace(/<input[^>]*\bid="pColOpN"[^>]*>/, '');
  await assert.rejects(run(broken), /addEventListener/);
  await run(html);
  await run(html, true);
  console.log('通过：旧版错误可复现；卡片初始化、蒙版按钮IPC、文件按钮、失败提示和着色双控均正常');
})().catch(error => { console.error(error); process.exitCode = 1; });
