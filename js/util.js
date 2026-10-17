export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const truncate = (s = '', n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const wait = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function hue(str = '') {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function avatar(user, size = 44) {
  const initial = esc((user.display_name || user.username || '?').trim().charAt(0).toUpperCase());
  return `<span class="avatar" style="--h:${hue(user.username)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${initial}</span>`;
}

export function fmtTime(ts, long = false) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  const days = (now - d) / 864e5;
  const day = days < 6
    ? d.toLocaleDateString([], { weekday: 'short' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return long ? `${day} ${hm}` : day;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function haptic(p = 10) {
  try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ }
}

/** Best video container this browser can record (mp4 first: plays everywhere). */
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const types = [
    'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  return types.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

/**
 * Draw `src` into a (outW × outH) canvas context so it fills it completely,
 * centre-cropping whatever doesn't fit ("cover"). Used to force every snap into 9:16.
 */
export function draw916(ctx, src, sw, sh, outW, outH, mirror = false) {
  const s = Math.max(outW / sw, outH / sh);
  const dw = sw * s, dh = sh * s;
  ctx.save();
  if (mirror) { ctx.translate(outW, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
  ctx.restore();
}

/** Output size for a 9:16 crop of a (sw × sh) source, never upscaling and capped at 1080 wide. */
export function size916(sw, sh, maxW = 1080) {
  const cw = Math.min(sw, (sh * 9) / 16);
  const w = Math.max(2, Math.round(Math.min(maxW, cw)));
  return [w, Math.round((w * 16) / 9)];
}

/** Centre-crop a photo to portrait 9:16 (respects EXIF rotation) and re-encode it small. */
export async function normalizeImage(src, { mirror = false } = {}) {
  let bmp;
  try { bmp = await createImageBitmap(src, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(src); }
  const [w, h] = size916(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw916(c.getContext('2d'), bmp, bmp.width, bmp.height, w, h, mirror);
  if (bmp.close) bmp.close();
  return new Promise((res, rej) =>
    c.toBlob(b => (b ? res(b) : rej(new Error('Could not process that image'))), 'image/jpeg', 0.85));
}

/** Read a video file's length in seconds (Infinity/NaN → null). */
export function videoDuration(blob) {
  return new Promise(res => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = d => { URL.revokeObjectURL(url); res(Number.isFinite(d) ? d : null); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    v.src = url;
  });
}
