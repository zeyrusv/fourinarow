import * as THREE from './vendor/three.module.min.js';

const ROWS = 6;
const COLS = 7;
const R_DISC = 0.41;
const T_DISC = 0.5;
const T_BOARD = 0.74;
const DROP_Y = 4.25;          // where discs start / the ghost hovers
const GRAVITY = 70;
const COLORS = { 1: 0xff5a67, 2: 0xffc83d };
const BOARD_COLORS = { light: 0x3558f0, dark: 0x2748c9 };

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const cellX = (c) => c - (COLS - 1) / 2;
const cellY = (r) => (ROWS - 1) / 2 - r;

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

function makeDiscGeometry() {
  // coin-like profile: flat faces, softly rounded rim
  const pts = [];
  const h = T_DISC / 2;
  const bevel = 0.07;
  pts.push(new THREE.Vector2(0, h));
  pts.push(new THREE.Vector2(R_DISC - bevel, h));
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI / 2;
    pts.push(new THREE.Vector2(R_DISC - bevel + Math.sin(a) * bevel, h - bevel + Math.cos(a) * bevel));
  }
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI / 2;
    pts.push(new THREE.Vector2(R_DISC - bevel + Math.cos(a) * bevel, -h + bevel - Math.sin(a) * bevel));
  }
  pts.push(new THREE.Vector2(R_DISC - bevel, -h));
  pts.push(new THREE.Vector2(0, -h));
  const g = new THREE.LatheGeometry(pts, 56);
  g.rotateX(Math.PI / 2); // axis along z
  return g;
}

function makeBoardGeometry() {
  const w = COLS + 0.7, h = ROWS + 0.7, r = 0.45;
  const shape = new THREE.Shape();
  const x0 = -w / 2, y0 = -h / 2;
  shape.moveTo(x0 + r, y0);
  shape.lineTo(x0 + w - r, y0);
  shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  shape.lineTo(x0 + w, y0 + h - r);
  shape.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  shape.lineTo(x0 + r, y0 + h);
  shape.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  shape.lineTo(x0, y0 + r);
  shape.quadraticCurveTo(x0, y0, x0 + r, y0);
  for (let c = 0; c < COLS; c++) {
    for (let rr = 0; rr < ROWS; rr++) {
      const hole = new THREE.Path();
      hole.absarc(cellX(c), cellY(rr), 0.455, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: T_BOARD, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.04,
    bevelSegments: 3, curveSegments: 40,
  });
  g.translate(0, 0, -T_BOARD / 2);
  return g;
}

function create(container, handlers = {}) {
  if (!webglOK()) return null;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch { return null; }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = 'stage3d-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const camTarget = new THREE.Vector3(0, 0.55, 0);
  let baseCam = new THREE.Vector3(0, 0.9, 17);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8794b8, 1.15);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-5, 9, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -8; key.shadow.camera.right = 8;
  key.shadow.camera.top = 9; key.shadow.camera.bottom = -6;
  key.shadow.camera.near = 1; key.shadow.camera.far = 40;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9db4ff, 0.9);
  rim.position.set(6, 3, -6);
  scene.add(rim);

  // ---- board ----
  const boardMat = new THREE.MeshPhysicalMaterial({
    color: BOARD_COLORS.light, roughness: 0.32, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25,
  });
  const boardGroup = new THREE.Group();
  const board = new THREE.Mesh(makeBoardGeometry(), boardMat);
  board.castShadow = true; board.receiveShadow = true;
  boardGroup.add(board);

  const footMat = new THREE.MeshStandardMaterial({ color: 0x1f2a5c, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 2.6), footMat);
    foot.position.set(sx * 3.1, -(ROWS + 0.7) / 2 - 0.13, 0);
    foot.castShadow = true; foot.receiveShadow = true;
    boardGroup.add(foot);
  }
  scene.add(boardGroup);

  const groundY = -(ROWS + 0.7) / 2 - 0.34;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.25 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = groundY;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- column highlight ----
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false });
  const highlight = new THREE.Mesh(new THREE.PlaneGeometry(0.98, ROWS + 0.4), hlMat);
  highlight.position.set(0, 0, T_BOARD / 2 + 0.07);
  highlight.visible = false;
  scene.add(highlight);

  // ---- discs ----
  const discGeo = makeDiscGeometry();
  const dotGeo = new THREE.CircleGeometry(R_DISC * 0.38, 32);
  const ringGeo = new THREE.RingGeometry(R_DISC * 0.5, R_DISC * 0.68, 40);
  const markMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.2, depthWrite: false });
  const haloGeo = new THREE.RingGeometry(R_DISC + 0.02, R_DISC + 0.1, 48);
  const matCache = {};
  const discMat = (seat) => matCache[seat] || (matCache[seat] = new THREE.MeshPhysicalMaterial({
    color: COLORS[seat], roughness: 0.28, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.2,
    emissive: COLORS[seat], emissiveIntensity: 0,
  }));

  function buildDisc(seat, ghost) {
    const g = new THREE.Group();
    const mat = ghost
      ? new THREE.MeshPhysicalMaterial({ color: COLORS[seat], roughness: 0.4, transparent: true, opacity: 0.62 })
      : discMat(seat).clone();
    const body = new THREE.Mesh(discGeo, mat);
    body.castShadow = !ghost;
    body.receiveShadow = !ghost;
    g.add(body);
    // markers (so colour is never the only clue): p1 = dot, p2 = ring — on both faces
    for (const s of [1, -1]) {
      const m = new THREE.Mesh(seat === 1 ? dotGeo : ringGeo, markMat);
      m.position.z = s * (T_DISC / 2 + 0.004);
      if (s < 0) m.rotation.y = Math.PI;
      g.add(m);
    }
    return g;
  }

  const discs = new Map();   // "r,c" -> { mesh, seat, y, vy, target, falling, bounces, win }
  const leaving = new Set(); // discs falling out of the board on reset
  let ghost = null, ghostSeat = 0;
  let hoverCol = 3;
  let playable = false;
  let pendingWin = null;
  let winActive = new Set();
  let wiggle = 0;

  function addDisc(r, c, seat, fall) {
    const mesh = buildDisc(seat, false);
    const d = { mesh, seat, r, c, target: cellY(r), y: cellY(r), vy: 0, falling: false, bounces: 0, win: false };
    mesh.position.set(cellX(c), d.y, 0);
    if (fall) {
      d.y = DROP_Y; d.falling = true;
      d.vy = reduceMotion ? 0 : -2;
      mesh.position.y = d.y;
    }
    scene.add(mesh);
    discs.set(`${r},${c}`, d);
  }

  function removeDisc(key) {
    const d = discs.get(key);
    discs.delete(key);
    if (!d) return;
    if (reduceMotion) { scene.remove(d.mesh); return; }
    d.leave = true; d.vy = 0; d.spin = (Math.random() - 0.5) * 3;
    leaving.add(d);
  }

  function setGhost() {
    const want = playable && ghostSeat ? ghostSeat : 0;
    const full = fullCols[hoverCol];
    if (want && !full) {
      if (!ghost || ghost.seat !== want) {
        if (ghost) scene.remove(ghost.mesh);
        ghost = { mesh: buildDisc(want, true), seat: want };
        scene.add(ghost.mesh);
      }
      ghost.mesh.visible = true;
      highlight.visible = true;
      highlight.position.x = cellX(hoverCol);
    } else {
      if (ghost) ghost.mesh.visible = false;
      highlight.visible = false;
    }
    renderer.domElement.style.cursor = playable && !full ? 'pointer' : 'default';
  }

  let fullCols = new Array(COLS).fill(false);

  // ---- state sync ----
  function update(s) {
    if ('playable' in s) playable = !!s.playable;
    if ('turn' in s) ghostSeat = s.turn || 0;
    if (s.board) {
      fullCols = s.board[0].map((v) => v !== 0);
      const lm = s.lastMove;
      const seen = new Set();
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const v = s.board[r][c];
          const k = `${r},${c}`;
          const cur = discs.get(k);
          if (cur && cur.seat !== v) { removeDisc(k); }
          if (v && !discs.get(k)) {
            addDisc(r, c, v, !!(s.animate && lm && lm.row === r && lm.col === c));
          }
          if (v) seen.add(k);
        }
      }
      for (const k of [...discs.keys()]) if (!seen.has(k)) removeDisc(k);

      // win glow (waits for the last disc to land)
      const wl = (s.win || []).map(([r, c]) => `${r},${c}`);
      winActive = new Set();
      for (const d of discs.values()) d.win = false;
      pendingWin = wl.length ? wl : null;
    }
    setGhost();
  }

  function setHover(c) {
    hoverCol = Math.max(0, Math.min(COLS - 1, c));
    setGhost();
  }

  function reject(c) { wiggle = 1; setHover(c); }

  // ---- input ----
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();
  const pointer = { x: 0, y: 0, active: false };

  function colFromEvent(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return -1;
    const c = Math.floor(hit.x + COLS / 2);
    if (c < 0 || c >= COLS) return -1;
    return c;
  }

  const el = renderer.domElement;
  el.addEventListener('pointermove', (e) => {
    const rect = el.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    pointer.active = e.pointerType === 'mouse';
    const c = colFromEvent(e);
    if (c >= 0 && c !== hoverCol) { setHover(c); handlers.onHover && handlers.onHover(c); }
  });
  el.addEventListener('pointerleave', () => { pointer.active = false; });
  el.addEventListener('pointerdown', (e) => {
    const c = colFromEvent(e);
    if (c >= 0 && c !== hoverCol) { setHover(c); handlers.onHover && handlers.onHover(c); }
  });
  el.addEventListener('click', (e) => {
    const c = colFromEvent(e);
    if (c >= 0) handlers.onPick && handlers.onPick(c);
  });

  // ---- sizing ----
  const FOV_T = Math.tan((camera.fov * Math.PI / 180) / 2);
  function resize() {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const needH = 9.6, needW = 8.6;
    const dist = Math.max(needH / 2 / FOV_T, needW / 2 / (FOV_T * camera.aspect));
    baseCam.set(0, 0.9 + dist * 0.02, dist);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ---- theme ----
  function applyTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    boardMat.color.setHex(dark ? BOARD_COLORS.dark : BOARD_COLORS.light);
    ground.material.opacity = dark ? 0.5 : 0.14;
    hemi.intensity = dark ? 0.75 : 1.15;
    key.intensity = dark ? 2.0 : 2.4;
    hlMat.opacity = dark ? 0.1 : 0.14;
  }
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  applyTheme();

  // ---- loop ----
  let last = performance.now();
  let raf = 0;
  let running = false;
  const camPos = baseCam.clone();

  function step(now) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    let anyFalling = false;
    for (const d of discs.values()) {
      if (d.falling) {
        d.vy -= GRAVITY * dt;
        d.y += d.vy * dt;
        if (d.y <= d.target) {
          d.y = d.target;
          if (reduceMotion || d.bounces >= 2 || Math.abs(d.vy) < 5) {
            d.falling = false; d.vy = 0;
          } else {
            d.vy = -d.vy * (d.bounces === 0 ? 0.3 : 0.12);
            d.bounces++;
          }
        }
        d.mesh.position.y = d.y;
        if (d.falling) anyFalling = true;
      }
    }
    for (const d of [...leaving]) {
      d.vy -= GRAVITY * dt;
      d.y += d.vy * dt;
      d.mesh.position.y = d.y;
      d.mesh.rotation.z += d.spin * dt;
      if (d.y < groundY - 6) { scene.remove(d.mesh); leaving.delete(d); }
    }

    if (pendingWin && !anyFalling) {
      for (const k of pendingWin) {
        const d = discs.get(k);
        if (!d) continue;
        d.win = true; winActive.add(d);
        if (!d.halo) {
          d.halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
          d.halo.position.z = T_DISC / 2 + 0.02;
          d.mesh.add(d.halo);
        }
      }
      pendingWin = null;
    }
    for (const d of winActive) {
      if (!d.win) { winActive.delete(d); continue; }
      const p = 0.5 + 0.5 * Math.sin(t * 6);
      d.mesh.children[0].material.emissiveIntensity = 0.35 + p * 0.75;
      if (d.halo) d.halo.material.opacity = 0.55 + p * 0.45;
    }
    for (const d of discs.values()) {
      const m = d.mesh;
      const target = d.win && !reduceMotion ? 1.0 + 0.07 * (0.5 + 0.5 * Math.sin(t * 6)) : 1;
      m.scale.setScalar(target);
      m.position.z = d.win && !reduceMotion ? 0.12 : 0;
      if (!d.win) m.children[0].material.emissiveIntensity = 0;
      if (d.halo) d.halo.visible = d.win;
    }

    if (ghost && ghost.mesh.visible) {
      const tx = cellX(hoverCol);
      ghost.mesh.position.x += (tx - ghost.mesh.position.x) * Math.min(1, dt * 18);
      let wob = 0;
      if (wiggle > 0) { wob = Math.sin(wiggle * 30) * 0.12 * wiggle; wiggle = Math.max(0, wiggle - dt * 3.5); }
      ghost.mesh.position.x += wob;
      ghost.mesh.position.y = DROP_Y + (reduceMotion ? 0 : Math.sin(t * 3.2) * 0.1);
    }

    // gentle parallax
    const px = pointer.active && !reduceMotion ? pointer.x : 0;
    const py = pointer.active && !reduceMotion ? pointer.y : 0;
    const idle = reduceMotion ? 0 : Math.sin(t * 0.35) * 0.35;
    const want = new THREE.Vector3(baseCam.x + px * 2.4 + idle, baseCam.y - py * 1.2, baseCam.z);
    camPos.lerp(want, Math.min(1, dt * 4));
    camera.position.copy(camPos);
    camera.lookAt(camTarget);

    renderer.render(scene, camera);
  }

  function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(step); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  function reset() {
    for (const k of [...discs.keys()]) { const d = discs.get(k); scene.remove(d.mesh); discs.delete(k); }
    for (const d of leaving) scene.remove(d.mesh);
    leaving.clear();
    pendingWin = null; winActive = new Set();
    fullCols = new Array(COLS).fill(false);
    playable = false;
    setGhost();
  }

  start();
  return {
    update, setHover, reject, reset, resize, start, stop,
    canvas: renderer.domElement,
    // test hook
    _debug: { discs, camera, scene, renderer },
  };
}

window.Board3D = { create };
window.dispatchEvent(new Event('board3d-ready'));
