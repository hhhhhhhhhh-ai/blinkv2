import { CONFIG } from './config.js';
import { pickMime } from './util.js';

export const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
export const MAX_GROUP_FRIENDS = 9;          // + you = 10 people
const BUCKET = 'snaps';
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const uid = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));
const nowIso = () => new Date().toISOString();
const pub = u => ({ id: u.id, username: u.username, display_name: u.display_name });
const pick = a => a[Math.floor(Math.random() * a.length)];
const between = (a, b) => a + Math.random() * (b - a);

/** Conversation keys: 'u:<userId>' for a 1-to-1 chat, 'g:<groupId>' for a group. */
const parseKey = k => ({ group: k.startsWith('g:'), id: k.slice(2) });

/** Last message, unread count and unopened snaps (oldest first) per conversation. `msgs` must be newest-first. */
export function summarize(msgs, meId) {
  const out = {};
  for (const m of msgs) {
    const key = m.group_id ? 'g:' + m.group_id : 'u:' + (m.sender === meId ? m.recipient : m.sender);
    const c = out[key] || (out[key] = { last: m, unread: 0, snaps: [] });
    if (m.recipient === meId) {
      const unread = m.kind === 'text' ? !m.read_at : !m.opened_at;
      if (unread) { c.unread++; if (m.kind !== 'text') c.snaps.push(m); }
    }
  }
  for (const c of Object.values(out)) c.snaps.reverse();
  return out;
}

export async function createBackend() {
  if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
    const { createClient } = await import(SUPABASE_CDN);
    return new LiveBackend(createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY));
  }
  return new DemoBackend();
}

const extFor = (kind, type) => (kind === 'image' ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : 'webm');
const typeFor = (kind, blob) => (kind === 'image' ? 'image/jpeg' : ((blob.type || '').split(';')[0] || 'video/webm'));

/* ════════════════════════════════════════════════════════════
   LIVE backend — Supabase (Auth + Postgres + Storage + Realtime)
   ════════════════════════════════════════════════════════════ */
function friendly(err) {
  const msg = (err && (err.message || err.error_description)) || String(err);
  if (/already (been )?registered/i.test(msg)) return new Error('That email already has an account — try logging in.');
  if (/invalid login credentials/i.test(msg)) return new Error('Wrong email or password.');
  if (/database error saving new user/i.test(msg)) return new Error('That username is taken or invalid. Try another one.');
  if (/mime type|not supported/i.test(msg)) return new Error('That file type isn’t supported.');
  if (/maximum allowed size|too large|413/i.test(msg)) return new Error('That file is too big (limit 50 MB).');
  if (/row-level security|violates/i.test(msg)) return new Error('Not allowed — are you friends with this person yet?');
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return new Error('Can’t reach the server. Check your connection.');
  return new Error(msg);
}

class LiveBackend {
  constructor(sb) {
    this.sb = sb; this.me = null; this.mode = 'live'; this.needsEmail = true;
    this.subs = new Set(); this.channel = null; this.groups = [];
  }

  onChange(cb) { this.subs.add(cb); return () => this.subs.delete(cb); }
  _emit() { for (const f of this.subs) f(); }

  async init() {
    const { data: { session } } = await this.sb.auth.getSession();
    return session ? this._loadMe(session.user.id) : null;
  }

  async _loadMe(id) {
    const { data, error } = await this.sb.from('profiles').select('id,username,display_name').eq('id', id).maybeSingle();
    if (error) throw friendly(error);
    if (!data) { await this.sb.auth.signOut(); return null; }
    this.me = data;
    this._listen();
    return data;
  }

  _listen() {
    if (this.channel) return;
    const emit = () => this._emit();
    let ch = this.sb.channel('blink-' + this.me.id);
    for (const table of ['messages', 'friendships', 'groups', 'group_members']) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, emit);
    }
    this.channel = ch.subscribe();
  }

  async signUp({ username, displayName, email, password }) {
    const { data: free, error: e1 } = await this.sb.rpc('username_available', { p_username: username });
    if (e1) throw friendly(e1);
    if (free === false) throw new Error('That username is taken.');
    const { data, error } = await this.sb.auth.signUp({
      email, password,
      options: { data: { username, display_name: displayName || username } },
    });
    if (error) throw friendly(error);
    if (!data.session) {
      throw new Error('Account created, but Supabase wants an email confirmation first. In Supabase turn off “Confirm email” (Authentication → Sign In / Providers → Email), then log in.');
    }
    return this._loadMe(data.user.id);
  }

  async signIn({ email, password }) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw friendly(error);
    return this._loadMe(data.user.id);
  }

  async signOut() {
    if (this.channel) { this.sb.removeChannel(this.channel); this.channel = null; }
    this.me = null; this.groups = [];
    await this.sb.auth.signOut();
  }

  async loadAll() {
    const { sb, me } = this;
    const { data: fr, error: e1 } = await sb.from('friendships').select('id,requester,addressee,status')
      .or(`requester.eq.${me.id},addressee.eq.${me.id}`);
    if (e1) throw friendly(e1);
    const { data: gs, error: e2 } = await sb.from('groups').select('id,name,created_by');
    if (e2) throw friendly(e2);
    let gm = [];
    if (gs.length) {
      const { data, error } = await sb.from('group_members').select('group_id,user_id').in('group_id', gs.map(g => g.id));
      if (error) throw friendly(error);
      gm = data;
    }
    const ids = new Set(gm.map(x => x.user_id));
    for (const f of fr) ids.add(f.requester === me.id ? f.addressee : f.requester);
    ids.delete(me.id);
    let profs = [];
    if (ids.size) {
      const { data, error } = await sb.from('profiles').select('id,username,display_name').in('id', [...ids]);
      if (error) throw friendly(error);
      profs = data;
    }
    const byId = Object.fromEntries(profs.map(p => [p.id, p]));
    byId[me.id] = me;
    const friends = [], incoming = [], outgoing = [];
    for (const f of fr) {
      const other = byId[f.requester === me.id ? f.addressee : f.requester];
      if (!other) continue;
      const item = { ...other, friendshipId: f.id };
      if (f.status === 'accepted') friends.push(item);
      else if (f.addressee === me.id) incoming.push(item);
      else outgoing.push(item);
    }
    const groups = gs.map(g => ({
      ...g,
      members: gm.filter(x => x.group_id === g.id).map(x => byId[x.user_id]).filter(Boolean),
    }));
    this.groups = groups;
    const { data: msgs, error: e3 } = await sb.from('messages').select('*')
      .or(`sender.eq.${me.id},recipient.eq.${me.id}`)
      .order('created_at', { ascending: false }).limit(500);
    if (e3) throw friendly(e3);
    return { friends, incoming, outgoing, groups, convos: summarize(msgs, me.id) };
  }

  async getMessages(key) {
    const { sb, me } = this;
    const { group, id } = parseKey(key);
    let q = sb.from('messages').select('*');
    q = group
      ? q.eq('group_id', id).or(`sender.eq.${me.id},recipient.eq.${me.id}`)
      : q.is('group_id', null).or(`and(sender.eq.${me.id},recipient.eq.${id}),and(sender.eq.${id},recipient.eq.${me.id})`);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(300);
    if (error) throw friendly(error);
    return data.reverse();
  }

  async _members(gid) {
    const g = this.groups.find(x => x.id === gid);
    if (g) return g.members;
    const { data, error } = await this.sb.from('group_members').select('user_id').eq('group_id', gid);
    if (error) throw friendly(error);
    return data.map(x => ({ id: x.user_id }));
  }

  /** Turn conversation keys into one row-template per recipient (groups fan out to every other member). */
  async _targets(keys) {
    const out = [];
    for (const key of keys) {
      const { group, id } = parseKey(key);
      if (!group) { out.push({ recipient: id, group_id: null, batch_id: null }); continue; }
      const batch = uid();
      for (const u of await this._members(id)) {
        if (u.id !== this.me.id) out.push({ recipient: u.id, group_id: id, batch_id: batch });
      }
    }
    return out;
  }

  async sendText(key, body) {
    const t = await this._targets([key]);
    const rows = t.map(x => ({ sender: this.me.id, kind: 'text', body: body.slice(0, 1000), ...x }));
    const { error } = await this.sb.from('messages').insert(rows);
    if (error) throw friendly(error);
  }

  async sendSnap(keys, blob, kind, caption, duration, capY = 0.6) {
    const { sb, me } = this;
    const targets = await this._targets(keys);
    if (!targets.length) throw new Error('There is nobody to send this to.');
    const contentType = typeFor(kind, blob), ext = extFor(kind, contentType);
    const store = sb.storage.from(BUCKET);
    const upload = async path => {
      const up = await store.upload(path, blob, { contentType, cacheControl: '0', upsert: false });
      if (up.error) throw friendly(up.error);
    };
    // One private copy per recipient (so each person's copy can be deleted when *they* open it).
    // Upload once, then let the server duplicate it — far cheaper than uploading N times.
    const first = `${me.id}/${uid()}.${ext}`;
    await upload(first);
    const paths = await Promise.all(targets.map(async (_, i) => {
      if (i === 0) return first;
      const p = `${me.id}/${uid()}.${ext}`;
      const cp = await store.copy(first, p);
      if (cp.error) await upload(p);
      return p;
    }));
    const results = await Promise.allSettled(targets.map(async (t, i) => {
      const ins = await sb.from('messages').insert({
        sender: me.id, kind, body: caption || '', media_path: paths[i], duration, cap_y: capY, ...t,
      });
      if (ins.error) { await store.remove([paths[i]]); throw friendly(ins.error); }
    }));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length === results.length) throw failed[0].reason;
    if (failed.length) throw new Error(`Sent to ${results.length - failed.length}, but ${failed.length} failed.`);
  }

  async _download(path) {
    const { data, error } = await this.sb.storage.from(BUCKET).download(path);
    if (error || !data) {
      const msg = String((error && error.message) || '');
      if (/failed to fetch|network|load failed/i.test(msg)) throw new Error('Can’t reach the server. Check your connection.');
      const e = new Error('This snap is gone or was already opened.');
      e.gone = true;
      throw e;
    }
    return data;
  }

  fetchSnap(m) { return this._download(m.media_path); }
  fetchSaved(m) { return this._download(m.media_path); }

  async openSnap(id) {
    const { error } = await this.sb.rpc('open_snap', { p_id: id });
    if (error) throw friendly(error);
  }

  async discardSnap(m) {
    if (m.recipient === this.me.id) await this.sb.storage.from(BUCKET).remove([m.media_path]);
  }

  /** Keep a snap you received in the chat: re-upload it into your own folder and flag the message as saved. */
  async saveSnap(m, blob) {
    const contentType = typeFor(m.kind, blob);
    const path = `${this.me.id}/${uid()}.${extFor(m.kind, contentType)}`;
    const up = await this.sb.storage.from(BUCKET).upload(path, blob, { contentType, cacheControl: '3600', upsert: false });
    if (up.error) throw friendly(up.error);
    const { error } = await this.sb.rpc('save_snap', { p_id: m.id, p_path: path });
    if (error) { await this.sb.storage.from(BUCKET).remove([path]); throw friendly(error); }
  }

  async markRead(key) {
    const { group, id } = parseKey(key);
    if (group) await this.sb.rpc('mark_read_group', { p_group: id });
    else await this.sb.rpc('mark_read', { p_friend: id });
  }

  async addFriend(input) {
    const { sb, me } = this;
    const uname = input.trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(uname)) throw new Error('Usernames are 3–20 characters: letters, numbers, _ or .');
    if (uname === me.username) throw new Error('That’s your own username 🙂');
    const { data: target, error: e1 } = await sb.from('profiles').select('id,username').eq('username', uname).maybeSingle();
    if (e1) throw friendly(e1);
    if (!target) throw new Error(`Nobody has the username @${uname}.`);
    const { data: ex, error: e2 } = await sb.from('friendships').select('id,requester,status')
      .or(`and(requester.eq.${me.id},addressee.eq.${target.id}),and(requester.eq.${target.id},addressee.eq.${me.id})`);
    if (e2) throw friendly(e2);
    if (ex.length) {
      const f = ex[0];
      if (f.status === 'accepted') return `You’re already friends with @${uname}.`;
      if (f.requester === me.id) return `Your request to @${uname} is still pending.`;
      await this.respond(f.id, true);
      return `You and @${uname} are now friends!`;
    }
    const { error } = await sb.from('friendships').insert({ requester: me.id, addressee: target.id });
    if (error) throw friendly(error);
    return `Friend request sent to @${uname}.`;
  }

  async respond(friendshipId, accept) {
    const q = accept
      ? this.sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId)
      : this.sb.from('friendships').delete().eq('id', friendshipId);
    const { error } = await q;
    if (error) throw friendly(error);
  }

  removeFriend(friendshipId) { return this.respond(friendshipId, false); }

  async createGroup(name, memberIds) {
    const { data, error } = await this.sb.rpc('create_group', { p_name: name, p_members: memberIds });
    if (error) throw friendly(error);
    return data;
  }

  async leaveGroup(groupId) {
    const { error } = await this.sb.from('group_members').delete().eq('group_id', groupId).eq('user_id', this.me.id);
    if (error) throw friendly(error);
  }
}

/* ════════════════════════════════════════════════════════════
   DEMO backend — a tiny fake "server" in localStorage + IndexedDB.
   Several tabs of the same browser share it, so you can sign up
   two users in two tabs and really chat with yourself. Three bots
   (mia, leo, zoe) are pre-friended so the app isn't empty.
   NOT secure — for trying the UI only.
   ════════════════════════════════════════════════════════════ */
const DB_KEY = 'blink_demo_db_v1';
const SESSION_KEY = 'blink_demo_uid';
const BOTS = [
  { id: 'bot-mia', username: 'mia', display_name: 'Mia', hue: 330 },
  { id: 'bot-leo', username: 'leo', display_name: 'Leo', hue: 210 },
  { id: 'bot-zoe', username: 'zoe', display_name: 'Zoe', hue: 150 },
];
const isBot = id => BOTS.some(b => b.id === id);
const TEXT_REPLIES = [
  'haha yes 😂', 'omg same', 'wait what?! tell me more', 'lol 💀', 'okay okay I’m listening 👀',
  'that’s so good', 'send a snap!', 'brb 2 min', 'no way', 'I was literally just thinking that',
];
const SNAP_REPLIES = ['haha love it 😂', 'okay that’s a good one', 'lmaooo', 'saw it! 👀', 'so pretty 😍'];

const mk = (sender, recipient, kind, extra = {}) => ({
  id: uid(), sender, recipient, kind, body: '', media_path: null, duration: 5, cap_y: 0.6,
  group_id: null, batch_id: null, saved_at: null,
  created_at: nowIso(), opened_at: null, read_at: null, ...extra,
});

async function hashPw(pw) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('blink:' + pw));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'plain:' + pw; }
}

/* IndexedDB blob store (snaps are binary — too big for localStorage) */
let idbPromise;
const idb = () => idbPromise || (idbPromise = new Promise((res, rej) => {
  const r = indexedDB.open('blink-demo', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('media');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
const mediaTx = async (mode, fn) => {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('media', mode);
    const req = fn(tx.objectStore('media'));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
};
const mediaPut = (k, blob) => mediaTx('readwrite', s => s.put(blob, k));
const mediaGet = k => mediaTx('readonly', s => s.get(k));
const mediaDel = k => mediaTx('readwrite', s => s.delete(k));

/* Generated "photos" and "videos" for the bots */
function paintScene(ctx, w, h, hue, t = 0) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${hue} 85% 58%)`);
  g.addColorStop(0.55, `hsl(${(hue + 40) % 360} 90% 66%)`);
  g.addColorStop(1, `hsl(${(hue + 70) % 360} 80% 30%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  for (let i = 0; i < 40; i++) ctx.fillRect((i * 97) % w, (i * 53) % (h * 0.3), 2, 2);
  const sx = w / 2, sy = h * (0.42 + Math.sin(t * 1.2) * 0.015), sr = w * 0.2;
  const sg = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * 2.2);
  sg.addColorStop(0, 'rgba(255,255,255,.95)'); sg.addColorStop(0.3, 'rgba(255,240,200,.55)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sx, sy, sr * 2.2, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff7e0'; ctx.beginPath(); ctx.arc(sx, sy, sr, 0, 7); ctx.fill();
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = `hsl(${(hue + 200 + i * 20) % 360} 40% ${22 - i * 6}%)`;
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 20) {
      ctx.lineTo(x, h * (0.68 + i * 0.08) + Math.sin((x / w) * 6 + i * 2 + t * (0.6 + i * 0.2)) * h * 0.03);
    }
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  }
}

function botImage(hue) {
  const c = document.createElement('canvas'); c.width = 720; c.height = 1280;
  paintScene(c.getContext('2d'), 720, 1280, hue);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
}

async function botVideo(hue) {
  const mime = pickMime();
  if (!mime || !HTMLCanvasElement.prototype.captureStream) return null;
  const c = document.createElement('canvas'); c.width = 360; c.height = 640;
  const ctx = c.getContext('2d');
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(200);
  const t0 = performance.now();
  await new Promise(res => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      paintScene(ctx, 360, 640, hue, t);
      if (t < 3) setTimeout(draw, 33); else res();
    };
    draw();
  });
  rec.stop(); await stopped;
  return new Blob(chunks, { type: mime.split(';')[0] });
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

class DemoBackend {
  constructor() {
    this.mode = 'demo'; this.needsEmail = false; this.me = null; this.subs = new Set();
    window.addEventListener('storage', e => { if (e.key === DB_KEY) this._emit(); });
  }

  /* — storage helpers — */
  _db() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DB_KEY)); } catch { /* fresh */ }
    if (!d || !d.users) {
      d = { users: BOTS.map(b => ({ id: b.id, username: b.username, display_name: b.display_name, bot: true })), friendships: [], messages: [] };
    }
    d.groups = d.groups || [];
    d.members = d.members || [];
    return d;
  }
  _save(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); this._emit(); }
  _emit() { for (const f of this.subs) f(); }
  onChange(cb) { this.subs.add(cb); return () => this.subs.delete(cb); }
  _findFriendship(db, a, b) {
    return db.friendships.find(f => (f.requester === a && f.addressee === b) || (f.requester === b && f.addressee === a));
  }
  _assertFriends(db, other) {
    const f = this._findFriendship(db, this.me.id, other);
    if (!f || f.status !== 'accepted') throw new Error('You can only message friends.');
  }
  _memberIds(db, gid) { return db.members.filter(x => x.group_id === gid).map(x => x.user_id); }
  _assertMember(db, gid) {
    if (!this._memberIds(db, gid).includes(this.me.id)) throw new Error('You’re not in this group.');
  }

  /* — auth — */
  async init() {
    const id = sessionStorage.getItem(SESSION_KEY);
    const u = id && this._db().users.find(x => x.id === id);
    if (!u) return null;
    this.me = pub(u);
    return this.me;
  }

  async signUp({ username, displayName, password }) {
    const db = this._db();
    if (db.users.some(u => u.username === username)) throw new Error('That username is taken.');
    const user = { id: uid(), username, display_name: displayName || username, pw: await hashPw(password) };
    db.users.push(user);
    for (const b of BOTS) db.friendships.push({ id: uid(), requester: b.id, addressee: user.id, status: 'accepted' });
    const t = Date.now();
    const at = ms => new Date(t - ms).toISOString();
    db.messages.push(mk('bot-mia', user.id, 'text', { body: 'hey! welcome to Blink 👋', created_at: at(240000) }));
    db.messages.push(mk('bot-leo', user.id, 'text', { body: 'psst — hold the shutter button to record a video', created_at: at(150000) }));
    const path = `bot-mia/${uid()}`;
    await mediaPut(path, await botImage(330));
    db.messages.push(mk('bot-mia', user.id, 'image', { media_path: path, body: 'good vibes only ✨', duration: 6, cap_y: 0.72, created_at: at(60000) }));
    const gid = uid();
    db.groups.push({ id: gid, name: 'Squad 🎉', created_by: 'bot-zoe' });
    for (const u of ['bot-mia', 'bot-leo', 'bot-zoe', user.id]) db.members.push({ group_id: gid, user_id: u });
    db.messages.push(mk('bot-zoe', user.id, 'text', { body: 'welcome to the group chat! 🎉', group_id: gid, batch_id: uid(), created_at: at(20000) }));
    this._save(db);
    sessionStorage.setItem(SESSION_KEY, user.id);
    this.me = pub(user);
    this._laterVideo(user.id);
    return this.me;
  }

  async signIn({ username, password }) {
    const u = this._db().users.find(x => x.username === username && !x.bot);
    if (!u || u.pw !== await hashPw(password)) throw new Error('Wrong username or password.');
    sessionStorage.setItem(SESSION_KEY, u.id);
    this.me = pub(u);
    return this.me;
  }

  async signOut() { sessionStorage.removeItem(SESSION_KEY); this.me = null; }

  _laterVideo(userId) {
    setTimeout(async () => {
      try {
        if (!this.me || this.me.id !== userId) return;
        const blob = await withTimeout(botVideo(262), 10000);
        if (!blob || !this.me || this.me.id !== userId) return;
        const path = `bot-leo/${uid()}`;
        await mediaPut(path, blob);
        const db = this._db();
        db.messages.push(mk('bot-leo', userId, 'video', { media_path: path, body: 'golden hour 🌇', duration: 3, cap_y: 0.3 }));
        this._save(db);
      } catch (e) { console.warn('demo video skipped:', e.message); }
    }, 5000);
  }

  /* — reads — */
  async loadAll() {
    const db = this._db(), me = this.me.id;
    const byId = Object.fromEntries(db.users.map(u => [u.id, u]));
    const friends = [], incoming = [], outgoing = [];
    for (const f of db.friendships) {
      if (f.requester !== me && f.addressee !== me) continue;
      const o = byId[f.requester === me ? f.addressee : f.requester];
      if (!o) continue;
      const item = { ...pub(o), friendshipId: f.id };
      if (f.status === 'accepted') friends.push(item);
      else if (f.addressee === me) incoming.push(item);
      else outgoing.push(item);
    }
    const groups = db.groups
      .filter(g => this._memberIds(db, g.id).includes(me))
      .map(g => ({ ...g, members: this._memberIds(db, g.id).map(id => byId[id]).filter(Boolean).map(pub) }));
    const msgs = db.messages.filter(m => m.sender === me || m.recipient === me)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { friends, incoming, outgoing, groups, convos: summarize(msgs, me) };
  }

  async getMessages(key) {
    const me = this.me.id, { group, id } = parseKey(key);
    return this._db().messages
      .filter(m => (group
        ? m.group_id === id && (m.sender === me || m.recipient === me)
        : !m.group_id && ((m.sender === me && m.recipient === id) || (m.sender === id && m.recipient === me))))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Row templates (one per recipient) for a conversation key. */
  _targets(db, key) {
    const { group, id } = parseKey(key);
    if (!group) { this._assertFriends(db, id); return [{ recipient: id, group_id: null, batch_id: null }]; }
    this._assertMember(db, id);
    const batch = uid();
    return this._memberIds(db, id).filter(u => u !== this.me.id).map(u => ({ recipient: u, group_id: id, batch_id: batch }));
  }

  /* — writes — */
  async sendText(key, body) {
    const db = this._db();
    const rows = this._targets(db, key).map(t => mk(this.me.id, t.recipient, 'text', { body: body.slice(0, 1000), ...t }));
    db.messages.push(...rows); this._save(db);
    const { group, id } = parseKey(key);
    this._botTextReact(group ? this._memberIds(this._db(), id).filter(isBot) : [id].filter(isBot), group ? id : null);
  }

  async sendSnap(keys, blob, kind, caption, duration, capY = 0.6) {
    for (const key of keys) {
      const templates = this._targets(this._db(), key);
      const rows = [];
      for (const t of templates) {
        const path = `${this.me.id}/${uid()}`;
        await mediaPut(path, blob);
        rows.push(mk(this.me.id, t.recipient, kind, { media_path: path, body: caption || '', duration, cap_y: capY, ...t }));
      }
      const db = this._db();
      db.messages.push(...rows); this._save(db);
      // bots "look at" the snap a few seconds later, then react
      for (const r of rows.filter(x => isBot(x.recipient))) {
        setTimeout(() => {
          const d = this._db();
          const cur = d.messages.find(x => x.id === r.id);
          if (cur && !cur.opened_at) { cur.opened_at = nowIso(); this._save(d); }
          mediaDel(r.media_path).catch(() => {});
        }, between(2500, 4000));
      }
      const { group, id } = parseKey(key);
      this._botTextReact(group ? this._memberIds(this._db(), id).filter(isBot) : [id].filter(isBot), group ? id : null, true);
    }
  }

  _botTextReact(botIds, gid, snap = false) {
    if (!botIds.length) return;
    const botId = pick(botIds);
    setTimeout(() => this._botSay(botId, pick(snap ? SNAP_REPLIES : TEXT_REPLIES), gid), between(snap ? 5200 : 1400, snap ? 7000 : 3200));
  }

  _botSay(botId, body, gid) {
    if (!this.me) return;
    const db = this._db();
    if (gid) {
      const batch = uid();
      for (const u of this._memberIds(db, gid)) {
        if (u !== botId && !isBot(u)) db.messages.push(mk(botId, u, 'text', { body, group_id: gid, batch_id: batch }));
      }
    } else {
      if (!this._findFriendship(db, this.me.id, botId)) return;
      db.messages.push(mk(botId, this.me.id, 'text', { body }));
    }
    this._save(db);
  }

  async fetchSnap(m) {
    const cur = this._db().messages.find(x => x.id === m.id);
    if (!cur || cur.recipient !== this.me.id || cur.opened_at) {
      const e = new Error('This snap is gone or was already opened.'); e.gone = true; throw e;
    }
    const blob = await mediaGet(cur.media_path);
    if (!blob) { const e = new Error('This snap is gone or was already opened.'); e.gone = true; throw e; }
    return blob;
  }

  async fetchSaved(m) {
    const cur = this._db().messages.find(x => x.id === m.id);
    if (!cur || !cur.saved_at || (cur.sender !== this.me.id && cur.recipient !== this.me.id)) throw new Error('This snap isn’t saved.');
    const blob = await mediaGet(cur.media_path);
    if (!blob) throw new Error('This saved snap is gone.');
    return blob;
  }

  async openSnap(id) {
    const db = this._db();
    const m = db.messages.find(x => x.id === id && x.recipient === this.me.id && !x.opened_at);
    if (m) { m.opened_at = nowIso(); this._save(db); }
  }

  async discardSnap(m) { if (m.recipient === this.me.id) await mediaDel(m.media_path); }

  async saveSnap(m, blob) {
    const path = `${this.me.id}/${uid()}`;
    await mediaPut(path, blob);
    const db = this._db();
    const cur = db.messages.find(x => x.id === m.id && x.recipient === this.me.id && x.opened_at && !x.saved_at);
    if (!cur) { await mediaDel(path); throw new Error('Couldn’t save this snap.'); }
    cur.media_path = path; cur.saved_at = nowIso();
    this._save(db);
  }

  async markRead(key) {
    const db = this._db(), me = this.me.id, { group, id } = parseKey(key);
    let changed = false;
    for (const m of db.messages) {
      const mine = m.recipient === me && m.kind === 'text' && !m.read_at;
      if (mine && (group ? m.group_id === id : (!m.group_id && m.sender === id))) { m.read_at = nowIso(); changed = true; }
    }
    if (changed) this._save(db);
  }

  async addFriend(input) {
    const me = this.me, db = this._db();
    const uname = input.trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(uname)) throw new Error('Usernames are 3–20 characters: letters, numbers, _ or .');
    if (uname === me.username) throw new Error('That’s your own username 🙂');
    const target = db.users.find(u => u.username === uname);
    if (!target) throw new Error(`Nobody has the username @${uname}.`);
    const ex = this._findFriendship(db, me.id, target.id);
    if (ex) {
      if (ex.status === 'accepted') return `You’re already friends with @${uname}.`;
      if (ex.requester === me.id) return `Your request to @${uname} is still pending.`;
      ex.status = 'accepted'; this._save(db);
      return `You and @${uname} are now friends!`;
    }
    db.friendships.push({ id: uid(), requester: me.id, addressee: target.id, status: target.bot ? 'accepted' : 'pending' });
    this._save(db);
    return target.bot ? `You and @${uname} are now friends!` : `Friend request sent to @${uname}.`;
  }

  async respond(friendshipId, accept) {
    const db = this._db();
    if (accept) { const f = db.friendships.find(x => x.id === friendshipId); if (f) f.status = 'accepted'; }
    else db.friendships = db.friendships.filter(x => x.id !== friendshipId);
    this._save(db);
  }
  removeFriend(id) { return this.respond(id, false); }

  async createGroup(name, memberIds) {
    const db = this._db();
    const ids = [...new Set(memberIds)].filter(x => x !== this.me.id);
    if (!name.trim()) throw new Error('Give the group a name.');
    if (ids.length < 2) throw new Error('Pick at least 2 friends.');
    if (ids.length > MAX_GROUP_FRIENDS) throw new Error(`Groups can have up to ${MAX_GROUP_FRIENDS + 1} people.`);
    for (const id of ids) this._assertFriends(db, id);
    const gid = uid();
    db.groups.push({ id: gid, name: name.trim().slice(0, 40), created_by: this.me.id });
    for (const u of [this.me.id, ...ids]) db.members.push({ group_id: gid, user_id: u });
    this._save(db);
    return gid;
  }

  async leaveGroup(gid) {
    const db = this._db();
    db.members = db.members.filter(x => !(x.group_id === gid && x.user_id === this.me.id));
    if (!this._memberIds(db, gid).some(u => !isBot(u))) {
      db.groups = db.groups.filter(g => g.id !== gid);
      db.members = db.members.filter(x => x.group_id !== gid);
      db.messages = db.messages.filter(m => m.group_id !== gid);
    }
    this._save(db);
  }
}
