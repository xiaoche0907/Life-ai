// host-api垫片：老插件Host模块的注册接口 → 桥接件动作注册表
// 让 mod-colorcal.host.js 等老host模块原样移植运行
const registry = {};
module.exports = {
  registerAction(name, fn) { registry[name] = fn; },
  _registry: registry,
};
