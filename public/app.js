(() => {
  'use strict';

  const ROWS = 6;
  const COLS = 7;
  const EMOJIS = ['👍', '😂', '😮', '😭', '🔥', '👏'];
  const BASE_TITLE = 'Four in a Row';
  const $ = (id) => document.getElementById(id);

  // ---------- storage ----------
  // localStorage keeps your name and theme; sessionStorage keeps this tab's seat in a game,
  // so two tabs on the same computer can play each other.
  function safeStorage(kind) {
    let s = null;
    try { s = window[kind]; s.getItem('x'); } catch { s = null; }
    return {
      get(k) { try { return s ? s.getItem(k) : null; } catch { return null; } },
      set(k, v) { try { if (s) s.setItem(k, v); } catch { /* ignore */ } },
      del(k) { try { if (s) s.removeItem(k); } catch { /* ignore */ } },
    };
  }
  const persistent = safeStorage('localStorage');
  const tabStore = safeStorage('sessionStorage');

  // ---------- theme ----------
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = persistent.get('four.theme') || (prefersDark ? 'dark' : 'light');
  $('theme-toggle').addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    persistent.set('four.theme', next);
  });

  // ---------- small helpers ----------
  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }, 3500);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }

  // ---------- views ----------
  const lobbyEl = $('lobby');
  const gameEl = $('game');
  const connEl = $('conn');

  function showView(name) {
    lobbyEl.hidden = name !== 'lobby';
    gameEl.hidden = name !== 'game';
    connEl.hidden = name !== 'game';
    if (name === 'lobby') document.title = BASE_TITLE;
  }

  function setConn(stateName) {
    connEl.dataset.state = stateName;
    $('conn-text').textContent = stateName === 'live' ? 'Live' : 'Reconnecting…';
  }

  // ---------- invite links ----------
  let inviteBase = location.origin;
  let sharingHint = '';
  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      const onLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      if (!onLoopback) return;
      if (info.shared && info.lan.length) {
        inviteBase = `http://${info.lan[0]}:${info.port}`;
      } else if (!info.shared) {
        sharingHint = 'This link only works on this computer (try a second tab). To play from another device, restart the server with HOST=0.0.0.0.';
      }
      if (state) renderWaiting(state);
    })
    .catch(() => { /* optional */ });

  const inviteLink = (code) => `${inviteBase}/#${code}`;

  // ---------- build the board once ----------
  const boardEl = $('board');
  const dropRow = $('drop-row');
  const colEls = [];
  const slotEls = [];
  let hoverCol = 3;

  for (let c = 0; c < COLS; c++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'col';
    btn.setAttribute('aria-label', `Drop in column ${c + 1}`);
    for (let r = 0; r < ROWS; r++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      btn.appendChild(cell);
    }
    btn.addEventListener('click', () => play(c));
    btn.addEventListener('mouseenter', () => setHover(c));
    btn.addEventListener('focus', () => setHover(c));
    boardEl.appendChild(btn);
    colEls.push(btn);

    const slot = document.createElement('div');
    slot.className = 'slot';
    dropRow.appendChild(slot);
    slotEls.push(slot);
  }

  function setHover(c, fromBoard) {
    hoverCol = c;
    if (b3d && !fromBoard) b3d.setHover(c);
    colEls.forEach((el, i) => el.classList.toggle('hover', i === c));
    renderGhost();
  }

  function renderGhost() {
    slotEls.forEach((s) => { s.innerHTML = ''; });
    if (!state || !isPlayable(state) || state.board[0][hoverCol]) return;
    const d = document.createElement('div');
    d.className = `disc ghost p${state.turn}`;
    slotEls[hoverCol].appendChild(d);
  }

  // reactions bar
  const reactionsEl = $('reactions');
  for (const emoji of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.setAttribute('aria-label', `Send ${emoji}`);
    b.addEventListener('click', () => {
      if (!session) return;
      api('POST', `/api/rooms/${session.code}/react`, { token: session.token, emoji }).catch(() => { /* rate limited */ });
    });
    reactionsEl.appendChild(b);
  }

  // ---------- 3D board (optional; falls back to the flat board) ----------
  let b3d = null;
  let want3d = persistent.get('four.view3d') !== '0';
  const wrapEl = document.querySelector('.board-wrap');
  const viewBtn = $('view-toggle');

  function apply3dMode() {
    const on = !!b3d && want3d;
    wrapEl.classList.toggle('is3d', on);
    gameEl.classList.toggle('mode3d', on);
    $('stage3d').hidden = !on;
    viewBtn.hidden = !b3d;
    viewBtn.setAttribute('aria-pressed', String(on));
    viewBtn.textContent = on ? '3D' : '2D';
    if (b3d) { on ? b3d.start() : b3d.stop(); if (on) b3d.resize(); }
  }

  function initBoard3d() {
    if (b3d || !window.Board3D) return;
    b3d = window.Board3D.create($('stage3d'), {
      onPick: (c) => play(c),
      onHover: (c) => setHover(c, true),
    });
    if (!b3d) return;
    apply3dMode();
    if (state) push3d(state, false);
  }
  viewBtn.addEventListener('click', () => {
    want3d = !want3d;
    persistent.set('four.view3d', want3d ? '1' : '0');
    apply3dMode();
    if (state && want3d) push3d(state, false);
  });
  window.addEventListener('board3d-ready', initBoard3d);

  function push3d(s, animate) {
    if (!b3d) return;
    b3d.update({
      board: s.board,
      lastMove: s.lastMove,
      animate,
      win: s.winLine || [],
      turn: s.turn,
      playable: isPlayable(s),
    });
  }

  // ---------- game state ----------
  let session = null; // { code, token, seat }
  let state = null;
  let es = null;
  let animatedKey = null;
  let busy = false;
  let aliveTimer = null;

  const isPlayable = (s) => s.status === 'playing' && s.you > 0 && (s.local || s.turn === s.you);

  function describe(s) {
    const nm = (seat) => (s.players[seat] && s.players[seat].name) || `Player ${seat}`;
    if (s.status === 'waiting') return { text: s.you === 1 ? 'Waiting for your opponent to join…' : 'Waiting for players…', seat: 0 };
    if (s.status === 'draw') return { text: "It's a draw — the board is full.", seat: 0 };
    if (s.status === 'won') {
      if (!s.local && s.you === s.winner) return { text: 'You win! 🎉', seat: s.winner, me: true };
      return { text: `${nm(s.winner)} wins${s.local ? '! 🎉' : ''}`, seat: s.winner };
    }
    if (s.local || s.you === 0) return { text: `${nm(s.turn)}'s turn`, seat: s.turn };
    if (s.you === s.turn) return { text: 'Your turn — pick a column', seat: s.turn, me: true };
    const opp = s.players[s.turn];
    if (opp && !opp.connected) return { text: `${nm(s.turn)} is offline — waiting for them to return`, seat: s.turn };
    return { text: `${nm(s.turn)} is thinking…`, seat: s.turn };
  }

  function renderWaiting(s) {
    const show = s.status === 'waiting' && s.you === 1;
    $('waiting').hidden = !show;
    if (!show) return;
    $('big-code').textContent = s.code;
    $('invite-link').textContent = inviteLink(s.code);
    $('invite-hint').textContent = sharingHint;
  }

  function render(s) {
    const first = state === null;
    state = s;
    showView('game');
    $('room-code').textContent = s.code;

    // players
    for (const seat of [1, 2]) {
      const card = $('pl' + seat);
      const p = s.players[seat];
      const tags = [];
      if (!s.local && s.you === seat) tags.push('You');
      if (p && !p.connected) tags.push('Offline');
      card.querySelector('.pl-name').textContent = p ? p.name : 'Waiting…';
      card.querySelector('.pl-meta').textContent = tags.join(' · ');
      card.querySelector('.score').textContent = s.scores[seat];
      card.classList.toggle('active', s.status === 'playing' && s.turn === seat);
      card.classList.toggle('offline', !!p && !p.connected);
      card.classList.toggle('empty', !p);
    }

    // banner
    const banner = $('banner');
    const d = describe(s);
    if (banner.textContent !== d.text) {
      banner.textContent = d.text;
      banner.classList.remove('pop');
      void banner.offsetWidth;
      banner.classList.add('pop');
    }
    banner.dataset.seat = String(d.seat);
    banner.classList.toggle('me', !!d.me);

    // discs: only the newest piece gets the drop animation
    const key = s.lastMove ? `${s.version}:${s.moveCount}` : null;
    const animate = !first && !!s.lastMove && key !== animatedKey;
    animatedKey = key;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = colEls[c].children[r];
        const v = s.board[r][c];
        let disc = cell.firstElementChild;
        if (!v) {
          if (disc) disc.remove();
          continue;
        }
        if (!disc || Number(disc.dataset.v) !== v) {
          if (!disc) {
            disc = document.createElement('div');
            cell.appendChild(disc);
          }
          disc.dataset.v = String(v);
          disc.className = `disc p${v}`;
          if (animate && s.lastMove.row === r && s.lastMove.col === c) {
            disc.style.setProperty('--drop', String(r + 1));
            disc.classList.add('drop');
          }
        }
      }
    }

    // winning four glow (after the last disc lands)
    const winSet = new Set((s.winLine || []).map(([r, c]) => r * COLS + c));
    const applyWin = () => {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const disc = colEls[c].children[r].firstElementChild;
          if (disc) disc.classList.toggle('win', winSet.has(r * COLS + c));
        }
      }
    };
    if (winSet.size && animate) {
      const wait = 350 + (s.lastMove.row + 1) * 50 + 200;
      setTimeout(() => { if (state === s) applyWin(); }, wait);
    } else {
      applyWin();
    }

    // columns
    const playable = isPlayable(s);
    colEls.forEach((el, c) => {
      const full = s.board[0][c] !== 0;
      el.classList.toggle('can-drop', playable && !full);
      el.setAttribute('aria-disabled', String(!(playable && !full)));
    });
    renderGhost();
    push3d(s, animate);

    // chrome around the board
    renderWaiting(s);
    $('again').hidden = !((s.status === 'won' || s.status === 'draw') && s.you > 0);
    reactionsEl.hidden = s.local || s.you === 0 || s.status === 'waiting';

    document.title = playable && !s.local ? `● Your turn · ${BASE_TITLE}` : BASE_TITLE;
  }

  // ---------- actions ----------
  async function play(col) {
    if (!state || !session || busy) return;
    if (!isPlayable(state)) return;
    if (state.board[0][col]) {
      const el = colEls[col];
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
      if (b3d) b3d.reject(col);
      return;
    }
    busy = true;
    try {
      await api('POST', `/api/rooms/${session.code}/move`, { token: session.token, col });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy = false;
    }
  }

  $('again').addEventListener('click', async () => {
    if (!session) return;
    try {
      await api('POST', `/api/rooms/${session.code}/rematch`, { token: session.token });
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  async function copyInvite() {
    if (!state) return;
    const ok = await copyText(inviteLink(state.code));
    toast(ok ? 'Invite link copied' : `Copy this link: ${inviteLink(state.code)}`);
  }
  $('copy-link').addEventListener('click', copyInvite);
  $('copy-link-2').addEventListener('click', copyInvite);

  $('leave').addEventListener('click', () => {
    if (state && state.status === 'playing' && !state.local && state.you > 0 &&
        !confirm('Leave this game? Your opponent will be left waiting.')) return;
    leaveGame();
  });

  // keyboard: arrows move the ghost disc, Enter/Space or 1-7 drop
  document.addEventListener('keydown', (e) => {
    if (gameEl.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHover(Math.max(0, hoverCol - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setHover(Math.min(COLS - 1, hoverCol + 1)); }
    else if ((e.key === 'Enter' || e.key === ' ') && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); play(hoverCol); }
    else if (/^[1-7]$/.test(e.key)) { play(Number(e.key) - 1); }
  });

  // ---------- live connection ----------
  function closeStream() {
    if (es) { es.close(); es = null; }
    clearTimeout(aliveTimer);
  }

  function connect() {
    closeStream();
    const url = `/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token || '')}`;
    es = new EventSource(url);
    es.onopen = () => setConn('live');
    es.onerror = () => { setConn('offline'); checkRoomAlive(); };
    es.addEventListener('state', (e) => render(JSON.parse(e.data)));
    es.addEventListener('reaction', (e) => floatReaction(JSON.parse(e.data)));
  }

  // EventSource retries by itself, but if the room is gone (server restarted, expired) stop and say so
  function checkRoomAlive() {
    clearTimeout(aliveTimer);
    aliveTimer = setTimeout(async () => {
      if (!session) return;
      try {
        const r = await fetch(`/api/rooms/${session.code}`);
        if (r.status === 404) leaveGame('That game has ended or no longer exists.');
      } catch { /* server unreachable — keep retrying */ }
    }, 2500);
  }

  function floatReaction({ seat, emoji }) {
    const card = $('pl' + seat);
    if (!card) return;
    const r = card.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'float-emoji';
    el.textContent = emoji;
    el.style.left = `${r.left + r.width / 2 + (Math.random() * 40 - 20)}px`;
    el.style.top = `${r.bottom - 8}px`;
    $('fx').appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }

  // ---------- entering and leaving games ----------
  function enterGame(sess) {
    session = sess;
    tabStore.set('four.session', JSON.stringify(sess));
    history.replaceState(null, '', `#${sess.code}`);
    state = null;
    animatedKey = null;
    busy = false;
    setConn('live');
    connect();
  }

  function leaveGame(message) {
    closeStream();
    session = null;
    state = null;
    tabStore.del('four.session');
    history.replaceState(null, '', location.pathname);
    colEls.forEach((el) => el.querySelectorAll('.cell').forEach((cell) => { cell.innerHTML = ''; }));
    if (b3d) b3d.reset();
    $('invite-note').hidden = true;
    $('code').value = '';
    showView('lobby');
    if (message) lobbyError(message);
  }

  // ---------- lobby ----------
  const nameInput = $('name');
  const codeInput = $('code');
  nameInput.value = persistent.get('four.name') || '';

  function currentName() {
    const n = nameInput.value.trim();
    persistent.set('four.name', n);
    return n;
  }

  function lobbyError(msg) {
    const el = $('lobby-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function setLobbyBusy(on) {
    for (const id of ['create', 'local', 'join']) $(id).disabled = on;
  }

  async function startGame(local) {
    lobbyError('');
    setLobbyBusy(true);
    try {
      const r = await api('POST', '/api/rooms', { name: currentName(), local });
      enterGame({ code: r.code, token: r.token, seat: r.seat });
    } catch (e) {
      lobbyError(e.message);
    } finally {
      setLobbyBusy(false);
    }
  }
  $('create').addEventListener('click', () => startGame(false));
  $('local').addEventListener('click', () => startGame(true));

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    lobbyError('');
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) return lobbyError('Enter the 4-character game code.');

    let token = '';
    try {
      const prev = JSON.parse(tabStore.get('four.session') || 'null');
      if (prev && prev.code === code) token = prev.token;
    } catch { /* ignore */ }

    setLobbyBusy(true);
    try {
      const r = await api('POST', `/api/rooms/${code}/join`, { name: currentName(), token });
      if (r.seat === 0) toast('That game already has two players — you are watching.');
      enterGame({ code: r.code, token: r.token, seat: r.seat });
    } catch (err) {
      lobbyError(err.message);
    } finally {
      setLobbyBusy(false);
    }
  });

  function codeFromHash() {
    return location.hash.slice(1).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  }

  function showInvite(code) {
    codeInput.value = code;
    const note = $('invite-note');
    note.textContent = `You've been invited to game ${code}. Enter your name and press Join.`;
    note.hidden = false;
    (nameInput.value ? $('join') : nameInput).focus();
  }

  window.addEventListener('hashchange', () => {
    const code = codeFromHash();
    if (!session && code.length === 4) showView('lobby'), showInvite(code);
  });

  // ---------- start ----------
  initBoard3d();
  (function boot() {
    const hashCode = codeFromHash();
    let saved = null;
    try { saved = JSON.parse(tabStore.get('four.session') || 'null'); } catch { /* ignore */ }

    if (saved && saved.code && (!hashCode || hashCode === saved.code)) {
      showView('game');
      enterGame(saved); // resume after a refresh
      return;
    }
    showView('lobby');
    if (hashCode.length === 4) showInvite(hashCode);
  })();
})();
