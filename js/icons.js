const svg = p =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;

export const I = {
  chat: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.2-4.4A8 8 0 1 1 21 12z"/>'),
  camera: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6"/>'),
  friends: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.6"/><path d="M17.5 14.2c2.3.1 3.9 1.6 4.3 4.3"/>'),
  flip: svg('<path d="M20 7h-9a5 5 0 0 0-5 5v1"/><path d="m17 4 3 3-3 3"/><path d="M4 17h9a5 5 0 0 0 5-5v-1"/><path d="m7 20-3-3 3-3"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="1.8"/><path d="m21 15-4.5-4.5L6 21"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  send: svg('<path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  timer: svg('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.3 2.3M9.5 2.5h5"/>'),
  download: svg('<path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M4 19.5h16"/>'),
  share: svg('<path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
  bolt: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  boltOff: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/><path d="M3 3l18 18"/>'),
  bookmark: svg('<path d="M6 3h12v18l-6-4.5L6 21z"/>'),
  groupPlus: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M19 8v6M16 11h6"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
  sound: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>'),
};

export const LOGO = `<svg class="logo" viewBox="0 0 512 512" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#ff4f9a"/></linearGradient></defs><rect width="512" height="512" rx="120" fill="url(#lg)"/><path d="M92 256c42-72 102-108 164-108s122 36 164 108c-42 72-102 108-164 108S134 328 92 256z" fill="#fff"/><circle cx="256" cy="256" r="64" fill="#1b1030"/><circle cx="278" cy="234" r="19" fill="#fff"/></svg>`;
