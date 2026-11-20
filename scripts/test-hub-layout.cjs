// electron scripts/test-hub-layout.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modules = require('../src/modules.json');

async function run() {
  const win = new BrowserWindow({ show: false, width: 420, height: 820, useContentSize: true });
  const renderer = path.join(__dirname, '../src/renderer');
  const html = fs.readFileSync(path.join(renderer, 'hub.html'), 'utf8');
  const theme = fs.readFileSync(path.join(renderer, 'theme.css'), 'utf8');
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace('<link rel="stylesheet" href="theme.css" />', `<style>${theme}</style>`);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(markup));
  const exec = script => win.webContents.executeJavaScript(script);
  await exec(fs.readFileSync(path.join(renderer, 'icons.js'), 'utf8'));
  await exec(`window.orange = {
    getModules: async () => ${JSON.stringify(modules)}, getCardStates: async () => ({}),
    getConfig: async () => ({}), openCard: id => { window.openedCard = id; }
  }; void 0`);
  await exec(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  for (const [width, height, columns] of [[420, 820, 4], [295, 750, 3], [238, 515, 2], [420, 270, 4]]) {
    win.setContentSize(width, height);
    for (const sub of [false, true]) {
      const result = await exec(`new Promise(resolve => requestAnimationFrame(() => {
        const main = document.querySelector('#grid');
        const group = [...main.children].find(tile => tile.textContent === '商业精修');
        ${sub ? 'group.click();' : 'document.querySelector("#btnBack").click();'}
        const grid = document.querySelector('${sub ? '#subgrid' : '#grid'}');
        const bounds = grid.getBoundingClientRect();
        grid.scrollTop = grid.scrollHeight;
        const last = grid.lastElementChild.getBoundingClientRect();
        const tiles = [...grid.children].map(tile => tile.getBoundingClientRect());
        const count = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
        resolve({ columns: count, scrollbar: getComputedStyle(grid).scrollbarWidth,
          rowsOverlap: tiles.some((tile, index) => index >= count && tile.top < tiles[index - count].bottom - 1),
          horizontalOverflow: grid.scrollWidth > grid.clientWidth,
          allWithinWidth: [...grid.children].every(tile => tile.getBoundingClientRect().right <= bounds.right + 1),
          lastReachable: last.bottom <= bounds.bottom + 1 && last.top >= bounds.top - 1,
          first: grid.firstElementChild.querySelector('.lab').textContent,
          badIcon: [...grid.children].some(tile => tile.querySelector('.ico').textContent === 'undefined') });
      }))`);
      assert.equal(result.columns, columns, `${width}px, subview=${sub}`);
      assert.equal(result.horizontalOverflow, false);
      assert.equal(result.scrollbar, 'none');
      assert.equal(result.rowsOverlap, false, `${width}px, subview=${sub}`);
      assert.equal(result.allWithinWidth, true);
      assert.equal(result.lastReachable, true);
      assert.equal(result.badIcon, false);
      if (sub) assert.equal(result.first, '服装精修');
    }
  }
  assert.equal(await exec(`(() => {
    document.querySelector('#subgrid .bubble').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    return window.openedCard;
  })()`), 'garment-retouch');
  win.destroy();
  console.log('通过：控制台及精修子网格在四种窗口尺寸下重排、无横向裁切、末行可滚动访问、服装精修可打开');
}

app.whenReady().then(run).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
