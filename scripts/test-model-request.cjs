const assert = require('node:assert/strict');
const { modelsURL, requestModels, networkMessage } = require('../src/core/model-request');
(async () => {
  for (const base of ['https://example.com', ' https://example.com/v1/ ', 'https://example.com/v1/models']) {
    assert.equal(modelsURL(base), 'https://example.com/v1/models');
  }
  assert.equal(modelsURL('https://example.com/proxy/v1'), 'https://example.com/proxy/v1/models');
  assert.throws(() => modelsURL('example.com'), /接口地址无效/);
  assert.throws(() => modelsURL('https://example.com?key=secret'), /格式不正确/);
  const models = await requestModels(async (url, options) => {
    assert.equal(url, 'https://example.com/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return { ok: true, json: async () => ({ data: [{ id: 'gpt-image-2' }, null, {}] }) };
  }, 'https://example.com/v1', 'test-key');
  assert.deepEqual(models, ['gpt-image-2']);
  await assert.rejects(requestModels(async () => ({ ok: false, status: 401 }), 'https://example.com', 'test'), /Key 无效/);
  await assert.rejects(requestModels(async () => ({ ok: true, json: async () => { throw Error('invalid'); } }), 'https://example.com', 'test'), /不是 JSON/);
  await assert.rejects(requestModels(async () => { throw Error('net::ERR_PROXY_CONNECTION_FAILED'); }, 'https://example.com', 'test'), /代理连接失败/);
  assert.match(networkMessage({ cause: { code: 'ENOTFOUND' } }), /域名无法解析/);
  console.log('模型请求测试通过：地址规范化、鉴权传递、返回解析和错误分类。');
})().catch((error) => { console.error(error); process.exitCode = 1; });
