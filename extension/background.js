importScripts('build.js', 'bg/debug.js', 'lib/record.js', 'bg/sources.js', 'bg/notebook.js', 'bg/team.js');

// 芯标注 · 后台：同步已审核名单、提交待审核内容、打开 QQ 会话、右键菜单
const DEFAULT_SETTINGS = { apiBase: '', hideAds: true, qqCopy: true, autoTabs: true, darkMode: 'off', personalQQ: 'copy' };
const SYNC_MINUTES = 60;

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

async function settings() {
  const { settings: s } = await get('settings');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

async function clientId() {
  let { clientId: id } = await get('clientId');
  if (!id) {
    id = crypto.randomUUID();
    await set({ clientId: id });
  }
  return id;
}

// ---------- 同步 ----------
const B = self.ICM_BUILD || {};
async function sync() {
  if (B.server === false) return { ok: true, offline: true };
  const s = await settings();
  const { data } = await get('data');
  const v = data && data.version ? data.version : 0;
  try {
    const res = await fetch(`${s.apiBase.replace(/\/$/, '')}/api/list?v=${v}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    dlog('同步', j.unchanged ? `名单没有变化（v${j.version}）` : `下载新名单 v${j.version}：公司 ${j.companies.length} 家，QQ ${j.qq.length} 个`, undefined, 'ok');
    if (!j.unchanged) {
      await set({
        data: {
          version: j.version,
          companies: Object.fromEntries(j.companies.map(([n, st, note]) => [n, [st, note]])),
          qq: Object.fromEntries(j.qq),
          config: j.config || {},
        },
      });
    }
    await set({ lastSync: Date.now(), lastError: '' });
    return { ok: true, version: j.version, unchanged: !!j.unchanged };
  } catch (e) {
    await set({ lastError: String(e.message || e) });
    dlog('同步', '同步失败：' + (e.message || e), { server: s.apiBase }, 'error');
    return { ok: false, error: String(e.message || e) };
  }
}

async function submit(payload) {
  if (B.server === false) return { ok: true, offline: true };
  const s = await settings();
  try {
    const res = await fetch(`${s.apiBase.replace(/\/$/, '')}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, clientId: await clientId() }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { dlog('提交', `提交被拒：${j.error || res.status}`, payload, 'warn'); return { ok: false, error: j.error || 'HTTP ' + res.status }; }
    dlog('提交', `已提交待审核：${payload.kind} ${payload.name}`, undefined, 'ok');
    return { ok: true, ...j };
  } catch (e) {
    dlog('提交', '无法连接服务器：' + (e.message || e), undefined, 'error');
    return { ok: false, error: '无法连接服务器：' + (e.message || e) };
  }
}

// 本人实测得到的 QQ 结果：本地立即生效，同时提交给管理员审核
async function recordQQ(qq, type, source = 'auto') {
  if (!/^[1-9]\d{4,11}$/.test(String(qq))) return;
  const { localQQ = {} } = await get('localQQ');
  if (localQQ[qq] === type && source === 'auto') return;
  localQQ[qq] = type;
  await set({ localQQ });
  dlog('QQ', `记录 QQ ${qq} 为${type === 'personal' ? '私人号' : '企业号'}（${source === 'auto' ? '跳转结果自动判断' : '手动标记'}）`, undefined, 'ok');
  await submit({ kind: 'qq', name: String(qq), status: type, source });
}

// ---------- 打开会话 ----------
const chatTabs = new Map(); // tabId -> qq

async function openChat(qq) {
  const url = `https://wpa.qq.com/msgrd?v=3&uin=${encodeURIComponent(qq)}&site=qq&menu=yes`;
  dlog('QQ', `打开 QQ 会话窗口：${qq}`);
  // 用前台小窗口打开：后台标签页里浏览器不会弹出“打开 QQ？”的提示
  const win = await chrome.windows.create({ url, type: 'popup', focused: true, width: 460, height: 360 });
  const tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
  if (tabId) {
    chatTabs.set(tabId, String(qq));
    await chrome.storage.session.set({ ['chat_' + tabId]: String(qq) }).catch(() => {});
  }
  return tabId;
}

async function qqForTab(tabId) {
  if (chatTabs.has(tabId)) return chatTabs.get(tabId);
  const k = 'chat_' + tabId;
  const r = await chrome.storage.session.get(k).catch(() => ({}));
  return r[k] || '';
}

// ---------- 消息 ----------
const MAIN_TYPES = ['sync', 'submit', 'openChat', 'chatOutcome', 'markQQ', 'openSubmit'];
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !MAIN_TYPES.includes(msg.type)) return false;
  (async () => {
    switch (msg.type) {
      case 'sync': return sync();
      case 'submit': return submit(msg.payload);
      case 'openChat': return { tabId: await openChat(msg.qq) };
      case 'chatOutcome': {
        // 来自企点跳转页：personal = 无法临时会话；enterprise = 可直接会话
        const tabId = sender.tab && sender.tab.id;
        const qq = msg.qq || (tabId ? await qqForTab(tabId) : '');
        if (qq) await recordQQ(qq, msg.outcome, 'auto');
        const ours = tabId && (await qqForTab(tabId));
        // 插件打开的企业会话页：等 QQ 被唤起后自动关闭，避免标签页堆积
        // 私人号的提示多留一会儿给用户看
        if (ours) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), msg.outcome === 'enterprise' ? 8000 : 15000);
        return { qq };
      }
      case 'markQQ': await recordQQ(msg.qq, msg.qqType, 'manual'); return { ok: true };
      case 'openSubmit': {
        const q = new URLSearchParams({ name: msg.name || '', mode: msg.mode || 'mark' });
        await chrome.windows.create({ url: chrome.runtime.getURL('submit.html?' + q), type: 'popup', width: 520, height: 680 });
        return { ok: true };
      }
    }
  })().then(reply);
  return true;
});

// ---------- 右键菜单 ----------
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    const docs = ['*://*.ic.net.cn/*', '*://*.bom.ai/*', '*://*.hqew.com/*'];
    chrome.contextMenus.create({ id: 'icm-root', title: '芯标注', contexts: ['all'], documentUrlPatterns: docs });
    if (B.submit !== false) {
      chrome.contextMenus.create({ id: 'icm-mark', parentId: 'icm-root', title: '标注这家公司（原装/避雷/注意）…', contexts: ['all'], documentUrlPatterns: docs });
      chrome.contextMenus.create({ id: 'icm-remove', parentId: 'icm-root', title: '申诉：这家公司标注有误…', contexts: ['all'], documentUrlPatterns: docs });
      chrome.contextMenus.create({ id: 'icm-sep', parentId: 'icm-root', type: 'separator', contexts: ['all'], documentUrlPatterns: docs });
    }
    chrome.contextMenus.create({ id: 'icm-qq-personal', parentId: 'icm-root', title: '这个 QQ 是私人号（需加好友）', contexts: ['all'], documentUrlPatterns: docs });
    chrome.contextMenus.create({ id: 'icm-qq-enterprise', parentId: 'icm-root', title: '这个 QQ 是企业号（可直接聊）', contexts: ['all'], documentUrlPatterns: docs });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const target = await chrome.tabs.sendMessage(tab.id, { type: 'getContextTarget' }).catch(() => ({}));
  const name = (info.selectionText || '').trim() || (target && target.company) || '';
  if (info.menuItemId === 'icm-mark' || info.menuItemId === 'icm-remove') {
    const q = new URLSearchParams({ name, mode: info.menuItemId === 'icm-remove' ? 'remove' : 'mark' });
    chrome.windows.create({ url: chrome.runtime.getURL('submit.html?' + q), type: 'popup', width: 520, height: 680 });
  } else if (info.menuItemId === 'icm-qq-personal' || info.menuItemId === 'icm-qq-enterprise') {
    const qq = target && target.qq;
    if (!qq) {
      chrome.tabs.sendMessage(tab.id, { type: 'toast', text: '请在 QQ 图标上点右键再选这一项' }).catch(() => {});
      return;
    }
    await recordQQ(qq, info.menuItemId === 'icm-qq-personal' ? 'personal' : 'enterprise', 'manual');
    chrome.tabs.sendMessage(tab.id, { type: 'toast', text: `已标记 QQ ${qq}，本机立即生效${B.server === false ? '' : '，已提交审核'}` }).catch(() => {});
  }
});

// ---------- 生命周期 ----------
chrome.runtime.onInstalled.addListener(async () => {
  const { settings: s } = await get('settings');
  if (!s) await set({ settings: DEFAULT_SETTINGS });
  await clientId();
  buildMenus();
  if (B.server !== false) { chrome.alarms.create('sync', { periodInMinutes: SYNC_MINUTES }); sync(); } else chrome.alarms.clear('sync');
});
chrome.runtime.onStartup.addListener(() => { buildMenus(); if (B.server !== false) sync(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') sync(); });
chrome.tabs.onRemoved.addListener((id) => { chatTabs.delete(id); chrome.storage.session.remove('chat_' + id).catch(() => {}); });
