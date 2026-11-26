// Four in a Row — a tiny real-time 2-player game server.
// No dependencies, Node 16+. Live updates go out over Server-Sent Events (SSE);
// players send their moves with ordinary POST requests. The server owns all the
// rules, so neither player can cheat or move out of turn.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // use HOST=0.0.0.0 to play from other devices on your network
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROWS = 6;
const COLS = 7;
const MAX_ROOMS = 200;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // idle rooms are removed after 2 hours
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid mix-ups
const EMOJIS = ['👍', '😂', '😮', '😭', '🔥', '👏'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- game logic ----------
const rooms = new Map();

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function newRoom() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));

  const room = {
    code,
    local: false, // true = two people sharing one screen
    board: emptyBoard(),
    turn: 1,
    starter: 1,
    status: 'waiting', // waiting | playing | won | draw
    winner: 0,
    winLine: null,
    lastMove: null,
    moveCount: 0,
    scores: { 1: 0, 2: 0 },
    players: { 1: null, 2: null }, // { name, token }
    clients: new Set(), // open event streams: { res, seat }
    lastReact: { 1: 0, 2: 0 },
    version: 0, // bumps on every rematch
    updated: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function seatOf(room, token) {
  if (!token) return 0;
  for (const seat of [1, 2]) {
    const p = room.players[seat];
    if (p && safeEqual(p.token, token)) return seat;
  }
  return 0; // spectator
}

function findWin(board, row, col, seat) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [[row, col]];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === seat) {
        line.push([r, c]);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= 4) return line;
  }
  return null;
}

function cleanName(value, fallback) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return name || fallback;
}

// ---------- live updates ----------
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function publicState(room, you) {
  const isConnected = (seat) => {
    for (const c of room.clients) if (c.seat === seat) return true;
    return false;
  };
  const describe = (seat) => {
    const p = room.players[seat];
    if (!p) return null;
    return { name: p.name, connected: room.local ? true : isConnected(seat) };
  };
  return {
    code: room.code,
    local: room.local,
    board: room.board,
    turn: room.turn,
    starter: room.starter,
    status: room.status,
    winner: room.winner,
    winLine: room.winLine,
    lastMove: room.lastMove,
    moveCount: room.moveCount,
    scores: room.scores,
    version: room.version,
    you,
    players: { 1: describe(1), 2: describe(2) },
  };
}

function broadcast(room) {
  for (const client of room.clients) send(client.res, 'state', publicState(room, client.seat));
}

function touch(room) {
  room.updated = Date.now();
  broadcast(room);
}

setInterval(() => {
  for (const room of rooms.values()) for (const c of room.clients) c.res.write(': ping\n\n');
}, 15000);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.updated > ROOM_TTL_MS) rooms.delete(code);
  }
}, 5 * 60 * 1000);

// ---------- http helpers ----------
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5000) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const data = JSON.parse(raw);
        resolve(data && typeof data === 'object' ? data : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function networkInfo() {
  const lan = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) lan.push(a.address);
    }
  }
  return { port: PORT, shared: HOST !== '127.0.0.1' && HOST !== 'localhost', lan };
}

// ---------- api handlers ----------
function createRoom(body, res) {
  if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'The server is full right now. Try again later.' });
  const room = newRoom();
  const token = crypto.randomBytes(16).toString('hex');
  room.players[1] = { name: cleanName(body.name, 'Player 1'), token };
  if (body.local) {
    // hot-seat mode: one browser controls both sides, so both seats share the token
    room.local = true;
    room.players[2] = { name: 'Player 2', token };
    room.status = 'playing';
  }
  json(res, 201, { code: room.code, token, seat: 1 });
}

function handleEvents(req, res, room, url) {
  const seat = seatOf(room, url.searchParams.get('token'));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const client = { res, seat };
  room.clients.add(client);
  broadcast(room); // the newcomer gets the current state; everyone sees who is online

  req.on('close', () => {
    room.clients.delete(client);
    touch(room);
  });
}

function handleJoin(room, body, res) {
  let seat = seatOf(room, body.token);
  let token = seat ? String(body.token) : '';
  if (!seat && !room.local && !room.players[2]) {
    token = crypto.randomBytes(16).toString('hex');
    room.players[2] = { name: cleanName(body.name, 'Player 2'), token };
    seat = 2;
    if (room.status === 'waiting') room.status = 'playing';
  }
  touch(room);
  json(res, 200, { code: room.code, token, seat }); // seat 0 = spectator (room is full)
}

function handleMove(room, body, res) {
  const owner = seatOf(room, body.token);
  if (!owner) return json(res, 403, { error: 'You are not a player in this game.' });
  const seat = room.local ? room.turn : owner;

  if (room.status === 'waiting') return json(res, 409, { error: 'Waiting for an opponent to join.' });
  if (room.status !== 'playing') return json(res, 409, { error: 'This game is over.' });
  if (room.turn !== seat) return json(res, 409, { error: "It's not your turn." });

  const col = Number(body.col);
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return json(res, 400, { error: 'Invalid column.' });

  let row = -1;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (room.board[r][col] === 0) {
      row = r;
      break;
    }
  }
  if (row < 0) return json(res, 409, { error: 'That column is full.' });

  room.board[row][col] = seat;
  room.moveCount++;
  room.lastMove = { row, col, seat };

  const line = findWin(room.board, row, col, seat);
  if (line) {
    room.status = 'won';
    room.winner = seat;
    room.winLine = line;
    room.scores[seat]++;
  } else if (room.moveCount === ROWS * COLS) {
    room.status = 'draw';
  } else {
    room.turn = seat === 1 ? 2 : 1;
  }
  touch(room);
  json(res, 200, { ok: true });
}

function handleRematch(room, body, res) {
  if (!seatOf(room, body.token)) return json(res, 403, { error: 'You are not a player in this game.' });
  if (room.status !== 'won' && room.status !== 'draw') return json(res, 409, { error: 'The game is still in progress.' });
  room.board = emptyBoard();
  room.starter = room.starter === 1 ? 2 : 1; // take turns going first
  room.turn = room.starter;
  room.status = 'playing';
  room.winner = 0;
  room.winLine = null;
  room.lastMove = null;
  room.moveCount = 0;
  room.version++;
  touch(room);
  json(res, 200, { ok: true });
}

function handleReact(room, body, res) {
  const seat = seatOf(room, body.token);
  if (!seat || room.local) return json(res, 403, { error: 'Reactions are only for online players.' });
  if (!EMOJIS.includes(body.emoji)) return json(res, 400, { error: 'Unknown reaction.' });
  const now = Date.now();
  if (now - room.lastReact[seat] < 700) return json(res, 429, { error: 'Slow down!' });
  room.lastReact[seat] = now;
  for (const c of room.clients) send(c.res, 'reaction', { seat, emoji: body.emoji, id: now });
  json(res, 200, { ok: true });
}

async function handleApi(req, res, url, code, action) {
  if (!code) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    return createRoom(await readJson(req), res);
  }

  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: 'Game not found. Check the code and try again.' });

  if (!action) {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    return json(res, 200, { code: room.code, status: room.status, open: !room.local && !room.players[2] });
  }
  if (action === 'events') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    return handleEvents(req, res, room, url);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = await readJson(req);
  if (action === 'join') return handleJoin(room, body, res);
  if (action === 'move') return handleMove(room, body, res);
  if (action === 'rematch') return handleRematch(room, body, res);
  if (action === 'react') return handleReact(room, body, res);
  return json(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/api/info' && req.method === 'GET') return json(res, 200, networkInfo());

    const m = p.match(/^\/api\/rooms(?:\/([A-Za-z0-9]{4})(?:\/(events|join|move|rematch|react))?)?$/);
    if (m) return await handleApi(req, res, url, m[1] && m[1].toUpperCase(), m[2]);

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    res.writeHead(405);
    res.end();
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  Four in a Row is running\n  → http://${shown}:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const ip of networkInfo().lan) console.log(`  → http://${ip}:${PORT}   (for other devices on your network)`);
  }
  console.log('');
});
