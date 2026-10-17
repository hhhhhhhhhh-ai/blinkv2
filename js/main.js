import { createBackend, USERNAME_RE, MAX_GROUP_FRIENDS } from './backend.js';
import { createCamera } from './camera.js';
import {
  $, $$, esc, avatar, fmtTime, toast, haptic, debounce, truncate, hue, clamp, normalizeImage, videoDuration,
} from './util.js';
import { I, LOGO } from './icons.js';

const app = $('#app');
const MAX_VIDEO_BYTES = 45 * 1024 * 1024;
const emptyData = () => ({ friends: [], incoming: [], outgoing: [], groups: [], convos: {} });

let be = null, me = null, camera = null, main = null;
let data = emptyData();
let loaded = false, tab = 'camera', replyTo = null, chat = null, viewing = false, swiped = false;
let unsub = null, poll = null, refreshing = false, again = false;

/* ═══════════ overlays (with Android back-button support) ═══════════ */
const stack = [];
const SID = Math.random().toString(36).slice(2);

function openOverlay(el, onClose) {
  const entry = { el, onClose, closing: false };
  stack.push(entry);
  document.body.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
  history.pushState({ ov: stack.length, sid: SID }, '');
  syncCamera();
  return {
    close() {
      const i = stack.indexOf(entry);
      if (i < 0 || entry.closing) return;
      entry.closing = true;
      history.go(-(stack.length - i));
    },
  };
}

addEventListener('popstate', e => {
  // history entries left over from before a page reload carry another session id → treat them as 'no overlay'
  const depth = e.state && e.state.sid === SID ? e.state.ov || 0 : 0;
  while (stack.length > depth) {
    const { el, onClose } = stack.pop();
    el.classList.remove('in');
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
    try { onClose && onClose(); } catch (err) { console.error(err); }
  }
  syncCamera();
});

const closeAllOverlays = () => { if (stack.length) history.go(-stack.length); };
const closeThen = (handle, fn) => { handle.close(); setTimeout(fn, 320); };

function syncCamera() {
  if (!camera) return;
  if (tab === 'camera' && stack.length === 0 && document.visibilityState === 'visible') camera.start();
  else camera.stop();
}
document.addEventListener('visibilitychange', syncCamera);

/* keep the layout above the on-screen keyboard (iOS + Android) */
function viewportVars() {
  const vv = window.visualViewport;
  const set = () => {
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv ? vv.height : innerHeight)}px`);
    if (vv && vv.offsetTop) window.scrollTo(0, 0);
  };
  set();
  (vv || window).addEventListener('resize', set);
  if (vv) vv.addEventListener('scroll', set);
}

/* ═══════════ people & conversations ═══════════ */
const nameOf = u => u.display_name || u.username;

function person(id) {
  if (id === me.id) return me;
  const f = data.friends.find(x => x.id === id);
  if (f) return f;
  for (const g of data.groups) {
    const u = g.members.find(x => x.id === id);
    if (u) return u;
  }
  return { id, username: '?', display_name: 'Someone' };
}

/** key: 'u:<friendId>' or 'g:<groupId>' */
function convoOf(key) {
  if (key.startsWith('g:')) {
    const g = data.groups.find(x => 'g:' + x.id === key);
    return g && {
      key, type: 'group', id: g.id, name: g.name, sub: `${g.members.length} members`, group: g,
      avatarUser: { username: g.name, display_name: g.name },
    };
  }
  const f = data.friends.find(x => 'u:' + x.id === key);
  return f && { key, type: 'dm', id: f.id, name: nameOf(f), sub: '@' + f.username, user: f, avatarUser: f };
}

/* ═══════════ boot ═══════════ */
boot();

async function boot() {
  viewportVars();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  app.innerHTML = `<div class="splash">${LOGO}</div>`;
  try {
    be = await createBackend();
    me = await be.init();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="fatal"><h2>Can’t start Blink</h2><p>${esc(e.message || 'Unknown error')}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  me ? showMain() : showAuth();
}

/* ═══════════ auth ═══════════ */
function showAuth(mode = 'signup') {
  const live = be.needsEmail;
  const signup = mode === 'signup';
  app.innerHTML = `
    <div class="auth">
      <div class="auth-top">${LOGO}<h1>Blink</h1><p>Send a snap. They watch it once.</p></div>
      <form class="auth-form" novalidate>
        <div class="seg">
          <button type="button" data-m="signup" class="${signup ? 'on' : ''}">Sign up</button>
          <button type="button" data-m="login" class="${signup ? '' : 'on'}">Log in</button>
        </div>
        ${signup ? `<label>Display name<input name="display" maxlength="30" autocomplete="nickname" placeholder="Alex"></label>` : ''}
        ${live ? `<label>Email<input name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" placeholder="you@email.com"></label>` : ''}
        ${signup || !live ? `<label>Username<input name="username" maxlength="20" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="alex_99"></label>` : ''}
        <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="At least 6 characters"></label>
        <p class="err" role="alert"></p>
        <button class="btn primary wide" type="submit">${signup ? 'Create account' : 'Log in'}</button>
        ${signup && live ? `<p class="fine">Friends find you by your <b>username</b>.</p>` : ''}
      </form>
      ${!live ? `<p class="demo-note"><b>Demo mode</b> — everything stays in this browser. Three friends are waiting for you. Connect Supabase (see README) to chat with real people.</p>` : ''}
    </div>`;
  const form = $('.auth-form'), errEl = $('.err', form), btn = $('button[type=submit]', form);
  $$('.seg button', form).forEach(b => b.addEventListener('click', () => showAuth(b.dataset.m)));
  const fail = msg => { errEl.textContent = msg; };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    fail('');
    const f = Object.fromEntries(new FormData(form));
    const username = (f.username || '').trim().toLowerCase().replace(/^@/, '');
    const email = (f.email || '').trim();
    if (live && !/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
    if ((signup || !live) && !USERNAME_RE.test(username)) return fail('Username: 3–20 characters — letters, numbers, _ or .');
    if (!f.password || f.password.length < 6) return fail('Password needs at least 6 characters.');
    btn.disabled = true; btn.textContent = 'One sec…';
    try {
      me = signup
        ? await be.signUp({ username, displayName: (f.display || '').trim(), email, password: f.password })
        : await be.signIn({ username, email, password: f.password });
      showMain();
    } catch (ex) {
      fail(ex.message || 'Something went wrong.');
      btn.disabled = false; btn.textContent = signup ? 'Create account' : 'Log in';
    }
  });
}

/* ═══════════ main shell ═══════════ */
function showMain() {
  tab = 'camera'; loaded = false; replyTo = null;
  app.innerHTML = `
    <div class="main" data-tab="camera">
      <section class="pane pane-chats"></section>
      <section class="pane pane-camera"></section>
      <section class="pane pane-friends"></section>
      <nav class="nav">
        <button data-tab="chats">${I.chat}<span>Chats</span><i class="badge" hidden></i></button>
        <button data-tab="camera" class="on">${I.camera}<span>Camera</span></button>
        <button data-tab="friends">${I.friends}<span>Friends</span><i class="badge" hidden></i></button>
      </nav>
    </div>`;
  main = $('.main');
  camera = createCamera($('.pane-camera'), {
    onCapture: showPreview,
    onFile: f => handleFile(f),
    onClearReply: () => { replyTo = null; camera.setReply(null); },
  });
  $('.nav').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  main.addEventListener('click', onMainClick);
  main.addEventListener('submit', onMainSubmit);
  initSwipe($('.pane-chats'));
  unsub = be.onChange(debounce(refresh, 150));
  if (be.mode === 'live') poll = setInterval(refresh, 10000);   // safety net if realtime drops
  setTab('camera');
  refresh();
}

function setTab(t) {
  tab = t;
  if (!main) return;
  main.dataset.tab = t;
  $$('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  syncCamera();
}

async function logout() {
  closeAllOverlays();
  if (unsub) unsub();
  clearInterval(poll);
  if (camera) camera.stop();
  await be.signOut();
  me = null; main = null; camera = null; chat = null; replyTo = null;
  data = emptyData();
  document.title = 'Blink';
  showAuth('login');
}

/* ═══════════ data refresh ═══════════ */
async function refresh() {
  if (!me) return;
  if (refreshing) { again = true; return; }
  refreshing = true;
  try {
    const next = await be.loadAll();
    const prev = data;
    data = next;
    notifyNew(prev, next);
    loaded = true;
    renderChats(); renderFriends(); renderBadges();
    if (chat) await refreshChat();
  } catch (e) {
    console.warn('refresh failed', e);
  } finally {
    refreshing = false;
    if (again) { again = false; refresh(); }
  }
}

const unreadTotal = d => Object.values(d.convos).reduce((a, c) => a + c.unread, 0);

function notifyNew(prev, next) {
  if (!loaded) return;
  if (unreadTotal(next) > unreadTotal(prev)) {
    const key = Object.keys(next.convos).find(k => next.convos[k].unread > ((prev.convos[k] && prev.convos[k].unread) || 0));
    if (key && !(chat && chat.convo.key === key)) {
      const cv = convoOf(key);
      const kind = next.convos[key].last.kind;
      toast(`${kind === 'text' ? 'New message' : 'New snap'} from ${cv ? cv.name : 'a friend'}`);
      haptic([20, 40, 20]);
    }
  }
  if (next.incoming.length > prev.incoming.length) { toast('You have a new friend request'); haptic(20); }
}

function renderBadges() {
  const n = unreadTotal(data), r = data.incoming.length;
  const set = (t, v) => {
    const b = $(`.nav button[data-tab=${t}] .badge`);
    if (!b) return;
    b.hidden = !v; b.textContent = v > 9 ? '9+' : v;
  };
  set('chats', n); set('friends', r);
  document.title = n ? `(${n}) Blink` : 'Blink';
}

/* ═══════════ chats tab ═══════════ */
const snapChip = (kind, hollow) => `<span class="chip ${kind}${hollow ? ' hollow' : ''}"></span>`;

function lastLine(last, cv) {
  if (!last) return '<span class="muted">Tap to start chatting</span>';
  const mine = last.sender === me.id;
  const who = cv.type === 'group' && !mine ? `${esc(nameOf(person(last.sender)).split(' ')[0])}: ` : '';
  if (last.kind === 'text') return `${mine ? 'You: ' : who}${esc(truncate(last.body, 38))}`;
  const label = last.kind === 'image' ? 'Photo' : 'Video';
  if (last.saved_at) return `${snapChip(last.kind, true)}Saved · ${label}`;
  if (mine) return `${snapChip(last.kind, true)}${last.opened_at ? 'Opened' : 'Delivered'} · ${label}`;
  return last.opened_at
    ? `${snapChip(last.kind, true)}${who}Opened · ${label}`
    : `${snapChip(last.kind, false)}<b>${who}New ${label} Snap</b>`;
}

function chatRows() {
  const rows = [
    ...data.friends.map(f => convoOf('u:' + f.id)),
    ...data.groups.map(g => convoOf('g:' + g.id)),
  ];
  const ts = r => { const c = data.convos[r.key]; return c && c.last ? Date.parse(c.last.created_at) : 0; };
  return rows.sort((a, b) => ts(b) - ts(a) || a.name.localeCompare(b.name));
}

function renderChats() {
  const pane = $('.pane-chats');
  if (!pane) return;
  const rows = chatRows();
  pane.innerHTML = `
    <header class="bar"><h2>Chats</h2>
      <div class="bar-actions">
        <button class="icon-btn" data-act="new-group" aria-label="New group">${I.groupPlus}</button>
        <button class="icon-btn" data-act="goto-friends" aria-label="Add friends">${I.plus}</button>
      </div></header>
    <div class="scroll">${rows.length ? rows.map(r => {
    const c = data.convos[r.key];
    const hasSnap = c && c.snaps && c.snaps.length;
    return `
      <div class="swipe"><div class="swipe-bg">${I.chat}<span>Chat</span></div>
        <button class="item ${c && c.unread ? 'unread' : ''}" data-conv="${r.key}" aria-label="${esc(r.name)}${hasSnap ? ', new snap' : ''}">
          ${avatar(r.avatarUser, 50)}
          <span class="item-main"><b>${esc(r.name)}</b><small>${lastLine(hasSnap ? c.snaps[c.snaps.length - 1] : c && c.last, r)}</small></span>
          <span class="item-side">${c && c.last ? fmtTime(c.last.created_at) : ''}${c && c.unread ? '<i class="dot"></i>' : ''}</span>
        </button></div>`;
  }).join('') : `
      <div class="empty"><div class="empty-ic">${I.friends}</div>
        <h3>No chats yet</h3><p>Add someone by their username to start sending snaps.</p>
        <button class="btn primary" data-act="goto-friends">Add a friend</button></div>`}
    </div>`;
}

/** Tap a row: new snaps open right away (all of them, one after another); otherwise open the chat. */
function tapConvo(key) {
  const c = data.convos[key];
  if (c && c.snaps && c.snaps.length) openViewer(c.snaps[0], c.snaps.slice(1));
  else openChat(key);
}

/** Swipe a row to the right → open the chat *without* opening the snap. */
function initSwipe(pane) {
  let s = null;
  pane.addEventListener('pointerdown', e => {
    const item = e.target.closest('.swipe .item');
    if (!item || (e.pointerType === 'mouse' && e.button !== 0)) return;
    s = { item, wrap: item.parentElement, key: item.dataset.conv, x0: e.clientX, y0: e.clientY, dx: 0, drag: false, id: e.pointerId };
  });
  pane.addEventListener('pointermove', e => {
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
    if (!s.drag) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        s.drag = true;
        s.item.classList.add('dragging'); s.wrap.classList.add('pulling');
        try { pane.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      } else return;
    }
    s.dx = Math.max(0, dx);
    s.item.style.transform = `translateX(${s.dx}px)`;
    s.wrap.classList.toggle('armed', s.dx > 90);
  });
  const end = e => {
    if (!s) return;
    const st = s; s = null;
    if (!st.drag) return;
    swiped = true; setTimeout(() => { swiped = false; }, 350);
    st.item.classList.remove('dragging'); st.wrap.classList.remove('pulling', 'armed');
    st.item.style.transform = '';
    if (st.dx > 90 && e.type === 'pointerup') { haptic(10); openChat(st.key); }
  };
  pane.addEventListener('pointerup', end);
  pane.addEventListener('pointercancel', end);
}

/* ═══════════ friends tab ═══════════ */
function renderFriends() {
  const pane = $('.pane-friends');
  if (!pane) return;
  const prevInput = $('input[name=u]', pane);
  const keep = prevInput ? { v: prevInput.value, focus: document.activeElement === prevInput } : null;
  const person_ = (u, actions) => `
    <div class="item static">${avatar(u, 46)}
      <span class="item-main"><b>${esc(u.display_name || u.username)}</b><small>@${esc(u.username)}</small></span>
      <span class="item-actions">${actions}</span></div>`;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  pane.innerHTML = `
    <header class="bar"><h2>Friends</h2></header>
    <div class="scroll pad">
      <div class="me-card">${avatar(me, 58)}
        <div class="item-main"><b>${esc(nameOf(me))}</b><small>@${esc(me.username)}</small></div>
        <button class="btn small" data-act="share">${I.share}Share</button></div>
      <form class="add" data-form="add">
        <span class="at">@</span>
        <input name="u" placeholder="Add friend by username" maxlength="21" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="go">
        <button class="btn primary small">Add</button></form>
      <p class="err" id="add-msg"></p>
      ${data.incoming.length ? `<h4>Requests</h4>${data.incoming.map(u => person_(u,
    `<button class="btn primary small" data-accept="${u.friendshipId}">Accept</button><button class="btn small" data-decline="${u.friendshipId}">Ignore</button>`)).join('')}` : ''}
      ${data.outgoing.length ? `<h4>Sent</h4>${data.outgoing.map(u => person_(u,
    `<span class="muted">Pending</span><button class="btn small" data-decline="${u.friendshipId}">Cancel</button>`)).join('')}` : ''}
      <h4>Groups · ${data.groups.length}</h4>
      <button class="btn wide new-group" data-act="new-group">${I.groupPlus}New group</button>
      ${data.groups.map(g => `
        <div class="item static">${avatar({ username: g.name, display_name: g.name }, 46)}
          <span class="item-main"><b>${esc(g.name)}</b><small>${g.members.length} members</small></span>
          <span class="item-actions"><button class="btn small" data-chat="g:${g.id}">Chat</button></span></div>`).join('')}
      <h4>My friends · ${data.friends.length}</h4>
      ${data.friends.length ? data.friends.map(u => person_(u,
    `<button class="btn small" data-chat="u:${u.id}">Chat</button><button class="icon-btn small" data-remove="${u.friendshipId}" data-name="${esc(u.username)}" aria-label="Remove @${esc(u.username)}">${I.close}</button>`)).join('')
    : '<p class="muted pad-s">No friends yet — type a username above.</p>'}
      <button class="btn ghost wide" data-act="logout">Log out</button>
      ${!standalone ? `<p class="fine">Tip: use your browser’s <b>Add to Home Screen</b> to open Blink like a real app.</p>` : ''}
    </div>`;
  if (keep) {
    const inp = $('input[name=u]', pane);
    inp.value = keep.v;
    if (keep.focus) inp.focus();
  }
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); refresh(); }
  catch (e) { toast(e.message || 'Something went wrong'); }
}

function onMainClick(e) {
  const t = e.target.closest('[data-conv],[data-chat],[data-act],[data-accept],[data-decline],[data-remove]');
  if (!t) return;
  const d = t.dataset;
  if (d.conv) { if (swiped) return; return tapConvo(d.conv); }
  if (d.chat) return openChat(d.chat);
  if (d.accept) return act(() => be.respond(d.accept, true), 'Friend added');
  if (d.decline) return act(() => be.respond(d.decline, false));
  if (d.remove) { if (confirm(`Remove @${d.name} from your friends?`)) act(() => be.removeFriend(d.remove)); return; }
  if (d.act === 'goto-friends') setTab('friends');
  else if (d.act === 'new-group') openNewGroup();
  else if (d.act === 'share') share();
  else if (d.act === 'logout') logout();
}

async function onMainSubmit(e) {
  if (!e.target.matches('[data-form=add]')) return;
  e.preventDefault();
  const input = $('input[name=u]', e.target), msg = $('#add-msg');
  const name = input.value.trim();
  if (!name) return;
  msg.textContent = '';
  try {
    const res = await be.addFriend(name);
    input.value = '';
    toast(res);
    refresh();
  } catch (ex) { msg.textContent = ex.message; }
}

async function share() {
  const text = `Add me on Blink — my username is @${me.username}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Blink', text, url: location.href.split('#')[0] }); return; }
    await navigator.clipboard.writeText(`${text} ${location.href.split('#')[0]}`);
    toast('Copied to clipboard');
  } catch { /* cancelled */ }
}

/* ═══════════ pick lists (used by "Send to" and "New group") ═══════════ */
const pickRow = (value, u, sub, checked = false) => `
  <label class="pick"><input type="checkbox" value="${esc(value)}" ${checked ? 'checked' : ''}>
    <span class="check">${I.check}</span>${avatar(u, 42)}
    <span class="item-main"><b>${esc(nameOf(u))}</b><small>${esc(sub)}</small></span></label>`;

/* ═══════════ new group ═══════════ */
function openNewGroup() {
  if (data.friends.length < 2) { toast('Add at least 2 friends first, then you can make a group.'); return; }
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-label="New group">
      <div class="grab"></div><h3>New group</h3>
      <input class="g-name" maxlength="40" placeholder="Group name" autocomplete="off" enterkeyhint="done">
      <p class="fine left">Pick 2–${MAX_GROUP_FRIENDS} friends.</p>
      <div class="sheet-list">${data.friends.map(f => pickRow('u:' + f.id, f, '@' + f.username)).join('')}</div>
      <p class="err"></p>
      <button class="btn primary wide" data-go disabled>Create group</button>
    </div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  const nameIn = $('.g-name', el), go = $('[data-go]', el), err = $('.err', el);
  const chosen = () => $$('input:checked', el).map(i => i.value.slice(2));
  const update = () => {
    const n = chosen().length;
    go.disabled = !nameIn.value.trim() || n < 2 || n > MAX_GROUP_FRIENDS;
    err.textContent = n > MAX_GROUP_FRIENDS ? `A group can have up to ${MAX_GROUP_FRIENDS + 1} people.` : '';
  };
  nameIn.addEventListener('input', update);
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') nameIn.blur(); });
  $$('input[type=checkbox]', el).forEach(i => i.addEventListener('change', update));
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Creating…'; err.textContent = '';
    try {
      const gid = await be.createGroup(nameIn.value.trim(), chosen());
      await refresh();
      closeThen(h, () => { setTab('chats'); openChat('g:' + gid); });
    } catch (e) {
      err.textContent = e.message || 'Couldn’t create the group.';
      go.textContent = 'Create group'; update();
    }
  });
}

function openGroupInfo(g) {
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Group info">
      <div class="grab"></div><h3>${esc(g.name)}</h3>
      <p class="fine left">${g.members.length} members</p>
      <div class="sheet-list">${g.members.map(u => `
        <div class="item static">${avatar(u, 42)}
          <span class="item-main"><b>${esc(nameOf(u))}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</b><small>@${esc(u.username)}</small></span></div>`).join('')}
      </div>
      <button class="btn danger wide" data-leave>Leave group</button>
    </div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  $('[data-leave]', el).addEventListener('click', async () => {
    if (!confirm(`Leave “${g.name}”? You won’t get its messages anymore.`)) return;
    try {
      await be.leaveGroup(g.id);
      closeAllOverlays();
      toast('You left the group');
      refresh();
    } catch (e) { toast(e.message || 'Couldn’t leave the group'); }
  });
}

/* ═══════════ chat thread ═══════════ */
/** Group messages you sent are stored once per member; show them as one bubble. */
function collapse(msgs) {
  const out = [], seen = new Map();
  for (const m of msgs) {
    if (m.group_id && m.sender === me.id) {
      const head = seen.get(m.batch_id);
      if (head) { head.rows.push(m); continue; }
      const h = { ...m, rows: [m], saved_at: null };
      seen.set(m.batch_id, h); out.push(h);
    } else out.push(m);
  }
  return out;
}

async function openChat(key) {
  const convo = convoOf(key);
  if (!convo || chat) return;
  const el = document.createElement('div');
  el.className = 'overlay chat';
  el.innerHTML = `
    <header class="chat-bar">
      <button class="icon-btn" data-x aria-label="Back">${I.back}</button>
      ${avatar(convo.avatarUser, 40)}
      <div class="item-main"><b>${esc(convo.name)}</b><small>${esc(convo.sub)}</small></div>
      ${convo.type === 'group' ? `<button class="icon-btn" data-info aria-label="Group info">${I.more}</button>` : ''}
    </header>
    <div class="thread" role="log" aria-live="polite"></div>
    <form class="composer">
      <button type="button" class="icon-btn" data-cam aria-label="Send a snap">${I.camera}</button>
      <button type="button" class="icon-btn" data-pick aria-label="Send a photo or video">${I.image}</button>
      <input name="t" placeholder="Send a chat" maxlength="1000" autocomplete="off" enterkeyhint="send">
      <button class="send" aria-label="Send">${I.send}</button>
      <input type="file" accept="image/*,video/*" hidden>
    </form>`;
  chat = { convo, el, messages: [], first: true, handle: null };
  const c = chat;
  c.handle = openOverlay(el, () => { chat = null; refresh(); });

  $('[data-x]', el).addEventListener('click', () => c.handle.close());
  const info = $('[data-info]', el);
  if (info) info.addEventListener('click', () => { const g = convoOf(key); if (g) openGroupInfo(g.group); });
  const input = $('input[name=t]', el), file = $('input[type=file]', el);
  $('[data-cam]', el).addEventListener('click', () => {
    replyTo = { key, label: convo.name }; camera.setReply(replyTo); setTab('camera'); c.handle.close();
  });
  $('[data-pick]', el).addEventListener('click', () => file.click());
  file.addEventListener('change', () => { const f = file.files[0]; file.value = ''; if (f) handleFile(f, convo); });
  $('.composer', el).addEventListener('submit', async e => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = ''; input.focus();
    const tmp = { id: 'tmp-' + Date.now(), sender: me.id, kind: 'text', body, created_at: new Date().toISOString(), group_id: convo.type === 'group' ? convo.id : null };
    c.messages.push(tmp); renderThread(true);
    try { await be.sendText(key, body); }
    catch (ex) {
      toast(ex.message || 'Couldn’t send');
      c.messages = c.messages.filter(m => m !== tmp); renderThread(); input.value = body;
    }
    refreshChat();
  });
  $('.thread', el).addEventListener('click', e => {
    const t = e.target.closest('[data-open]');
    if (!t) return;
    const m = c.messages.find(x => x.id === t.dataset.open);
    if (m) openViewer(m);
  });
  await refreshChat();
}

async function refreshChat() {
  const c = chat;
  if (!c) return;
  try {
    const msgs = await be.getMessages(c.convo.key);
    if (chat !== c) return;
    c.messages = c.convo.type === 'group' ? collapse(msgs) : msgs;
    renderThread();
    if (msgs.some(m => m.recipient === me.id && m.kind === 'text' && !m.read_at)) await be.markRead(c.convo.key);
  } catch (e) { console.warn('chat refresh failed', e); }
}

function renderMsg(m, isLastMine, group) {
  const mine = m.sender === me.id;
  const side = mine ? 'me' : 'them';
  const sender = group && !mine ? person(m.sender) : null;
  const who = sender ? `<div class="who" style="--h:${hue(sender.username)}">${esc(nameOf(sender))}</div>` : '';
  if (m.kind === 'text') {
    let meta = '';
    if (mine && isLastMine) {
      const rows = m.rows || [m];
      meta = `<div class="meta">${String(m.id).startsWith('tmp-') ? 'Sending…' : rows.every(r => r.read_at) ? 'Read' : 'Delivered'}</div>`;
    }
    return `<div class="row ${side}"><div>${who}<div class="bubble">${esc(m.body)}</div>${meta}</div></div>`;
  }
  const label = m.kind === 'image' ? 'Photo' : 'Video';
  const ic = '<span class="snap-ic"></span>';
  if (m.saved_at) {
    return `<button class="row ${side} snap-btn" data-open="${m.id}"><span class="stack">${who}<span class="snap ${m.kind} saved">${ic}<span>Saved ${label}</span><small>Tap to view</small></span></span></button>`;
  }
  if (mine) {
    const rows = m.rows || [m];
    const opened = rows.filter(r => r.opened_at).length;
    const status = !opened ? 'Delivered' : opened === rows.length ? 'Opened' : `Opened by ${opened}/${rows.length}`;
    return `<div class="row me"><div class="snap ${m.kind} sent">${ic}<span>${status}</span><small>${label}</small></div></div>`;
  }
  return m.opened_at
    ? `<div class="row them"><span class="stack">${who}<span class="snap ${m.kind} done">${ic}<span>Opened</span><small>${label}</small></span></span></div>`
    : `<button class="row them snap-btn" data-open="${m.id}"><span class="stack">${who}<span class="snap ${m.kind} new">${ic}<span>New ${label} Snap</span><small>Tap to view</small></span></span></button>`;
}

function renderThread(forceBottom = false) {
  if (!chat) return;
  const box = $('.thread', chat.el);
  const group = chat.convo.type === 'group';
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  let html = '', prev = 0;
  const lastMineIdx = chat.messages.map(m => m.sender === me.id).lastIndexOf(true);
  chat.messages.forEach((m, i) => {
    const t = Date.parse(m.created_at);
    if (t - prev > 15 * 60e3) html += `<div class="divider">${fmtTime(m.created_at, true)}</div>`;
    prev = t;
    html += renderMsg(m, i === lastMineIdx, group);
  });
  if (!chat.messages.length) {
    html = `<div class="empty small"><p>Say hi to <b>${esc(chat.convo.name)}</b> 👋<br>or send a snap with the camera button.</p></div>`;
  }
  box.innerHTML = html;
  if (atBottom || forceBottom || chat.first) box.scrollTop = box.scrollHeight;
  chat.first = false;
}

/* ═══════════ snap viewer (view once — unless you save it in the chat) ═══════════ */
async function openViewer(m, queue = []) {
  if (viewing) return;
  viewing = true;
  const sender = person(m.sender);
  const saved = !!m.saved_at;
  const canSave = !saved && m.recipient === me.id;
  const el = document.createElement('div');
  el.className = 'overlay viewer';
  el.innerHTML = `<div class="v-load"><span class="spinner"></span></div>`;
  let url = null, timer = null, vid = null, advance = false, closed = false, saving = false;
  const onHide = () => { if (document.visibilityState === 'hidden') h.close(); };
  document.addEventListener('visibilitychange', onHide);
  const h = openOverlay(el, () => {
    closed = true;
    clearTimeout(timer);
    if (vid) vid.pause();
    if (url) URL.revokeObjectURL(url);
    document.removeEventListener('visibilitychange', onHide);
    viewing = false;
    refresh();
    // tapping / finishing continues with the next unopened snap; the X button and Back stop here
    if (advance && queue.length) setTimeout(() => openViewer(queue[0], queue.slice(1)), 260);
  });
  const next = () => { advance = true; h.close(); };
  el.addEventListener('contextmenu', e => e.preventDefault());

  let blob;
  try {
    blob = saved ? await be.fetchSaved(m) : await be.fetchSnap(m);
    if (closed) return;
    if (!saved) {
      await be.discardSnap(m);          // delete the file first (the server only allows it while unopened)...
      await be.openSnap(m.id);          // ...then mark it opened: it can never be opened again
    }
  } catch (e) {
    if (e.gone && !saved) be.openSnap(m.id).catch(() => {});   // file already gone → stop showing it as new
    toast(e.message || 'Couldn’t load this snap');
    next();
    return;
  }
  if (closed) return;
  url = URL.createObjectURL(blob);
  const dur = Math.max(1, Math.min(30, m.duration || 5));
  const capY = clamp(Number.isFinite(+m.cap_y) ? +m.cap_y : 0.6, 0, 1);
  el.innerHTML = `
    <div class="stage">
      ${m.kind === 'image'
    ? `<img class="v-media" src="${url}" alt="" draggable="false">`
    : `<video class="v-media" src="${url}" playsinline autoplay></video>`}
      ${m.body ? `<div class="v-cap" style="top:${capY * 100}%"><span>${esc(m.body)}</span></div>` : ''}
    </div>
    <div class="v-top">
      <div class="v-bar"><i></i></div>
      <div class="v-head">${avatar(sender, 36)}
        <div class="item-main"><b>${esc(nameOf(sender))}</b><small>${fmtTime(m.created_at)}</small></div>
        <button class="icon-btn" data-x aria-label="Close">${I.close}</button></div>
    </div>
    <button class="v-sound" hidden>${I.sound}Tap for sound</button>
    ${canSave ? `<button class="v-save">${I.bookmark}<span>Save in chat</span></button>`
    : saved ? `<div class="v-saved">${I.bookmark}Saved in chat</div>` : ''}
    <p class="v-hint">${queue.length ? `Tap for the next snap · ${queue.length} more` : 'Tap anywhere to close'}</p>`;
  const bar = $('.v-bar i', el);
  if (m.kind === 'image') {
    if (saved) $('.v-bar', el).style.visibility = 'hidden';      // saved photos stay until you tap
    else { bar.style.animation = `v-fill ${dur}s linear forwards`; timer = setTimeout(next, dur * 1000); }
  } else {
    vid = $('video', el);
    vid.onended = next;
    vid.ontimeupdate = () => {
      const total = Number.isFinite(vid.duration) ? vid.duration : dur;
      bar.style.width = `${Math.min(100, (vid.currentTime / total) * 100)}%`;
    };
    timer = setTimeout(next, 31000);
    vid.play().catch(() => {
      vid.muted = true; vid.play().catch(() => {});
      const s = $('.v-sound', el); s.hidden = false;
      s.addEventListener('click', ev => { ev.stopPropagation(); vid.muted = false; s.hidden = true; });
    });
  }
  $('[data-x]', el).addEventListener('click', ev => { ev.stopPropagation(); h.close(); });
  const saveBtn = $('.v-save', el);
  if (saveBtn) {
    saveBtn.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (saving) return;
      saving = true;
      saveBtn.disabled = true; $('span', saveBtn).textContent = 'Saving…';
      try {
        await be.saveSnap(m, blob);
        saveBtn.classList.add('done'); $('span', saveBtn).textContent = 'Saved in chat';
        toast('Saved in chat — you can open it again anytime');
        haptic(15);
      } catch (e) {
        saving = false; saveBtn.disabled = false; $('span', saveBtn).textContent = 'Save in chat';
        toast(e.message || 'Couldn’t save this snap');
      }
    });
  }
  el.addEventListener('click', next);
}

/* ═══════════ capture → preview → send ═══════════ */
async function handleFile(file, convo) {
  if (convo) { replyTo = { key: convo.key, label: convo.name }; camera && camera.setReply(replyTo); }
  try {
    if (file.type.startsWith('image/')) {
      showPreview({ blob: await normalizeImage(file), kind: 'image' });
    } else if (file.type.startsWith('video/')) {
      if (file.size > MAX_VIDEO_BYTES) return toast('That video is too big — keep it under 45 MB.');
      const d = await videoDuration(file);
      showPreview({ blob: file, kind: 'video', duration: Math.max(1, Math.min(30, Math.round(d || 10))) });
    } else {
      toast('Please choose a photo or a video.');
    }
  } catch (e) {
    console.error(e);
    toast('Couldn’t open that file.');
  }
}

function showPreview({ blob, kind, duration = 5 }) {
  const url = URL.createObjectURL(blob);
  const st = { caption: '', dur: 5, capY: 0.6 };
  const type = (blob.type || '').split(';')[0];
  const ext = kind === 'image' ? 'jpg' : type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : 'webm';
  const el = document.createElement('div');
  el.className = 'overlay preview';
  el.innerHTML = `
    <div class="stage">
      ${kind === 'image'
    ? `<img class="v-media" src="${url}" alt="Your snap">`
    : `<video class="v-media" src="${url}" playsinline autoplay loop muted></video>`}
      <div class="cap" hidden style="top:60%"><input maxlength="80" placeholder="Add a caption" autocomplete="off" enterkeyhint="done"></div>
    </div>
    <div class="p-top">
      <button class="icon-btn glass" data-x aria-label="Discard">${I.close}</button>
      <div class="p-tools">
        ${kind === 'image' ? `<button class="tool" data-dur aria-label="Viewing time">${I.timer}<span>5s</span></button>` : ''}
        <button class="tool" data-cap aria-label="Add caption"><b>Aa</b></button>
        <a class="tool" href="${url}" download="blink-${Date.now()}.${ext}" aria-label="Save to your device">${I.download}</a>
      </div>
    </div>
    <p class="p-hint" hidden>Drag the caption up or down</p>
    <div class="p-bottom"><button class="btn primary send-to">Send to ${I.send}</button></div>`;
  const h = openOverlay(el, () => URL.revokeObjectURL(url));
  $('[data-x]', el).addEventListener('click', () => h.close());

  /* caption: tap to edit, drag to move up/down */
  const stage = $('.stage', el), cap = $('.cap', el), capIn = $('input', cap), hint = $('.p-hint', el);
  let drag = null, justDragged = false;
  const showCap = () => { cap.hidden = false; hint.hidden = false; capIn.focus(); };
  $('[data-cap]', el).addEventListener('click', showCap);
  capIn.addEventListener('input', () => { st.caption = capIn.value; });
  capIn.addEventListener('blur', () => { if (!capIn.value.trim()) { cap.hidden = true; hint.hidden = true; } });
  capIn.addEventListener('keydown', e => { if (e.key === 'Enter') capIn.blur(); });
  cap.addEventListener('pointerdown', e => {
    drag = { y0: e.clientY, top0: st.capY, moved: false, id: e.pointerId };
    try { cap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  cap.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const r = stage.getBoundingClientRect();
    st.capY = clamp(drag.top0 + dy / r.height, 0.07, 0.93);
    cap.style.top = `${(st.capY * 100).toFixed(2)}%`;
  });
  const endDrag = e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.moved) { justDragged = true; setTimeout(() => { justDragged = false; }, 250); }
    else if (e.type === 'pointerup') capIn.focus();
  };
  cap.addEventListener('pointerup', endDrag);
  cap.addEventListener('pointercancel', endDrag);
  cap.addEventListener('click', e => { if (justDragged) e.preventDefault(); });

  const durBtn = $('[data-dur]', el);
  if (durBtn) {
    const opts = [3, 5, 10];
    durBtn.addEventListener('click', () => {
      st.dur = opts[(opts.indexOf(st.dur) + 1) % opts.length];
      $('span', durBtn).textContent = `${st.dur}s`;
    });
  }
  $('.send-to', el).addEventListener('click', () => openSendSheet(st, blob, kind, kind === 'image' ? null : duration));
}

function openSendSheet(st, blob, kind, videoSecs) {
  const el = document.createElement('div');
  el.className = 'overlay sheet-wrap';
  const empty = !data.friends.length;
  el.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Send to">
      <div class="grab"></div><h3>Send to</h3>
      <div class="sheet-list">${empty ? `<p class="muted pad-s">You have no friends yet. Add someone by username first.</p>` : `
        ${data.groups.length ? '<h4 class="sh">Groups</h4>' : ''}
        ${data.groups.map(g => pickRow('g:' + g.id, { username: g.name, display_name: g.name }, `${g.members.length} members`, replyTo && replyTo.key === 'g:' + g.id)).join('')}
        <h4 class="sh">Friends</h4>
        ${data.friends.map(f => pickRow('u:' + f.id, f, '@' + f.username, replyTo && replyTo.key === 'u:' + f.id)).join('')}`}
      </div>
      ${empty ? `<button class="btn primary wide" data-friends>Add friends</button>` : `<button class="btn primary wide" data-go disabled>Send</button>`}
    </div>`;
  const h = openOverlay(el);
  el.addEventListener('click', e => { if (e.target === el) h.close(); });
  const go = $('[data-go]', el);
  const update = () => {
    const n = $$('input:checked', el).length;
    go.disabled = !n;
    go.textContent = n ? `Send to ${n} chat${n > 1 ? 's' : ''}` : 'Send';
  };
  if (go) {
    $$('input', el).forEach(i => i.addEventListener('change', update));
    update();
    go.addEventListener('click', async () => {
      const keys = $$('input:checked', el).map(i => i.value);
      if (!keys.length) return;
      go.disabled = true; go.textContent = 'Sending…';
      try {
        await be.sendSnap(keys, blob, kind, st.caption.trim(), kind === 'image' ? st.dur : videoSecs, st.capY);
        toast(`Snap sent to ${keys.length} chat${keys.length > 1 ? 's' : ''}`);
        haptic(15);
        replyTo = null; camera.setReply(null);
        closeAllOverlays();
        setTab('chats');
        refresh();
      } catch (e) {
        toast(e.message || 'Couldn’t send');
        update();
      }
    });
  } else {
    $('[data-friends]', el).addEventListener('click', () => { closeAllOverlays(); setTab('friends'); });
  }
}
