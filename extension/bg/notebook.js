// 芯标注 · 询价记录本 + 库存变化提醒（全部保存在本机，不上传）

const LOG_KEY = 'inquiryLog';
const LOG_MAX = 5000;
const WATCH_KEY = 'watches';
const WATCH_EVENTS_KEY = 'watchEvents';
const WATCH_MAX = 30;
const WATCH_MINUTES = 120;

// ---------- 询价记录 ----------
// 同一天 + 同一家公司 + 同一个型号只保留一行：再次点 QQ 只更新时间和自动记录的字段，不动用户填写的内容
let logQueue = Promise.resolve();
function appendLog(entry) {
  logQueue = logQueue.then(async () => {
    const { [LOG_KEY]: raw = [] } = await chrome.storage.local.get(LOG_KEY);
    const list = raw.map(ICMRecord.migrate);
    const fresh = ICMRecord.create(entry || {});
    const key = ICMRecord.dedupeKey(fresh);
    const i = fresh.company && fresh.pn ? list.findIndex((r) => ICMRecord.dedupeKey(r) === key) : -1;
    let item;
    if (i >= 0) {
      item = list.splice(i, 1)[0];
      const auto = ICMRecord.pickAuto(entry || {});
      for (const [k, v] of Object.entries(auto)) if (v) item[k] = v;
      if (!item.qty && fresh.qty) item.qty = fresh.qty;
      item.time = fresh.time;
      dlog('记录本', `更新询价记录（同一天同公司同型号）：${item.pn} · ${item.company}`, undefined, 'ok');
    } else {
      item = fresh;
      dlog('记录本', `新增询价记录：${item.pn} · ${item.company || '-'} · ${item.brand || '-'} · ${item.batch || '-'}`, undefined, 'ok');
    }
    list.unshift(item);
    if (list.length > LOG_MAX) list.length = LOG_MAX;
    await chrome.storage.local.set({ [LOG_KEY]: list });
    teamMarkDirty([item.id]);
    return item;
  });
  return logQueue;
}

// 记录本页面的修改（排队写入，避免和新记录同时写导致丢数据）
function patchLog(fn) {
  logQueue = logQueue.then(async () => {
    const { [LOG_KEY]: raw = [] } = await chrome.storage.local.get(LOG_KEY);
    const list = fn(raw.map(ICMRecord.migrate));
    await chrome.storage.local.set({ [LOG_KEY]: list });
    return { ok: true };
  });
  return logQueue;
}
const EDITABLE = ['company', 'qq', 'pn', 'brand', 'batch', 'qty', 'price', 'tax', 'goods', 'lead', 'valid', 'validAt', 'note'];
function updateRecord(id, patch) {
  teamMarkDirty([id]);
  return patchLog((list) => {
    const r = list.find((x) => x.id === id);
    if (r) for (const k of EDITABLE) if (patch && k in patch) r[k] = patch[k];
    return list;
  });
}

// ---------- 库存提醒 ----------
// 只查“⚙ 货源网站”里勾选的这 5 个货源网站：立创、云汉、圣禾堂、得捷、贸泽（每次检查时按当前勾选）
// 每个网站记下库存总数和货源条数，下次检查有变化就弹出系统通知，写明是哪个网站、从多少变成多少
const WATCH_SITES = ['szlcsc', 'ickey', 'bomman', 'digikey', 'mouser'];
const SITE_LABEL = { szlcsc: '立创商城', ickey: '云汉芯城', bomman: '圣禾堂', digikey: '得捷', mouser: '贸泽' };
const SRC_OFF_DEFAULT = ['mouser', 'digikey', 'taobao', 'ti'];
const WATCH_INTERVALS = [30, 60, 120, 240, 720, 1440]; // 分钟，可在弹窗里选
const fmtN = (n) => Number(n || 0).toLocaleString('zh-CN');

async function watchSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const off = settings.sources || {};
  const sites = WATCH_SITES.filter((k) => (off[k] === undefined ? !SRC_OFF_DEFAULT.includes(k) : off[k] !== false));
  const minutes = WATCH_INTERVALS.includes(Number(settings.watchMinutes)) ? Number(settings.watchMinutes) : WATCH_MINUTES;
  return { sites, minutes };
}

// 一个型号在各网站的当前情况：{ szlcsc: { stock, count, url }, ... }；查询失败的网站不记（避免误报）
async function snapshot(pn) {
  const { sites } = await watchSettings();
  const snap = {};
  for (const site of sites) {
    try {
      const r = await lookup(site, pn, { force: true });
      if (r && r.ok) snap[site] = { stock: Number(r.stock) || 0, count: Number(r.count) || 0, price: Number(r.minPrice) || 0, url: r.url || '' };
      else dlog('库存提醒', `${pn} · ${SITE_LABEL[site]}：${(r && r.error) || '查询失败'}，这次不比较`, undefined, 'warn');
    } catch (e) { dlog('库存提醒', `${pn} · ${SITE_LABEL[site]} 查询出错：${e.message}`, undefined, 'warn'); }
  }
  return snap;
}

// 比较一个网站前后两次：库存变多 / 变少 / 到货 / 卖完，最低价涨 / 降
const fmtP = (p) => '¥' + (p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(3) : p.toFixed(4)).replace(/\.?0+$/, '');
function diffSite(site, before, now) {
  if (!before || typeof before !== 'object' || !now) return null;
  const parts = [];
  const d = now.stock - before.stock;
  if (before.stock > 0 && now.stock === 0) parts.push(`卖完了（原库存 ${fmtN(before.stock)}）`);
  else if (before.stock === 0 && now.stock > 0) parts.push(`到货了，库存 ${fmtN(now.stock)}`);
  else if (d > 0) parts.push(`库存增加 ${fmtN(d)}：${fmtN(before.stock)} → ${fmtN(now.stock)}`);
  else if (d < 0) parts.push(`库存减少 ${fmtN(-d)}：${fmtN(before.stock)} → ${fmtN(now.stock)}`);
  // 价格：两次都有价格才比较（旧记录没有价格的不比较）
  if (before.price > 0 && now.price > 0 && Math.abs(now.price - before.price) / before.price >= 0.001) {
    const pct = ((now.price - before.price) / before.price * 100).toFixed(1).replace('-', '');
    parts.push(`最低价${now.price < before.price ? '降' : '涨'} ${pct}%：${fmtP(before.price)} → ${fmtP(now.price)}`);
  }
  if (!parts.length) return null;
  return { site, text: `${SITE_LABEL[site] || site}：${parts.join('；')}`, url: now.url };
}

function notifyWatch(pn, changes, test) {
  const nid = 'watch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  chrome.storage.session.set({ [nid]: changes[0].url || '' }).catch(() => {});
  chrome.notifications.create(nid, {
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: `${test ? '【模拟】' : ''}库存/价格变化：${pn}`,
    message: changes.map((c) => c.text).join('\n'),
    contextMessage: test ? '芯标注 · 这是模拟提醒，不是真实变化' : '芯标注 · 点击打开变化的网站',
    priority: 1,
  });
}

// 弹窗里的“模拟一次提醒”：用一个示例型号弹出一条和真实提醒一样格式的通知
function testNotify() {
  const pn = 'ICM-42688-P';
  notifyWatch(pn, [
    { text: '立创商城：库存减少 2,936：12,936 → 10,000；最低价降 4.6%：¥132.18 → ¥126', url: 'https://so.szlcsc.com/global.html?k=' + pn },
    { text: '云汉芯城：到货了，库存 813', url: '' },
    { text: '贸泽：最低价涨 2.1%：¥40.19 → ¥41.03', url: '' },
  ], true);
  dlog('库存提醒', '弹出了一条模拟提醒');
  return { ok: true };
}

let watchRunning = null;
async function checkWatches() {
  if (watchRunning) return watchRunning; // 同一时间只跑一次
  watchRunning = (async () => {
    const { [WATCH_KEY]: list = [] } = await chrome.storage.local.get(WATCH_KEY);
    if (!list.length) { dlog('库存提醒', '没有关注的型号，跳过检查'); return; }
    const { sites } = await watchSettings();
    dlog('库存提醒', `开始检查 ${list.length} 个关注型号（${sites.map((k) => SITE_LABEL[k]).join('、') || '没有勾选货源网站'}）`);
    const { [WATCH_EVENTS_KEY]: events = [] } = await chrome.storage.local.get(WATCH_EVENTS_KEY);
    for (const w of list) {
      const snap = await snapshot(w.pn);
      const last = w.last && typeof w.last === 'object' ? w.last : {};
      const changes = Object.keys(snap).map((k) => diffSite(k, last[k], snap[k])).filter(Boolean);
      dlog('库存提醒', `${w.pn}：${Object.entries(snap).map(([k, v]) => `${SITE_LABEL[k]} ${fmtN(v.stock)}`).join('，') || '没有取到数据'}${changes.length ? '（有变化）' : '（无变化）'}`, undefined, changes.length ? 'warn' : 'info');
      const next = {};
      for (const k of WATCH_SITES) if (snap[k]) next[k] = snap[k]; else if (last[k] && typeof last[k] === 'object') next[k] = last[k];
      w.last = next;
      w.lastCheck = Date.now();
      if (changes.length) {
        events.unshift({ pn: w.pn, time: Date.now(), changes: changes.map((c) => c.text), url: changes[0].url });
        notifyWatch(w.pn, changes);
      }
    }
    if (events.length > 200) events.length = 200;
    await chrome.storage.local.set({ [WATCH_KEY]: list, [WATCH_EVENTS_KEY]: events, watchLastRun: Date.now() });
  })().finally(() => { watchRunning = null; });
  return watchRunning;
}

async function addWatch(pn) {
  pn = String(pn || '').trim();
  if (!pn) return { ok: false, error: '型号为空' };
  const { [WATCH_KEY]: list = [] } = await chrome.storage.local.get(WATCH_KEY);
  if (list.some((w) => w.pn.toUpperCase() === pn.toUpperCase())) return { ok: true, exists: true };
  if (list.length >= WATCH_MAX) return { ok: false, error: `最多关注 ${WATCH_MAX} 个型号` };
  const { sites, minutes } = await watchSettings();
  if (!sites.length) return { ok: false, error: '没有勾选货源网站（立创、云汉、圣禾堂、得捷、贸泽），请先在“⚙ 货源网站”里勾选' };
  const w = { pn, addedAt: Date.now(), last: await snapshot(pn), lastCheck: Date.now() }; // 记下当前值，之后有变化才提醒
  list.push(w);
  await chrome.storage.local.set({ [WATCH_KEY]: list });
  dlog('库存提醒', `开始关注 ${pn}，当前：${Object.entries(w.last).map(([k, v]) => `${SITE_LABEL[k]} ${fmtN(v.stock)}`).join('，')}`, undefined, 'ok');
  return { ok: true, watch: w, minutes, sites: sites.map((k) => SITE_LABEL[k]) };
}

async function removeWatch(pn) {
  const { [WATCH_KEY]: list = [] } = await chrome.storage.local.get(WATCH_KEY);
  await chrome.storage.local.set({ [WATCH_KEY]: list.filter((w) => w.pn.toUpperCase() !== String(pn || '').trim().toUpperCase()) });
  return { ok: true };
}

chrome.notifications.onClicked.addListener(async (nid) => {
  if (!nid.startsWith('watch_')) return;
  const { [nid]: url } = await chrome.storage.session.get(nid).catch(() => ({}));
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(nid);
});

// 定时检查：间隔按设置；浏览器关着时不会检查，重新打开浏览器后如果已经超过间隔，1 分钟后补查一次
const WATCH_ON = !(self.ICM_BUILD && self.ICM_BUILD.watch === false);
async function scheduleWatch(catchUp) {
  if (!WATCH_ON) return chrome.alarms.clear('watch');
  const { minutes } = await watchSettings();
  const cur = await chrome.alarms.get('watch');
  if (!cur || cur.periodInMinutes !== minutes) chrome.alarms.create('watch', { periodInMinutes: minutes });
  if (catchUp) {
    const { watchLastRun = 0, [WATCH_KEY]: list = [] } = await chrome.storage.local.get(['watchLastRun', WATCH_KEY]);
    if (list.length && Date.now() - watchLastRun > minutes * 60e3) chrome.alarms.create('watchCatchUp', { delayInMinutes: 1 });
  }
}
chrome.alarms.onAlarm.addListener((a) => { if ((a.name === 'watch' || a.name === 'watchCatchUp') && WATCH_ON) checkWatches(); });
chrome.runtime.onInstalled.addListener(() => scheduleWatch(false));
chrome.runtime.onStartup.addListener(() => scheduleWatch(true));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.settings && (c.settings.oldValue || {}).watchMinutes !== (c.settings.newValue || {}).watchMinutes) scheduleWatch(false);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handlers = {
    logInquiry: () => appendLog(msg.entry),
    updateRecord: () => updateRecord(msg.id, msg.patch),
    deleteRecord: () => patchLog((list) => list.filter((x) => x.id !== msg.id)).then((r) => { dlog('记录本', '删除了一条询价记录'); teamMarkDirty([msg.id]); return r; }),
    clearRecords: () => { let ids = []; return patchLog((list) => { ids = list.map((x) => x.id); return []; }).then((r) => { dlog('记录本', '清空了询价记录', undefined, 'warn'); teamMarkDirty(ids); return r; }); },
    migrateRecords: () => patchLog((list) => list),
    addWatch: () => addWatch(msg.pn),
    removeWatch: () => removeWatch(msg.pn),
    checkWatchesNow: () => checkWatches().then(() => ({ ok: true })),
    watchTest: () => testNotify(),
    watchList: () => chrome.storage.local.get(WATCH_KEY).then((r) => ({ ok: true, pns: (r[WATCH_KEY] || []).map((w) => w.pn) })),
    openLogs: () => chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') }).then(() => ({ ok: true })),
    openAccounts: () => chrome.tabs.create({ url: chrome.runtime.getURL('accounts.html') }).then(() => ({ ok: true })),
    openRecords: () => chrome.tabs.create({ url: chrome.runtime.getURL('records.html') + (msg.pn ? '?pn=' + encodeURIComponent(msg.pn) : '') }).then(() => ({ ok: true })),
  };
  const h = handlers[msg.type];
  if (!h) return false;
  Promise.resolve(h()).then(reply);
  return true;
});
