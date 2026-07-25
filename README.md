# Lyrics & Chords — tablet kiosk PWA

A single-purpose web app for a wall-mounted / stage tablet: shows lyrics with
chords, transposes, auto-scrolls, and loads songs over the air. Runs fullscreen
in Chrome on a stripped-down Lenovo Tab M10 (TB-X505F). No app store, no root.

## Features
- **ChordPro rendering** with chords aligned above the right syllable
- **Transpose** up/down by semitone (`− / +`, or ↑/↓ keys)
- **Auto-scroll** with a speed slider (Play button, or Spacebar)
- **Font size** `A− / A+`
- **Song list** with filter (☰)
- **Offline** via service worker; **OTA updates** by pushing to this repo
- **Screen stays awake** via the Wake Lock API

## Add / edit songs (over the air)
1. Drop a ChordPro file in `songs/` — e.g. `songs/my-song.chordpro`.
2. Add an entry to `songs/index.json`:
   ```json
   { "id": "my-song", "title": "My Song", "artist": "Someone", "file": "songs/my-song.chordpro" }
   ```
3. Commit and push. The tablet picks it up on next load (or tap ↻ Refresh).

### ChordPro quick reference
```
{title: Song Title}
{artist: Artist}
{key: G}

{start_of_verse: Verse 1}
A[G]mazing [C]grace how [G]sweet the sound
```
Chords go in `[ ]` immediately before the syllable they sit over.

## Update the app itself
Edit `app.js` / `app.css` / `index.html`, bump `CACHE` in `sw.js` (e.g. `v3` → `v4`),
commit and push. The new shell activates on the tablet's next reload.

## Local testing against the tablet (USB)
```
node server.js "D:\temp\tablet" 8080          # static server (see scratchpad copy)
adb reverse tcp:8080 tcp:8080                  # tunnel PC:8080 to tablet localhost
adb shell am start -a android.intent.action.VIEW -d "http://localhost:8080/" com.android.chrome
```

## Hosting
Served by GitHub Pages from the repo root on the `main` branch.
