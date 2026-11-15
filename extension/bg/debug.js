// 芯标注 · 调试日志：记录后台做的每一件事，在“日志”页面查看（只存本机）
const BG_BUILD = '0.10.2';
const DLOG_KEY = 'debugLog';
const DLOG_MAX = 800;
let dlogBuf = null;
let dlogTimer = null;

async function dlogLoad() {
  if (!dlogBuf) dlogBuf = (await chrome.storage.local.get(DLOG_KEY))[DLOG_KEY] || [];
  return dlogBuf;
}

// level: info / ok / warn / error；cat：模块名
function dlog(cat, msg, data, level = 'info') {
  const item = { t: Date.now(), cat, msg, level };
  if (data !== undefined) {
    try { item.data = JSON.parse(JSON.stringify(data)); } catch { item.data = String(data); }
  }
  dlogLoad().then((buf) => {
    buf.unshift(item);
    if (buf.length > DLOG_MAX) buf.length = DLOG_MAX;
    clearTimeout(dlogTimer);
    dlogTimer = setTimeout(() => chrome.storage.local.set({ [DLOG_KEY]: buf }), 300);
  });
}

// 记录收到的每条消息（来源页面 + 类型）
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type === 'dlog' || msg.type === 'ping' || msg.type === 'lookupWho' || msg.type === 'updateRecord') return false;
  const from = sender.tab ? new URL(sender.tab.url || 'about:blank').hostname : '插件页面';
  const brief = { ...msg };
  delete brief.type;
  for (const k of ['code', 'token']) if (k in brief) brief[k] = '（已隐藏）';
  dlog('消息', `${msg.type} ← ${from}`, Object.keys(brief).length ? brief : undefined);
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'ping') {
    reply({ build: BG_BUILD, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (msg && msg.type === 'dlog') {
    dlog(msg.cat || '页面', msg.msg, msg.data, msg.level);
    reply({});
    return false;
  }
  if (msg && msg.type === 'clearDebugLog') {
    dlogBuf = [];
    chrome.storage.local.set({ [DLOG_KEY]: [] }).then(() => reply({ ok: true }));
    return true;
  }
  return false;
});

self.addEventListener('error', (e) => dlog('错误', String(e.message || e), { file: e.filename, line: e.lineno }, 'error'));
self.addEventListener('unhandledrejection', (e) => dlog('错误', String((e.reason && e.reason.message) || e.reason), undefined, 'error'));
dlog('后台', `后台启动（版本 ${BG_BUILD}）`, undefined, 'ok');
