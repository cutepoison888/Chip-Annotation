// 芯标注 · 团队共享询价记录（端到端加密）
// 邀请码 → ① join_id（哈希，发给服务器用来找团队） ② AES 密钥（只在本机，用来加解密）
// 服务器只存密文：看不到团队名、昵称、公司、QQ、型号、价格。没有邀请码的人（包括服务器管理员）解不开。

// 内测版（不连服务器）没有团队功能
const TEAM_ON = !(self.ICM_BUILD && (self.ICM_BUILD.team === false || self.ICM_BUILD.server === false));
const TEAM_KEY = 'team';          // { code, teamId, memberId, token, role, name, myName, members, locked, lastRev, since, autoShare, lastSync, lastError }
const TEAM_LOG = 'teamLog';       // 队友的记录 { id: record }（解密后，只存本机）
const TEAM_DIRTY = 'teamDirty';   // 待上传的本人记录 { id: 1 }
const TEAM_ALARM = 'teamSync';
const TEAM_MINUTES = 5;
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉了 0 O 1 I，避免看错

let teamKeyCache = null; // { code, key }
let teamPushTimer = null;
let teamSyncing = null;
let teamLastSyncAt = 0;

// ---------- 邀请码与加密 ----------
function teamGenCode() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  const s = [...a].map((b) => CODE_CHARS[b % 32]).join('');
  return s.match(/.{4}/g).join('-');
}
function teamNormCode(code) {
  const s = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/I/g, '1');
  if (s.length !== 16 || [...s].some((c) => !CODE_CHARS.includes(c))) return '';
  return s.match(/.{4}/g).join('-');
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function teamJoinId(code) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('icmark-team-join-v1:' + code));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function teamKeyOf(code) {
  if (teamKeyCache && teamKeyCache.code === code) return teamKeyCache.key;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('icmark-team-key-v1'), iterations: 150000 },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  teamKeyCache = { code, key };
  return key;
}
async function teamEnc(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return b64u(iv) + '.' + b64u(ct);
}
async function teamDec(key, str) {
  const [iv, ct] = String(str || '').split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, key, unb64u(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------- 存储与接口 ----------
const teamGet = async () => (await chrome.storage.local.get(TEAM_KEY))[TEAM_KEY] || null;
const teamSet = (t) => chrome.storage.local.set({ [TEAM_KEY]: t });

async function teamApi(path, { method = 'GET', body, token } = {}) {
  const { apiBase } = await settings();
  const res = await fetch(apiBase.replace(/\/$/, '') + '/api/team' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `服务器返回 ${res.status}`);
    err.gone = !!data.gone;
    throw err;
  }
  return data;
}

// 不再属于团队：清掉本机的团队信息和队友记录（自己的记录不动）
async function teamForget(reason) {
  await chrome.storage.local.remove([TEAM_KEY, TEAM_LOG, TEAM_DIRTY]);
  teamKeyCache = null;
  chrome.alarms.clear(TEAM_ALARM);
  dlog('团队', `已退出团队：${reason}`, undefined, 'warn');
}

function teamShareable(t, r) {
  return t && t.autoShare !== false && r && (r.time || 0) >= (t.since || 0);
}

// 本人记录有变化：记下来，2 秒后统一上传
async function teamMarkDirty(ids) {
  if (!TEAM_ON) return;
  const t = await teamGet();
  if (!t || !ids || !ids.length) return;
  const { [TEAM_DIRTY]: dirty = {} } = await chrome.storage.local.get(TEAM_DIRTY);
  for (const id of ids) dirty[id] = 1;
  await chrome.storage.local.set({ [TEAM_DIRTY]: dirty });
  clearTimeout(teamPushTimer);
  teamPushTimer = setTimeout(() => teamSync('改动后上传').catch(() => {}), 2000);
}

async function teamPush(t, key) {
  const { [TEAM_DIRTY]: dirty = {}, inquiryLog = [] } = await chrome.storage.local.get([TEAM_DIRTY, 'inquiryLog']);
  const ids = Object.keys(dirty);
  if (!ids.length) return 0;
  const byId = new Map(inquiryLog.map((r) => [r.id, r]));
  let sent = 0;
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const records = [];
    for (const id of chunk) {
      const r = byId.get(id);
      if (r && teamShareable(t, r)) {
        const clean = { ...ICMRecord.migrate(r) };
        delete clean.text; // 询价话术不共享
        records.push({ id, data: await teamEnc(key, clean) });
      } else {
        records.push({ id, deleted: true }); // 本机删除了 / 不再共享
      }
    }
    await teamApi('/push', { method: 'POST', body: { records }, token: t.token });
    sent += records.length;
    const { [TEAM_DIRTY]: cur = {} } = await chrome.storage.local.get(TEAM_DIRTY);
    for (const id of chunk) delete cur[id];
    await chrome.storage.local.set({ [TEAM_DIRTY]: cur });
  }
  return sent;
}

async function teamPull(t, key) {
  const { [TEAM_LOG]: log = {} } = await chrome.storage.local.get(TEAM_LOG);
  let since = t.lastRev || 0;
  let got = 0;
  let info = null;
  for (let round = 0; round < 20; round++) {
    const d = await teamApi('/pull?since=' + since, { token: t.token });
    info = d;
    for (const x of d.records) {
      if (x.by === t.memberId) continue; // 自己的记录本机已有
      if (x.deleted) { delete log[x.id]; continue; }
      try {
        const r = await teamDec(key, x.data);
        log[x.id] = { ...r, id: x.id, _by: x.by, _rev: x.rev };
        got++;
      } catch { /* 解不开（可能被篡改），跳过 */ }
    }
    since = d.next;
    if (!d.more) break;
  }
  // 成员列表：解密昵称
  const members = [];
  for (const mb of info.members) {
    let name = '';
    try { name = await teamDec(key, mb.nameEnc); } catch { name = '（无法解密）'; }
    members.push({ id: mb.id, name, role: mb.role, joinedAt: mb.joinedAt, lastSeen: mb.lastSeen });
  }
  let teamName = t.name;
  try { teamName = await teamDec(key, info.team.nameEnc); } catch {}
  // 已被移出的成员，记录也清掉
  const alive = new Set(members.map((m) => m.id));
  for (const [id, r] of Object.entries(log)) if (!alive.has(r._by)) delete log[id];
  await chrome.storage.local.set({ [TEAM_LOG]: log });
  return { got, since, members, teamName, locked: info.team.locked, role: info.me.role };
}

// 同步：先上传自己的改动，再下载队友的记录
async function teamSync(why = '') {
  if (teamSyncing) return teamSyncing;
  teamSyncing = (async () => {
    const t = await teamGet();
    if (!t) return { ok: false, error: '还没有加入团队' };
    try {
      const key = await teamKeyOf(t.code);
      const sent = await teamPush(t, key);
      const p = await teamPull(t, key);
      const fresh = await teamGet();
      if (!fresh || fresh.teamId !== t.teamId) return { ok: false, error: '团队已变更' };
      Object.assign(fresh, { lastRev: p.since, members: p.members, name: p.teamName, locked: p.locked, role: p.role, lastSync: Date.now(), lastError: '' });
      await teamSet(fresh);
      teamLastSyncAt = Date.now();
      if (sent || p.got) dlog('团队', `同步完成${why ? '（' + why + '）' : ''}：上传 ${sent} 条，收到 ${p.got} 条`, undefined, 'ok');
      return { ok: true, sent, got: p.got };
    } catch (e) {
      if (e.gone) {
        await teamForget(e.message);
        chrome.notifications.create('team_gone_' + Date.now(), { type: 'basic', iconUrl: 'icons/128.png', title: '芯标注 · 团队共享', message: e.message });
        return { ok: false, error: e.message, gone: true };
      }
      const cur = await teamGet();
      if (cur) { cur.lastError = e.message; await teamSet(cur); }
      dlog('团队', `同步失败：${e.message}`, undefined, 'error');
      return { ok: false, error: e.message };
    }
  })();
  try { return await teamSyncing; } finally { teamSyncing = null; }
}

function teamStartAlarm() { chrome.alarms.create(TEAM_ALARM, { periodInMinutes: TEAM_MINUTES }); }

async function teamEnter(code, res, name, myName, shareOld) {
  const t = {
    code, teamId: res.teamId, memberId: res.memberId, token: res.token, role: res.role,
    name, myName, members: [], locked: false, lastRev: 0,
    since: shareOld ? 0 : Date.now(), autoShare: true, joinedAt: Date.now(), lastSync: 0, lastError: '',
  };
  await teamSet(t);
  await chrome.storage.local.set({ [TEAM_LOG]: {}, [TEAM_DIRTY]: {} });
  if (shareOld) {
    const { inquiryLog = [] } = await chrome.storage.local.get('inquiryLog');
    const dirty = {};
    for (const r of inquiryLog) dirty[r.id] = 1;
    await chrome.storage.local.set({ [TEAM_DIRTY]: dirty });
  }
  teamStartAlarm();
  return teamSync('加入后首次同步');
}

async function teamCreate({ teamName, myName, shareOld }) {
  teamName = String(teamName || '').trim().slice(0, 40);
  myName = String(myName || '').trim().slice(0, 20);
  if (!teamName || !myName) return { ok: false, error: '请填写团队名称和你的昵称' };
  if (await teamGet()) return { ok: false, error: '你已经在一个团队里了，请先退出' };
  const code = teamGenCode();
  const key = await teamKeyOf(code);
  const res = await teamApi('/create', { method: 'POST', body: { joinId: await teamJoinId(code), nameEnc: await teamEnc(key, teamName), memberNameEnc: await teamEnc(key, myName) } });
  dlog('团队', `创建了团队“${teamName}”`, undefined, 'ok');
  await teamEnter(code, res, teamName, myName, shareOld);
  return { ok: true, code };
}

async function teamJoin({ code, myName, shareOld }) {
  const c = teamNormCode(code);
  if (!c) return { ok: false, error: '邀请码格式不对：应该是 16 位，形如 ABCD-EFGH-JKLM-NPQR' };
  myName = String(myName || '').trim().slice(0, 20);
  if (!myName) return { ok: false, error: '请填写你的昵称（队友看到的名字）' };
  if (await teamGet()) return { ok: false, error: '你已经在一个团队里了，请先退出' };
  const key = await teamKeyOf(c);
  const res = await teamApi('/join', { method: 'POST', body: { joinId: await teamJoinId(c), memberNameEnc: await teamEnc(key, myName) } });
  let name = '';
  try { name = await teamDec(key, res.nameEnc); } catch {}
  dlog('团队', `加入了团队“${name}”`, undefined, 'ok');
  await teamEnter(c, res, name, myName, shareOld);
  return { ok: true };
}

async function teamOwnerCall(path, body) {
  const t = await teamGet();
  if (!t) return { ok: false, error: '还没有加入团队' };
  await teamApi(path, { method: 'POST', body, token: t.token });
  return { ok: true };
}

// 撤回：把我已经共享的记录从团队里删掉（本机保留），并停止自动共享
async function teamRecall() {
  const t = await teamGet();
  if (!t) return { ok: false, error: '还没有加入团队' };
  t.autoShare = false;
  await teamSet(t);
  const { inquiryLog = [] } = await chrome.storage.local.get('inquiryLog');
  const dirty = {};
  for (const r of inquiryLog) dirty[r.id] = 1;
  await chrome.storage.local.set({ [TEAM_DIRTY]: dirty });
  const r = await teamSync('撤回共享');
  dlog('团队', '撤回了我共享的全部记录，并关闭自动共享', undefined, 'warn');
  return r;
}

chrome.alarms.onAlarm.addListener((a) => { if (TEAM_ON && a.name === TEAM_ALARM) teamSync('定时').catch(() => {}); });
chrome.runtime.onStartup.addListener(async () => { if (await teamGet()) { teamStartAlarm(); teamSync('浏览器启动').catch(() => {}); } });
chrome.runtime.onInstalled.addListener(async () => { if (await teamGet()) teamStartAlarm(); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const t = msg && msg.type;
  const handlers = {
    teamCreate: () => teamCreate(msg),
    teamJoin: () => teamJoin(msg),
    // 页面打开时顺便同步一次（20 秒内不重复）
    teamSync: () => (msg.force || Date.now() - teamLastSyncAt > 20000 ? teamSync(msg.why || '页面请求') : Promise.resolve({ ok: true, skipped: true })),
    teamLeave: async () => { await teamSync('退出前上传').catch(() => {}); await teamOwnerCall('/leave'); await teamForget('自己退出'); return { ok: true }; },
    teamDisband: async () => { await teamOwnerCall('/disband'); await teamForget('解散了团队'); return { ok: true }; },
    teamKick: async () => { const r = await teamOwnerCall('/kick', { memberId: msg.memberId }); await teamSync('移出成员'); return r; },
    teamLock: async () => { const r = await teamOwnerCall('/lock', { locked: !!msg.locked }); await teamSync('修改加入设置'); return r; },
    teamRename: async () => { const cur = await teamGet(); const key = await teamKeyOf(cur.code); const r = await teamOwnerCall('/rename', { nameEnc: await teamEnc(key, String(msg.name || '').trim().slice(0, 40)) }); await teamSync('改团队名'); return r; },
    teamRenameMe: async () => { const cur = await teamGet(); const key = await teamKeyOf(cur.code); const name = String(msg.name || '').trim().slice(0, 20); const r = await teamOwnerCall('/rename-me', { nameEnc: await teamEnc(key, name) }); cur.myName = name; await teamSet(cur); await teamSync('改昵称'); return r; },
    teamSetShare: async () => { const cur = await teamGet(); if (!cur) return { ok: false }; cur.autoShare = !!msg.on; if (msg.on) cur.since = Date.now(); /* 重新打开后只共享之后的新记录 */ await teamSet(cur); return { ok: true }; },
    teamRecall: () => teamRecall(),
  };
  const h = handlers[t];
  if (!h) return false;
  if (!TEAM_ON) { reply({ ok: false, error: '这个版本没有团队共享功能' }); return false; }
  Promise.resolve().then(h).then(reply, (e) => reply({ ok: false, error: e.message || String(e) }));
  return true;
});
