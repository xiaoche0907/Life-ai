function createPanel(request) {
  const elements = {};
  for (const name of ['model', 'params', 'options', 'actions', 'status']) {
    const node = document.getElementById('garment-' + name);
    if (!node) throw Error('面板缺少控件：' + name);
    elements[name] = node;
  }
  const { options, actions, status } = elements;
  let config;
  let online = false;
  let busy = false;
  let group = 0;
  let ratio = 'Auto';
  let size = '2K';
  let selectedMenu = '';
  let refreshId = 0;

  function button(label, onClick) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
  }

  function render() {
    const controls = elements.params;
    for (const container of [controls, options, actions]) {
      while (container.firstChild) container.removeChild(container.firstChild);
    }
    if (!config || !online) return;
    const activeSize = config.sizes.includes(size) ? size : config.defaultSize;
    const menus = [
      ['分类', config.groups[group][0], config.groups.map(([name]) => name), index => { group = index; }],
      ['比例', ratio, config.ratios, index => { ratio = config.ratios[index]; }],
      ['分辨率', activeSize || '不可用', config.sizes, index => { size = config.sizes[index]; }],
    ];
    for (const [name, value, choices, select] of menus) {
      const toggle = button(`${name} · ${value}`, () => { selectedMenu = selectedMenu === name ? '' : name; render(); });
      toggle.setAttribute('aria-expanded', String(selectedMenu === name));
      toggle.disabled = busy;
      controls.appendChild(toggle);
      if (selectedMenu === name) choices.forEach((choice, index) => {
        const option = button(choice, () => { select(index); selectedMenu = ''; render(); });
        option.setAttribute('aria-pressed', String(choice === value));
        options.appendChild(option);
      });
    }
    config.groups[group][1].forEach((label, preset) => {
      if (!label) return;
      const tool = button(label, () => generate(label, preset, activeSize));
      tool.className = 'garment-tool';
      tool.disabled = busy || !config.model || !activeSize;
      actions.appendChild(tool);
    });
  }

  async function refresh(showHint = true) {
    const id = ++refreshId;
    if (!online) return;
    try {
      const current = await request('settings');
      if (id !== refreshId) return;
      config = current;
      elements.model.textContent = `${current.channel} · ${current.modelName || '未选择模型'}`;
      if (!busy && showHint) status.textContent = current.model
        ? '在 Photoshop 框选区域，点能力即生成并贴回。' : '请先在来福的生图模式选择模型。';
      render();
    } catch (error) {
      if (id === refreshId && !busy) status.textContent = error.message;
    }
  }

  async function generate(label, preset, activeSize) {
    if (!online || busy) return;
    busy = true;
    selectedMenu = '';
    status.textContent = `正在生成「${label}」…`;
    render();
    try {
      await request('generate', { group, preset, ratio, size: activeSize });
      status.textContent = `「${label}」已贴回，可在 Photoshop 一步撤销。`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      render();
      refresh(false);
    }
  }

  return {
    connected(value) {
      online = value;
      if (online) refresh();
      else {
        refreshId++;
        elements.model.textContent = '未连接来福';
        status.textContent = '请保持来福运行，面板会自动重连。';
        render();
      }
    },
    refresh,
  };
}

module.exports = createPanel;
