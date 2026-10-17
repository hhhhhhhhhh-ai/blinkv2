import { toast, pickMime, esc, wait, draw916, size916 } from './util.js';
import { I } from './icons.js';

const MAX_REC_SECONDS = 15;
const VID_W = 720, VID_H = 1280;

/**
 * Full-screen camera shown in a 9:16 frame, so what you see is exactly what you send.
 * Tap the shutter for a photo, hold it for a video.
 * handlers: { onCapture({blob, kind, duration?}), onFile(file), onClearReply() }
 */
export function createCamera(root, h) {
  root.innerHTML = `
    <div class="cam-frame">
      <video class="cam-video" playsinline muted autoplay></video>
      <div class="cam-flash"></div>
      <div class="cam-screenflash"></div>
      <div class="cam-fallback" hidden>
        <p class="cf-msg"></p>
        <button class="btn primary" data-open>Open camera</button>
        <button class="btn ghost" data-pick>Choose photo or video</button>
      </div>
      <div class="cam-top">
        <button class="reply-pill" hidden></button>
        <div class="cam-side">
          <button class="icon-btn glass cam-flip" aria-label="Flip camera">${I.flip}</button>
          <button class="icon-btn glass cam-flashbtn" aria-label="Flash" aria-pressed="false"></button>
        </div>
      </div>
      <div class="cam-rec" hidden><i></i><span>0:00</span></div>
      <div class="cam-bottom">
        <button class="icon-btn glass big cam-gallery" aria-label="Choose from gallery">${I.image}</button>
        <button class="shutter" aria-label="Tap for a photo, hold to record a video">
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-bg" cx="50" cy="50" r="44"/><circle class="ring" cx="50" cy="50" r="44"/></svg><i></i>
        </button>
        <span></span>
      </div>
      <p class="cam-hint">Tap for photo · Hold for video</p>
      <input class="f-pick" type="file" accept="image/*,video/*" hidden>
      <input class="f-cap" type="file" accept="image/*,video/*" capture="environment" hidden>
    </div>`;

  const q = s => root.querySelector(s);
  const video = q('.cam-video'), shutter = q('.shutter'), fallback = q('.cam-fallback');
  const recBadge = q('.cam-rec'), fPick = q('.f-pick'), fCap = q('.f-cap'), replyPill = q('.reply-pill');
  const flashBtn = q('.cam-flashbtn'), screenFlash = q('.cam-screenflash');

  let stream = null, starting = false, facing = 'environment';
  let holdTimer = null, pressing = false, capturing = false;
  let recorder = null, chunks = [], t0 = 0, tick = null, autoStop = null, recMime = '', canvasTimer = null;
  let flashOn = false, torchOk = false;

  /* ---------- flash ---------- */
  function updateFlashUI() {
    flashBtn.classList.toggle('on', flashOn);
    flashBtn.setAttribute('aria-pressed', String(flashOn));
    flashBtn.innerHTML = flashOn ? I.bolt : I.boltOff;
  }
  updateFlashUI();

  const vtrack = () => (stream && stream.getVideoTracks()[0]) || null;

  async function setTorch(on) {
    const t = vtrack();
    if (!t || !torchOk) return false;
    try { await t.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
  }

  /** Light up the scene: rear camera → real torch (where the browser allows it), front camera → bright screen. */
  async function lightOn(settle) {
    if (!flashOn) return false;
    if (facing === 'user') {
      screenFlash.classList.add('on');
      if (settle) await wait(260);
      return true;
    }
    if (torchOk && await setTorch(true)) {
      if (settle) await wait(380);
      return true;
    }
    return false;
  }

  function lightOff() {
    screenFlash.classList.remove('on');
    if (torchOk && facing === 'environment') setTorch(false);
  }

  flashBtn.addEventListener('click', () => {
    if (!flashOn && facing === 'environment' && stream && !torchOk) {
      toast('This browser doesn’t allow the rear flash. Flip to the front camera for a screen flash.', 3600);
      return;
    }
    flashOn = !flashOn;
    updateFlashUI();
  });

  /* ---------- stream ---------- */
  const getStream = audio => navigator.mediaDevices.getUserMedia({
    audio,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 },
    },
  });

  function showFallback(msg) {
    q('.cf-msg').textContent = msg;
    fallback.hidden = false;
  }

  async function start() {
    if (stream || starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return showFallback('The live camera isn’t available in this browser.');
    }
    starting = true;
    try {
      try { stream = await getStream(true); }
      catch (e) { stream = await getStream(false); }   // no mic? still allow photos/silent video
      video.srcObject = stream;
      video.classList.toggle('mirror', facing === 'user');
      fallback.hidden = true;
      const t = vtrack();
      let caps = {};
      try { caps = (t && t.getCapabilities && t.getCapabilities()) || {}; } catch { /* ignore */ }
      torchOk = !!caps.torch;
      await video.play().catch(() => {});
    } catch (e) {
      stream = null; torchOk = false;
      showFallback('Camera access is blocked. Allow it in your browser settings, or use your phone’s camera instead.');
    } finally {
      starting = false;
    }
  }

  function stop() {
    if (recorder) { try { recorder.onstop = null; recorder.stop(); } catch { /* ignore */ } cleanupRec(); }
    lightOff();
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; torchOk = false;
    video.srcObject = null;
  }

  /* ---------- photo (always cropped to 9:16) ---------- */
  async function takePhoto() {
    if (capturing || !stream) return;
    capturing = true;
    try {
      await lightOn(true);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const [w, hh] = size916(vw, vh);
      const c = document.createElement('canvas');
      c.width = w; c.height = hh;
      draw916(c.getContext('2d'), video, vw, vh, w, hh, facing === 'user');
      root.classList.add('flash');
      setTimeout(() => root.classList.remove('flash'), 160);
      lightOff();
      c.toBlob(b => b && h.onCapture({ blob: b, kind: 'image' }), 'image/jpeg', 0.88);
    } finally {
      lightOff();
      capturing = false;
    }
  }

  /* ---------- video (recorded through a 9:16 canvas) ---------- */
  async function startRec() {
    if (!stream || typeof MediaRecorder === 'undefined') {
      toast('Video recording isn’t supported in this browser');
      return;
    }
    const mime = pickMime();
    let src = stream;
    if (HTMLCanvasElement.prototype.captureStream) {
      const cvs = document.createElement('canvas');
      cvs.width = VID_W; cvs.height = VID_H;
      const ctx = cvs.getContext('2d');
      const draw = () => {
        if (video.videoWidth) draw916(ctx, video, video.videoWidth, video.videoHeight, VID_W, VID_H, facing === 'user');
      };
      draw();
      canvasTimer = setInterval(draw, 1000 / 30);
      src = cvs.captureStream(30);
      stream.getAudioTracks().forEach(t => src.addTrack(t));
    }
    try {
      recorder = new MediaRecorder(src, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : {});
    } catch (e) {
      clearInterval(canvasTimer);
      recorder = null;
      toast('Couldn’t start recording');
      return;
    }
    recMime = (recorder.mimeType || mime || 'video/webm').split(';')[0];
    chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const elapsed = (Date.now() - t0) / 1000;
      const blob = new Blob(chunks, { type: recMime });
      cleanupRec();
      if (elapsed < 0.8 || !blob.size) { toast('Hold a little longer to record'); return; }
      h.onCapture({ blob, kind: 'video', duration: Math.max(1, Math.min(30, Math.round(elapsed))) });
    };
    t0 = Date.now();
    recorder.start(250);
    lightOn(false);
    shutter.classList.add('rec');
    recBadge.hidden = false;
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      recBadge.querySelector('span').textContent = `0:${String(s).padStart(2, '0')}`;
    }, 250);
    autoStop = setTimeout(stopRec, MAX_REC_SECONDS * 1000);
    try { navigator.vibrate && navigator.vibrate(12); } catch { /* ignore */ }
  }

  function stopRec() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function cleanupRec() {
    clearInterval(tick); clearTimeout(autoStop); clearInterval(canvasTimer);
    shutter.classList.remove('rec');
    recBadge.hidden = true;
    recBadge.querySelector('span').textContent = '0:00';
    recorder = null;
    lightOff();
  }

  /* ---------- shutter: tap = photo, hold = video ---------- */
  shutter.addEventListener('pointerdown', e => {
    if (!stream) return;
    e.preventDefault();
    pressing = true;
    shutter.classList.add('down');
    if (shutter.setPointerCapture) { try { shutter.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    holdTimer = setTimeout(() => { holdTimer = null; startRec(); }, 320);
  });
  const release = () => {
    if (!pressing) return;
    pressing = false;
    shutter.classList.remove('down');
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; takePhoto(); }
    else if (recorder) stopRec();
  };
  shutter.addEventListener('pointerup', release);
  shutter.addEventListener('pointercancel', release);
  shutter.addEventListener('contextmenu', e => e.preventDefault());
  shutter.addEventListener('click', () => { if (!stream) fCap.click(); });   // no live camera → system camera

  /* ---------- other controls ---------- */
  q('.cam-flip').addEventListener('click', async () => {
    facing = facing === 'user' ? 'environment' : 'user';
    stop();
    await start();
    if (flashOn && facing === 'environment' && stream && !torchOk) {
      flashOn = false; updateFlashUI();
      toast('Rear flash isn’t available in this browser');
    }
  });
  q('.cam-gallery').addEventListener('click', () => fPick.click());
  fallback.querySelector('[data-open]').addEventListener('click', () => fCap.click());
  fallback.querySelector('[data-pick]').addEventListener('click', () => fPick.click());
  for (const inp of [fPick, fCap]) {
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (f) h.onFile(f);
    });
  }
  replyPill.addEventListener('click', () => h.onClearReply && h.onClearReply());

  /** r = { label } or null */
  function setReply(r) {
    replyPill.hidden = !r;
    if (r) replyPill.innerHTML = `To <b>${esc(r.label)}</b> ${I.close}`;
  }

  return { start, stop, setReply };
}
