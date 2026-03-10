# CLAUDE.md — Curling Vote

Project context for Claude Code. Keep this file updated as the codebase evolves.

---

## Project Overview

**Curling Vote** is a "Twitch Plays"-style crowd voting app for curling.
Spectators scan a QR code on a venue TV and vote on the next shot in real time.
The organizer controls the session from an admin panel; results appear live on the display page.

Three voter categories per stone:
- **Shot Type** — Guard / Draw / Takeout (discrete)
- **Handle** — In Turn (L) / Out Turn (R) (discrete)
- **Line** — continuous 0–1 float representing distance from centre to 12-foot ring, displayed as a tap-on-house SVG

---

## Tech Stack

- **Node.js + Express** — static file server + REST-ish routes
- **Socket.io** — real-time bidirectional comms (no REST polling)
- **qrcode** npm package — generates voter QR at startup
- **dotenv** — `.env` for secrets/config
- **pm2** — process manager on the DigitalOcean droplet
- No build step; all JS is vanilla inline in HTML files

---

## File Structure

```
server.js            — Express + Socket.io server, all game logic
public/
  index.html         — Landing page with links to Display / Admin / Voter
  display.html       — TV/projector view; shows voting live + results
  admin.html         — Organiser controls (start round, end voting, etc.)
  voter.html         — Participant view; served at /vote (token-gated optional)
.env.example         — Template for required env vars
package.json         — deps: express, socket.io, qrcode, dotenv
```

---

## Environment Variables (`.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ADMIN_TOKEN` | Yes | `admin-change-me` | Admin panel password |
| `PUBLIC_URL` | Yes | `http://localhost` | No trailing slash |
| `VOTER_TOKEN` | No | random hex on startup | Set for stable predictable token |
| `VOTER_TOKEN_REQUIRED` | No | `false` | Set to `true` to gate voter page behind token |
| `SSL_KEY` | No | — | Path to Let's Encrypt privkey.pem |
| `SSL_CERT` | No | — | Path to Let's Encrypt fullchain.pem |
| `PORT` | No | 443 (SSL) / 80 (plain) | Override listen port (useful for nginx proxy) |

When `SSL_KEY` + `SSL_CERT` both exist on disk, the server runs HTTPS on 443 and spins up an HTTP→HTTPS redirect on 80.

---

## Server Architecture

### State

```js
setupDone          // bool — true once admin has configured sheets
sheetNames         // string[] — e.g. ['A','B'] or ['1','2','3']
sheets             // { [sheetId]: SheetState }
```

**SheetState:**
```js
{
  phase: 'idle' | 'voting' | 'result',
  round: number,            // increments each stone
  countdown: number,        // configured voting duration (seconds)
  timeRemaining: number,
  colors: [colorA, colorB], // alternates each round
  stoneColor,               // derived: colors[(round-1) % 2]
  votes: { type: {guard,draw,takeout}, handle: {in,out} },
  linePositions: Map<socketId, float>,  // 0–1
  winners: { type, handle, line },      // line is float avg or null
  voterState: Map<socketId, {type,handle,line}>,
  timer: setInterval handle,
}
```

### Vote Categories

```js
VOTE_CATEGORIES = {
  type:   { label, options: ['guard','draw','takeout'], labels: {...} },
  handle: { label, options: ['in','out'],               labels: {in:'In Turn (L)', out:'Out Turn (R)'} },
  line:   { label: 'Line', continuous: true },  // NOT discrete — float 0–1
}
```

The `continuous: true` flag is important — any code iterating `cat.options` must skip continuous categories or it will crash.

### Socket Rooms

| Room | Members |
|---|---|
| `display` | display page sockets |
| `admin` | admin page sockets |
| `voter` | all voter sockets |
| `sheet:{sheetId}` | voters joined to a specific sheet |

### Key Socket Events

**Server → Client:**
| Event | Payload | Sent to |
|---|---|---|
| `init` | `{setup, sheets, sheetNames, categories, qr?}` | on connect |
| `setup-complete` | `{sheetNames, sheets}` | broadcast all |
| `state-update` | `publicSheet(sheetId)` | sheet room + admin + display |
| `votes-update` | `{sheetId, votes, totalVoters}` | sheet room + admin + display |
| `line-update` | `{sheetId, positions, avg}` | sheet room + admin + display |
| `timer-tick` | `{sheetId, timeRemaining}` | sheet room + admin + display |
| `vote-ack` | `{category, choice}` | voter only |
| `vote-line-ack` | `{position}` | voter only |
| `token-rotated` | `{url, dataUrl}` | admin only |
| `qr-update` | `{url, dataUrl}` | display only |
| `full-reset` | — | broadcast all |

**Client → Server:**
| Event | Payload | Who |
|---|---|---|
| `join-sheet` | `{sheetId}` | voter |
| `vote` | `{sheetId, category, choice}` | voter |
| `vote-line` | `{sheetId, position}` | voter |
| `setup` | `{count, scheme, sheetColors}` | admin |
| `start-round` | `{sheetId, countdown}` | admin |
| `force-end` | `{sheetId}` | admin |
| `throw-complete` | `{sheetId}` | admin |
| `rotate-token` | — | admin |
| `reset-all` | — | admin |

---

## Line Position Math

`pos` is always a float **0–1** where:
- `0` = centre (button)
- `1` = edge of 12-foot ring

Converting to feet/inches for display:
```js
function formatFtIn(pos) {
  if (pos == null) return '—';
  const totalIn = Math.round(pos * 12 * 12); // 0–144 inches
  const ft = Math.floor(totalIn / 12);
  const inches = totalIn % 12;
  return inches === 0 ? `${ft}'` : `${ft}' ${inches}"`;
}
```

`pos * 12` gives feet from centre (0–12).

---

## House SVG Design

ViewBox: `0 0 100 100`, centre at `(50, 50)`.
Scale: `46px = 12'`, so `1' = 3.833px`.

| Ring | Radius | Fill |
|---|---|---|
| 12-foot | 46 | `#0d2d50` (dark blue) |
| 8-foot | 30.7 | `#c8dff0` (white/light blue) |
| 4-foot | 15.3 | `#9b1c1c` (red) |
| Button | 3.8 | `#c8dff0` (white) |
| Centre dot | 1.5 | `#9b1c1c` |

Tee line: `<line x1="4" y1="50" x2="96" y2="50">`

**Broom dot position (x-axis only, y stays on tee line):**
```js
const side = handle === 'in' ? -1 : 1;   // in = left, out = right
const cx = 50 + side * pos * 46;
```

**SVG constants (duplicated in voter.html and display.html):**
```js
// voter.html
const H_CX = 50, H_CY = 50, H_SCALE = 46;

// display.html
const D_CX = 50, D_CY = 50, D_SCALE = 46;
```

**DOM IDs used for live manipulation:**

In voter.html:
- `#line-house-svg` — the interactive SVG element
- `#broom-dot` — gold `<circle>`, `cx` updated on drag
- `#avg-tick` — white `<line>`, `x1`/`x2` updated on line-update
- `#voter-dots` — `<g>` whose innerHTML is rebuilt on line-update
- `#result-house` — `<div>` populated with result house SVG

In display.html (per-sheet, prefixed with sheetId):
- `ldbar-{sheetId}` — the voting SVG element
- `voter-dots-{sheetId}` — `<g>` rebuilt on line-update
- `lavg-{sheetId}` — gold avg tick `<line>`

**House SVG sizes on display page:**
- Voting card: `240px / 200px / 160px` (1 / 2 / 3+ sheets)
- Result card: `480px / 360px / 270px` (1 / 2 / 3+ sheets)

---

## QR Code

- Generated at startup and on token rotation via `buildQR()`
- Size: 800×800px (dark `#0a1628`, light `#e8f4f8`)
- URL: `PUBLIC_URL/vote?t=TOKEN` when `VOTER_TOKEN_REQUIRED=true`, else `PUBLIC_URL/vote`
- Display page shows QR in corner; click it to open a full-screen modal with print button
- Admin page also shows QR with rotate-token button

---

## Known Gotchas / Bug History

1. **`cat.options` undefined for `line`** — The `line` category has `continuous: true` and no `options` array. Any loop over `VOTE_CATEGORIES` that accesses `cat.options` without checking `cat.continuous` first will throw a TypeError. This previously caused the admin card to silently crash on every `state-update`, requiring a page refresh. Fix: always `if (cat.continuous) { ...; continue; }` before touching `cat.options`.

2. **`shotLabels[w.line]` float lookup** — `w.line` is a float (0–1), not a string key. Using it as an object key returns `undefined`. Always use `formatFtIn(w.line)` directly for display.

3. **Voters must rejoin sheet each round** — On `start-round`, all `voterState` entries are reset to `{type:null, handle:null, line:null}` so existing voters can re-vote without physically navigating away. voter.html listens for `state-update` with `phase:'voting'` and calls `buildCategoryUI()` to re-render.

4. **`voter-dots` shows right-half only** — The server doesn't expose which side (in/out) other voters chose, so all live voter dots on the display are shown on the right (out) half of the tee line. Only the current voter's broom dot respects the in/out side.

---

## Deploy Workflow

**Local → Droplet:**
```bash
# On local machine (Windows)
cd "C:\Users\Chris\Claude Stuff\curling-vote"
git add <files>
git commit -m "..."
git push

# On DigitalOcean droplet
cd /srv/curling-vote
git pull
pm2 restart <app-name>   # check name with: pm2 list
```

**First-time droplet setup:**
```bash
git clone <repo> /srv/curling-vote
cd /srv/curling-vote
npm install
cp .env.example .env
# edit .env with real values
pm2 start server.js --name curling-vote
pm2 save
```

---

## Color Palette (CSS vars, shared across pages)

```css
--bg:    #080e1c   /* deep navy background */
--bg2:   #0f1a2e   /* card background */
--ice:   #4fc3f7   /* light blue accent */
--slate: #1e2d45   /* border/divider */
--text:  #e8f4f8   /* primary text */
--muted: #7a9ab5   /* secondary text */
--gold:  #ffd700   /* highlights, avg markers, broom dot */
```

Stone colors: `red`, `yellow`, `blue`, `black`, `white`, `green`, `orange`, `purple`

---

## Updating This File

When making significant changes, update the relevant section(s) of this file in the same commit. Sections most likely to need updates:
- Socket events table (server.js changes)
- SVG sizes / constants (display.html / voter.html changes)
- Line position math (if range or formula changes)
- Known gotchas (new bugs discovered and fixed)
- Env vars (new config added)
