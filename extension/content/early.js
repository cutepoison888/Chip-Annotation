// 芯标注 · 页面一开始加载就执行：应用深色模式，避免先白屏再变黑
(() => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  let mode = 'off';
  const apply = () => {
    const on = mode === 'on' || (mode === 'auto' && mq.matches);
    document.documentElement.classList.toggle('icm-dark', on);
  };
  chrome.storage.local.get('settings').then(({ settings }) => {
    mode = (settings && settings.darkMode) || 'off';
    apply();
  });
  mq.addEventListener('change', apply);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.settings) { mode = (c.settings.newValue && c.settings.newValue.darkMode) || 'off'; apply(); }
  });
})();
