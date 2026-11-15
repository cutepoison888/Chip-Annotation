// 芯标注 · 货源网站上的“🔔 关注”按钮（立创、云汉、圣禾堂、贸泽、得捷）
// 立创 / 云汉 / 圣禾堂：搜索结果每个商品右边一个；贸泽 / 得捷：商品页库存旁边一个。
// 点一下 = 关注这个型号的库存和价格变化（和三个网站货源条上的“🔔 关注库存变化”是同一份关注列表），再点一下取消。
// 只在用户自己打开的页面显示；插件开的后台查询标签页（网址带 #icm-lookup）不显示，免得影响读取。
(async () => {
  if (/icm-lookup=/.test(location.hash)) return;
  const who = await chrome.runtime.sendMessage({ type: 'lookupWho' }).catch(() => null);
  if (who && who.id) return;

  const host = location.hostname;
  const SITE = /szlcsc/.test(host) ? 'szlcsc' : /ickey/.test(host) ? 'ickey' : /bomman/.test(host) ? 'bomman' : /mouser/.test(host) ? 'mouser' : /digikey/.test(host) ? 'digikey' : '';
  if (!SITE) return;
  const SITE_NAME = { szlcsc: '立创商城', ickey: '云汉芯城', bomman: '圣禾堂', mouser: '贸泽', digikey: '得捷' }[SITE];
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const PN_RE = /^[A-Za-z0-9][A-Za-z0-9\-./#+_,]{2,40}$/;
  const cleanPn = (t) => String(t || '').trim().replace(/[（(][^）)]*[）)]$/, '').trim();

  // 一个商品块里的型号
  function pnOfRow(row) {
    if (row.dataset && row.dataset.productModel) return cleanPn(row.dataset.productModel);
    // 先看链接（型号一般是商品详情链接，里面可能有高亮的 span，所以取整个链接的文字），再看普通文字
    const ok = (t) => PN_RE.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t);
    const fromLinks = [...row.querySelectorAll('a')].filter(visible).slice(0, 20).map((a) => cleanPn(a.textContent)).find(ok);
    if (fromLinks) return fromLinks;
    const leaves = [...row.querySelectorAll('span, div, p, h3, h4')].filter((e) => e.children.length === 0 && visible(e)).slice(0, 60);
    return leaves.map((e) => cleanPn(e.textContent)).find(ok) || '';
  }

  // 找商品块：从“加入购物车 / 立即订货 / 咨询客服”按钮往上找到整行（宽度占列表大部分的那一层）
  function searchRows() {
    if (SITE === 'ickey') return [...document.querySelectorAll('article.site-product-item')].filter(visible);
    if (SITE === 'szlcsc') {
      const rows = [...document.querySelectorAll('section[class*="MainCard"]')].filter(visible);
      if (rows.length) return rows;
    }
    const btns = [...document.querySelectorAll('button, a')].filter((b) => /^(加入购物车|立即订货|咨询客服|直接购买|立即购买)$/.test(b.textContent.trim()) && visible(b));
    const out = new Set();
    for (const b of btns) {
      let n = b;
      while (n && n.parentElement && n.getBoundingClientRect().width < 880) n = n.parentElement;
      if (n && n !== document.body && n.getBoundingClientRect().height < 600) out.add(n);
    }
    return [...out];
  }

  // 贸泽 / 得捷商品页：{ pn, anchor（按钮放在它右边）}
  function detailTarget() {
    if (SITE === 'mouser') {
      const pnEl = document.querySelector('#spnManufacturerPartNumber');
      const box = document.querySelector('#pdpPricingAvailability');
      if (pnEl && box) return { pn: pnEl.textContent.trim(), anchor: box, dy: 52 };
      return null;
    }
    if (SITE === 'digikey') {
      if (!/\/products\/detail\//.test(location.pathname)) return null;
      const stockEl = [...document.querySelectorAll('div, span, p, h2, h3')].find((e) => e.children.length <= 1 && /^现货\s*[:：]/.test(e.textContent.trim()) && visible(e));
      const mfr = document.querySelector('[data-testid="mfr-number"]');
      const seg = location.pathname.split('/').filter(Boolean);
      const pn = (mfr && mfr.textContent.trim()) || decodeURIComponent(seg[seg.length - 2] || '');
      if (stockEl && pn) return { pn, anchor: stockEl, dy: 0, inline: true };
    }
    return null;
  }

  // ---------- 按钮 ----------
  const style = document.createElement('style');
  style.textContent = `
  #icm-bells { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000; }
  #icm-bells .icm-bell { position: absolute; display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border-radius: 16px; cursor: pointer; white-space: nowrap;
    border: 1px solid #d9d2ff; background: #fff; color: #5b3df5; font: 600 12px/1.3 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    box-shadow: 0 2px 8px rgba(92, 70, 255, .15); transition: transform .12s, box-shadow .12s; }
  #icm-bells .icm-bell:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(92, 70, 255, .28); }
  #icm-bells .icm-bell.on { background: linear-gradient(135deg, #7c5cff, #4f8cff); color: #fff; border-color: transparent; }
  #icm-bells .icm-bell.busy { opacity: .7; cursor: progress; }
  #icm-bell-tip { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 2147483001; background: #1d2230; color: #fff; padding: 9px 16px; border-radius: 8px;
    font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 80vw; opacity: 0; pointer-events: none; transition: opacity .2s; }
  #icm-bell-tip.show { opacity: 1; }`;
  document.documentElement.appendChild(style);
  const layer = document.createElement('div');
  layer.id = 'icm-bells';
  document.body.appendChild(layer);

  function tip(text) {
    let t = document.getElementById('icm-bell-tip');
    if (!t) { t = document.createElement('div'); t.id = 'icm-bell-tip'; document.documentElement.appendChild(t); }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 5000);
  }

  let watched = new Set();
  async function loadWatched() {
    const { watches = [] } = await chrome.storage.local.get('watches');
    watched = new Set(watches.map((w) => norm(w.pn)));
    paintStates();
  }
  function paintStates() {
    for (const b of layer.querySelectorAll('.icm-bell')) {
      if (b.classList.contains('busy')) continue;
      const on = watched.has(norm(b.dataset.pn));
      b.classList.toggle('on', on);
      b.textContent = on ? '🔔 已关注' : '🔔 关注';
      b.title = on ? `已关注 ${b.dataset.pn} 的库存和价格变化，点击取消` : `关注 ${b.dataset.pn} 的库存和价格变化（有变化时弹出电脑通知）`;
    }
  }
  const every = (m) => (m >= 1440 ? '每天' : m >= 60 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`);
  async function onBell(b) {
    const pn = b.dataset.pn;
    if (b.classList.contains('busy')) return;
    if (watched.has(norm(pn))) {
      await chrome.runtime.sendMessage({ type: 'removeWatch', pn });
      tip(`已取消关注 ${pn}`);
      return;
    }
    b.classList.add('busy');
    b.textContent = '🔔 记录当前库存…';
    const r = await chrome.runtime.sendMessage({ type: 'addWatch', pn }).catch(() => null);
    b.classList.remove('busy');
    if (r && r.ok) {
      const sites = r.sites || [];
      const miss = r.exists || sites.includes(SITE_NAME) ? '' : `（${SITE_NAME}没有在“⚙ 货源网站”里勾选，不会检查${SITE_NAME}）`;
      tip(r.exists ? `${pn} 已经在关注了` : `已关注 ${pn}：${every(r.minutes || 120)}检查 ${sites.join('、')} 的库存和价格，有变化弹出电脑通知${miss}`);
    } else tip((r && r.error) || '关注失败：请到 chrome://extensions 刷新芯标注插件后，再刷新这个页面');
    paintStates();
  }

  // 把按钮放到每个商品右边；右边没有空位时放进商品块的右上角
  const bells = new Map(); // key → button
  function place() {
    const targets = [];
    const det = detailTarget();
    if (det) targets.push({ key: 'detail', pn: det.pn, el: det.anchor, dy: det.dy, inline: det.inline });
    else for (const row of searchRows()) { const pn = pnOfRow(row); if (pn) targets.push({ key: row, pn, el: row, dy: 14 }); }
    const keep = new Set();
    const vw = document.documentElement.clientWidth;
    for (const t of targets.slice(0, 80)) {
      let b = bells.get(t.key);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'icm-bell';
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onBell(b); });
        layer.appendChild(b);
        bells.set(t.key, b);
      }
      if (b.dataset.pn !== t.pn) { b.dataset.pn = t.pn; b.textContent = ''; }
      keep.add(b);
      const r = t.el.getBoundingClientRect();
      const w = b.offsetWidth || 86;
      let x = r.right + (t.inline ? 16 : 12);
      if (x + w > vw - 4) x = r.right - w - 12; // 右边放不下：放进块里
      b.style.left = `${Math.round(x + window.scrollX)}px`;
      b.style.top = `${Math.round(r.top + window.scrollY + (t.dy || 0))}px`;
    }
    for (const [k, b] of bells) if (!keep.has(b)) { b.remove(); bells.delete(k); }
    paintStates();
  }

  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(place, 300); };
  new MutationObserver((muts) => { if (muts.some((m) => !layer.contains(m.target))) later(); }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', later);
  setInterval(place, 2500);
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.watches) loadWatched(); });
  await loadWatched();
  place();
})();
