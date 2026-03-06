require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ─── Config ────────────────────────────────────────────────────────────────────

const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || 'admin-change-me';
let   VOTER_TOKEN          = process.env.VOTER_TOKEN || crypto.randomBytes(16).toString('hex');
const PUBLIC_URL           = (process.env.PUBLIC_URL || 'http://localhost').replace(/\/$/, '');
const VOTER_TOKEN_REQUIRED = process.env.VOTER_TOKEN_REQUIRED !== 'false';

const SSL_KEY  = process.env.SSL_KEY;
const SSL_CERT = process.env.SSL_CERT;
const USE_SSL  = !!(SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT));

// ─── Express + Socket.io ───────────────────────────────────────────────────────

const app = express();
app.use(express.static('public'));

// /vote — token required only if VOTER_TOKEN_REQUIRED=true (default)
app.get('/vote', (req, res) => {
  if (VOTER_TOKEN_REQUIRED && !req.query.t) return res.redirect('/');
  res.sendFile('voter.html', { root: 'public' });
});

// HTTP → HTTPS redirect when SSL is active
if (USE_SSL) {
  const redirectApp = express();
  redirectApp.use((req, res) => {
    res.redirect(301, PUBLIC_URL + req.url);
  });
  http.createServer(redirectApp).listen(80, () => {
    console.log('HTTP redirect server running on port 80');
  });
}

const server = USE_SSL
  ? https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) }, app)
  : http.createServer(app);

const io = new Server(server);

// ─── Constants ─────────────────────────────────────────────────────────────────

const VOTE_CATEGORIES = {
  type:   { label: 'Shot Type', options: ['guard', 'draw', 'takeout'], labels: { guard: 'Guard', draw: 'Draw', takeout: 'Takeout' } },
  handle: { label: 'Handle',    options: ['in', 'out'],                labels: { in: 'In Turn (L)', out: 'Out Turn (R)' } },
  line:   { label: 'Line',      options: ['12', '8', '4', '2'],       labels: { '12': "12'", '8': "8'", '4': "4'", '2': "2'" } },
};

// ─── App State ─────────────────────────────────────────────────────────────────

let setupDone = false;
let sheetNames = []; // e.g. ['A','B','C'] or ['1','2','3']

// sheetId → sheet state
const sheets = {};

function makeSheetState() {
  return {
    phase: 'idle',   // idle | voting | result
    round: 0,
    countdown: 30,
    timeRemaining: 0,
    stoneColor: 'red',  // color indicator set by admin
    votes: {
      type:   { guard: 0, draw: 0, takeout: 0 },
      handle: { in: 0, out: 0 },
      line:   { '12': 0, '8': 0, '4': 0, '2': 0 },
    },
    winners: { type: null, handle: null, line: null },
    voterState: new Map(),  // socketId → { type, handle, line }
    timer: null,
  };
}

function initSheets(names) {
  sheetNames = names;
  for (const name of names) {
    sheets[name] = makeSheetState();
  }
}

// ─── QR Code ───────────────────────────────────────────────────────────────────

async function buildQR() {
  const url = `${PUBLIC_URL}/vote?t=${VOTER_TOKEN}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#0a1628', light: '#e8f4f8' } });
  return { url, dataUrl };
}

// ─── Vote helpers ──────────────────────────────────────────────────────────────

function emptyVotes() {
  return {
    type:   { guard: 0, draw: 0, takeout: 0 },
    handle: { in: 0, out: 0 },
    line:   { '12': 0, '8': 0, '4': 0, '2': 0 },
  };
}

function applyVoterDelta(sheet, socketId, category, newChoice, oldChoice) {
  if (oldChoice && sheet.votes[category][oldChoice] !== undefined) {
    sheet.votes[category][oldChoice] = Math.max(0, sheet.votes[category][oldChoice] - 1);
  }
  if (newChoice && sheet.votes[category][newChoice] !== undefined) {
    sheet.votes[category][newChoice]++;
  }
}

function findWinner(voteCounts) {
  let max = -1, winner = null;
  for (const [key, count] of Object.entries(voteCounts)) {
    if (count > max) { max = count; winner = key; }
  }
  return max > 0 ? winner : null;
}

function endVoting(sheetId) {
  const sheet = sheets[sheetId];
  if (!sheet) return;
  clearInterval(sheet.timer);
  sheet.timer = null;
  sheet.phase = 'result';
  sheet.timeRemaining = 0;
  sheet.winners = {
    type:   findWinner(sheet.votes.type),
    handle: findWinner(sheet.votes.handle),
    line:   findWinner(sheet.votes.line),
  };
  io.to(`sheet:${sheetId}`).emit('state-update', publicSheet(sheetId));
  io.to('admin').emit('state-update', publicSheet(sheetId));
  io.to('display').emit('state-update', publicSheet(sheetId));
}

// ─── Serialisation ─────────────────────────────────────────────────────────────

function publicSheet(sheetId) {
  const s = sheets[sheetId];
  if (!s) return null;
  const totalVoters = s.voterState.size;
  return {
    sheetId,
    phase: s.phase,
    round: s.round,
    countdown: s.countdown,
    timeRemaining: s.timeRemaining,
    stoneColor: s.stoneColor,
    votes: s.votes,
    winners: s.winners,
    totalVoters,
    categories: VOTE_CATEGORIES,
  };
}

function allSheetsPublic() {
  return sheetNames.map(id => publicSheet(id));
}

// ─── Socket.io middleware ──────────────────────────────────────────────────────

io.use((socket, next) => {
  const { role, token, adminToken } = socket.handshake.query;

  if (role === 'display') return next();

  if (role === 'admin') {
    if (adminToken === ADMIN_TOKEN) return next();
    return next(new Error('Unauthorized'));
  }

  // voter
  if (!VOTER_TOKEN_REQUIRED || token === VOTER_TOKEN) return next();
  return next(new Error('Invalid voter token'));
});

// ─── Socket.io connections ─────────────────────────────────────────────────────

io.on('connection', async (socket) => {
  const role = socket.handshake.query.role || 'voter';

  // ── Display ────────────────────────────────────────────────────────────────
  if (role === 'display') {
    socket.join('display');
    const qr = await buildQR();
    socket.emit('init', {
      setup: setupDone,
      sheets: allSheetsPublic(),
      sheetNames,
      categories: VOTE_CATEGORIES,
      qr,
    });
    return;
  }

  // ── Admin ──────────────────────────────────────────────────────────────────
  if (role === 'admin') {
    socket.join('admin');
    const qr = await buildQR();
    socket.emit('init', {
      setup: setupDone,
      sheets: allSheetsPublic(),
      sheetNames,
      categories: VOTE_CATEGORIES,
      qr,
    });

    socket.on('setup', ({ count, scheme }) => {
      if (setupDone) return;
      count = Math.min(48, Math.max(1, parseInt(count) || 1));
      let names;
      if (scheme === 'letter') {
        names = Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i));
      } else {
        names = Array.from({ length: count }, (_, i) => String(i + 1));
      }
      initSheets(names);
      setupDone = true;
      io.emit('setup-complete', { sheetNames, sheets: allSheetsPublic() });
    });

    socket.on('start-round', async ({ sheetId, countdown }) => {
      const sheet = sheets[sheetId];
      if (!sheet || sheet.phase === 'voting') return;

      clearInterval(sheet.timer);

      // Reset existing voter selections to null so voters already on the sheet
      // can vote again without needing to rejoin (fixes the "must rejoin" bug)
      for (const state of sheet.voterState.values()) {
        state.type = null; state.handle = null; state.line = null;
      }
      sheet.votes = emptyVotes();
      sheet.winners = { type: null, handle: null, line: null };
      sheet.phase = 'voting';
      sheet.round++;
      sheet.countdown = parseInt(countdown) || 30;
      sheet.timeRemaining = sheet.countdown;

      const update = publicSheet(sheetId);
      io.to(`sheet:${sheetId}`).emit('state-update', update);
      io.to('admin').emit('state-update', update);
      io.to('display').emit('state-update', update);

      sheet.timer = setInterval(() => {
        sheet.timeRemaining = Math.max(0, sheet.timeRemaining - 1);
        const tick = { sheetId, timeRemaining: sheet.timeRemaining };
        io.to(`sheet:${sheetId}`).emit('timer-tick', tick);
        io.to('admin').emit('timer-tick', tick);
        io.to('display').emit('timer-tick', tick);
        if (sheet.timeRemaining <= 0) endVoting(sheetId);
      }, 1000);
    });

    socket.on('force-end', ({ sheetId }) => {
      if (sheets[sheetId]?.phase === 'voting') endVoting(sheetId);
    });

    socket.on('throw-complete', ({ sheetId }) => {
      const sheet = sheets[sheetId];
      if (!sheet || sheet.phase !== 'result') return;
      sheet.phase = 'idle';
      const update = publicSheet(sheetId);
      io.to(`sheet:${sheetId}`).emit('state-update', update);
      io.to('admin').emit('state-update', update);
      io.to('display').emit('state-update', update);
    });

    socket.on('set-stone-color', ({ sheetId, color }) => {
      const sheet = sheets[sheetId];
      if (!sheet) return;
      sheet.stoneColor = color;
      const update = publicSheet(sheetId);
      io.to(`sheet:${sheetId}`).emit('state-update', update);
      io.to('admin').emit('state-update', update);
      io.to('display').emit('state-update', update);
    });

    socket.on('rotate-token', async () => {
      VOTER_TOKEN = crypto.randomBytes(16).toString('hex');
      const qr = await buildQR();
      // Kick all current voter sockets
      io.in('voter').disconnectSockets(true);
      io.to('admin').emit('token-rotated', qr);
      io.to('display').emit('qr-update', qr);
      console.log(`Voter token rotated. New voter URL: ${qr.url}`);
    });

    socket.on('reset-all', () => {
      for (const [id, sheet] of Object.entries(sheets)) {
        clearInterval(sheet.timer);
        sheets[id] = makeSheetState();
      }
      setupDone = false;
      sheetNames = [];
      io.emit('full-reset');
    });

    return;
  }

  // ── Voter ──────────────────────────────────────────────────────────────────
  socket.join('voter');

  socket.emit('init', {
    setup: setupDone,
    sheetNames,
    categories: VOTE_CATEGORIES,
  });

  // Voter joins a specific sheet
  socket.on('join-sheet', ({ sheetId }) => {
    const sheet = sheets[sheetId];
    if (!sheet) return socket.emit('error', 'Unknown sheet');

    // Leave any previous sheet rooms
    for (const name of sheetNames) {
      socket.leave(`sheet:${name}`);
      // Remove old voter state
      if (sheets[name]) {
        const old = sheets[name].voterState.get(socket.id);
        if (old) {
          // Roll back any live votes
          for (const cat of ['type', 'handle', 'line']) {
            if (old[cat]) {
              sheets[name].votes[cat][old[cat]] = Math.max(0, sheets[name].votes[cat][old[cat]] - 1);
            }
          }
          sheets[name].voterState.delete(socket.id);
          broadcastVotes(name);
        }
      }
    }

    socket.join(`sheet:${sheetId}`);
    sheet.voterState.set(socket.id, { type: null, handle: null, line: null });
    socket.emit('sheet-joined', publicSheet(sheetId));
  });

  // Live vote — called when voter taps an option in any category
  socket.on('vote', ({ sheetId, category, choice }) => {
    const sheet = sheets[sheetId];
    if (!sheet || sheet.phase !== 'voting') return;
    if (!VOTE_CATEGORIES[category]) return;
    if (!VOTE_CATEGORIES[category].options.includes(choice)) return;

    const voterCurrent = sheet.voterState.get(socket.id);
    if (!voterCurrent) return; // hasn't joined this sheet properly

    const oldChoice = voterCurrent[category];
    voterCurrent[category] = choice;
    applyVoterDelta(sheet, socket.id, category, choice, oldChoice);

    socket.emit('vote-ack', { category, choice });
    broadcastVotes(sheetId);
  });

  socket.on('disconnect', () => {
    for (const [sheetId, sheet] of Object.entries(sheets)) {
      const state = sheet.voterState.get(socket.id);
      if (state) {
        for (const cat of ['type', 'handle', 'line']) {
          if (state[cat]) {
            sheet.votes[cat][state[cat]] = Math.max(0, sheet.votes[cat][state[cat]] - 1);
          }
        }
        sheet.voterState.delete(socket.id);
        broadcastVotes(sheetId);
      }
    }
  });
});

function broadcastVotes(sheetId) {
  const sheet = sheets[sheetId];
  if (!sheet) return;
  const payload = {
    sheetId,
    votes: sheet.votes,
    totalVoters: sheet.voterState.size,
  };
  io.to(`sheet:${sheetId}`).emit('votes-update', payload);
  io.to('admin').emit('votes-update', payload);
  io.to('display').emit('votes-update', payload);
}

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = USE_SSL ? 443 : 80;
server.listen(PORT, () => {
  const voterUrl = `${PUBLIC_URL}/vote?t=${VOTER_TOKEN}`;
  console.log('\n=== Curling Vote ===');
  console.log(`Mode    : ${USE_SSL ? 'HTTPS' : 'HTTP'} on port ${PORT}`);
  console.log(`Display : ${PUBLIC_URL}/display.html`);
  console.log(`Admin   : ${PUBLIC_URL}/admin.html`);
  console.log(`Voter   : ${voterUrl}`);
  console.log(`Admin token: ${ADMIN_TOKEN}`);
  console.log('====================\n');
});
