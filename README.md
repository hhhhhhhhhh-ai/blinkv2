# Blink — disappearing-snap chat app (web, phone-first)

Add friends by **username**, chat, and send **photos or videos that can be opened only once** — full-screen, with a timer bar and caption, like a snap. Installable on your phone's home screen.

The app is plain HTML/CSS/JS (no build step), so it can be hosted **free on GitHub Pages**. Sharing messages between phones needs a small free backend: **Supabase** (accounts, database, file storage, realtime).

| Mode | When | What you get |
|---|---|---|
| **Demo** | `js/config.js` left empty | Works instantly, data stays in your browser. 3 bot friends (mia, leo, zoe) reply to you. |
| **Real** | Supabase URL + key filled in | Real accounts. Chat with real friends on their own phones. |

---

## 1 · Set up the backend (Supabase, free, ~5 min)

1. Create a free account at <https://supabase.com> → **New project** (pick any name/password/region).
2. Open **SQL Editor → New query**, paste the whole contents of `schema.sql`, press **Run**. (Run it once; you should see “Success”.)
3. Go to **Authentication → Sign In / Providers → Email** and **turn OFF “Confirm email”**. (Otherwise sign-up waits for an email that Supabase’s free mailer rarely delivers.)
4. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
5. Open `js/config.js` and paste them in:
   ```js
   export const CONFIG = {
     SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
     SUPABASE_ANON_KEY: 'eyJhbGciOi…',
   };
   ```
   The anon key is *meant* to be public — the security rules in `schema.sql` protect the data. **Never** paste the `service_role` key anywhere.

## 2 · Put it online with GitHub Pages (free)

1. Create a GitHub account → **New repository** → name it e.g. `blink` → set it to **Public** → Create.
2. Click **uploading an existing file**, then drag in **everything inside this folder** (`index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js` …). Commit.
3. Repo **Settings → Pages → Build and deployment**: Source = **Deploy from a branch**, Branch = **main** / **(root)** → Save.
4. After ~1 minute your app is live at `https://YOUR-USERNAME.github.io/blink/`.

(Prefer something else? Any static host works: Cloudflare Pages, Netlify drag-and-drop, Vercel. Just upload the folder.)

## 3 · Install it on your phone

Open the link on your phone → **iPhone:** Share → *Add to Home Screen* · **Android:** ⋮ → *Install app* / *Add to Home screen*. It opens full-screen like a native app.

Send your friends the link; they sign up, then add each other by username.

---

## How it works

- **Camera tab** – always a **9:16 portrait** frame (what you see is what you send, not zoomed in). Tap the shutter for a photo, hold it for a video (max 15 s), flip the camera, or pick from your gallery. **⚡ Flash button:** on the front camera it lights up your screen; on the back camera it uses the phone's real flash where the browser allows it (Android Chrome — iPhone Safari doesn't allow it, so use the front camera there).
- **Caption** – tap **Aa**, type, then **drag the text up or down** anywhere on the snap. Your friend sees it at the same spot. Also choose a viewing time (3/5/10 s for photos), then pick who to send to.
- **Snaps** – shown as a coloured tile (pink = photo, purple = video). They can be opened **once**, then they're gone — the file is deleted and the server refuses a second download. Senders see *Delivered → Opened*.
- **Chats list** – tap a chat with a new snap to **open the snap right away** (several snaps play one after another). **Swipe the row to the right** to open the chat *without* opening the snap.
- **Save in chat** – while watching a snap someone sent you, tap **Save in chat** to keep it. It stays in the chat as a “Saved Photo/Video” tile that you **and** the sender can open again any time.
- **Groups** – Chats tab → the group icon (top right) → name it and pick 2–9 friends. Text chat plus group snaps (each person opens their own copy once). The “⋯” menu in a group lets you leave it; an empty group deletes itself.
- **Friends** – add by username → the other person accepts. Only accepted friends can message each other or be put in a group together.

### Already deployed the first version?
Your Supabase database needs one upgrade for groups, “Save in chat” and caption position:
Supabase → **SQL Editor → New query** → paste `migrations/002_groups_save_caption.sql` → **Run** (once). Then upload the new app files to GitHub (replace the old ones). Brand-new project? Just run `schema.sql` — it already includes everything.

### Files
```
index.html            app shell
css/style.css         all styling (dark, mobile-first, safe-area aware)
js/main.js            UI: auth, chats, friends, viewer, preview, send flow
js/camera.js          live camera + photo/video capture
js/backend.js         Supabase backend + built-in demo backend
js/config.js          ← put your Supabase URL + key here
schema.sql            database tables + security rules (run once in Supabase)
migrations/           upgrade script for projects created with the first version
sw.js, manifest…      installable-app (PWA) bits
```

## Honest limits

- A web app **cannot block screenshots or screen recording** — nobody can, on the web. “View once” stops re-opening in the app, not copying.
- No push notifications when the app is closed (that needs a push server). New snaps/messages appear live while the app is open.
- Free Supabase tier: 1 GB file storage, 50 MB per file, and a project **pauses after ~1 week without activity** (one click to resume in the dashboard).
- Snaps are uploaded once per recipient so each person’s copy can be deleted independently; if someone never opens a snap, the file stays until it’s opened.
- Photos and videos recorded **in the app** are really 9:16. A video picked from your gallery is shown cropped to 9:16 (centre) but the file itself isn't re-encoded.
- iPhone `.mov` videos picked from the gallery may not play on some Android phones; videos recorded in the app are fine.
- A snap that a group member saves is kept for them and the sender only, not for the whole group.
- Browsers only allow the camera on **https** (GitHub Pages is) or `localhost`.

## Try it locally
```bash
cd blink
python3 -m http.server 8000     # then open http://localhost:8000
```
(Opening `index.html` by double-click won’t work — browsers block ES modules from `file://`.)

## Troubleshooting
- **“Account created, but Supabase wants an email confirmation”** → step 1.3: turn off *Confirm email*, then log in.
- **“Email address … is invalid”** → use a real email address.
- **Can’t send to a friend** → you must both have accepted the friend request.
- **Page shows old version after you update files** → close the app fully and reopen (the service worker refreshes on next load).
