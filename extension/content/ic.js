// 芯标注 · IC交易网页面脚本
// 说明：IC交易网在每行里混入大量隐藏的“假”公司名和 QQ（防抓取），这里只处理真正显示出来的元素。
(() => {
  if (window.__icmarkLoaded) return;
  window.__icmarkLoaded = true;

  const DEFAULT_PREFIXES = ['800', '400', '2355', '2843', '2851', '2852', '2853', '2880', '2881', '2882', '2883', '2884', '2885', '3003', '3004', '3007', '3008', '3009'];
  const BUILTIN_AD_SELECTORS = ['#result_topBanners', '#left_ads', '.left_ads', '.jd_ad_img'];
  const STATUS_TEXT = { original: '原装', avoid: '避雷（用户反馈，仅供参考）', caution: '注意' };
  const TEMPLATE_KEY = 'inquiryTemplate';
  const DEFAULT_TEMPLATE = '您好，请问 {型号} 有现货吗？需要 {数量} pcs，麻烦报个价，谢谢！';
  const BATCH_MAX = 20;

  let state = { data: null, settings: {}, localQQ: {} };
  let lastContext = { qq: '', company: '' };

  // 插件在 chrome://extensions 里刷新过、而这个网页没刷新时，旧页面上的插件会失效：给出提示，而不是点了没反应
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };
  let staleShown = false;
  const stale = () => { if (!staleShown) { staleShown = true; toast('芯标注插件刚更新过，请按 F5 刷新这个页面后再用', 6000); } };
  const send = (msg) => {
    if (!alive()) { stale(); return Promise.resolve({}); }
    try { return chrome.runtime.sendMessage(msg).catch(() => ({})); } catch { stale(); return Promise.resolve({}); }
  };
  // 设置的默认值（和 background.js / popup.js 一致）：旧版本存下的设置里缺的项按默认处理
  const SETTING_DEFAULTS = { hideAds: true, qqCopy: true, autoTabs: true, darkMode: 'off', personalQQ: 'copy' };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const keyword = () => {
    let m = location.pathname.match(/\/(?:search|components-storage)\/([^/]+?)\.html/i);
    // 华强电子网：s.hqew.com/型号.html
    if (!m && /(^|\.)s\.hqew\.com$/.test(location.hostname)) m = location.pathname.match(/^\/([^/]+?)\.html$/i);
    return m ? decodeURIComponent(m[1]).trim() : '';
  };

  // ---------- 站点适配：IC交易网 / 正能量电子网（bom.ai） / 华强电子网（hqew.com） ----------
  const SITE = /(^|\.)bom\.ai$/.test(location.hostname) ? 'bom' : /(^|\.)hqew\.com$/.test(location.hostname) ? 'hqew' : 'ic';
  const SITE_NAME = { ic: 'IC交易网', bom: '正能量网', hqew: '华强电子网' }[SITE];
  document.documentElement.classList.add('icm-site-' + SITE);
  const hqewQQData = (a) => { try { return JSON.parse((a.querySelector('[data]') || a).getAttribute('data') || '{}'); } catch { return {}; } };
  const ADAPTER = {
    ic: {
      qqSel: 'a.qqicon',
      qqOf: (a) => a.getAttribute('mytitle') || ((a.getAttribute('inthref') || '').match(/uin=(\d+)/) || [])[1] || '',
      rowSel: 'li.stair_tr',
      company: (row) => {
        const a = [...row.querySelectorAll('.result_supply a.result_goCompany')].find(visible);
        return a ? a.textContent.trim() : '';
      },
      // 该行的型号 / 品牌 / 批次（只取显示出来的格子）
      info: (row) => {
        const pick = (sel) => { const e = [...row.querySelectorAll(sel)].find(visible); return e ? (e.getAttribute('title') || e.textContent).trim() : ''; };
        return { pn: pick('.result_id .product_number'), brand: pick('.result_factory'), batch: pick('.result_batchNumber') };
      },
      hint: () => null,
    },
    bom: {
      qqSel: 'a.bom_Merchant_Qbtn[data-qq]',
      qqOf: (a) => (a.dataset.qq || '').trim(),
      rowSel: 'aside.stock-view',
      company: (row) => {
        const s = row.querySelector('[data-suppliername]');
        if (s && s.dataset.suppliername) return s.dataset.suppliername.trim();
        const el = [...row.querySelectorAll('a, span, p, div')].find((e) => e.children.length <= 1 && /公司$/.test(e.textContent.trim()) && visible(e));
        return el ? el.textContent.trim() : '';
      },
      // 优先读网站自己的格子：型号 .bomID_Merchant_XH、品牌 .cell-brand、批次 .cell-batch（云价格和电子料库存两种行都有）；
      // 读不到的再按文字顺序猜
      info: (row) => {
        const pick = (sel) => { const e = [...row.querySelectorAll(sel)].find(visible); return e ? (e.getAttribute('title') || e.textContent).trim() : ''; };
        const BATCH_RE = /^(\d{2}\+|\d{4}\+?|\d{2,4}(\+\d{2,4})+\+?|20\d{6}|\d{2}年\+?|\d{2}-\d{2}\+?|[一两三]年内|新年份)$/;
        const guess = ADAPTER_BOM_GUESS(row);
        const pn = pick('.bomID_Merchant_XH').split(/\s+/)[0] || guess.pn;
        const brand = pick('.cell-brand') || guess.brand;
        let batch = pick('.cell-batch');
        if (!batch) batch = [...row.querySelectorAll('.bom_Merchant_num, .bom_Merchant_hidden')].filter(visible).map((e) => e.textContent.trim()).find((t) => BATCH_RE.test(t)) || guess.batch;
        return { pn, brand, batch };
      },
      guessInfo: (row) => {
        const kw = keyword().toUpperCase();
        const cells = [...row.querySelectorAll('*')].filter((e) => !e.children.length && visible(e))
          .map((e) => e.textContent.trim()).filter((t) => t && t.length < 40);
        let i = cells.findIndex((t) => kw && t.toUpperCase() === kw);
        if (i < 0) i = cells.findIndex((t) => kw && t.toUpperCase().startsWith(kw));
        const pn = i >= 0 ? cells[i] : '';
        const after = i >= 0 ? cells.slice(i + 1) : cells;
        const brand = (after[0] && /^[A-Za-z\u4e00-\u9fa5][\w\s.&()（）\u4e00-\u9fa5/-]*$/.test(after[0]) && !/复制|购买|公司/.test(after[0])) ? after[0] : '';
        const batch = after.find((t) => /^(\d{2}\+|\d{4}\+?|\d{2,4}(\+\d{2,4})+\+?|20\d{6}|\d{2}年\+?|\d{2}-\d{2}\+?)$/.test(t)) || '';
        return { pn, brand, batch };
      },
      // 正能量网会给企点（企业）QQ 加 qidian 标记
      hint: (a) => (a && a.classList.contains('qidian') ? 'enterprise' : null),
    },
    hqew: {
      // 列表里的 QQ 图标 + 名片里的 QQ
      qqSel: 'a.customerqq[qq], #card .qq-item[qq]',
      qqOf: (a) => (a.getAttribute('qq') || '').trim(),
      rowSel: 'tr.ec-data',
      // 名片里的 QQ 不在行里：按公司 uid 找回对应的行
      rowOf: (a) => {
        const uid = a.getAttribute('uid');
        return uid ? document.querySelector(`tr.ec-data a.company[uid="${CSS.escape(uid)}"]`)?.closest('tr.ec-data') : null;
      },
      company: (row) => {
        const a = row.querySelector('a.company[cname]') || row.querySelector('a.company');
        return a ? (a.getAttribute('cname') || a.textContent).trim() : '';
      },
      info: (row) => {
        const pick = (sel) => { const e = row.querySelector(sel); return e ? (e.getAttribute('title') || e.textContent).trim() : ''; };
        return { pn: (pick('.td-model a.model-cinfo-click') || pick('.td-model a')).split(/\s+/)[0], brand: pick('.td-brand .list-pro'), batch: pick('.td-pproductDate p') };
      },
      // 网站自己标了企点 QQ（entPointQQ / 企点链接）
      hint: (a) => {
        if (!a) return null;
        const d = hqewQQData(a);
        return d.entPointQQ || a.classList.contains('a-qdqq') || /qidian=true/.test(d.qqHref || '') ? 'enterprise' : null;
      },
    },
  }[SITE];
  function ADAPTER_BOM_GUESS(row) { try { return ADAPTER.guessInfo ? ADAPTER.guessInfo(row) : {}; } catch { return {}; } }
  const rowOfQQ = (a) => a.closest(ADAPTER.rowSel) || (ADAPTER.rowOf ? ADAPTER.rowOf(a) : null);

  // ---------- 提示 ----------
  function toast(text, ms = 2600) {
    let t = document.getElementById('icm-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'icm-toast';
      document.documentElement.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), ms);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  // ---------- QQ 分类 ----------
  // 返回 { type: 'personal'|'enterprise', sure: boolean }
  function classifyQQ(qq, el) {
    if (state.localQQ[qq]) return { type: state.localQQ[qq], sure: true };
    const h = ADAPTER.hint(el);
    if (h) return { type: h, sure: true };
    const shared = state.data && state.data.qq && state.data.qq[qq];
    if (shared) return { type: shared, sure: true };
    const prefixes = (state.data && state.data.config && state.data.config.enterprisePrefixes) || DEFAULT_PREFIXES;
    const ent = prefixes.some((p) => qq.startsWith(p));
    return { type: ent ? 'enterprise' : 'personal', sure: false };
  }

  const qqOf = ADAPTER.qqOf;

  function visibleQQIcons(root = document) {
    return [...root.querySelectorAll(ADAPTER.qqSel)].filter((a) => qqOf(a) && visible(a));
  }

  function decorateQQ() {
    for (const a of visibleQQIcons()) {
      const qq = qqOf(a);
      const c = classifyQQ(qq, a);
      a.classList.add('icm-qq');
      a.classList.toggle('icm-qq-personal', c.type === 'personal');
      a.classList.toggle('icm-qq-enterprise', c.type === 'enterprise');
      a.classList.toggle('icm-qq-guess', !c.sure);
      a.title = `芯标注：${c.type === 'enterprise' ? '企业 QQ，可直接聊' : '私人 QQ，需先加好友'}${c.sure ? '' : '（推测）'} · ${qq}`;
    }
  }

  // 私人 QQ：用 QQ 客户端的 tencent:// 协议打开聊天框（只打开窗口，不发送任何内容）。
  // 网页无法知道是不是好友：是好友就能直接聊；不是好友 QQ 会打不开或提示，需要用已复制的号码先加好友
  function openPersonalChat(qq) {
    const a = document.createElement('a');
    a.href = `tencent://message/?uin=${encodeURIComponent(qq)}&Site=&Menu=yes`;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
  }
  // 点 QQ 的统一处理：企业号复制并打开会话；私人号按设置“仅复制”或“复制并打开聊天框”
  async function handleQQ(qq, type, sure) {
    await copy(qq);
    if (type === 'enterprise') {
      toast(`已复制 QQ：${qq}，正在打开企业 QQ 会话…`);
      send({ type: 'openChat', qq });
    } else if (state.settings.personalQQ === 'open') {
      openPersonalChat(qq);
      toast(`已复制 QQ：${qq}，正在打开 QQ 聊天框。好友可以直接聊；非好友状态不支持跳转，请用已复制的号码加好友`, 5000);
    } else {
      toast(`已复制 QQ：${qq}（私人号，需先加好友）${sure ? '' : ' · 推测'}`);
    }
  }

  // 拦截 QQ 图标点击（捕获阶段，先于网站自己的弹窗）
  window.addEventListener('click', async (e) => {
    const a = e.target.closest && e.target.closest(ADAPTER.qqSel);
    if (!a || state.settings.qqCopy === false) return;
    const qq = qqOf(a);
    if (!qq) return;
    if (e.shiftKey) return; // 按住 Shift：走网站原流程
    e.preventDefault();
    e.stopImmediatePropagation();
    const c = classifyQQ(qq, a);
    await copy(qq);
    const row = rowOfQQ(a);
    let info = {};
    try { info = row ? ADAPTER.info(row) : {}; } catch {}
    send({ type: 'logInquiry', entry: { pn: info.pn || keyword(), brand: info.brand || '', batch: info.batch || '',
      company: row ? companyOfRow(row) : '', qq, qqType: c.type, site: SITE,
      action: c.type !== 'personal' || e.altKey ? '打开会话' : state.settings.personalQQ === 'open' ? '打开聊天框' : '复制QQ' } });
    if (c.type === 'personal' && e.altKey) { await copy(qq); toast(`已复制 QQ：${qq}，按住 Alt：尝试用企业会话方式打开`); send({ type: 'openChat', qq }); }
    else await handleQQ(qq, c.type, c.sure);
  }, true);

  // 记录右键位置，供右键菜单使用
  window.addEventListener('contextmenu', (e) => {
    const a = e.target.closest && e.target.closest(ADAPTER.qqSel);
    const row = e.target.closest && (e.target.closest(ADAPTER.rowSel) || (a ? rowOfQQ(a) : null));
    lastContext = { qq: a ? qqOf(a) : '', company: row ? companyOfRow(row) : '' };
  }, true);

  // ---------- 公司标注 ----------
  const companyOfRow = (row) => ADAPTER.company(row);

  const BUILD = window.ICM_BUILD || {};
  function decorateCompanies() {
    if (BUILD.marks === false) return;
    const companies = (state.data && state.data.companies) || {};
    // 先清掉旧标注（名单可能被管理员改过）
    document.querySelectorAll('[data-icm-status]').forEach((el) => {
      const name = el.textContent.trim();
      if (!companies[name]) {
        el.classList.remove('icm-original', 'icm-avoid', 'icm-caution');
        el.removeAttribute('data-icm-status');
        el.removeAttribute('title');
      }
    });
    if (!Object.keys(companies).length) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim().length >= 2 && n.parentElement && !n.parentElement.closest('#icm-panel, script, style, textarea, input')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const name = n.nodeValue.trim();
      const hit = companies[name];
      if (!hit) continue;
      const el = n.parentElement;
      if (el.textContent.trim() !== name) continue; // 只认完全一致
      const [status, note] = hit;
      el.classList.remove('icm-original', 'icm-avoid', 'icm-caution');
      el.classList.add('icm-' + status);
      el.dataset.icmStatus = status;
      el.title = `芯标注：${STATUS_TEXT[status]}${note ? ' · ' + note : ''}`;
    }
  }

  // ---------- 去广告（默认关闭） ----------
  function applyAds() {
    if (SITE !== 'ic') return; // 其他网站的去广告由 adblock.js 负责
    let st = document.getElementById('icm-adblock');
    if (!state.settings.hideAds) {
      if (st) st.remove();
      document.documentElement.classList.remove('icm-noads');
      return;
    }
    const extra = (state.data && state.data.config && state.data.config.adSelectors) || [];
    const sel = [...BUILTIN_AD_SELECTORS, ...extra].join(',\n');
    if (!st) {
      st = document.createElement('style');
      st.id = 'icm-adblock';
      document.documentElement.appendChild(st);
    }
    st.textContent = `${sel} { display: none !important; }`;
    document.documentElement.classList.add('icm-noads');
  }

  // ---------- 半自动批量询价 ----------
  function collectRows() {
    const seen = new Set();
    const out = [];
    for (const row of document.querySelectorAll(ADAPTER.rowSel)) {
      if (!visible(row)) continue;
      const company = companyOfRow(row);
      if (!company || seen.has(company)) continue;
      const icons = visibleQQIcons(row);
      if (!icons.length) continue;
      seen.add(company);
      const qqs = icons.filter((a, i, arr) => arr.findIndex((b) => qqOf(b) === qqOf(a)) === i).map((a) => ({ qq: qqOf(a), ...classifyQQ(qqOf(a), a) }));
      const pick = qqs.find((q) => q.type === 'enterprise') || qqs[0];
      const status = state.data && state.data.companies && state.data.companies[company];
      // 每行的勾选框：网站自带的（IC交易网、华强电子网），或插件加在每家公司后面的
      const siteBox = [...row.querySelectorAll('input[type=checkbox]')].find((x) => x.checked && (SITE === 'hqew' || x.classList.contains('icm-pick-box') || visible(x)));
      let info = {};
      try { info = ADAPTER.info(row); } catch {}
      const ownBox = row.querySelector(':scope > .icm-pick input');
      out.push({ company, info, qq: pick.qq, type: pick.type, sure: pick.sure, status: status ? status[0] : '', siteChecked: !!(siteBox && siteBox.checked), pickChecked: !!(ownBox && ownBox.checked) });
    }
    return out;
  }

  let batch = null; // { list, i, text }

  // 批量询价里已经轮到过的公司（这个型号、这个标签页内记住，刷新页面也还在）：面板里名字变绿，页面上的勾选框变绿并取消勾选
  const askedKey = () => 'icm-asked|' + SITE + '|' + keyword().toUpperCase();
  const askedSet = () => { try { return new Set(JSON.parse(sessionStorage.getItem(askedKey()) || '[]')); } catch { return new Set(); } };
  function markAsked(company) {
    const s = askedSet();
    if (s.has(company)) return;
    s.add(company);
    try { sessionStorage.setItem(askedKey(), JSON.stringify([...s])); } catch {}
  }
  // 页面上每家公司后面的勾选框：已询价的变绿、取消勾选（只在刚询价完时取消一次，之后用户自己再勾可以）
  function paintAskedPicks(uncheck) {
    const s = askedSet();
    for (const row of document.querySelectorAll(ADAPTER.rowSel)) {
      const lab = row.querySelector(':scope > .icm-pick');
      if (!lab) continue;
      const co = companyOfRow(row);
      const asked = !!co && s.has(co);
      lab.classList.toggle('icm-asked', asked);
      lab.title = asked ? '这家已经批量询价过了（绿色）。再勾上可以重新询价' : '勾选后点右侧“批量询价”，这家公司会自动选上';
      const box = lab.querySelector('input');
      if (asked && uncheck && box && box.checked) box.checked = false;
    }
  }

  // 按钮放进 IC交易网结果栏（“商务通批量询价”旁边），跟着页面走，不会盖住页面内容
  function ensureFab() {
    if (BUILD.batch === false) return;
    if (SITE !== 'ic' || !/\/search\//.test(location.pathname)) return;
    const old = document.getElementById('icm-fab');
    if (old && old.isConnected && visible(old)) return;
    if (old) old.remove();
    const fab = document.createElement('button');
    fab.id = 'icm-fab';
    fab.type = 'button';
    fab.innerHTML = '<span class="icm-fab-dot"></span>批量询价';
    fab.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openPanel(); };
    const anchor = [...document.querySelectorAll('.right_resultTitle .batchInquiryBtn')].find(visible);
    if (anchor) {
      fab.className = 'icm-inline';
      anchor.insertAdjacentElement('afterend', fab);
    } else {
      fab.className = 'icm-floating'; // 找不到结果栏时（网站改版），退回到右上角悬浮
      document.documentElement.appendChild(fab);
    }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function openPanel() {
    if (!alive()) return stale();
    let panel = document.getElementById('icm-panel');
    if (panel) { closePanel(); return; }
    const { [TEMPLATE_KEY]: tpl } = await chrome.storage.local.get(TEMPLATE_KEY);
    const rows = collectRows();
    // 默认勾选：如果你在 IC交易网页面上勾了行，就用你勾的；否则勾前 20 家企业 QQ（避雷的不勾）
    const fromSite = rows.some((r) => r.siteChecked);
    let quota = BATCH_MAX;
    const asked = askedSet();
    rows.forEach((r) => {
      r.asked = asked.has(r.company);
      // 默认一家都不勾；只有在网站列表里自己勾过的才带过来
      // 已询价的公司不再自动带过来，除非你在它后面的绿色勾选框里重新勾上
      r.preChecked = fromSite && r.siteChecked && (!r.asked || r.pickChecked) && quota-- > 0;
    });
    panel = document.createElement('div');
    panel.id = 'icm-panel';
    panel.innerHTML = `
      <div class="icm-head"><b>芯标注 · 批量询价</b><button class="icm-x" title="关闭">×</button></div>
      <div class="icm-body" id="icm-choose">
        <div class="icm-guide">
          <div class="icm-guide-t">怎么用？4 步</div>
          <ol>
            <li>在下面写好询价内容，勾选要询价的公司</li>
            <li>点最下面的 <b>开始询价</b></li>
            <li>插件自动打开对方 QQ，并复制好询价内容 → 你在 QQ 聊天框按 <b>Ctrl+V</b>（Mac 按 <b>⌘V</b>），再按 <b>回车</b></li>
            <li>回到这里点 <b>下一家</b>，重复到结束</li>
          </ol>
          <div class="icm-guide-n">“企业”QQ 可直接聊；“私人”QQ 要先加好友，轮到它时插件只复制 QQ 号。带 ? 的是推测。每批最多 ${BATCH_MAX} 家。</div>
        </div>
        <label>询价内容（{型号} {数量} 会自动替换）</label>
        <textarea id="icm-tpl" rows="3">${esc(tpl || DEFAULT_TEMPLATE)}</textarea>
        <div class="icm-line">
          <label>型号 <input id="icm-pn" value="${esc(keyword())}"></label>
          <label>数量 <input id="icm-qty" placeholder="可不填" title="不填时只发“你好，请问 型号 有现货吗？”" style="width:90px"></label>
        </div>
        <div class="icm-line">
          <span class="icm-muted">${fromSite ? '已按你在页面上勾选的公司选好' : `本页 ${rows.length} 家 · 在页面上打勾也会同步到这里`}</span>
          <span class="icm-grow"></span>
          <button class="icm-link" data-sel="ent">只选企业</button>
          <button class="icm-link" data-sel="none">清空</button>
        </div>
        <div class="icm-list">${rows.map((r, i) => `
          <label class="icm-item ${r.asked ? 'icm-asked' : ''}" ${r.asked ? 'title="这家已经询价过了，再勾上可以重新询价"' : ''}>
            <input type="checkbox" data-i="${i}" data-co="${esc(r.company)}" ${r.preChecked ? 'checked' : ''}>
            <span class="icm-name ${r.status ? 'icm-' + r.status : ''}">${esc(r.company)}</span>${r.asked ? '<span class="icm-asked-t">已询价</span>' : ''}
            <span class="icm-tag ${r.type}">${r.type === 'enterprise' ? '企业' : '私人'}${r.sure ? '' : '?'}</span>
            <span class="icm-muted">${r.qq}</span>
          </label>`).join('') || '<div class="icm-muted" style="padding:12px">本页没有找到带 QQ 的供应商</div>'}
        </div>
      </div>
      <div class="icm-body hidden" id="icm-run"></div>
      <div class="icm-foot" id="icm-foot">
        <button id="icm-start" class="icm-btn primary icm-big">开始询价</button>
      </div>`;
    document.documentElement.appendChild(panel);
    document.documentElement.classList.add('icm-drawer-open');
    panel._rows = rows;
    const boxes = () => [...panel.querySelectorAll('.icm-list input[type=checkbox]')];
    const startBtn = panel.querySelector('#icm-start');
    const refreshCount = () => {
      const n = boxes().filter((x) => x.checked).length;
      startBtn.textContent = n ? `开始询价（已选 ${n} 家）` : '请先勾选公司';
      startBtn.disabled = !n;
    };
    panel.querySelector('.icm-list').addEventListener('change', refreshCount);
    panel.querySelector('.icm-x').onclick = closePanel;
    panel.querySelectorAll('[data-sel]').forEach((b) => (b.onclick = () => {
      let left = BATCH_MAX;
      boxes().forEach((x) => {
        const r = rows[x.dataset.i];
        const want = b.dataset.sel === 'ent' ? r.type === 'enterprise' && r.status !== 'avoid' && !r.asked : false;
        x.checked = want && left-- > 0;
      });
      refreshCount();
    }));
    panel.querySelector('#icm-tpl').onchange = (e) => chrome.storage.local.set({ [TEMPLATE_KEY]: e.target.value });
    startBtn.onclick = () => {
      const list = boxes().filter((x) => x.checked).map((x) => rows[x.dataset.i]);
      if (!list.length) return toast('请先勾选要询价的公司');
      if (list.length > BATCH_MAX) return toast(`一批最多 ${BATCH_MAX} 家，避免被腾讯判定为骚扰，请少勾几家`);
      const pnV = panel.querySelector('#icm-pn').value.trim();
      const qtyV = panel.querySelector('#icm-qty').value.trim();
      // 数量没填：只问有没有现货
      const text = qtyV
        ? panel.querySelector('#icm-tpl').value.replaceAll('{型号}', pnV).replaceAll('{数量}', qtyV)
        : `你好，请问 ${pnV} 有现货吗？`;
      chrome.storage.local.set({ [TEMPLATE_KEY]: panel.querySelector('#icm-tpl').value });
      batch = { list, i: 0, text, pn: panel.querySelector('#icm-pn').value.trim(), qty: panel.querySelector('#icm-qty').value.trim() };
      panel.querySelector('#icm-choose').classList.add('hidden');
      panel.querySelector('#icm-run').classList.remove('hidden');
      step(panel);
    };
    refreshCount();
  }

  function closePanel() {
    if (batch) paintAskedPicks(true); // 询价中途关掉面板：轮到过的也标绿
    batch = null;
    const panel = document.getElementById('icm-panel');
    if (panel) panel.remove();
    document.documentElement.classList.remove('icm-drawer-open');
  }

  function backToChoose(panel) {
    batch = null;
    // 刚才轮到过的公司：名字变绿 + “已询价”，取消勾选；页面上的勾选框也变绿、取消勾选
    const asked = askedSet();
    for (const x of panel.querySelectorAll('.icm-list input[type=checkbox]')) {
      const r = panel._rows && panel._rows[x.dataset.i];
      if (!asked.has(x.dataset.co)) continue;
      if (r) r.asked = true;
      x.checked = false;
      const item = x.closest('.icm-item');
      if (item && !item.classList.contains('icm-asked')) {
        item.classList.add('icm-asked');
        item.title = '这家已经询价过了，再勾上可以重新询价';
        item.querySelector('.icm-name').insertAdjacentHTML('afterend', '<span class="icm-asked-t">已询价</span>');
      }
    }
    paintAskedPicks(true);
    panel.querySelector('#icm-run').classList.add('hidden');
    panel.querySelector('#icm-choose').classList.remove('hidden');
    const foot = panel.querySelector('#icm-foot');
    foot.innerHTML = '';
    foot.appendChild(panel._startBtn);
    const n = [...panel.querySelectorAll('.icm-list input[type=checkbox]')].filter((x) => x.checked).length;
    panel._startBtn.textContent = n ? `开始询价（已选 ${n} 家）` : '请先勾选公司';
    panel._startBtn.disabled = !n;
  }

  async function step(panel) {
    const run = panel.querySelector('#icm-run');
    const foot = panel.querySelector('#icm-foot');
    if (!panel._startBtn) panel._startBtn = panel.querySelector('#icm-start');
    if (!batch || batch.i >= batch.list.length) {
      const total = batch ? batch.list.length : 0;
      run.innerHTML = `<div class="icm-done">✅ 本批 ${total} 家已全部发起</div><p class="icm-muted" style="text-align:center">记得在 QQ 里留意回复。</p>`;
      foot.innerHTML = '<button class="icm-btn primary icm-big">再来一批</button>';
      foot.querySelector('button').onclick = () => backToChoose(panel);
      batch = null;
      return;
    }
    const cur = batch.list[batch.i];
    const total = batch.list.length;
    markAsked(cur.company);
    const isEnt = cur.type === 'enterprise';
    const ci = cur.info || {};
    // 打开了 QQ 会话的才记入询价记录本：企业号；私人号只有在设置为“复制并打开 QQ 聊天框”时才会打开
    const opensChat = isEnt || state.settings.personalQQ === 'open';
    let copiedOk;
    if (isEnt) {
      copiedOk = await copy(batch.text);
      send({ type: 'openChat', qq: cur.qq });
    } else {
      copiedOk = await copy(cur.qq);
      if (opensChat) openPersonalChat(cur.qq);
    }
    if (opensChat) {
      send({ type: 'logInquiry', entry: { pn: batch.pn || ci.pn, qty: batch.qty, brand: ci.brand || '', batch: ci.batch || '', site: SITE,
        company: cur.company, qq: cur.qq, qqType: cur.type, action: '批量询价', text: isEnt ? batch.text : '' } });
    }
    const stamp = () => new Date().toTimeString().slice(0, 8);
    run.innerHTML = `
      ${isEnt ? `
        <div class="icm-howto">
          <div class="icm-guide-t">现在请这样做</div>
          <div>① 浏览器问“打开 QQ？”时点 <b>打开</b>（可勾选“始终允许”）</div>
          <div>② 在 QQ 聊天框按 <b>Ctrl+V</b>（Mac 按 <b>⌘V</b>），再按 <b>回车</b>。<span class="icm-warn">聊天框里如果已经有字（QQ 会保留上次没发出去的草稿），先删掉再粘贴</span></div>
          <div>③ 回到这里点下面的 <b>下一家</b></div>
        </div>` : `
        <div class="icm-howto">
          <div class="icm-guide-t">这家是私人 QQ</div>
          <div>${opensChat ? `已尝试打开 QQ 聊天框：是好友就能直接聊；非好友状态不支持跳转，QQ 号 <b>${cur.qq}</b> 已复制，可以去加好友。` : `不能直接发消息。QQ 号 <b>${cur.qq}</b> 已复制，可以去 QQ 加好友；也可以直接点 <b>下一家</b> 跳过。这家不记入询价记录本。`}</div>
        </div>`}
      <div class="icm-progress"><span style="width:${(batch.i / total) * 100}%"></span></div>
      <div class="icm-muted">第 ${batch.i + 1} / ${total} 家</div>
      <div class="icm-cur ${cur.status ? 'icm-' + cur.status : ''}">${esc(cur.company)} <span class="icm-tag ${cur.type}">${isEnt ? '企业' : '私人'}</span></div>
      ${isEnt ? `<div class="icm-muted">已复制的询价内容（可以直接修改，改完自动重新复制，后面几家也用改过的内容）：</div><textarea class="icm-preview icm-preview-edit" rows="3">${esc(batch.text)}</textarea>` : ''}
      <div class="icm-copystate ${copiedOk ? 'ok' : 'bad'}">${copiedOk ? `✓ 已复制到剪贴板（${stamp()}）` : '✗ 复制失败：请点“重新复制”后再粘贴'}</div>
      <div class="icm-actions" style="justify-content:space-between">
        ${isEnt ? '<button class="icm-btn" data-a="reopen">QQ 没弹出？重新打开</button>' : '<span></span>'}
        <button class="icm-btn" data-a="copy">${isEnt ? '重新复制询价内容' : '重新复制 QQ 号'}</button>
      </div>`;
    foot.innerHTML = `<button class="icm-btn ghost" data-a="stop">结束</button><button class="icm-btn primary icm-big" data-a="next">${batch.i + 1 < total ? '下一家 →' : '完成'}</button>`;
    const on = (a, fn) => { const b = panel.querySelector(`[data-a="${a}"]`); if (b) b.onclick = fn; };
    on('reopen', () => send({ type: 'openChat', qq: cur.qq }));
    const showCopy = (ok) => { const el = run.querySelector('.icm-copystate'); if (el) { el.className = `icm-copystate ${ok ? 'ok' : 'bad'}`; el.textContent = ok ? `✓ 已复制到剪贴板（${stamp()}）` : '✗ 复制失败：请点“重新复制”后再粘贴'; } };
    on('copy', async () => { const ok = await copy(isEnt ? batch.text : cur.qq); showCopy(ok); toast(ok ? '已复制' : '复制失败'); });
    const ed = run.querySelector('.icm-preview-edit');
    if (ed) {
      let t;
      ed.addEventListener('keydown', (e) => e.stopPropagation());
      ed.addEventListener('input', () => {
        batch.text = ed.value;
        clearTimeout(t);
        t = setTimeout(async () => { const ok = await copy(batch.text); showCopy(ok); toast(ok ? '询价内容已更新并重新复制' : '复制失败，请点“重新复制询价内容”'); }, 400);
      });
    }
    on('next', () => { batch.i++; step(panel); });
    on('stop', () => backToChoose(panel));
  }


  // ---------- 货源对比条 + 库存价格监控 + 询价记录入口 ----------
  const SITES = [['szlcsc', '立创商城'], ['ickey', '云汉芯城'], ['bomman', '圣禾堂'], ['mouser', '贸泽'], ['digikey', '得捷'], ['taobao', '淘宝'], ['ti', 'TI 官网']];
  const TAB_SITES = ['ickey', 'bomman', 'mouser', 'digikey', 'taobao'];
  // 用户可以关掉不需要的货源网站（关掉的不显示、不查询、不打开后台标签页）
  // 默认关闭：贸泽、得捷、淘宝、TI 官网（用户可以在“⚙ 货源网站”里打开）
  const SRC_DEFAULT_OFF = ['mouser', 'digikey', 'taobao', 'ti'];
  const srcOn = (k) => {
    const v = state.settings.sources && state.settings.sources[k];
    return v === undefined ? !SRC_DEFAULT_OFF.includes(k) : v !== false;
  };
  // TI 官网只在这个料号是 TI 的时候显示（识别不出品牌时照常显示）
  function partBrand() {
    let brand = pageBrand();
    if (!brand && srcState.szlcsc && srcState.szlcsc.r && srcState.szlcsc.r.items && srcState.szlcsc.r.items[0]) brand = brandOf(srcState.szlcsc.r.items[0].brand);
    return brand;
  }
  // 品牌文字：页面每行的厂商格 + 已查到的货源品牌；多数是 TI 才显示 TI 官网，一个品牌都读不到时照常显示
  const TI_RE = /\bTI\b|texas|德州|德仪/i;
  function tiAllowed() {
    const sel = SITE === 'ic' ? 'li.stair_tr .result_factory' : SITE === 'hqew' ? 'tr.ec-data .td-brand .list-pro' : '';
    const texts = (sel ? [...document.querySelectorAll(sel)].filter(visible).slice(0, 40).map((e) => (e.getAttribute('title') || e.textContent).trim()) : [])
      .concat(Object.values(srcState).flatMap((x) => (x && x.r && x.r.ok ? x.r.items.map((it) => it.brand) : [])))
      .filter(Boolean);
    if (!texts.length) { const b = partBrand(); return !b || b === 'TI'; }
    return texts.filter((t) => TI_RE.test(t)).length * 2 >= texts.length;
  }
  async function setSrcOn(k, on) {
    // 先同步改内存，连续快速点几个也不会互相覆盖
    const sources = { ...(state.settings.sources || {}), [k]: on };
    state.settings = { ...state.settings, sources };
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, sources: state.settings.sources } });
  }
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');

  // ---- 品牌识别：只保留与本型号同品牌的货源 ----
  const BRANDS = [
    ['TI', /\bTI\b|texas|德州|德仪/i],
    ['ADI', /\bADI\b|analog\s*dev|亚德诺|linear\s*tech|凌力尔特|maxim|美信/i],
    ['ST', /\bST\b|\bSTM\b|stmicro|意法/i],
    ['NXP', /\bNXP\b|恩智浦|freescale|飞思卡尔/i],
    ['Microchip', /microchip|微芯|atmel|爱特梅尔/i],
    ['Infineon', /infineon|英飞凌|cypress|赛普拉斯|international\s*rectifier/i],
    ['onsemi', /onsemi|on\s*semi|安森美|fairchild|仙童/i],
    ['Renesas', /renesas|瑞萨|intersil|\bIDT\b/i],
    ['Nexperia', /nexperia|安世/i],
    ['Vishay', /vishay|威世/i],
    ['Toshiba', /toshiba|东芝/i],
    ['ROHM', /\brohm\b|罗姆/i],
    ['Murata', /murata|村田/i],
    ['Samsung', /samsung|三星/i],
    ['Yageo', /yageo|国巨/i],
    ['Diodes', /\bdiodes\b|美台/i],
    ['GigaDevice', /gigadevice|兆易/i],
    ['WCH', /\bWCH\b|沁恒/i],
    ['Winbond', /winbond|华邦/i],
    ['Micron', /micron|美光/i],
  ];
  const brandOf = (s) => { const b = BRANDS.find(([, re]) => re.test(String(s || ''))); return b ? b[0] : ''; };
  let pageBrandCache = null;
  function pageBrand() {
    if (pageBrandCache !== null) return pageBrandCache;
    const cnt = {};
    const cells = SITE === 'ic'
      ? [...document.querySelectorAll('li.stair_tr .result_factory')].filter(visible).map((e) => e.textContent)
      : [...document.querySelectorAll(ADAPTER.rowSel)].filter(visible).slice(0, 40).map((e) => e.innerText);
    for (const c of cells) { const b = brandOf(c); if (b) cnt[b] = (cnt[b] || 0) + 1; }
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    pageBrandCache = top && top[1] >= 2 ? top[0] : '';
    return pageBrandCache;
  }
  // 按品牌过滤后重新汇总（品牌不明的货源保留）
  function view(r) {
    if (!r || !r.ok) return r;
    let brand = pageBrand();
    if (!brand && srcState.szlcsc && srcState.szlcsc.r && srcState.szlcsc.r.items && srcState.szlcsc.r.items[0]) brand = brandOf(srcState.szlcsc.r.items[0].brand);
    const items = brand ? r.items.filter((it) => { const b = brandOf(it.brand); return !b || b === brand; }) : r.items;
    const prices = items.map((it) => it.price).filter((p) => p > 0);
    return { ...r, items, brand, hidden: r.items.length - items.length, count: items.length,
      stock: items.reduce((a, it) => a + (Number(it.stock) || 0), 0), minPrice: prices.length ? Math.min(...prices) : 0,
      direct: items.some((it) => it.direct) };
  }

  function sourceCard(site, name, raw, loading) {
    if (site === 'ti') return `<a class="icm-src ok" href="https://www.ti.com.cn/sitesearch/zh-cn/docs/universalsearch.tsp?searchTerm=${encodeURIComponent(keyword())}" target="_blank" rel="noopener" title="TI 官网的库存和价格要登录后才显示，点击去官网查看"><b>${name}</b> <span class="icm-muted">去官网查↗</span></a>`;
    if (loading) return `<span class="icm-src loading" data-site="${site}"><b>${name}</b> 查询中…</span>`;
    if (!raw) return `<span class="icm-src idle" data-site="${site}"><b>${name}</b> <button type="button" class="icm-src-q" data-q="${site}">点击查询</button></span>`;
    if (!raw.ok) return `<span class="icm-src err" data-site="${site}" title="${esc(raw.error)}"><b>${name}</b> ${/^需要先登录|要求登录/.test(raw.error) ? '需要登录' : /人机验证/.test(raw.error) ? '需要验证' : /超时/.test(raw.error) ? '超时' : '查询失败'} <button type="button" class="icm-src-q" data-q="${site}" data-force="1">重试</button> <a href="${raw.url}" target="_blank" rel="noopener">去看看↗</a></span>`;
    const r = view(raw);
    if (site === 'taobao') {
      const tb = r.count ? `${r.minPrice ? `<em class="icm-stock">¥${r.minPrice} 起</em>` : ''} <span class="icm-muted">(${r.count} 家店铺)</span>` : '<span class="icm-muted">未找到</span>';
      return `<a class="icm-src ok" data-site="${site}" href="${r.url}" target="_blank" rel="noopener"><b>${name}</b> ${tb}</a>`;
    }
    const body = r.count
      ? `${r.stock ? `<em class="icm-stock">库存 ${fmt(r.stock)}</em>` : '<em class="icm-nostock">无库存</em>'}${r.minPrice ? ` · ¥${r.minPrice} 起` : ''} <span class="icm-muted">(${r.count} 条货源)</span>`
      : '<span class="icm-muted">未找到</span>';
    const chs = {};
    r.items.forEach((it) => { if (it.channel) chs[it.channel] = (chs[it.channel] || 0) + 1; });
    const chTip = Object.keys(chs).length ? ` title="${esc(Object.entries(chs).map(([c, n]) => `${c} ${n} 条`).join('，'))}（型号完全一致才显示）"` : '';
    return `<a class="icm-src ok" data-site="${site}" href="${r.url}" target="_blank" rel="noopener"${chTip}><b>${name}</b> ${body}${r.direct ? ' <span class="icm-direct">原厂直供</span>' : ''}</a>`;
  }

  const srcState = {};
  async function querySource(site, force) {
    const pn = keyword();
    if (!srcOn(site)) return;
    srcState[site] = { loading: true };
    paintBar();
    const r = await send({ type: 'lookup', site, pn, force: !!force });
    srcState[site] = { r: r && r.site ? r : { ok: false, error: '查询失败', url: '' } };
    paintBar();
  }

  // 规格书：立创 > 得捷 > 贸泽 > 圣禾堂
  function datasheetUrl() {
    for (const k of ['szlcsc', 'digikey', 'mouser', 'bomman']) {
      const r = srcOn(k) && srcState[k] && srcState[k].r;
      if (r && r.ok && r.datasheet) return { url: r.datasheet, from: SITES.find((s) => s[0] === k)[1] };
    }
    return null;
  }

  function paintBar() {
    const bar = document.getElementById('icm-srcbar');
    if (!bar) return;
    const ds = datasheetUrl();
    const brand = pageBrand();
    bar.querySelector('.icm-srcs').innerHTML = SITES.filter(([k]) => srcOn(k) && (k !== 'ti' || tiAllowed())).map(([k, n]) => sourceCard(k, n, srcState[k] && srcState[k].r, srcState[k] && srcState[k].loading)).join('')
      + (ds ? `<a class="icm-src ok icm-ds" href="${esc(ds.url)}" target="_blank" rel="noopener" title="规格书来源：${ds.from}">📄 <b>规格书</b></a>` : '');
    const bt = bar.querySelector('.icm-brand');
    if (bt) bt.textContent = brand ? `品牌：${brand}` : '';
    bar.querySelectorAll('[data-q]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); querySource(b.dataset.q, b.dataset.force); }));
    bar.querySelectorAll('.icm-src.ok[data-site]').forEach((card) => {
      card.onmouseenter = () => showPop(card.dataset.site, card);
      card.onmouseleave = () => hidePopSoon();
    });
  }

  // ---------- 货源悬浮详情窗 ----------
  let popTimer;
  const absUrl = (u) => (u && u.startsWith('//') ? 'https:' + u : u || '');
  function hidePopSoon() {
    clearTimeout(popTimer);
    popTimer = setTimeout(() => { const p = document.getElementById('icm-pop'); if (p) p.remove(); }, 250);
  }
  function ladderHtml(it) {
    const rows = it.ladder && it.ladder.length ? it.ladder : (it.price ? [[it.moq || 1, it.price]] : []);
    if (!rows.length) return '<div class="icm-muted">无价格</div>';
    const hasHk = rows.some((x) => x[2]);
    return `<table class="icm-lad">${hasHk ? '<tr><th>数量</th><th>内地(含税)</th><th>香港</th></tr>' : ''}
      ${rows.map(([q, p, hk]) => `<tr><td>${fmt(q)}+</td><td><b>${p ? '¥' + p : '-'}</b></td>${hasHk ? `<td>${esc(hk || '-')}</td>` : ''}</tr>`).join('')}</table>
      ${it.priceNote ? `<div class="icm-muted">${esc(it.priceNote)}</div>` : ''}`;
  }
  function showPop(site, card) {
    const st = srcState[site];
    const r = st && view(st.r);
    if (!r || !r.ok) return;
    clearTimeout(popTimer);
    let pop = document.getElementById('icm-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'icm-pop';
      pop.onmouseenter = () => clearTimeout(popTimer);
      pop.onmouseleave = () => hidePopSoon();
      document.documentElement.appendChild(pop);
    }
    const isTb = site === 'taobao';
    const items = isTb ? [...r.items].sort((a, b) => (a.price || 1e9) - (b.price || 1e9))
      : [...r.items].sort((a, b) => (a.rank || 0) - (b.rank || 0) || (b.stock > 0) - (a.stock > 0) || (b.direct ? 1 : 0) - (a.direct ? 1 : 0) || (a.price || 1e9) - (b.price || 1e9));
    pop.innerHTML = `
      <div class="icm-pop-h">
        <b>${esc(r.name)}</b> · ${esc(r.pn)} · ${isTb ? `搜索结果前 ${r.count} 个商品（按价格从低到高）` : `${r.count} 条货源 · 库存合计 <b class="icm-stock">${fmt(r.stock)}</b>`}
        ${r.direct ? '<span class="icm-direct">含原厂直供</span>' : ''}
        ${r.brand && r.hidden ? `<span class="icm-muted">（已隐藏 ${r.hidden} 条非 ${esc(r.brand)} 货源）</span>` : ''}
        <span class="icm-grow"></span><a href="${r.url}" target="_blank" rel="noopener">打开网站 ↗</a>
      </div>
      <div class="icm-pop-b">${items.length ? items.map((it) => isTb ? `
        <div class="icm-pop-it">
          <div class="icm-pop-img">${it.img ? `<img src="${esc(absUrl(it.img))}" referrerpolicy="no-referrer" loading="lazy" data-zoom="${esc(absUrl(it.imgBig || it.img))}" data-small="${esc(absUrl(it.img))}" title="点击放大">` : '<span>无图</span>'}</div>
          <div class="icm-pop-info">
            <div class="icm-pop-model"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></div>
            <div><span>店铺：</span>${esc(it.shop)}${it.shopTag ? ` <span class="icm-ch">${esc(it.shopTag)}</span>` : ''}</div>
          </div>
          <div class="icm-pop-ladder"><div class="icm-pop-t">价格</div><b class="icm-tb-price">${it.price ? '¥' + it.price : '-'}</b></div>
          <div class="icm-pop-stock"><div class="icm-pop-t">店铺信息</div>
            ${it.location ? `<div><span>发货地：</span>${esc(it.location)}</div>` : ''}
            ${it.sales ? `<div><span>销量：</span>${esc(it.sales)}</div>` : ''}
          </div>
        </div>` : `
        <div class="icm-pop-it">
          <div class="icm-pop-img">${it.img ? `<img src="${esc(absUrl(it.img))}" referrerpolicy="no-referrer" loading="lazy" data-zoom="${esc(absUrl(it.imgBig || it.img))}" data-small="${esc(absUrl(it.img))}" title="点击放大">` : '<span>无图</span>'}</div>
          <div class="icm-pop-info">
            <div class="icm-pop-model">${it.url ? `<a href="${esc(absUrl(it.url))}" target="_blank" rel="noopener">${esc(it.model)}</a>` : esc(it.model)}</div>
            ${it.channel ? `<div><span class="icm-ch${it.direct ? ' direct' : ''}">${esc(it.channel)}${it.direct ? ' · 原厂直供' : ''}</span></div>` : ''}
            ${it.brand ? `<div><span>品牌：</span>${esc(it.brand)}</div>` : ''}
            ${it.pkg ? `<div><span>封装：</span>${esc(it.pkg)}</div>` : ''}
            ${it.category ? `<div><span>类目：</span>${esc(it.category)}</div>` : ''}
            ${it.code ? `<div><span>编号：</span>${esc(it.code)}</div>` : ''}
          </div>
          <div class="icm-pop-ladder"><div class="icm-pop-t">价格梯度</div>${ladderHtml(it)}</div>
          <div class="icm-pop-stock">
            <div class="icm-pop-t">库存交期</div>
            ${it.delivery ? `<div class="icm-tag-d">${esc(it.delivery)}</div>` : ''}
            <div>${it.stock > 0 ? `现货：<b class="icm-stock">${fmt(it.stock)}</b>` : `库存：<b>0</b>`}</div>
            ${it.onOrder && it.onOrder.length ? `<div><span>在途：</span>${it.onOrder.map(esc).join('<br>')}</div>` : ''}
            ${it.leadTime ? `<div><span>生产周期：</span>${esc(it.leadTime)}</div>` : ''}
            ${it.batch ? `<div><span>批次：</span>${esc(it.batch)}</div>` : ''}
            ${it.updated ? `<div><span>更新：</span>${esc(it.updated)}</div>` : ''}
            ${it.moq ? `<div><span>起订：</span>${fmt(it.moq)}</div>` : ''}
            ${it.step ? `<div><span>增量：</span>${fmt(it.step)}</div>` : ''}
            ${it.pack ? `<div>${esc(it.pack)}</div>` : ''}
          </div>
        </div>`).join('') : '<div class="icm-muted" style="padding:16px">没有匹配的型号</div>'}
      </div>`;
    pop.querySelectorAll('img[data-zoom]').forEach((img) => {
      img.onclick = (e) => { e.preventDefault(); openLightbox(img.dataset.zoom, img.dataset.small); };
      img.onerror = () => fixBrokenImage(img);
    });
    pop.querySelectorAll('.icm-pop-img').forEach((box) => { if (!box.querySelector('img')) dropImageBox(box); });
    const rc = card.getBoundingClientRect();
    const w = Math.min(860, window.innerWidth - 24);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(12, Math.min(rc.left, window.innerWidth - w - 12)) + 'px';
    const below = window.innerHeight - rc.bottom;
    if (below > 320 || below > rc.top) { pop.style.top = rc.bottom + 6 + 'px'; pop.style.bottom = ''; pop.style.maxHeight = (below - 18) + 'px'; }
    else { pop.style.bottom = (window.innerHeight - rc.top + 6) + 'px'; pop.style.top = ''; pop.style.maxHeight = (rc.top - 18) + 'px'; }
  }

  // 图片打不开时（例如网站禁止加载外部图片）：先让后台代读一次，还不行就把图片位置去掉
  const imgCache = {};
  function dropImageBox(box) {
    const it = box.closest('.icm-pop-it');
    box.remove();
    if (it) it.classList.add('noimg');
  }
  async function fixBrokenImage(img) {
    if (img.dataset.tried) { dropImageBox(img.closest('.icm-pop-img')); return; }
    img.dataset.tried = '1';
    const url = img.dataset.small || img.src;
    let data = imgCache[url];
    if (data === undefined) {
      const r = await send({ type: 'fetchImage', url });
      data = imgCache[url] = r && r.ok ? r.dataUrl : null;
    }
    if (data) img.src = data; else dropImageBox(img.closest('.icm-pop-img'));
  }

  // ---------- 图片放大预览：滚轮缩放、拖动、复制 ----------
  function openLightbox(url, fallback) {
    const old = document.getElementById('icm-lightbox');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'icm-lightbox';
    box.innerHTML = `
      <div class="icm-lb-stage"><img src="${esc(url)}" referrerpolicy="no-referrer" draggable="false"></div>
      <div class="icm-lb-bar">
        <button type="button" data-a="out">－</button><span class="icm-lb-zoom">100%</span><button type="button" data-a="in">＋</button>
        <button type="button" data-a="reset">原始大小</button>
        <button type="button" data-a="copy">复制图片</button>
        <button type="button" data-a="url">复制图片地址</button>
        <button type="button" data-a="close">关闭 (Esc)</button>
      </div>
      <div class="icm-lb-tip">滚轮缩放 · 按住拖动 · 双击还原 · 点空白处关闭</div>`;
    document.documentElement.appendChild(box);
    const img = box.querySelector('img');
    // 大图打不开时退回小图
    img.onerror = () => { if (fallback && img.src !== fallback) { url = fallback; img.src = fallback; } };
    let scale = 1, x = 0, y = 0;
    // 小图（如 150px 缩略图）自动放大到合适的观看尺寸
    img.onload = () => { if (img.naturalWidth && img.naturalWidth < 420) { scale = Math.min(4, 420 / img.naturalWidth); apply(); } };
    const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; box.querySelector('.icm-lb-zoom').textContent = Math.round(scale * 100) + '%'; };
    const zoom = (f) => { scale = Math.min(12, Math.max(0.2, scale * f)); apply(); };
    box.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    let drag = null;
    img.addEventListener('mousedown', (e) => { e.preventDefault(); drag = { sx: e.clientX - x, sy: e.clientY - y }; img.style.cursor = 'grabbing'; });
    window.addEventListener('mousemove', (e) => { if (drag) { x = e.clientX - drag.sx; y = e.clientY - drag.sy; apply(); } });
    window.addEventListener('mouseup', () => { drag = null; img.style.cursor = 'grab'; });
    img.addEventListener('dblclick', () => { scale = 1; x = 0; y = 0; apply(); });
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    box.addEventListener('click', (e) => { if (e.target === box || e.target.classList.contains('icm-lb-stage')) close(); });
    box.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'in') zoom(1.25);
      else if (a === 'out') zoom(1 / 1.25);
      else if (a === 'reset') { scale = 1; x = 0; y = 0; apply(); }
      else if (a === 'close') close();
      else if (a === 'url') { await copy(url); toast('已复制图片地址'); }
      else if (a === 'copy') {
        try {
          const r = await send({ type: 'fetchImage', url });
          if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
          const im = new Image();
          await new Promise((ok, bad) => { im.onload = ok; im.onerror = bad; im.src = r.dataUrl; });
          const cv = document.createElement('canvas');
          cv.width = im.naturalWidth; cv.height = im.naturalHeight;
          cv.getContext('2d').drawImage(im, 0, 0);
          const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('已复制图片，可以直接粘贴到 QQ / 微信 / 文档');
        } catch (err) {
          await copy(url);
          toast('这张图片不能直接复制，已改为复制图片地址');
        }
      }
    }));
    apply();
  }

  async function paintWatchBtn() {
    const btn = document.getElementById('icm-watch');
    if (!btn) return;
    const { watches = [] } = await chrome.storage.local.get('watches');
    const on = watches.some((w) => w.kind !== 'item' && w.pn.toUpperCase() === keyword().toUpperCase());
    btn.textContent = on ? '🔔 已加入库存价格监控' : '🔔 加入库存价格监控';
    btn.title = on ? '已在库存价格监控里，点击移出' : '把这个型号加入库存价格监控：定时检查货源对比里开着的网站，库存或价格有变化弹出电脑通知';
    btn.classList.toggle('on', on);
    btn.dataset.on = on ? '1' : '';
  }

  // ---------- 实时询价记录列表（货源条下方）：当前型号的询价，点 QQ 后立刻出现，可直接填报价 ----------
  // 和“询价记录本”页面是同一份数据，三个网站共用
  const LIVE_FOLD_KEY = 'liveListFolded';
  const LIVE_VALID_KEY = 'liveOnlyValid';
  const REC = window.ICMRecord;
  let liveLastTop = '';
  let liveDirty = false;
  let liveRecs = [];
  let liveTeamRecs = []; // 队友的记录（只读）
  let liveTeam = null;
  const livePending = new Map();
  const liveMember = (id) => { const m = liveTeam && (liveTeam.members || []).find((x) => x.id === id); return m ? m.name : '队友'; };

  function liveSave(id, patch, now) {
    const cur = livePending.get(id) || { patch: {} };
    Object.assign(cur.patch, patch);
    clearTimeout(cur.timer);
    livePending.set(id, cur);
    const go = () => { livePending.delete(id); send({ type: 'updateRecord', id, patch: cur.patch }); };
    if (now) go(); else cur.timer = setTimeout(go, 400);
  }
  const liveFlush = (id) => { const c = livePending.get(id); if (c) { clearTimeout(c.timer); livePending.delete(id); send({ type: 'updateRecord', id, patch: c.patch }); } };

  function liveBest() {
    let best = null;
    for (const r of liveRecs.concat(liveTeamRecs)) {
      if (!r.valid) continue;
      const p = REC.netPrice(r);
      if (p != null && (!best || p < best.p)) best = { id: r.id, p };
    }
    return best && best.id;
  }
  function liveMarks(box) {
    const bestId = liveBest();
    box.querySelectorAll('tr[data-id]').forEach((tr) => {
      const r = liveRecs.find((x) => x.id === tr.dataset.id) || liveTeamRecs.find((x) => x.id === tr.dataset.id);
      if (!r) return;
      tr.classList.toggle('valid', !!r.valid);
      tr.classList.toggle('best', r.id === bestId);
    });
    const n = box.querySelector('.icm-live-n');
    if (n) n.textContent = liveCount();
  }
  const liveCount = () => {
    const all = liveRecs.concat(liveTeamRecs);
    return `共 ${all.length} 条${liveTeam ? `（队友 ${liveTeamRecs.length} 条）` : ''}，有效报价 ${all.filter((r) => r.valid).length} 条`;
  };

  const liveQQ = (r) => (r.qq
    ? `<a href="javascript:;" class="icm-live-qq" data-a="qq" data-qq="${esc(r.qq)}" data-type="${r.qqType === 'enterprise' ? 'enterprise' : 'personal'}" title="${r.qqType === 'enterprise' ? '企业 QQ：点击复制并打开会话' : state.settings.personalQQ === 'open' ? '私人 QQ：点击复制并打开 QQ 聊天框（好友可直接聊）' : '私人 QQ：点击复制号码'}">${esc(r.qq)}</a>`
      + (r.qqType ? `<span class="icm-live-tag ${r.qqType === 'enterprise' ? 'ent' : ''}">${r.qqType === 'enterprise' ? '企业' : '私人'}</span>` : '')
    : '');

  const liveRecordOf = (company) => liveRecs.concat(liveTeamRecs).find((r) => r.company === company) || null;
  async function paintLive(force) {
    const box = document.getElementById('icm-live');
    if (!box) return;
    // 正在填写时不重画，等离开这个列表再刷新
    if (!force && box.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) { liveDirty = true; return; }
    liveDirty = false;
    try {
      const got = await chrome.storage.local.get(['inquiryLog', LIVE_FOLD_KEY, LIVE_VALID_KEY, 'team', 'teamLog']);
      const kw = keyword().toUpperCase();
      const mig = REC ? REC.migrate : (r) => r;
      const samePn = (r) => { const p = String(r.pn || '').toUpperCase(); return kw && (p === kw || p.startsWith(kw) || (kw.startsWith(p) && p.length >= 4)); };
      liveRecs = (got.inquiryLog || []).map(mig).filter(samePn);
      liveTeam = got.team || null;
      liveTeamRecs = liveTeam ? Object.values(got.teamLog || {}).map((r) => ({ ...mig(r), _by: r._by, _ro: true })).filter(samePn) : [];
      for (const r of liveRecs) { const p = livePending.get(r.id); if (p) Object.assign(r, p.patch); }
      const folded = !!got[LIVE_FOLD_KEY];
      const onlyValid = !!got[LIVE_VALID_KEY];
      const merged = liveTeamRecs.length ? liveRecs.concat(liveTeamRecs).sort((a, b) => b.time - a.time) : liveRecs;
      const list = onlyValid ? merged.filter((r) => r.valid) : merged;
      const t = (x) => { const d = new Date(x); const today = new Date().toDateString() === d.toDateString();
        return (today ? '' : `${d.getMonth() + 1}-${d.getDate()} `) + d.toTimeString().slice(0, 5); };
      const top = merged[0] ? merged[0].id + merged[0].time : '';
      const fresh = liveLastTop && top !== liveLastTop;
      liveLastTop = top;
      const bestId = liveBest();
      const goods = (REC && REC.GOODS) || ['原装', '散新', '翻新', '国产替代'];
      const inp = (r, f, cls, ph) => `<input class="${cls}" data-f="${f}" value="${esc(r[f])}" placeholder="${ph}" spellcheck="false" autocomplete="off">`;
      box.innerHTML = `<div class="icm-live-h">
          <b>📒 询价记录本 · 实时</b>
          <span class="icm-muted"><span class="icm-live-n">${liveCount()}</span> · 点 QQ 自动记到这里，报价直接在下面填</span>
          <span class="icm-grow"></span>
          <button type="button" class="icm-mini" data-live="tab" title="在新标签页打开完整的询价记录本">↗ 新标签页打开</button>
          <label class="icm-live-chk"><input type="checkbox" data-live="valid" ${onlyValid ? 'checked' : ''}> 只看有效报价</label>
          <button type="button" class="icm-mini" data-live="fold">${folded ? '展开 ▾' : '收起 ▴'}</button>
        </div>
        ${folded ? '' : list.length ? `<div class="icm-live-list"><table>
          <thead><tr><th>时间</th><th>公司名</th><th>QQ</th><th>型号</th><th>品牌</th><th>批次</th>
            <th class="fill">数量</th><th class="fill">价格</th><th class="fill">货品</th><th class="fill">货期</th><th>操作</th></tr></thead>
          <tbody>${list.slice(0, 50).map((r, i) => r._ro ? `<tr data-id="${esc(r.id)}" class="ro ${r.valid ? 'valid' : ''} ${r.id === bestId ? 'best' : ''} ${i === 0 && fresh ? 'fresh' : ''}">
            <td>${t(r.time)}</td><td class="co" data-co="${esc(r.company)}">${esc(r.company || '-')}</td>
            <td>${liveQQ(r)}</td>
            <td>${esc(r.pn)}</td><td>${esc(r.brand || '')}</td><td>${esc(r.batch || '')}</td>
            <td>${esc(r.qty || '')}</td>
            <td class="pr">${r.price !== '' && r.price != null ? `<b>¥${esc(r.price)}</b> <span class="icm-muted">${esc(r.tax)}</span>` : '<span class="icm-muted">未报价</span>'}<span class="icm-live-best">最低</span></td>
            <td>${r.price !== '' && r.price != null ? esc(r.goods) : ''}</td><td>${r.price !== '' && r.price != null ? esc(r.lead) : ''}</td>
            <td class="ops"><span class="icm-live-who" title="队友的记录，只能看">👤 ${esc(liveMember(r._by))}</span>${r.valid ? ' <span class="icm-live-okmark">✓</span>' : ''}</td></tr>` : `<tr data-id="${esc(r.id)}" class="${r.valid ? 'valid' : ''} ${r.id === bestId ? 'best' : ''} ${i === 0 && fresh ? 'fresh' : ''}">
            <td>${t(r.time)}</td><td class="co" data-co="${esc(r.company)}">${esc(r.company || '-')}</td>
            <td>${liveQQ(r)}</td>
            <td>${esc(r.pn)}</td><td>${esc(r.brand || '')}</td><td>${esc(r.batch || '')}</td>
            <td>${inp(r, 'qty', 'w-qty', '数量')}</td>
            <td class="pr">${inp(r, 'price', 'w-pr', '单价')}<button type="button" class="icm-live-tax ${r.tax === '含税' ? 't1' : 't0'}" data-a="tax" tabindex="-1" title="点击切换未税 / 含税">${r.tax === '含税' ? '含税' : '未税'}</button><span class="icm-live-best">最低</span></td>
            <td><select data-f="goods">${goods.map((g) => `<option ${g === r.goods ? 'selected' : ''}>${g}</option>`).join('')}</select></td>
            <td>${inp(r, 'lead', 'w-ld', '货期')}</td>
            <td class="ops"><button type="button" class="icm-live-ok" data-a="ok" tabindex="-1" title="有货，标记为有效报价（再点一次取消）">✓</button><button type="button" class="icm-live-reset" data-a="reset" tabindex="-1" title="把数量、价格、货品、货期恢复默认，不删除这一行">清除</button><button type="button" class="icm-live-del" data-a="del" tabindex="-1" title="删除这一行（点两次）">🗑</button></td></tr>`).join('')}</tbody></table></div>`
          : `<div class="icm-live-empty icm-muted">${onlyValid && liveRecs.length ? '这个型号还没有有效报价。' : '还没有这个型号的询价记录。点下面公司的 QQ 图标，就会实时出现在这里。'}</div>`}`;
      bindLive(box);
    } catch (e) {
      box.innerHTML = `<div class="icm-live-empty icm-muted">询价记录读取失败：${esc(e.message)}（请到 chrome://extensions 刷新插件后再刷新本页）</div>`;
      send({ type: 'dlog', cat: '记录本', msg: `${SITE_NAME} 实时列表出错：${e.message}`, level: 'error' });
    }
  }

  function bindLive(box) {
    if (box.dataset.bound) return;
    box.dataset.bound = '1';
    const recOf = (el) => { const tr = el.closest('tr[data-id]'); return tr ? liveRecs.find((r) => r.id === tr.dataset.id) : null; };
    const setF = (r, f, v) => {
      r[f] = v;
      const patch = { [f]: v };
      if (f === 'price' && r.valid && !String(v).trim()) { r.valid = false; r.validAt = 0; patch.valid = false; patch.validAt = 0; }
      liveSave(r.id, patch);
      liveMarks(box);
    };
    const confirmOk = (r, tr) => {
      if (r.valid) { r.valid = false; r.validAt = 0; liveSave(r.id, { valid: false, validAt: 0 }, true); liveMarks(box); return; }
      if (!REC || REC.netPrice(r) == null) { toast('请先填价格'); const p = tr.querySelector('[data-f=price]'); if (p) p.focus(); return; }
      r.valid = true; r.validAt = Date.now();
      liveSave(r.id, { valid: true, validAt: r.validAt, qty: r.qty, price: r.price, tax: r.tax, goods: r.goods, lead: r.lead }, true);
      liveMarks(box);
      toast(`已标记为有效报价：${r.company || ''} ¥${r.price} ${r.tax}`);
    };
    box.addEventListener('input', (e) => { const f = e.target.dataset.f; const r = f && recOf(e.target); if (r && e.target.tagName === 'INPUT') setF(r, f, e.target.value); });
    box.addEventListener('change', async (e) => {
      if (e.target.dataset.live === 'valid') { await chrome.storage.local.set({ [LIVE_VALID_KEY]: e.target.checked }); return; }
      const r = e.target.tagName === 'SELECT' && recOf(e.target);
      if (r) setF(r, e.target.dataset.f, e.target.value);
    });
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a], [data-live=fold], [data-live=tab]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.live === 'tab') { openRecordsTab(); return; }
      if (b.dataset.live === 'fold') { const { [LIVE_FOLD_KEY]: f } = await chrome.storage.local.get(LIVE_FOLD_KEY); await chrome.storage.local.set({ [LIVE_FOLD_KEY]: !f }); return; }
      if (b.dataset.a === 'qq') { handleQQ(b.dataset.qq, b.dataset.type, true); return; }
      const tr = b.closest('tr[data-id]');
      const r = recOf(b);
      if (!r) return;
      if (b.dataset.a === 'ok') confirmOk(r, tr);
      else if (b.dataset.a === 'tax') {
        const v = r.tax === '含税' ? '未税' : '含税';
        b.textContent = v; b.className = `icm-live-tax ${v === '含税' ? 't1' : 't0'}`;
        setF(r, 'tax', v);
      } else if (b.dataset.a === 'del') {
        // 点一次变成 ✅（3 秒内再点一次才删除），不弹确认框
        if (!b.classList.contains('armed')) {
          box.querySelectorAll('.icm-live-del.armed').forEach((x) => { x.classList.remove('armed'); x.textContent = '🗑'; });
          b.classList.add('armed');
          b.textContent = '✅';
          b.title = '再点一次删除';
          clearTimeout(b._t);
          b._t = setTimeout(() => { b.classList.remove('armed'); b.textContent = '🗑'; b.title = '删除这一行（点两次）'; }, 3000);
          return;
        }
        livePending.delete(r.id);
        liveRecs = liveRecs.filter((x) => x.id !== r.id);
        if (tr) tr.remove();
        liveMarks(box);
        send({ type: 'deleteRecord', id: r.id });
        toast('已删除这条记录');
      } else if (b.dataset.a === 'reset') {
        const d = { qty: '', price: '', tax: '未税', goods: '原装', lead: '现货', valid: false, validAt: 0 };
        Object.assign(r, d);
        liveSave(r.id, d, true);
        paintLive(true);
        toast('已清除这一行填写的内容');
      }
    });
    // 回车：价格格 = ✓，其他格跳到下一格；不让网站的表单提交 / 快捷键收到
    box.addEventListener('keydown', (e) => {
      const el = e.target;
      if (!el.dataset || !el.dataset.f) return;
      e.stopPropagation();
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const tr = el.closest('tr[data-id]');
      const r = recOf(el);
      if (el.dataset.f === 'price' && r) { liveFlush(r.id); confirmOk(r, tr); return; }
      const fs = [...tr.querySelectorAll('[data-f]')];
      const next = fs[fs.indexOf(el) + 1];
      if (next) { next.focus(); if (next.select) next.select(); }
    });
    box.addEventListener('keyup', (e) => { if (e.target.dataset && e.target.dataset.f) e.stopPropagation(); });
    box.addEventListener('keypress', (e) => { if (e.target.dataset && e.target.dataset.f) e.stopPropagation(); });
    box.addEventListener('focusout', (e) => {
      const r = e.target.dataset && e.target.dataset.f && recOf(e.target);
      if (r) liveFlush(r.id);
      setTimeout(() => { if (liveDirty && !box.contains(document.activeElement)) paintLive(true); }, 0);
    });
    // 公司名：鼠标停留显示网站自己的公司名片
    box.addEventListener('mouseover', (e) => {
      const td = e.target.closest && e.target.closest('td.co[data-co]');
      if (td && !td.contains(e.relatedTarget)) companyCardFor(td);
    });
    box.addEventListener('mouseout', (e) => {
      const td = e.target.closest && e.target.closest('td.co[data-co]');
      if (td && !td.contains(e.relatedTarget)) hideCardSoon();
    });
  }

  // 货源条插入位置：IC交易网在结果列表上方；正能量网在“云价格”表格上方
  function barAnchor() {
    if (SITE === 'ic') { const l = document.getElementById('resultList'); return l ? { parent: l.parentElement, before: l } : null; }
    if (SITE === 'hqew') { const t = [...document.querySelectorAll('table.list-table')].find((x) => x.querySelector('tr.ec-data')); const box = t && (t.parentElement.classList.contains('list') ? t.parentElement : t); return box ? { parent: box.parentElement, before: box } : null; }
    const a = document.getElementById('extStock_forms') || document.querySelector('.bomID_searchs_inner') || document.querySelector('article.bom_Merchant_list.stocks');
    return a ? { parent: a.parentElement, before: a } : null;
  }

  function ensureSourceBar() {
    if (!keyword()) return;
    const old = document.getElementById('icm-srcbar');
    if (old && old.isConnected) return;
    const at = barAnchor();
    if (!at) return;
    const bar = document.createElement('div');
    bar.id = 'icm-srcbar';
    bar.innerHTML = `
      <span class="icm-srcbar-t">货源对比</span><span class="icm-brand icm-muted"></span>
      <span class="icm-srcs"></span>
      <span class="icm-grow"></span>
      <span class="icm-srcset-wrap"><button type="button" class="icm-mini" id="icm-srcset" title="选择要对比的货源网站">⚙ 货源网站</button><div class="icm-srcset hidden" id="icm-srcset-menu"></div></span>
      <button type="button" class="icm-mini" id="icm-refresh" title="重新查询">⟳ 刷新</button>
      ${BUILD.watch === false ? '' : '<button type="button" class="icm-mini" id="icm-watch" title="把这个型号加入库存价格监控：定时检查货源对比里开着的网站，库存或价格有变化弹出电脑通知">🔔 加入库存价格监控</button><button type="button" class="icm-mini" id="icm-watchpage" title="打开库存价格监控页面：所有监控的型号和商品、下次检查时间、加入前后的库存和价格对比">📈 库存价格监控</button>'}
      <div class="icm-live" id="icm-live"></div>`;
    at.parent.insertBefore(bar, at.before);
    bar.querySelector('#icm-refresh').onclick = () => SITES.forEach(([k]) => { if (k !== 'ti' && (k === 'szlcsc' || state.settings.autoTabs || (srcState[k] && srcState[k].r))) querySource(k, true); });
    const menu = bar.querySelector('#icm-srcset-menu');
    const paintMenu = () => {
      menu.innerHTML = '<div class="icm-srcset-t">勾选要对比的网站</div>' + SITES.map(([k, n]) => `<label><input type="checkbox" data-src="${k}" ${srcOn(k) ? 'checked' : ''}> ${n}</label>`).join('')
        + '<div class="icm-muted">关掉的网站不显示、不查询，也不会打开后台标签页。三个网站共用这个设置。</div>';
    };
    bar.querySelector('#icm-srcset').onclick = (e) => { e.preventDefault(); e.stopPropagation(); paintMenu(); menu.classList.toggle('hidden'); };
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => menu.classList.add('hidden'));
    menu.addEventListener('change', async (e) => {
      const k = e.target.dataset.src;
      if (!k) return;
      await setSrcOn(k, e.target.checked);
      if (e.target.checked && k !== 'ti' && (k === 'szlcsc' || state.settings.autoTabs)) querySource(k);
      paintBar();
    });
    if (bar.querySelector('#icm-watch')) bar.querySelector('#icm-watch').onclick = async (e) => {
      const b = e.currentTarget;
      if (b.dataset.on) {
        await send({ type: 'removeWatch', pn: keyword() });
        toast('已移出库存价格监控');
      } else {
        // 只监控货源对比里开着的网站（立创、云汉、圣禾堂、贸泽、得捷；淘宝、TI 不在监控范围内）
        const sites = ['szlcsc', 'ickey', 'bomman', 'digikey', 'mouser'].filter((k) => srcOn(k));
        if (!sites.length) { toast('货源对比里没有开着的货源网站（立创、云汉、圣禾堂、贸泽、得捷），请先在“⚙ 货源网站”里勾选', 5000); return; }
        b.textContent = '🔔 正在记录当前库存和价格…';
        const r = await send({ type: 'addWatch', pn: keyword(), sites, from: SITE });
        const every = (m) => (m >= 1440 ? '每天' : m >= 60 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`);
        toast(r && r.ok ? (r.exists ? `${keyword()} 已经在库存价格监控里了` : `已加入库存价格监控：${every(r.minutes || 120)}检查一次 ${(r.sites || []).join('、')} 的 ${keyword()}，有变化弹出电脑通知。点“📈 库存价格监控”查看`) : (r && r.error) || '加入失败', 6000);
      }
      paintWatchBtn();
    };
    if (bar.querySelector('#icm-watchpage')) bar.querySelector('#icm-watchpage').onclick = () => send({ type: 'openWatch', pn: keyword() });
    paintBar();
    paintWatchBtn();
    paintLive();
    if (BUILD.team !== false && BUILD.server !== false) chrome.storage.local.get('team').then(({ team }) => { if (team) send({ type: 'teamSync', why: '打开搜索页' }); });
    querySource('szlcsc');
    if (state.settings.autoTabs) TAB_SITES.forEach((k) => querySource(k));
  }

  // ---------- 公司名片：一键复制（公司名、联系人、电话、手机、QQ、地址，分行） ----------
  function cardText(d) {
    const lines = [d.company];
    for (const c of d.contacts) lines.push(c.name ? `联系人：${c.name}　电话：${c.tel}` : `电话：${c.tel}`);
    if (d.mobiles.length) lines.push(`手机：${d.mobiles.join(' / ')}`);
    if (d.qqs.length) lines.push(`QQ：${d.qqs.join(' / ')}`);
    if (d.address) lines.push(`地址：${d.address}`);
    return lines.filter(Boolean).join('\n');
  }
  function addCopyButton(card, getData, inlineHost) {
    if (!card || card.querySelector('.icm-copycard')) return;
    if (!inlineHost && getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icm-copycard';
    b.textContent = '📋 一键复制';
    b.title = '复制公司名、联系人、电话、手机、地址';
    b.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      const d = getData();
      if (!d || !d.company) return toast('没有读到名片信息');
      await copy(cardText(d));
      toast('已复制名片信息');
      send({ type: 'dlog', cat: '名片', msg: `复制名片：${d.company}` });
    };
    if (inlineHost) { b.classList.add('inline'); inlineHost.appendChild(b); } else card.appendChild(b);
  }
  // IC交易网：名片里混有隐藏的假号码，只取显示出来的
  // 取元素文字，但不包含插件自己加的按钮
  const ownText = (el) => { const c = el.cloneNode(true); c.querySelectorAll('.icm-copycard').forEach((b) => b.remove()); return c.textContent; };
  function icCardData(layer) {
    const v = (sel) => [...layer.querySelectorAll(sel)].filter(visible);
    const company = (v('.layer_companyName').map((e) => ownText(e).trim()).find((t) => /公司|商行|经营部|厂/.test(t)) || '').trim();
    const contacts = v('.layer_contacts').map((li) => ({ tel: ((li.querySelector('.layer_telNumber') || {}).textContent || '').trim(), name: ((li.querySelector('.layer_contactName') || {}).textContent || '').trim() })).filter((c) => c.tel);
    const mobiles = [...new Set(v('.layer_otherContentphone').map((e) => e.textContent.trim()).filter(Boolean))];
    const addrLine = v('.layer_line').map((e) => e.innerText).find((t) => /地址/.test(t)) || '';
    return { company, contacts, mobiles, qqs: [], address: addrLine.replace(/^[\s\S]*?地址[:：]\s*/, '').replace(/\s+/g, ' ').trim() };
  }
  // 通用：按名片上显示的文字解析（正能量网）
  function textCardData(el) {
    const t = (el.innerText || '').replace(/📋\s*一键复制/g, '');
    const company = (t.split('\n').map((x) => x.trim()).find((x) => /有限公司|公司|商行|经营部/.test(x)) || '').replace(/\s*\d+年$/, '').trim();
    const telSec = (t.split(/Q\s*Q\s*[:：]/)[0] || t);
    const contacts = [];
    const mobiles = [];
    for (const m of telSec.matchAll(/(0\d{2,3}-?\d{7,8}|1[3-9]\d{9})\s*(?:[(（]首选[)）])?\s*([^\d\n(（]{0,8})/g)) {
      const name = m[2].replace(/[:：]/g, '').trim();
      if (/^1[3-9]\d{9}$/.test(m[1]) && !name) mobiles.push(m[1]);
      else contacts.push({ tel: m[1], name });
    }
    const qqSec = (t.split(/Q\s*Q\s*[:：]/)[1] || '').split(/员工|办公|库存|标签|客户评价/)[0];
    const qqs = [...new Set([...qqSec.matchAll(/\b([1-9]\d{4,10})\b/g)].map((m) => m[1]))];
    const address = ((t.match(/地址\s*[:：]\s*([^\n]+)/) || [])[1] || '').trim();
    return { company, contacts, mobiles, qqs, address };
  }
  function findBomCard() {
    // 名片是悬停时弹出的浮层：可见、定位为绝对/固定、包含“电话”
    let best = null;
    for (const el of document.querySelectorAll('div, section, aside')) {
      if (el.closest('#icm-pop, #icm-panel, #icm-srcbar, #icm-cardpop, #icm-drawer')) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 120) continue;
      const t = el.innerText || '';
      if (!/电话/.test(t) || !/公司/.test(t)) continue;
      const area = r.width * r.height;
      if (!best || area < best.area) best = { el, area };
    }
    return best && best.el;
  }
  let cardTimer;
  document.addEventListener('mouseover', () => {
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => {
      if (SITE === 'ic') {
        for (const layer of document.querySelectorAll('.detailLayer')) {
          if (!visible(layer)) continue;
          // 按钮放在公司名旁边（名片标题栏里）
          const nameEl = [...layer.querySelectorAll('.layer_companyName')].filter(visible).find((e) => /公司|商行|经营部|厂/.test(e.textContent));
          addCopyButton(layer, () => icCardData(layer), nameEl);
        }
      } else if (SITE === 'hqew') {
        const card = document.getElementById('card');
        if (card && visible(card)) addCopyButton(card, () => hqewCardData(card), card.querySelector('h3 .r-box'));
      } else {
        const card = findBomCard();
        if (card) addCopyButton(card, () => textCardData(card));
      }
      if (SITE === 'bom') fixFaintText();
    }, 250);
  }, true);

  // 华强电子网名片：手机号是网站加密的图片，读不到文字，只复制能读到的
  function hqewCardData(card) {
    const txt = (sel) => { const e = card.querySelector(sel); return e ? ownText(e).replace(/\s+/g, ' ').trim() : ''; };
    const tels = [...card.querySelectorAll('#phone_new .def-tels, #phone_new b')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const uniq = [...new Set(tels.length ? tels.filter((t, i, arr) => !arr.some((o, j) => j !== i && o.includes(t) && o !== t)) : [txt('#phone_new')].filter(Boolean))];
    const mobiles = [...card.querySelectorAll('#mphone_new')].map((e) => e.textContent.replace(/\D/g, '')).filter((m) => /^1\d{10}$/.test(m));
    const qqs = [...new Set([...card.querySelectorAll('.qq-item[qq]')].map((e) => e.getAttribute('qq')).filter(Boolean))];
    return { company: txt('#name'), contacts: uniq.map((t) => ({ name: '', tel: t })), mobiles, qqs, address: txt('#address_new') };
  }

  // 正能量网深色模式：网站有些关键信息用很浅的灰色，反色后几乎变黑看不见，这里统一调深（反色后变亮）
  function fixFaintText() {
    if (!document.documentElement.classList.contains('icm-dark')) {
      document.querySelectorAll('[data-icm-faint]').forEach((el) => { el.style.removeProperty('color'); delete el.dataset.icmFaint; });
      return;
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.dataset.icmFaint || el.children.length > 2 || !el.firstChild || el.closest('#icm-srcbar')) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (!own) continue;
      const m = getComputedStyle(el).color.match(/\d+(\.\d+)?/g);
      if (!m) continue;
      const [r, g, b] = m.map(Number);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      if (lum > 0.72) { el.style.setProperty('color', '#3a3f4a', 'important'); el.dataset.icmFaint = '1'; }
    }
  }

  // ---------- 右侧浮动栏的“询价记录本”入口 + 半幅抽屉 ----------
  // IC交易网：把“价格”换成询价记录本（原来的只隐藏不删除）；华强电子网、正能量网：在右侧栏里加一项。
  // 入口放在网站自己的浮动栏里，网站的“隐藏”按钮收起浮动栏时，入口也跟着收起。
  const REC_ICON = '<span class="icm-rec-emoji">📒</span>'; // 和货源条“📒 询价记录本”同一个图标
  // 批量询价图标（用户提供的“电脑”图标）
  const BATCH_ICON = '<img class="icm-batch-ico" alt="" src="data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMTQ3MiAxMDI0IiB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiPjxwYXRoIGQ9Ik0xMDQ5LjQzMzkyNCA2ODcuMzU5MjM1YzAgNDguNDc2MjctMzYuNzI0NDQ3IDg3Ljc3MTQyOS04Mi4xNDAzNDcgODcuNzcxNDI4SDE3OC41NzQ4NjhDMTMzLjE1ODk2OSA3NzUuMTMwNjYzIDk2LjQzNDUyMiA3MzUuNzEzMDkgOTYuNDM0NTIyIDY4Ny4zNTkyMzVWMTA5LjkyODUxMmMwLTQ4LjQ3NjI3IDM2Ljg0Njg2Mi04Ny43NzE0MjkgODIuMTQwMzQ2LTg3Ljc3MTQyOWg3ODguNzE4NzA5YzQ1LjQxNTkgMCA4Mi4xNDAzNDcgMzkuMjk1MTU4IDgyLjE0MDM0NyA4Ny43NzE0Mjl2NTc3LjQzMDcyM3oiIGZpbGw9IiM1QUJGQzYiPjwvcGF0aD48cGF0aCBkPSJNODM5LjAwMjg0MiA5NzUuNjQ2MTQ1YzAgMTcuOTk0OTc5LTE3LjEzODA3NSAzMi40Mzk5MjgtMzguMTkzNDI1IDMyLjQzOTkyOEgyODQuNzA4NTJjLTIxLjA1NTM1IDAtMzguMTkzNDI1LTE0LjQ0NDk0OS0zOC4xOTM0MjUtMzIuNDM5OTI4IDAtMTcuODcyNTY0IDE3LjEzODA3NS0zMi40Mzk5MjggMzguMTkzNDI1LTMyLjQzOTkyOWg1MTYuMTAwODk3YzIxLjA1NTM1IDAgMzguMTkzNDI1IDE0LjU2NzM2NCAzOC4xOTM0MjUgMzIuNDM5OTI5eiIgZmlsbD0iI0VFQkYyRiI+PC9wYXRoPjxwYXRoIGQ9Ik0yOTYuNTgyNzU4IDQ3MS43ODY3M2MtNDMuMzM0ODQ4IDAtNzguNTkwMzE3LTM1LjI1NTQ2OS03OC41OTAzMTYtNzguNTkwMzE2czM1LjI1NTQ2OS03OC41OTAzMTcgNzguNTkwMzE2LTc4LjU5MDMxNyA3OC41OTAzMTcgMzUuMjU1NDY5IDc4LjU5MDMxNyA3OC41OTAzMTctMzUuMjU1NDY5IDc4LjU5MDMxNy03OC41OTAzMTcgNzguNTkwMzE2eiBtMC0xNDAuMTY0OTczYy0zMy45MDg5MDYgMC02MS41NzQ2NTYgMjcuNjY1NzUtNjEuNTc0NjU2IDYxLjU3NDY1N3MyNy42NjU3NSA2MS41NzQ2NTYgNjEuNTc0NjU2IDYxLjU3NDY1NiA2MS41NzQ2NTYtMjcuNjY1NzUgNjEuNTc0NjU3LTYxLjU3NDY1Ni0yNy42NjU3NS02MS41NzQ2NTYtNjEuNTc0NjU3LTYxLjU3NDY1N3pNNTM5LjU3NjE4MyA0NzEuNzg2NzNjLTQzLjMzNDg0OCAwLTc4LjU5MDMxNy0zNS4yNTU0NjktNzguNTkwMzE2LTc4LjU5MDMxNnMzNS4yNTU0NjktNzguNTkwMzE3IDc4LjU5MDMxNi03OC41OTAzMTcgNzguNTkwMzE3IDM1LjI1NTQ2OSA3OC41OTAzMTcgNzguNTkwMzE3LTM1LjI1NTQ2OSA3OC41OTAzMTctNzguNTkwMzE3IDc4LjU5MDMxNnogbTAtMTQwLjE2NDk3M2MtMzMuOTA4OTA2IDAtNjEuNTc0NjU2IDI3LjY2NTc1LTYxLjU3NDY1NiA2MS41NzQ2NTdzMjcuNjY1NzUgNjEuNTc0NjU2IDYxLjU3NDY1NiA2MS41NzQ2NTYgNjEuNTc0NjU2LTI3LjY2NTc1IDYxLjU3NDY1Ny02MS41NzQ2NTYtMjcuNTQzMzM1LTYxLjU3NDY1Ni02MS41NzQ2NTctNjEuNTc0NjU3ek03ODIuNTY5NjA4IDQ3MS43ODY3M2MtNDMuMzM0ODQ4IDAtNzguNTkwMzE3LTM1LjI1NTQ2OS03OC41OTAzMTctNzguNTkwMzE2czM1LjI1NTQ2OS03OC41OTAzMTcgNzguNTkwMzE3LTc4LjU5MDMxNyA3OC41OTAzMTcgMzUuMjU1NDY5IDc4LjU5MDMxNyA3OC41OTAzMTctMzUuMjU1NDY5IDc4LjU5MDMxNy03OC41OTAzMTcgNzguNTkwMzE2eiBtMC0xNDAuMTY0OTczYy0zMy45MDg5MDYgMC02MS41NzQ2NTYgMjcuNjY1NzUtNjEuNTc0NjU2IDYxLjU3NDY1N3MyNy42NjU3NSA2MS41NzQ2NTYgNjEuNTc0NjU2IDYxLjU3NDY1NiA2MS41NzQ2NTYtMjcuNjY1NzUgNjEuNTc0NjU3LTYxLjU3NDY1Ni0yNy41NDMzMzUtNjEuNTc0NjU2LTYxLjU3NDY1Ny02MS41NzQ2NTd6IiBmaWxsPSIjMDcwNjA2Ij48L3BhdGg+PHBhdGggZD0iTTYwNC43MDA4NjkgMzkzLjE5NjQxNGMwIDM1Ljk4OTk1OC0yOS4xMzQ3MjggNjUuMTI0Njg2LTY1LjEyNDY4NiA2NS4xMjQ2ODYtMzUuOTg5OTU4IDAtNjUuMTI0Njg2LTI5LjEzNDcyOC02NS4xMjQ2ODYtNjUuMTI0Njg2IDAtMzUuOTg5OTU4IDI5LjEzNDcyOC02NS4xMjQ2ODYgNjUuMTI0Njg2LTY1LjEyNDY4NyAzNS45ODk5NTggMCA2NS4xMjQ2ODYgMjkuMTM0NzI4IDY1LjEyNDY4NiA2NS4xMjQ2ODd6TTg0Ny42OTQyOTQgMzkzLjE5NjQxNGMwIDM1Ljk4OTk1OC0yOS4xMzQ3MjggNjUuMTI0Njg2LTY1LjEyNDY4NiA2NS4xMjQ2ODYtMzUuOTg5OTU4IDAtNjUuMTI0Njg2LTI5LjEzNDcyOC02NS4xMjQ2ODYtNjUuMTI0Njg2IDAtMzUuOTg5OTU4IDI5LjEzNDcyOC02NS4xMjQ2ODYgNjUuMTI0Njg2LTY1LjEyNDY4NyAzNS45ODk5NTggMCA2NS4xMjQ2ODYgMjkuMTM0NzI4IDY1LjEyNDY4NiA2NS4xMjQ2ODd6TTM2MS43MDc0NDUgMzkzLjE5NjQxNGMwIDM1Ljk4OTk1OC0yOS4xMzQ3MjggNjUuMTI0Njg2LTY1LjEyNDY4NyA2NS4xMjQ2ODYtMzUuOTg5OTU4IDAtNjUuMTI0Njg2LTI5LjEzNDcyOC02NS4xMjQ2ODYtNjUuMTI0Njg2IDAtMzUuOTg5OTU4IDI5LjEzNDcyOC02NS4xMjQ2ODYgNjUuMTI0Njg2LTY1LjEyNDY4NyAzNS45ODk5NTggMCA2NS4xMjQ2ODYgMjkuMTM0NzI4IDY1LjEyNDY4NyA2NS4xMjQ2ODd6IiBmaWxsPSIjRUVCRjJGIj48L3BhdGg+PHBhdGggZD0iTTk3MC45NjYwMjIgMEgxMTUuNTMxMjM0Yy01NS4zMzE1IDAtMTAwLjM4MDE1NSA0NS4wNDg2NTUtMTAwLjM4MDE1NSAxMDAuMzgwMTU1djU4NS42MzI1MTdjMCA1NS4zMzE1IDQ1LjA0ODY1NSAxMDAuMzgwMTU1IDEwMC4zODAxNTUgMTAwLjM4MDE1NWgzOTEuNzI3NDM2Yy02Ljg1NTIzIDguMjAxNzkzLTExLjEzOTc0OSAxOC44NTE4ODMtMTEuMTM5NzQ5IDMwLjQ4MTI5MXY3Mi40Njk1NzZjMCAxMi45NzU5NzEgNS4yNjM4MzcgMjQuNzI3Nzk0IDEzLjcxMDQ2IDMzLjI5NjgzMkgyNzguMDk4MTJjLTI3LjkxMDU4IDAtNTAuNjc5NzM3IDIyLjc2OTE1Ny01MC42Nzk3MzcgNTAuNjc5NzM3czIyLjc2OTE1NyA1MC42Nzk3MzcgNTAuNjc5NzM3IDUwLjY3OTczN0g4MTAuMTEyOTQ0YzI3LjkxMDU4IDAgNTAuNjc5NzM3LTIyLjc2OTE1NyA1MC42Nzk3MzctNTAuNjc5NzM3cy0yMi43NjkxNTctNTAuNjc5NzM3LTUwLjY3OTczNy01MC42Nzk3MzdINTc3LjI3OTk0OWM4LjQ0NjYyMy04LjU2OTAzOCAxMy43MTA0Ni0yMC4zMjA4NjEgMTMuNzEwNDYtMzMuMjk2ODMydi03Mi40Njk1NzZjMC0xMS42Mjk0MDgtNC4xNjIxMDQtMjIuMTU3MDgzLTExLjEzOTc0OS0zMC40ODEyOTFoMzkxLjExNTM2MmM1NS4zMzE1IDAgMTAwLjM4MDE1NS00NS4wNDg2NTUgMTAwLjM4MDE1NS0xMDAuMzgwMTU1VjEwMC4zODAxNTVjMC01NS4zMzE1LTQ1LjA0ODY1NS0xMDAuMzgwMTU1LTEwMC4zODAxNTUtMTAwLjM4MDE1NXpNODM4LjE0NTkzOCA5NzMuMzIwMjYzYzAgMTUuNDI0MjY4LTEyLjYwODcyNyAyOC4wMzI5OTUtMjguMDMyOTk0IDI4LjAzMjk5NUgyNzguMDk4MTJjLTE1LjQyNDI2OCAwLTI4LjAzMjk5NS0xMi42MDg3MjctMjguMDMyOTk1LTI4LjAzMjk5NXMxMi42MDg3MjctMjguMDMyOTk1IDI4LjAzMjk5NS0yOC4wMzI5OTVIODEwLjExMjk0NGMxNS40MjQyNjgtMC4xMjI0MTUgMjguMDMyOTk1IDEyLjQ4NjMxMiAyOC4wMzI5OTQgMjguMDMyOTk1ek01MTguNzY1NjYzIDg4OS4zNDM2OTR2LTcyLjQ2OTU3NmMwLTEzLjcxMDQ2IDExLjEzOTc0OS0yNC43Mjc3OTQgMjQuNzI3Nzk1LTI0LjcyNzc5NHMyNC43Mjc3OTQgMTEuMTM5NzQ5IDI0LjcyNzc5NCAyNC43Mjc3OTR2NzIuNDY5NTc2YzAgMTMuNzEwNDYtMTEuMTM5NzQ5IDI0LjcyNzc5NC0yNC43Mjc3OTQgMjQuNzI3Nzk0cy0yNC43Mjc3OTQtMTEuMTM5NzQ5LTI0LjcyNzc5NS0yNC43Mjc3OTR6IG01MjkuOTMzNzcyLTIwMy4zMzEwMjJjMCA0Mi44NDUxODgtMzQuODg4MjI1IDc3LjczMzQxMy03Ny43MzM0MTMgNzcuNzMzNDEzSDExNS41MzEyMzRjLTQyLjg0NTE4OCAwLTc3LjczMzQxMy0zNC44ODgyMjUtNzcuNzMzNDEzLTc3LjczMzQxM1YxMDAuMzgwMTU1YzAtNDIuODQ1MTg4IDM0Ljg4ODIyNS03Ny43MzM0MTMgNzcuNzMzNDEzLTc3LjczMzQxM2g4NTUuNDM0Nzg4YzQyLjg0NTE4OCAwIDc3LjczMzQxMyAzNC44ODgyMjUgNzcuNzMzNDEzIDc3LjczMzQxM3Y1ODUuNjMyNTE3eiIgZmlsbD0iIzA3MDYwNiI+PC9wYXRoPjxwYXRoIGQ9Ik02MzQuNjkyNTAxIDc2Mi44ODkxODFjLTAuMzY3MjQ0IDAuMTIyNDE1IDAgMCAwIDBsMzM2LjE1MTEwNiAxLjgzNjIyMmM0Mi4zNTU1MjktMi41NzA3MTEgODIuMTQwMzQ3LTM3LjA5MTY5MiA4Mi4xNDAzNDctODIuNzUyNDJWMjU5Ljc2NDI1NmMwIDI1My41MjExLTE3Ni41MjIxNzYgNDYyLjM2MDc4OS00MTguMjkxNDUzIDUwMy4xMjQ5MjV6IiBmaWxsPSIjMkJBNUE1Ij48L3BhdGg+PC9zdmc+">';
  // 右侧栏入口的点击在 window 捕获阶段最先处理，网站自己的点击 / 拦截代码拦不住
  const sideActs = new WeakMap();
  const sideClick = (el, fn) => { sideActs.set(el, fn); el.dataset.icmAct = '1'; };
  window.addEventListener('click', (e) => {
    const t = e.target && e.target.closest && e.target.closest('[data-icm-act]');
    const fn = t && sideActs.get(t);
    if (!fn) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try { fn(); } catch (err) { toast('打开失败：' + (err && err.message || err)); send({ type: 'dlog', cat: SITE_NAME, msg: '右侧栏点击出错：' + (err && err.message || err) }); }
  }, true);
  // 浮动栏里只留下插件的两项：把其它项（和它们所在的层级）都隐藏，不删除
  function isolateSide(container, keep) {
    const keepSet = new Set();
    for (const k of keep) for (let n = k; n && n !== container; n = n.parentElement) keepSet.add(n);
    for (const n of keepSet) {
      for (const sib of n.parentElement ? n.parentElement.children : []) {
        if (keepSet.has(sib) || /^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) continue;
        sib.classList.add('icm-sidehide');
      }
    }
    container.classList.add('icm-sideonly');
  }
  function ensureSideEntry() {
    // 只在搜索结果页改右侧浮动栏；首页和其它页面保持网站原样
    if (!keyword()) return;
    const showBatch = BUILD.batch !== false;
    if (SITE === 'ic') {
      const nav = document.getElementById('floatNav');
      if (!nav) return;
      let rec = nav.querySelector('.icm-recnavdiv');
      if (!rec) {
        const ref = nav.querySelector('.navDiv');
        if (!ref) return;
        rec = document.createElement('div');
        rec.className = 'navDiv icm-recnavdiv';
        rec.innerHTML = `<a class="navA icm-recnav" title="芯标注 · 询价记录本（在下半屏打开）"><span class="icm-recicon">${REC_ICON}</span><span class="fixedText">询价<br>记录本</span></a>`;
        sideClick(rec, () => toggleDrawer());
        ref.parentElement.insertBefore(rec, ref);
        if (showBatch) {
          const b = rec.cloneNode(true);
          b.classList.add('icm-batchnav');
          b.querySelector('a').title = '芯标注 · 批量询价（在每家公司后面打勾，或在面板里勾选）';
          b.querySelector('.icm-recicon').innerHTML = BATCH_ICON;
          b.querySelector('.fixedText').innerHTML = '批量<br>询价';
          sideClick(b, () => openPanel());
          ref.parentElement.insertBefore(b, rec);
        }
        send({ type: 'dlog', cat: 'IC交易网', msg: '右侧浮动栏只保留“批量询价”“询价记录本”' });
      }
      isolateSide(nav, [...nav.querySelectorAll('.icm-recnavdiv')]);
    } else if (SITE === 'hqew') {
      const ul = document.querySelector('#right-side-fixed .side-bar-main');
      if (!ul) return;
      if (!ul.querySelector('.icm-side')) {
        const li = document.createElement('li');
        li.className = 'bar-item icm-side';
        li.title = '芯标注 · 询价记录本（在下半屏打开）';
        li.innerHTML = `<div class="item-hr"></div><div class="item-con"><span class="icm-sideicon">${REC_ICON}</span><div class="name">询价<br>记录本</div></div>`;
        sideClick(li, () => toggleDrawer());
        ul.appendChild(li);
      }
      // 插件的“批量询价”放在最上面
      if (showBatch && !ul.querySelector('.icm-side-batch')) {
        const li = document.createElement('li');
        li.className = 'bar-item icm-side icm-side-batch';
        li.title = '芯标注 · 批量询价（在每家公司后面打勾，或用网站左边的勾选框）';
        li.innerHTML = `<div class="item-hr"></div><div class="item-con"><span class="icm-sideicon">${BATCH_ICON}</span><div class="name">批量<br>询价</div></div>`;
        sideClick(li, () => openPanel());
        ul.insertBefore(li, ul.querySelector('li.icm-side'));
      }
      // 网站自己的“批量”原样保留（点它显示每家公司左边的勾选框），放在询价记录本下面
      const pl = document.getElementById('right-fixed-piliang');
      const plLi = pl && pl.closest('li');
      if (plLi && !plLi.classList.contains('icm-keep')) { plLi.classList.add('icm-keep'); ul.appendChild(plLi); }
      isolateSide(ul.closest('#right-side-fixed') || ul, [...ul.querySelectorAll('.icm-side, .icm-keep')]);
    } else if (SITE === 'bom') {
      const bar = document.querySelector('#bartrigger .toptoolbar');
      if (!bar) return;
      if (!bar.querySelector('.icm-side')) {
        const mk = (cls, title, icon, label, fn) => {
          const d = document.createElement('div');
          d.className = 'navbar_default icm-side ' + cls;
          d.title = title;
          d.innerHTML = `<a href="javascript:;" class="a_view"><div class="iconbox"><span class="icm-sideicon">${icon}</span></div><div class="title">${label}</div></a>`;
          sideClick(d, fn);
          bar.appendChild(d);
        };
        if (showBatch) mk('icm-side-batch', '芯标注 · 批量询价（在每家公司后面打勾，或在面板里勾选）', BATCH_ICON, '批量<br>询价', () => openPanel());
        mk('icm-side-rec', '芯标注 · 询价记录本（在下半屏打开）', REC_ICON, '询价<br>记录本', () => toggleDrawer());
      }
      isolateSide(document.getElementById('bartrigger'), [...bar.querySelectorAll('.icm-side')]);
    }
  }

  // ---------- 每家公司后面的勾选框：询价（QQ）那一列的右边单独一列，三个网站都有 ----------
  // 勾中的公司，点“批量询价”时自动选上；批量询价面板开着时，页面上打勾 / 取消也会同步过去
  // 位置：按这一行 QQ 那一格的右边缘定位（同一张表的列宽一致，所以上下对齐），垂直居中，不挤占网站的格子
  function qqCellOf(row, icon) {
    let n = icon;
    while (n && n.parentElement && n.parentElement !== row) n = n.parentElement;
    return n && n.parentElement === row ? n : icon.parentElement;
  }
  // QQ 那一格里实际显示的内容（图标、购买按钮等）的最右边
  function qqContentRight(row) {
    const icons = visibleQQIcons(row);
    if (!icons.length) return 0;
    const cell = qqCellOf(row, icons[icons.length - 1]);
    let right = 0;
    for (const el of [cell, ...cell.querySelectorAll('*')]) {
      if (el.closest('.icm-pick') || (el !== cell && el.children.length && !/^(A|IMG|BUTTON|I|SVG)$/i.test(el.tagName))) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      if (el === cell) { if (!cell.children.length) right = Math.max(right, r.right); continue; }
      right = Math.max(right, r.right);
    }
    return right;
  }
  function clippedAt(el, x) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).overflowX !== 'visible' && x > n.getBoundingClientRect().right) return true;
    }
    return x > document.documentElement.clientWidth;
  }
  function ensureRowPicks() {
    if (BUILD.batch === false || !keyword()) return;
    const groups = new Map(); // 同一张表（同一个父元素）的行放一组，勾选框对齐成一列
    for (const row of document.querySelectorAll(ADAPTER.rowSel)) {
      let lab = row.querySelector(':scope > .icm-pick');
      if (!lab) {
        if (!visibleQQIcons(row).length || !companyOfRow(row)) continue;
        lab = document.createElement('label');
        lab.className = 'icm-pick';
        lab.title = '勾选后点右侧“批量询价”，这家公司会自动选上';
        lab.innerHTML = '<input type="checkbox" class="icm-pick-box">';
        if (getComputedStyle(row).position === 'static') row.style.position = 'relative';
        row.appendChild(lab);
      }
      if (!visible(row)) continue;
      const key = row.parentElement;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([row, lab]);
    }
    paintAskedPicks(false);
    for (const list of groups.values()) {
      let x = Math.max(...list.map(([row]) => qqContentRight(row))) + 8;
      if (x <= 8) continue;
      // 放到行外面会被网站裁掉时，退回到这一行最右边（行内）
      const row0 = list[0][0];
      const rr = row0.getBoundingClientRect();
      if (x + 22 > rr.right && clippedAt(row0, x + 22)) x = rr.right - 26;
      for (const [row, lab] of list) lab.style.left = `${Math.round(x - row.getBoundingClientRect().left)}px`;
    }
  }
  let pickResize;
  window.addEventListener('resize', () => { clearTimeout(pickResize); pickResize = setTimeout(ensureRowPicks, 200); });
  document.addEventListener('change', (e) => {
    const box = e.target;
    if (!box || box.type !== 'checkbox' || box.closest('#icm-panel, #icm-srcbar, #icm-drawer')) return;
    const row = box.closest(ADAPTER.rowSel);
    if (!row) return;
    const company = companyOfRow(row);
    const panel = document.getElementById('icm-panel');
    if (!company || !panel || panel.querySelector('#icm-choose.hidden')) return;
    const pick = [...panel.querySelectorAll('.icm-list input[type=checkbox]')].find((x) => x.dataset.co === company);
    if (pick && pick.checked !== box.checked) { pick.checked = box.checked; pick.dispatchEvent(new Event('change', { bubbles: true })); }
  }, true);

  // 下半屏面板：从底部弹出，显示完整的询价记录本页面，可以直接在里面填写、筛选、导出
  let drawer = null;
  // 在新标签页打开记录本：先让后台开；后台没响应时由页面直接打开（records.html 允许网页打开）
  async function openRecordsTab() {
    if (!alive()) return stale();
    const pn = keyword();
    const r = await send({ type: 'openRecords', pn });
    if (!r || !r.ok) window.open(chrome.runtime.getURL('records.html') + (pn ? '?pn=' + encodeURIComponent(pn) : ''), '_blank');
  }
  function toggleDrawer(force) {
    if (!alive()) return stale();
    const open = force !== undefined ? force : !(drawer && drawer.classList.contains('open'));
    if (!drawer) {
      if (!open) return;
      drawer = document.createElement('div');
      drawer.id = 'icm-drawer';
      drawer.innerHTML = `<div class="icm-drawer-mask"></div>
        <section class="icm-drawer-panel">
          <header><b>📒 询价记录本</b><span class="icm-drawer-pn"></span><span class="icm-grow"></span>
            <button type="button" data-d="tab" title="在新标签页打开">↗ 新标签页打开</button><button type="button" data-d="close" title="关闭（Esc）">✕</button></header>
          <iframe title="询价记录本"></iframe>
        </section>`;
      document.documentElement.appendChild(drawer);
      drawer.querySelector('.icm-drawer-mask').onclick = () => toggleDrawer(false);
      drawer.querySelector('[data-d=close]').onclick = () => toggleDrawer(false);
      drawer.querySelector('[data-d=tab]').onclick = () => { openRecordsTab(); toggleDrawer(false); };
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) toggleDrawer(false); });
    }
    if (open) {
      const pn = keyword();
      const f = drawer.querySelector('iframe');
      const want = chrome.runtime.getURL('records.html') + '?embed=1' + (pn ? '&pn=' + encodeURIComponent(pn) : '');
      if (!f.src) {
        f.onload = () => { f.dataset.ok = '1'; };
        f.src = want;
        setTimeout(() => {
          if (f.dataset.ok || !drawer.classList.contains('open')) return;
          const tip = document.createElement('div');
          tip.className = 'icm-drawer-tip';
          tip.innerHTML = '询价记录本没有加载出来（可能被网站拦截了）。<button type="button">↗ 在新标签页打开</button>';
          tip.querySelector('button').onclick = () => { openRecordsTab(); toggleDrawer(false); };
          f.before(tip);
          send({ type: 'dlog', cat: SITE_NAME, msg: '下半屏询价记录本 4 秒内没有加载出来' });
        }, 4000);
      }
      drawer.querySelector('.icm-drawer-pn').textContent = pn ? `当前型号 ${pn}` : '';
    }
    drawer.classList.toggle('open', open);
  }

  // ---------- 实时列表的公司名：显示网站自己的公司名片（原样复制过来，不做改动） ----------
  // 做法：在当前页面找到这家公司的那一行，让网站照常弹出名片，再把名片复制到公司名旁边显示
  const cardCache = new Map();
  let cardPop = null;
  let cardTimer2 = null;
  let cardSeq = 0;
  function companyEl(name) {
    if (SITE === 'ic') return [...document.querySelectorAll('li.stair_tr .result_supply a.result_goCompany')].find((a) => visible(a) && a.textContent.trim() === name);
    if (SITE === 'hqew') return document.querySelector(`tr.ec-data a.company[cname="${CSS.escape(name)}"]`);
    // 正能量网：名片挂在公司名链接 .tagscell a.tooltips 上（网站延迟约 0.5 秒才弹出）
    for (const a of document.querySelectorAll(`${ADAPTER.rowSel} .tagscell a.tooltips`)) {
      if (visible(a) && a.textContent.trim() === name) return a;
    }
    for (const row of document.querySelectorAll(ADAPTER.rowSel)) {
      if (!visible(row) || companyOfRow(row) !== name) continue;
      return row.querySelector('.tagscell a.tooltips') || [...row.querySelectorAll('a, span, p, div')].find((e) => e.children.length <= 1 && e.textContent.trim() === name && visible(e));
    }
    return null;
  }
  function siteCardFor(name) {
    const has = (el) => el && visible(el) && ownText(el).includes(name);
    if (SITE === 'ic') return [...document.querySelectorAll('.detailLayer')].find(has) || null;
    if (SITE === 'hqew') { const c = document.getElementById('card'); return has(c) ? c : null; }
    const c = [...document.querySelectorAll('aside.bomID_uc_box')].find(has);
    if (c) return c;
    const f = findBomCard();
    return has(f) ? f : null;
  }
  // 模拟鼠标移入 / 移出：和真实鼠标一样，mouseenter / mouseleave 要发给从行到公司名的每一层元素
  // （华强电子网的名片挂在公司名所在的格子上，IC交易网、正能量网挂在公司名链接上）
  function hoverChain(el) {
    const row = el.closest(ADAPTER.rowSel) || el.parentElement;
    const chain = [];
    for (let c = el; c && c !== row.parentElement; c = c.parentElement) chain.unshift(c);
    return chain;
  }
  function hoverIn(el) {
    const r = el.getBoundingClientRect();
    const o = { cancelable: true, view: window, clientX: r.left + 5, clientY: r.top + r.height / 2, relatedTarget: document.body };
    el.dispatchEvent(new MouseEvent('mouseover', { ...o, bubbles: true }));
    hoverChain(el).forEach((c) => c.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false })));
    el.dispatchEvent(new MouseEvent('mousemove', { ...o, bubbles: true }));
  }
  function hoverOut(el) {
    const r = el.getBoundingClientRect();
    const o = { cancelable: true, view: window, clientX: r.left + 5, clientY: r.top + r.height / 2, relatedTarget: document.body };
    el.dispatchEvent(new MouseEvent('mouseout', { ...o, bubbles: true }));
    hoverChain(el).reverse().forEach((c) => c.dispatchEvent(new MouseEvent('mouseleave', { ...o, bubbles: false })));
  }
  function placeCardPop(td) {
    const r = td.getBoundingClientRect();
    const b = document.body.getBoundingClientRect();
    cardPop.style.left = '0px';
    cardPop.style.top = '0px';
    const w = cardPop.offsetWidth, h = cardPop.offsetHeight;
    let x = Math.min(r.left, window.innerWidth - w - 12);
    let y = r.bottom + 6;
    if (y + h > window.innerHeight - 8 && r.top - h - 6 > 8) y = r.top - h - 6;
    cardPop.style.left = `${Math.max(8, x) - b.left}px`;
    cardPop.style.top = `${y - b.top}px`;
  }
  function showCardPop(td, html, node) {
    if (!cardPop) {
      cardPop = document.createElement('div');
      cardPop.id = 'icm-cardpop';
      cardPop.addEventListener('mouseenter', () => clearTimeout(cardTimer2));
      cardPop.addEventListener('mouseleave', () => hideCardSoon());
    }
    document.body.appendChild(cardPop);
    cardPop.innerHTML = html || '';
    // 顶部一条：一键复制公司信息（公司名、联系人、电话、手机、QQ、地址）
    const name = td.dataset.co || '';
    const tools = document.createElement('div');
    tools.className = 'icm-cardpop-tools';
    tools.innerHTML = `<span class="icm-cardpop-name">${esc(name)}</span><button type="button" class="icm-cardpop-copy">📋 一键复制公司信息</button>`;
    cardPop.prepend(tools);
    if (node) cardPop.appendChild(node);
    tools.querySelector('button').onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      let d = null;
      try { d = node ? (SITE === 'ic' ? icCardData(node) : SITE === 'hqew' ? hqewCardData(node) : textCardData(node)) : null; } catch {}
      if (!d || !d.company) d = { company: name, contacts: [], mobiles: [], qqs: [], address: '', ...(d || {}), ...(d && d.company ? {} : { company: name }) };
      const rec = liveRecordOf(name);
      if (rec && rec.qq && !d.qqs.includes(rec.qq)) d.qqs = [...d.qqs, rec.qq];
      const ok = await copy(cardText(d));
      const b = e.currentTarget || tools.querySelector('button');
      b.textContent = ok ? '✓ 已复制' : '✗ 复制失败';
      setTimeout(() => { b.textContent = '📋 一键复制公司信息'; }, 1600);
      send({ type: 'dlog', cat: '名片', msg: `复制名片：${d.company}` });
    };
    cardPop.classList.add('show');
    placeCardPop(td);
  }
  function hideCardSoon() {
    clearTimeout(cardTimer2);
    cardTimer2 = setTimeout(() => { if (cardPop) cardPop.classList.remove('show'); }, 250);
  }
  async function companyCardFor(td) {
    clearTimeout(cardTimer2);
    const name = td.dataset.co;
    if (!name) return;
    const seq = ++cardSeq;
    const cached = cardCache.get(name);
    if (cached) return showCardPop(td, '', cached.cloneNode(true));
    const el = companyEl(name);
    if (!el) {
      return showCardPop(td, `<div class="icm-cardpop-none"><b>${esc(name)}</b><div>这家公司不在当前页面的搜索结果里，读不到它的名片。<br>可以在${esc(SITE_NAME)}搜索这个型号或公司名后再看。</div></div>`);
    }
    showCardPop(td, `<div class="icm-cardpop-none"><b>${esc(name)}</b><div>正在读取名片…</div></div>`);
    hoverIn(el);
    let card = null;
    for (let i = 0; i < 25 && !card; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (seq !== cardSeq) return;
      card = siteCardFor(name);
    }
    if (!card) {
      hoverOut(el);
      return showCardPop(td, `<div class="icm-cardpop-none"><b>${esc(name)}</b><div>网站没有弹出这家公司的名片（可能需要登录）。</div></div>`);
    }
    const w = card.getBoundingClientRect().width;
    const clone = card.cloneNode(true);
    clone.querySelectorAll('.icm-copycard').forEach((x) => x.remove());
    clone.classList.add('icm-cardclone');
    clone.style.cssText += `;position:static!important;display:block!important;visibility:visible!important;opacity:1!important;transform:none!important;margin:0!important;left:auto!important;top:auto!important;width:${Math.round(w)}px;max-width:none;`;
    hoverOut(el);
    cardCache.set(name, clone.cloneNode(true));
    if (seq === cardSeq) showCardPop(td, '', clone);
  }

  // ---------- 渲染 ----------
  let timer;
  function render() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      applyAds();
      decorateCompanies();
      decorateQQ();
      if (loaded) ensureSourceBar(); // 设置读完再建货源条，免得把“自动查询”当成关闭
      ensureSideEntry();
      ensureRowPicks();
      if (SITE === 'bom') fixFaintText();
      if (!window.__icmLogged && document.querySelector(ADAPTER.rowSel)) {
        window.__icmLogged = true;
        const marked = document.querySelectorAll('[data-icm-status]').length;
        const ent = document.querySelectorAll('a.icm-qq-enterprise').length;
        const per = document.querySelectorAll('a.icm-qq-personal').length;
        send({ type: 'dlog', cat: SITE_NAME, msg: `打开页面 ${keyword() || location.pathname}：标注公司 ${marked} 处，企业 QQ ${ent} 个，私人 QQ ${per} 个${state.settings.hideAds ? '，已隐藏广告' : ''}` });
      }
    }, 200);
  }

  let loaded = false;
  async function load() {
    if (!alive()) return;
    const r = await chrome.storage.local.get(['data', 'settings', 'localQQ']);
    state = { data: r.data || null, settings: { ...SETTING_DEFAULTS, ...(r.settings || {}) }, localQQ: r.localQQ || {} };
    loaded = true;
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.data || changes.settings || changes.localQQ)) load();
    if (area === 'local' && changes.watches) paintWatchBtn();
    if (area === 'local' && (changes.inquiryLog || changes.liveListFolded || changes.liveOnlyValid || changes.teamLog || changes.team)) paintLive(!!(changes.liveListFolded || changes.liveOnlyValid));
  });
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === 'getContextTarget') reply(lastContext);
    if (msg.type === 'toast') { toast(msg.text); reply({}); }
  });
  new MutationObserver((muts) => {
    if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !(n.id || '').startsWith('icm-')))) render();
  }).observe(document.documentElement, { childList: true, subtree: true });

  load();
})();
