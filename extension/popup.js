const $ = (s) => document.querySelector(s);
// 内测版：隐藏关掉的功能
const BUILD = window.ICM_BUILD || {};
document.querySelectorAll('[data-need]').forEach((el) => { if (BUILD[el.dataset.need] === false || (el.dataset.need === 'team' && BUILD.server === false)) el.remove(); });
$('#title').textContent = chrome.runtime.getManifest().name;
if (BUILD.edition === 'beta') $('#subtitle').textContent = '内测版 · 免费';
const DEFAULTS = { apiBase: '', hideAds: true, qqCopy: true, autoTabs: true, darkMode: 'off', personalQQ: 'copy' };
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function render() {
  const { data, settings, lastSync, lastError, localQQ } = await chrome.storage.local.get(['data', 'settings', 'lastSync', 'lastError', 'localQQ']);
  const s = { ...DEFAULTS, ...(settings || {}) };
  const counts = { original: 0, avoid: 0, caution: 0 };
  Object.values((data && data.companies) || {}).forEach(([st]) => { counts[st] = (counts[st] || 0) + 1; });
  if (!$('#nOriginal')) return renderRest(s);
  $('#nOriginal').textContent = counts.original;
  $('#nAvoid').textContent = counts.avoid;
  $('#nCaution').textContent = counts.caution;
  $('#nQQ').textContent = Object.keys({ ...((data && data.qq) || {}), ...(localQQ || {}) }).length;
  $('#syncInfo').textContent = lastSync ? `已同步 v${data ? data.version : '-'} · ${new Date(lastSync).toLocaleString('zh-CN', { hour12: false })}` : '尚未同步';
  $('#syncErr').textContent = lastError ? `同步失败：${lastError}` : '';
  return renderRest(s);
}

async function renderRest(s) {
  $('#qqCopy').checked = s.qqCopy !== false;
  $('#personalQQ').value = s.personalQQ === 'open' ? 'open' : 'copy';
  $('#hideAds').checked = !!s.hideAds;
  if ($('#apiBase')) $('#apiBase').value = s.apiBase;
  $('#autoTabs').checked = !!s.autoTabs;
  $('#darkMode').value = s.darkMode || 'off';
  if ($('#watchMinutes')) $('#watchMinutes').value = String(s.watchMinutes || 120);
  document.querySelectorAll('[data-src]').forEach((c) => { const v = s.sources && s.sources[c.dataset.src]; c.checked = v === undefined ? !['mouser', 'digikey', 'taobao', 'ti'].includes(c.dataset.src) : v !== false; });
  const { inquiryLog = [], watches = [], watchEvents = [] } = await chrome.storage.local.get(['inquiryLog', 'watches', 'watchEvents']);
  $('#logCount').textContent = `目前 ${inquiryLog.length} 条。`;
  const t = (x) => (x ? new Date(x).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-');
  if (!$('#watchSum')) return;
  const a = await chrome.alarms.get('watch');
  $('#watchSum').textContent = watches.length ? `监控 ${watches.length} 条${a ? ` · 下次检查 ${t(a.scheduledTime)}` : ''}` : '还没有监控的商品';
  $('#watchEvents').innerHTML = watchEvents.slice(0, 2).map((e) => `<div class="muted" style="margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🔔 ${t(e.time)} <b style="color:#1d2230">${esc(e.pn)}</b>：${esc(e.changes.join('；'))}</div>`).join('');
}

async function saveSetting(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULTS, ...(settings || {}), ...patch } });
}

if ($('#syncBtn')) $('#syncBtn').onclick = async () => {
  $('#syncBtn').disabled = true;
  $('#syncBtn').textContent = '同步中…';
  await chrome.runtime.sendMessage({ type: 'sync' });
  $('#syncBtn').disabled = false;
  $('#syncBtn').textContent = '立即同步';
  render();
};
$('#qqCopy').onchange = (e) => saveSetting({ qqCopy: e.target.checked });
$('#personalQQ').onchange = (e) => saveSetting({ personalQQ: e.target.value });
$('#hideAds').onchange = (e) => saveSetting({ hideAds: e.target.checked });
if ($('#apiSave')) $('#apiSave').onclick = async () => {
  const v = $('#apiBase').value.trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(v)) { $('#apiSaved').textContent = '地址要以 http(s):// 开头'; return; }
  await saveSetting({ apiBase: v });
  await chrome.storage.local.remove('data');
  $('#apiSaved').textContent = '已保存，正在重新同步…';
  await chrome.runtime.sendMessage({ type: 'sync' });
  $('#apiSaved').textContent = '已保存';
  render();
};
$('#darkMode').onchange = (e) => saveSetting({ darkMode: e.target.value });
$('#autoTabs').onchange = (e) => saveSetting({ autoTabs: e.target.checked });
if ($('#watchMinutes')) $('#watchMinutes').onchange = (e) => saveSetting({ watchMinutes: Number(e.target.value) });
document.querySelectorAll('[data-src]').forEach((c) => (c.onchange = async () => {
  const { settings } = await chrome.storage.local.get('settings');
  saveSetting({ sources: { ...((settings && settings.sources) || {}), [c.dataset.src]: c.checked } });
}));
$('#recordsBtn').onclick = () => chrome.runtime.sendMessage({ type: 'openRecords' }).then((r) => { if (!r) chrome.tabs.create({ url: chrome.runtime.getURL('records.html') }); });
if ($('#testNotify')) $('#testNotify').onclick = (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'watchTest' }); };
if ($('#watchPage')) $('#watchPage').onclick = () => chrome.runtime.sendMessage({ type: 'openWatch' }).then((r) => { if (!r) chrome.tabs.create({ url: chrome.runtime.getURL('watch.html') }); });
if ($('#checkNow')) $('#checkNow').onclick = async () => { $('#checkNow').disabled = true; $('#checkNow').textContent = '检查中…'; const { watches = [] } = await chrome.storage.local.get('watches'); if (!watches.length) { $('#checkNow').disabled = false; $('#checkNow').textContent = '立即检查'; alert('还没有监控的商品。\n请在立创、云汉等商品旁点「🔔 监控」，或在三个网站的货源对比条上点「🔔 加入库存价格监控」。'); return; } await chrome.runtime.sendMessage({ type: 'checkWatchesNow' }); $('#checkNow').disabled = false; $('#checkNow').textContent = '立即检查'; render(); };
if ($('#logsBtn')) $('#logsBtn').onclick = () => chrome.runtime.sendMessage({ type: 'openLogs' }).then((r) => { if (!r) chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') }); });
$('#accountsBtn').onclick = () => chrome.runtime.sendMessage({ type: 'openAccounts' }).then((r) => { if (!r) chrome.tabs.create({ url: chrome.runtime.getURL('accounts.html') }); });
$('#openExt').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
// 版本自检：后台没刷新时提示用户
(async () => {
  const v = chrome.runtime.getManifest().version;
  $('#ver').textContent = 'v' + v;
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: 'ping' }); } catch { r = null; }
  if (!r || r.build !== v) $('#stale').classList.remove('hidden');
})();
if ($('#markBtn')) $('#markBtn').onclick = () => chrome.runtime.sendMessage({ type: 'openSubmit', mode: 'mark' });
if ($('#appealBtn')) $('#appealBtn').onclick = () => chrome.runtime.sendMessage({ type: 'openSubmit', mode: 'remove' });

render();

// 团队共享入口
if ($('#teamBtn')) {
  $('#teamBtn').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('team.html') });
  chrome.storage.local.get(['team', 'teamLog']).then(({ team, teamLog = {} }) => {
    if (team) $('#teamState').textContent = `已加入“${team.name || '团队'}”，${(team.members || []).length} 人，队友记录 ${Object.keys(teamLog).length} 条`;
  });
}
