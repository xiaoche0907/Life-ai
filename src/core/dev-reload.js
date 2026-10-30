const fs = require('fs');
const path = require('path');

function changeAction(relative) {
  const name = relative.replace(/\\/g, '/');
  if (name.startsWith('renderer/') || name.startsWith('assets/')) return 'reload';
  return 'restart';
}

function enableDevReload({ app, BrowserWindow }, ctx) {
  if (app.isPackaged || !process.argv.includes('--dev')) return;
  const root = path.resolve(__dirname, '../..');
  const watchers = [];
  let timer = null;
  let nextAction = null;
  let quitting = false;
  function schedule(action) {
    if (quitting) return;
    if (action === 'restart' || !nextAction) nextAction = action;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const actionToRun = nextAction;
      nextAction = null;
      if (actionToRun === 'reload') {
        console.log('[开发预览] 界面已更新，正在刷新窗口');
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
        }
        return;
      }
      console.log('[开发预览] 程序代码已更新，正在重启');
      // Persist pending edits before the new process takes over the single-instance lock.
      for (const name of ['flushConfig', 'flushPlib', 'flushTasks']) {
        try { if (ctx[name]) ctx[name](); } catch (error) { console.error('[开发预览] 保存失败', error); }
      }
      app.relaunch();
      app.quit();
    }, 500);
  }
  function watch(target, recursive, actionFor) {
    try {
      const watcher = fs.watch(target, { recursive }, (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (/(?:~|\.tmp|\.swp|\.bak)$/.test(name)) return;
        schedule(actionFor(name));
      });
      watcher.on('error', (error) => console.error('[开发预览] 文件监听失败：' + error.message));
      watchers.push(watcher);
    } catch (error) { console.error('[开发预览] 无法监听文件：' + error.message); }
  }
  watch(path.join(root, 'src'), true, changeAction);
  watch(path.join(root, 'ps-bridge'), true, () => 'restart');
  watch(path.join(root, 'bridge-machine-install.ps1'), false, () => 'restart');
  watch(path.join(root, 'package.json'), false, () => 'restart');
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  });
  console.log('[开发预览] 已启用：界面自动刷新，程序代码自动重启；PS 插件更新须等待 PS 退出。');
}

module.exports = { changeAction, enableDevReload };
