"use strict";

// ================= constants =================
// Game units; y grows downward, floor at FLOOR_Y.
const W = 1000;
const H = 640;              // extra ground below the floor = touch-control zone
const FLOOR_Y = 500;
const SLIME_R = 46;
const GRAVITY = 0.42;
const SLIME_SPEED = 6.5;
const JUMP_VEL = -11.5;

const NET_HALF = 5;            // volleyball net half-width
const NET_TOP = FLOOR_Y - 70;

const CFG = {
  volley: { ballR: 11, ballGrav: 0.22, win: 7,  maxBall: 13 },
  soccer: { ballR: 13, ballGrav: 0.34, win: 5,  maxBall: 16,
            goalW: 64, goalH: 150, barT: 8 },
};

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

// ================= state =================
const G = {
  type: "volley",        // "volley" | "soccer"
  mode: null,            // "1p" | "2p" | "host" | "guest"
  running: false,
  paused: false,
  score: [0, 0],
  server: 0,             // side that serves / kicks off next
  freeze: 0,             // frames of freeze after a point
  flash: null,           // side that just scored
  rallyT: 0,             // frames since the current rally started
};

const NET = {
  ws: null,              // LAN transport (node server.js relay)
  peer: null,            // online transport (WebRTC via PeerJS)
  conn: null,            // guest side: reliable channel to the host
  fast: null,            // guest side: unreliable channel (state/input stream)
  joinCode: null,
  guests: new Map(),     // host side, online mode: gid -> reliable conn
  fastGuests: new Map(), // host side: gid -> unreliable conn
  inputs: new Map(),     // host side: gid -> latest input
  inputSeqs: new Map(),  // host side: gid -> last input seq (drop stale)
  inSeq: 0,              // guest side: outgoing input seq
  lastSeq: 0,            // guest side: newest state seq received
  snaps: [],             // guest side: buffered snapshots for interpolation
  myIdx: -1,             // guest side: index of own slime in the roster
  gapEma: 40,            // guest side: smoothed ms between snapshots
  lastAt: 0,
  lan: false,            // true when the local relay server is reachable
  connected: false,
  role: null,
  lastState: null,       // latest snapshot (guest side)
  info: null,            // {ips, port} from /info
};

// pre-game lobby, host side: gid -> { team: null|0|1 }
const LOBBY = { players: new Map(), hostTeam: 0 };
let myTeam = 0;          // this client's team in a network match
let chosenTeam = null;   // guest's pick on the team screen

// LAN relay available? (fails on GitHub Pages / Firebase / file:// -> online mode)
fetch("/info")
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((info) => { NET.lan = true; NET.info = info; })
  .catch(() => { NET.lan = false; });

// Teams: 0 = red (left), 1 = blue (right). Teammates get different shades.
const TEAM_COLORS = [["#e8413c", "#ff8b6b"], ["#3c6fe8", "#6fd0ff"]];
const teamName = (t) => ["RED", "BLUE"][t];

// roster: one entry per slime — { team, color, gid } where gid is null for
// the local/host player and a guest id for remote players
function defaultRoster() {
  return [
    { team: 0, color: TEAM_COLORS[0][0], gid: null },
    { team: 1, color: TEAM_COLORS[1][0], gid: null },
  ];
}
let roster = defaultRoster();

const slimes = [];
function buildSlimes() {
  slimes.length = 0;
  for (const e of roster) {
    slimes.push({
      side: e.team, x: 0, y: FLOOR_Y, vx: 0, vy: 0,
      color: e.color, gid: e.gid ?? null, speedMul: 1,
    });
  }
}
buildSlimes();

const ball = { x: 0, y: 0, vx: 0, vy: 0 };

function cfg() { return CFG[G.type]; }

function resetRally(servingSide) {
  const byTeam = [[], []];
  for (const s of slimes) byTeam[s.side].push(s);
  for (const t of [0, 1]) {
    const solo = byTeam[t].length < 2;
    const spots = G.type === "volley"
      ? (solo ? [0.25] : [0.15, 0.34])
      : (solo ? [0.2] : [0.12, 0.3]);
    byTeam[t].forEach((s, i) => {
      const f = spots[i] ?? 0.42;
      s.x = W * (t === 0 ? f : 1 - f);
      s.y = FLOOR_Y; s.vx = 0; s.vy = 0;
    });
  }
  if (G.type === "volley") {
    const server = byTeam[servingSide][0] || slimes[0];
    ball.x = server.x;
    ball.y = FLOOR_Y - 220;
  } else {
    ball.x = W / 2;
    ball.y = FLOOR_Y - 250;
  }
  ball.vx = 0;
  ball.vy = 0;
  G.rallyT = 0;
  rollAI();
}

// ================= input =================
const keys = {};
addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) e.preventDefault();
  keys[e.code] = true;
  if (e.code === "KeyP") togglePause();
});
addEventListener("keyup", (e) => { keys[e.code] = false; });

const touch = { l: false, r: false, j: false };
const IS_TOUCH = "ontouchstart" in window;

// Multi-touch button handling: on every touch event, recompute every button's
// state from the full list of active touches. No per-button listeners means
// no stuck or missed presses when several fingers act at once, and thumbs can
// slide between left/right without lifting. A small pad grows the hit area
// beyond the (already larger than visible) button element.
if (IS_TOUCH) {
  const tbtns = {
    l: document.getElementById("tLeft"),
    r: document.getElementById("tRight"),
    j: document.getElementById("tJump"),
  };
  const PAD = 14;
  const updateTouches = (e) => {
    e.preventDefault();
    const state = { l: false, r: false, j: false };
    for (const t of e.touches) {
      for (const k of ["l", "r", "j"]) {
        const r = tbtns[k].getBoundingClientRect();
        if (t.clientX >= r.left - PAD && t.clientX <= r.right + PAD &&
            t.clientY >= r.top - PAD && t.clientY <= r.bottom + PAD) state[k] = true;
      }
    }
    for (const k of ["l", "r", "j"]) {
      touch[k] = state[k];
      tbtns[k].classList.toggle("pressed", state[k]);
    }
  };
  const layer = document.getElementById("touchControls");
  for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    layer.addEventListener(ev, updateTouches, { passive: false });
  }
}

// ---- tilt controls (gyro to move, tap anywhere to jump) ----
const tilt = { ax: 0, tap: false, seen: false, listening: false, t: 0, cal: 0, holdA: 90, prevT: 0, prevAt: 0, rate: 0 };
let controlScheme = localStorage.getItem("slimeControls") || "buttons";

// gyro sensitivity 1..10: sets how many degrees of tilt give full speed
let gyroSens = parseInt(localStorage.getItem("slimeGyroSens"), 10);
if (!(gyroSens >= 1 && gyroSens <= 10)) gyroSens = 5;
function gyroFullAngle() { return 30 - gyroSens * 2.2; } // 1 -> ~28°, 10 -> 8°

// response curve: "linear" = speed exactly proportional to tilt;
// "dynamic" = gentle near center, ramping up toward full tilt
let gyroCurve = localStorage.getItem("slimeGyroCurve") === "dynamic" ? "dynamic" : "linear";

function orientationHandler(e) {
  if (e.gamma === null && e.beta === null) return;
  tilt.seen = true;

  // Reconstruct the gravity direction in device coordinates from beta/gamma.
  // This is immune to euler-angle flips near vertical holds and needs no
  // screen-orientation APIs at all.
  const b = ((e.beta || 0) * Math.PI) / 180;
  const g = ((e.gamma || 0) * Math.PI) / 180;
  const gx = Math.sin(g) * Math.cos(b); // gravity along the device's short axis
  const gy = -Math.sin(b);              // gravity along the device's long axis

  // The game is always shown landscape, so the phone is held sideways.
  // Gravity along the short axis tells us which way: device-top to the
  // user's left (gx < 0) or right (gx > 0). Hysteresis keeps the last
  // answer when the phone is held too flat to tell.
  if (gx < -0.2) tilt.holdA = 90;
  else if (gx > 0.2) tilt.holdA = 270;

  // Tilt = gravity along whatever direction is currently "screen right".
  const rightG = tilt.holdA === 90 ? -gy : gy;
  tilt.t = (Math.asin(Math.max(-1, Math.min(1, rightG))) * 180) / Math.PI;

  // analog steering: speed scales with tilt up to FULL degrees. The dead
  // zone sits just above sensor noise so crossing the center is seamless.
  const FULL = gyroFullAngle();
  const DEAD = 0.1;
  const d = tilt.t - tilt.cal;
  // re-center only when truly neutral, and very slowly — must never eat a
  // small intentional tilt
  if (Math.abs(d) < 0.3) tilt.cal += (tilt.t - tilt.cal) * 0.001;
  let mag = Math.min(1, Math.max(0, (Math.abs(d) - DEAD) / (FULL - DEAD)));
  if (gyroCurve === "dynamic") mag = Math.pow(mag, 1.8); // fine control near center

  // flick boost: the tilt *rate* feeds in too, so a quick wrist flick turns
  // the slime immediately — before the angle has even crossed neutral
  const nowMs = e.timeStamp || performance.now();
  if (tilt.prevAt) {
    const dt = Math.min(100, Math.max(5, nowMs - tilt.prevAt));
    const rawRate = ((tilt.t - tilt.prevT) / dt) * 1000; // degrees per second
    tilt.rate = tilt.rate * 0.7 + rawRate * 0.3;
  }
  tilt.prevAt = nowMs;
  tilt.prevT = tilt.t;

  tilt.ax = Math.max(-1, Math.min(1, Math.sign(d) * mag + tilt.rate / 220));
}

function enableTilt() {
  return new Promise((resolve) => {
    if (tilt.seen) { resolve(true); return; }
    const attach = () => {
      if (!tilt.listening) {
        addEventListener("deviceorientation", orientationHandler);
        tilt.listening = true;
      }
      // some browsers silently deliver no events (e.g. over http) — verify
      setTimeout(() => resolve(tilt.seen), 900);
    };
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) {
      DeviceOrientationEvent.requestPermission()
        .then((res) => { if (res === "granted") attach(); else resolve(false); })
        .catch(() => resolve(false));
    } else {
      attach();
    }
  });
}

// ---- finger steering: hold a finger where you want the slime to go,
// touch with a second finger to jump ----
const finger = { active: false, targetX: 0, jump: false };

function gameXFromTouch(t) {
  const rect = canvas.getBoundingClientRect();
  // in forced-landscape (CSS-rotated) mode the game's x-axis runs along the
  // screen's vertical axis
  const rotated = matchMedia("(orientation: portrait) and (pointer: coarse)").matches;
  const frac = rotated
    ? (t.clientY - rect.top) / rect.height
    : (t.clientX - rect.left) / rect.width;
  return Math.max(0, Math.min(1, frac)) * W;
}

function canvasTouch(e) {
  if (controlScheme === "tilt") {
    e.preventDefault();
    tilt.tap = e.touches.length > 0; // tap anywhere to jump
  } else if (controlScheme === "finger") {
    e.preventDefault();
    finger.active = e.touches.length > 0;
    finger.jump = e.touches.length >= 2;
    if (e.touches.length > 0) finger.targetX = gameXFromTouch(e.touches[0]);
  }
}
for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
  canvas.addEventListener(ev, canvasTouch, { passive: false });
}

// the slime this client actually controls (predicted one for guests)
function mySlime() {
  if (G.mode === "guest") return slimes[NET.myIdx] || slimes[0];
  if (G.mode === "host") return slimes.find((s) => s.gid === null) || slimes[0];
  return slimes[0];
}

function applyControlScheme() {
  document.getElementById("touchControls")
    .classList.toggle("active", IS_TOUCH && controlScheme === "buttons");
  const btn = document.getElementById("btnControls");
  btn.classList.toggle("hidden", !IS_TOUCH);
  btn.textContent = {
    buttons: "CONTROLS: BUTTONS",
    tilt: "CONTROLS: TILT + TAP",
    finger: "CONTROLS: FINGER",
  }[controlScheme] || "CONTROLS: BUTTONS";
  document.getElementById("sensRow")
    .classList.toggle("hidden", !(IS_TOUCH && controlScheme === "tilt"));
}
applyControlScheme();

// the gyro settings panel lives in one place at a time: main menu or pause
function placeGyroPanel(slotId) {
  const panel = document.getElementById("sensRow");
  const slot = document.getElementById(slotId);
  if (panel && slot && panel.parentElement !== slot) slot.appendChild(panel);
}

// manual recalibration: however the phone is held right now becomes neutral.
// Waits for a fresh sensor reading — resetting before the gyro is armed used
// to capture a stale zero and do nothing.
function resetGyro() {
  const hint = document.getElementById("gyroHint");
  const apply = () => {
    tilt.cal = tilt.t;
    hint.textContent = "gyro reset — this angle is now neutral";
    setTimeout(() => {
      if (hint.textContent.startsWith("gyro reset")) {
        hint.textContent = "hold the phone how you want, tap reset — then tilt to test";
      }
    }, 2500);
  };
  if (!tilt.seen) {
    hint.textContent = "activating gyro…";
    enableTilt().then((ok) => {
      if (ok) setTimeout(apply, 150); // let a fresh reading land first
      else hint.textContent = "no gyro data — check motion permission";
    });
  } else {
    apply();
  }
}

function wasdInput() {
  return { left: !!keys["KeyA"], right: !!keys["KeyD"], jump: !!keys["KeyW"] };
}
function arrowInput() {
  return { left: !!keys["ArrowLeft"], right: !!keys["ArrowRight"], jump: !!keys["ArrowUp"] };
}
// any control scheme + touch/tilt — used when only one local player.
// ax is an analog axis in [-1, 1]; buttons/keys override tilt at full speed.
function combinedInput() {
  const a = wasdInput(), b = arrowInput();
  const left = a.left || b.left || touch.l;
  const right = a.right || b.right || touch.r;
  const jump = a.jump || b.jump || touch.j
    || (controlScheme === "tilt" && tilt.tap)
    || (controlScheme === "finger" && finger.jump);
  let ax;
  if (left) ax = -1;
  else if (right) ax = 1;
  else if (controlScheme === "tilt" && tilt.seen) ax = tilt.ax;
  else if (controlScheme === "finger" && finger.active) {
    const s = mySlime();
    if (s) ax = Math.max(-1, Math.min(1, (finger.targetX - s.x) / 50));
  }
  return { left, right, jump, ax };
}

// re-arm the gyro on a user gesture (iOS forgets the permission on reload)
function armTilt() {
  if (IS_TOUCH && controlScheme === "tilt" && !tilt.seen) enableTilt();
}

// ================= AI =================
const DIFF = {
  easy:   { speed: 0.62, err: 55, jumpP: 0.45, lead: 0.15, react: 35 },
  medium: { speed: 0.85, err: 24, jumpP: 0.75, lead: 0.30, react: 14 },
  hard:   { speed: 1.00, err: 7,  jumpP: 1.00, lead: 0.42, react: 0  },
};
let aiLevel = localStorage.getItem("slimeAI") || "medium";
if (!DIFF[aiLevel]) aiLevel = "medium";

// per-rally randomness so the AI never plays two rallies identically
const aiR = { off: 14, jumpDist: 80, smash: true, delay: 0 };
function rollAI() {
  const d = DIFF[aiLevel];
  aiR.off = 14 + (Math.random() * 2 - 1) * d.err;
  aiR.jumpDist = 55 + Math.random() * 45;
  aiR.smash = Math.random() < d.jumpP;
  aiR.delay = d.react * (0.5 + Math.random());
}

const IDLE = { left: false, right: false, jump: false };

function aiVolley() {
  if (G.rallyT < aiR.delay) return IDLE; // reaction time after a serve
  const d = DIFF[aiLevel];
  const s = slimes[1];
  const onMySide = ball.x > W / 2;
  let targetX;
  if (onMySide || ball.vx > 0) {
    const lead = Math.min(20, Math.max(4, (FLOOR_Y - ball.y) / 8));
    targetX = ball.x + ball.vx * lead * d.lead;
    targetX = Math.max(W / 2 + NET_HALF + SLIME_R, Math.min(W - SLIME_R, targetX));
    targetX += aiR.off; // stand off-center so hits angle forward — varies per rally
  } else {
    targetX = W * 0.72;
  }
  const input = { left: false, right: false, jump: false };
  if (s.x < targetX - 8) input.right = true;
  else if (s.x > targetX + 8) input.left = true;

  const dx = ball.x - s.x, dy = ball.y - s.y;
  if (aiR.smash && Math.abs(dx) < aiR.jumpDist && dy > -160 && dy < 0 && ball.vy > -2 && onMySide) {
    input.jump = true;
  }
  return input;
}

function aiSoccer() {
  if (G.rallyT < aiR.delay) return IDLE;
  const s = slimes[1]; // AI attacks the left goal
  let targetX = ball.x + 20 + aiR.off; // stay right of the ball to knock it left
  // ball pinned near own goal: get on top of it instead of pushing it in
  if (targetX > W - SLIME_R - 10) targetX = ball.x;
  targetX = Math.max(SLIME_R, Math.min(W - SLIME_R, targetX));

  const input = { left: false, right: false, jump: false };
  if (s.x < targetX - 8) input.right = true;
  else if (s.x > targetX + 8) input.left = true;

  const dx = ball.x - s.x, dy = ball.y - s.y;
  const close = Math.abs(dx) < aiR.jumpDist;
  if (aiR.smash && close && dy < -30 && dy > -190) input.jump = true;   // ball overhead
  if (close && ball.x > W - 140 && s.y >= FLOOR_Y) input.jump = true;   // clear own corner
  return input;
}

// ================= physics =================
function stepSlime(s, input) {
  const sp = SLIME_SPEED * (s.speedMul || 1);
  s.vx = 0;
  if (typeof input.ax === "number") {
    s.vx = sp * Math.max(-1, Math.min(1, input.ax)); // analog (tilt)
  } else {
    if (input.left) s.vx = -sp;
    if (input.right) s.vx = sp;
  }

  if (input.jump && s.y >= FLOOR_Y) s.vy = JUMP_VEL;
  s.vy += GRAVITY;
  s.x += s.vx;
  s.y += s.vy;
  if (s.y > FLOOR_Y) { s.y = FLOOR_Y; s.vy = 0; }
  clampSlimeX(s);
}

function clampSlimeX(s) {
  let minX, maxX;
  if (G.type === "volley") {
    minX = s.side === 0 ? SLIME_R : W / 2 + NET_HALF + SLIME_R;
    maxX = s.side === 0 ? W / 2 - NET_HALF - SLIME_R : W - SLIME_R;
  } else {
    minX = SLIME_R; maxX = W - SLIME_R; // soccer: whole pitch
  }
  s.x = Math.max(minX, Math.min(maxX, s.x));
}

// every pair of slimes pushes apart (teammates share a half in volleyball,
// everyone shares the pitch in soccer)
function slimeCollisions() {
  for (let i = 0; i < slimes.length; i++) {
    for (let j = i + 1; j < slimes.length; j++) {
      const a = slimes[i], b = slimes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001 && d < SLIME_R * 2) {
        const push = (SLIME_R * 2 - d) / 2;
        const ux = dx / d, uy = dy / d;
        a.x -= ux * push; b.x += ux * push;
        if (uy < -0.3) a.y = Math.min(FLOOR_Y, a.y + push);  // a landed on b
        if (uy > 0.3) b.y = Math.min(FLOOR_Y, b.y + push);   // b landed on a
        clampSlimeX(a); clampSlimeX(b);
      }
    }
  }
}

// circle-vs-rect bounce (net, crossbars)
function circleRectBounce(rx, ry, rw, rh, restitution) {
  const r = cfg().ballR;
  const nx = Math.max(rx, Math.min(rx + rw, ball.x));
  const ny = Math.max(ry, Math.min(ry + rh, ball.y));
  const dx = ball.x - nx, dy = ball.y - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r || d2 === 0) return;
  const d = Math.sqrt(d2);
  const ux = dx / d, uy = dy / d;
  ball.x = nx + ux * r;
  ball.y = ny + uy * r;
  const dot = ball.vx * ux + ball.vy * uy;
  if (dot < 0) {
    ball.vx -= 2 * dot * ux;
    ball.vy -= 2 * dot * uy;
    ball.vx *= restitution;
    ball.vy *= restitution;
  }
}

function scorePoint(scorer) {
  G.score[scorer]++;
  G.server = G.type === "volley" ? scorer : 1 - scorer; // soccer: conceding side kicks off
  G.flash = scorer;
  G.freeze = 60;
  ball.vx = 0; ball.vy = 0;
}

function stepBall() {
  const c = cfg();
  const r = c.ballR;
  ball.vy += c.ballGrav;
  ball.x += ball.vx;
  ball.y += ball.vy;

  if (G.type === "soccer") {
    const barY = FLOOR_Y - c.goalH;
    // goal? (ball reaches the back wall below the crossbar)
    if (ball.x < r + 2 && ball.y - r > barY + c.barT) { scorePoint(1); return; }
    if (ball.x > W - r - 2 && ball.y - r > barY + c.barT) { scorePoint(0); return; }
    // crossbars
    circleRectBounce(0, barY, c.goalW, c.barT, 0.7);
    circleRectBounce(W - c.goalW, barY, c.goalW, c.barT, 0.7);
  }

  // walls + ceiling
  if (ball.x < r) { ball.x = r; ball.vx = Math.abs(ball.vx); }
  if (ball.x > W - r) { ball.x = W - r; ball.vx = -Math.abs(ball.vx); }
  if (ball.y < r) { ball.y = r; ball.vy = Math.abs(ball.vy); }

  if (G.type === "volley") {
    circleRectBounce(W / 2 - NET_HALF, NET_TOP, NET_HALF * 2, FLOOR_Y - NET_TOP, 0.85);
    // floor => point for the other side
    if (ball.y > FLOOR_Y - r) {
      ball.y = FLOOR_Y - r;
      scorePoint(ball.x < W / 2 ? 1 : 0);
      return;
    }
  } else {
    // soccer floor: bounce, then roll with friction
    if (ball.y > FLOOR_Y - r) {
      ball.y = FLOOR_Y - r;
      if (Math.abs(ball.vy) > 1.4) ball.vy = -ball.vy * 0.72;
      else ball.vy = 0;
      ball.vx *= 0.99;
    }
  }

  // slimes
  for (const s of slimes) {
    const dx = ball.x - s.x, dy = ball.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = SLIME_R + r;
    if (dist < minDist && dist > 0.0001 && ball.y < s.y + 4) {
      const ux = dx / dist, uy = dy / dist;
      ball.x = s.x + ux * minDist;
      ball.y = s.y + uy * minDist;
      const rvx = ball.vx - s.vx, rvy = ball.vy - s.vy;
      const dot = rvx * ux + rvy * uy;
      if (dot < 0) {
        ball.vx = rvx - 2 * dot * ux + s.vx;
        ball.vy = rvy - 2 * dot * uy + s.vy;
      }
      const sp = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
      if (sp > c.maxBall) {
        ball.vx = (ball.vx / sp) * c.maxBall;
        ball.vy = (ball.vy / sp) * c.maxBall;
      }
    }
  }
}

// ================= game flow =================
const $ = (id) => document.getElementById(id);
const screens = ["menu", "modeMenu", "hostScreen", "joinScreen", "teamScreen", "winScreen", "pauseScreen", "dcScreen"];
function showScreen(id) {
  for (const s of screens) $(s).classList.toggle("hidden", s !== id);
  if (id === "menu") placeGyroPanel("gyroSlotMenu");
}
function hideAllScreens() {
  for (const s of screens) $(s).classList.add("hidden");
}

async function goLandscape() {
  // Android: real fullscreen + orientation lock. iPhone: not allowed, but the
  // CSS forced-rotation handles it there.
  try {
    await document.documentElement.requestFullscreen?.();
    await screen.orientation.lock?.("landscape");
  } catch {}
}

function startGame(mode) {
  if (IS_TOUCH) goLandscape();
  armTilt(); // user gesture: re-request gyro permission if iOS dropped it
  tilt.cal = tilt.t; // however the phone is held right now = neutral
  G.mode = mode;
  if (mode === "1p" || mode === "2p") roster = defaultRoster();
  buildSlimes();
  if (mode === "1p") slimes[1].speedMul = DIFF[aiLevel].speed;
  G.score = [0, 0];
  G.server = 0;
  G.running = true;
  G.paused = false;
  G.freeze = 0;
  G.flash = null;
  NET.lastState = null;
  NET.snaps = [];
  NET.lastSeq = 0;
  NET.lastAt = 0;
  NET.gapEma = 40;
  NET.myIdx = mode === "guest" ? roster.findIndex((e) => e.gid === NET.myGid) : -1;
  resetRally(0);
  hideAllScreens();
  $("btnPause").classList.remove("hidden");
}

function playerNames() {
  switch (G.mode) {
    case "1p": return ["YOU", "AI"];
    case "host": return ["YOU", "OPPONENT"];
    case "guest": return ["OPPONENT", "YOU"];
    default: return ["PLAYER 1", "PLAYER 2"];
  }
}

function endGame(winner) {
  G.running = false;
  $("btnPause").classList.add("hidden");
  if (G.mode === "host" || G.mode === "guest") {
    $("winText").textContent = winner === myTeam
      ? (roster.length > 2 ? "YOUR TEAM WINS! \u{1F3C6}" : "YOU WIN! \u{1F3C6}")
      : `${teamName(winner)} TEAM WINS!`;
  } else {
    const n = playerNames();
    $("winText").textContent = n[winner] === "YOU" ? "YOU WIN! \u{1F3C6}"
      : n[winner] + (n[winner].endsWith("S") ? " WIN!" : " WINS!");
  }
  const isGuest = G.mode === "guest";
  $("btnRematch").classList.toggle("hidden", isGuest);
  $("guestWait").classList.toggle("hidden", !isGuest);
  showScreen("winScreen");
}

function togglePause() {
  if (!G.running) return;
  if (G.mode === "guest") { netSend({ t: "pauseReq" }); return; } // host decides
  G.paused = !G.paused;
  if (G.paused) placeGyroPanel("gyroSlotPause");
  $("pauseScreen").classList.toggle("hidden", !G.paused);
  if (G.mode === "host") netSendAll({ t: "pause", on: G.paused });
}

function backToMenu() {
  G.running = false;
  G.paused = false;
  $("btnPause").classList.add("hidden");
  if (NET.ws) { NET.ws.close(); NET.ws = null; }
  cleanupPeer();
  NET.connected = false;
  showScreen("menu");
}

// ================= networking (client side) =================
// guest -> host (and host -> LAN server for control messages)
function netSend(obj) {
  if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(obj));
  else if (NET.conn && NET.conn.open) NET.conn.send(obj);
}

// host -> all guests
function netSendAll(obj) {
  if (NET.lan) {
    if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(obj));
  } else {
    for (const conn of NET.guests.values()) if (conn.open) conn.send(obj);
  }
}

// host -> one guest
function netSendTo(gid, obj) {
  if (NET.lan) {
    if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify({ ...obj, to: gid }));
  } else {
    const conn = NET.guests.get(gid);
    if (conn && conn.open) conn.send(obj);
  }
}

// ---- lobby (host side) ----
function initLobby() {
  LOBBY.players.clear();
  LOBBY.hostTeam = 0;
  NET.inputs.clear();
  syncHostTeamUI();
  renderLobby();
}

function teamCount(t) {
  let n = LOBBY.hostTeam === t ? 1 : 0;
  for (const p of LOBBY.players.values()) if (p.team === t) n++;
  return n;
}

function broadcastLobby() {
  netSendAll({
    t: "lobby",
    host: LOBBY.hostTeam,
    players: [...LOBBY.players].map(([gid, p]) => ({ gid, team: p.team })),
  });
}

function renderLobby() {
  const rows = [`YOU — ${teamName(LOBBY.hostTeam)}`];
  let n = 2;
  for (const p of LOBBY.players.values()) {
    rows.push(`PLAYER ${n++} — ${p.team === null ? "choosing…" : teamName(p.team)}`);
  }
  $("lobbyList").innerHTML = rows.join("<br>");
  const ready = LOBBY.players.size >= 1
    && [...LOBBY.players.values()].every((p) => p.team !== null)
    && teamCount(0) >= 1 && teamCount(1) >= 1
    && teamCount(0) <= 2 && teamCount(1) <= 2;
  $("btnStart").disabled = !ready;
}

function syncHostTeamUI() {
  $("hostRed").classList.toggle("sel", LOBBY.hostTeam === 0);
  $("hostBlue").classList.toggle("sel", LOBBY.hostTeam === 1);
}

function hostGuestIn(gid) {
  LOBBY.players.set(gid, { team: null });
  broadcastLobby();
  renderLobby();
}

function hostGuestOut(gid) {
  LOBBY.players.delete(gid);
  NET.guests.delete(gid);
  NET.inputs.delete(gid);
  const inMatch = G.running || !$("winScreen").classList.contains("hidden");
  if (inMatch && LOBBY.players.size === 0) {
    handleNetMessage({ t: "peer-left" });
    return;
  }
  broadcastLobby();
  renderLobby();
}

// messages from one guest, host side
function hostMsg(gid, msg) {
  switch (msg.t) {
    case "team": {
      const p = LOBBY.players.get(gid);
      if (!p) break;
      const t = msg.team === 1 ? 1 : 0;
      if (p.team === t || teamCount(t) < 2) p.team = t;
      broadcastLobby();
      renderLobby();
      break;
    }
    case "input": {
      const q = msg.q || 0;
      if (q && q <= (NET.inputSeqs.get(gid) || 0)) break; // stale (unordered)
      NET.inputSeqs.set(gid, q);
      NET.inputs.set(gid, {
        left: !!msg.l, right: !!msg.r, jump: !!msg.j,
        ax: typeof msg.a === "number" ? msg.a : undefined,
      });
      break;
    }
    case "pauseReq":
      togglePause();
      break;
  }
}

function hostStart() {
  const idx = [0, 0];
  roster = [];
  const add = (team, gid) => roster.push({ team, color: TEAM_COLORS[team][idx[team]++ % 2], gid });
  add(LOBBY.hostTeam, null);
  for (const [gid, p] of LOBBY.players) add(p.team, gid);
  myTeam = LOBBY.hostTeam;
  for (const gid of LOBBY.players.keys()) {
    netSendTo(gid, { t: "start", game: G.type, roster, you: gid });
  }
  startGame("host");
}

function connect(onOpen) {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const ws = new WebSocket(proto + location.host);
  NET.ws = ws;
  ws.onopen = () => { NET.connected = true; onOpen(); };
  ws.onmessage = (e) => handleNetMessage(JSON.parse(e.data));
  ws.onclose = () => {
    NET.connected = false;
    if (NET.ws !== ws) return; // superseded
    NET.ws = null;
    if (G.running || !$("winScreen").classList.contains("hidden")) {
      G.running = false;
      $("dcReason").textContent = "The connection was closed.";
      showScreen("dcScreen");
    }
  };
  ws.onerror = () => {
    $("netError").textContent = "Could not reach the server.";
  };
}

function handleNetMessage(msg) {
  // host side: lobby management and per-guest routing (LAN server tags guest
  // messages with .gid; the PeerJS path calls hostMsg directly)
  if (NET.role === "host") {
    if (msg.t === "created") {
      initLobby();
      $("roomCode").textContent = msg.code;
      showScreen("hostScreen");
      fetch("/info").then((r) => r.json()).then((info) => {
        NET.info = info;
        const ip = info.ips[0];
        if (!ip) {
          $("hostUrl").textContent = "other players open this same address and join with the code";
          return;
        }
        let html = `other players open:<br><b>http://${ip}:${info.port}</b>`;
        if (info.httpsPort) {
          html += `<br>(or <b>https://${ip}:${info.httpsPort}</b> for tilt controls)`;
        }
        $("hostUrl").innerHTML = html + "<br>then JOIN GAME with this code";
      }).catch(() => {});
    } else if (msg.t === "guest-in") {
      hostGuestIn(msg.gid);
    } else if (msg.t === "guest-out") {
      hostGuestOut(msg.gid);
    } else if (msg.gid !== undefined) {
      hostMsg(msg.gid, msg);
    }
    return;
  }

  // guest side
  switch (msg.t) {
    case "joined":
      if (msg.game) G.type = msg.game;
      NET.myGid = msg.gid ?? null;
      // open the unreliable fast lane for the state/input stream (online mode)
      if (!NET.lan && NET.peer && NET.myGid != null && NET.joinCode) openFastChannel(NET.myGid);
      chosenTeam = null;
      updateTeamUI(null);
      showScreen("teamScreen");
      break;
    case "lobby": {
      // sync own choice with what the host accepted
      NET.lastLobby = msg;
      if (NET.myGid != null) {
        const me = msg.players.find((p) => p.gid === NET.myGid);
        if (me) chosenTeam = me.team;
      }
      updateTeamUI(msg);
      break;
    }
    case "start":
      G.type = msg.game;
      roster = msg.roster;
      myTeam = (roster.find((e) => e.gid === msg.you) || roster[0]).team;
      startGame("guest");
      break;
    case "error":
      $("joinStatus").textContent = msg.reason || "Something went wrong.";
      break;
    case "state": {
      if (msg.q && msg.q <= NET.lastSeq) break; // stale (unordered channel)
      NET.lastSeq = msg.q || NET.lastSeq;
      NET.lastState = msg;
      const now = performance.now();
      if (NET.lastAt) NET.gapEma = NET.gapEma * 0.9 + Math.min(200, now - NET.lastAt) * 0.1;
      NET.lastAt = now;
      NET.snaps.push({ at: now, p: msg.p, b: msg.b, sc: msg.sc, fl: msg.fl, fz: msg.fz });
      if (NET.snaps.length > 30) NET.snaps.shift();
      break;
    }
    case "end":
      endGame(msg.w);
      break;
    case "restart":
      startGame("guest");
      break;
    case "pause":
      G.paused = msg.on;
      if (msg.on) placeGyroPanel("gyroSlotPause");
      $("pauseScreen").classList.toggle("hidden", !msg.on);
      break;
    case "peer-left":
      G.running = false;
      G.paused = false;
      $("btnPause").classList.add("hidden");
      $("dcReason").textContent = "The other player disconnected.";
      showScreen("dcScreen");
      break;
  }
}

function openFastChannel(gid) {
  const fc = NET.peer.connect(PEER_PREFIX + NET.joinCode, {
    reliable: false,
    metadata: { fast: true, gid },
  });
  NET.fast = fc;
  fc.on("data", (d) => { if (d && typeof d === "object") handleNetMessage(d); });
  const gone = () => { if (NET.fast === fc) NET.fast = null; };
  fc.on("close", gone);
  fc.on("error", gone);
}

// guest team-select screen: reflect lobby counts and own choice
function updateTeamUI(lobbyMsg) {
  const counts = [0, 0];
  if (lobbyMsg) {
    counts[lobbyMsg.host]++;
    for (const p of lobbyMsg.players) if (p.team !== null) counts[p.team]++;
  }
  $("teamRed").classList.toggle("sel", chosenTeam === 0);
  $("teamBlue").classList.toggle("sel", chosenTeam === 1);
  $("teamRed").disabled = chosenTeam !== 0 && counts[0] >= 2;
  $("teamBlue").disabled = chosenTeam !== 1 && counts[1] >= 2;
  $("teamRed").textContent = `RED ${counts[0]}/2`;
  $("teamBlue").textContent = `BLUE ${counts[1]}/2`;
  $("teamStatus").textContent = chosenTeam === null
    ? "pick a side!"
    : "waiting for the host to start…";
}

// ---- online transport: WebRTC peer-to-peer, PeerJS cloud for the handshake ----
const PEER_PREFIX = "slime-games-errie15-";

// STUN finds a direct route between peers. A TURN relay (credentials below,
// when configured) is the fallback that makes phone-to-phone across
// different networks (CGNAT mobile carriers) work — without one, players on
// e.g. 5G vs WiFi often cannot connect.
const TURN_SERVERS = [{
  urls: [
    "turn:global.relay.metered.ca:80",
    "turn:global.relay.metered.ca:80?transport=tcp",
    "turn:global.relay.metered.ca:443",
    "turns:global.relay.metered.ca:443?transport=tcp",
  ],
  username: "942766cbd6343c1fae686e0d",
  credential: "+fDHgGH91CzUa6si",
}];
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      ...TURN_SERVERS,
    ],
  },
};

function randomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // letters only
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function cleanupPeer() {
  for (const conn of NET.guests.values()) { try { conn.close(); } catch {} }
  for (const conn of NET.fastGuests.values()) { try { conn.close(); } catch {} }
  NET.guests = new Map();
  NET.fastGuests = new Map();
  NET.inputs = new Map();
  NET.inputSeqs = new Map();
  if (NET.fast) { try { NET.fast.close(); } catch {} NET.fast = null; }
  if (NET.conn) { try { NET.conn.close(); } catch {} NET.conn = null; }
  if (NET.peer) { try { NET.peer.destroy(); } catch {} NET.peer = null; }
}

function wireConn(conn) {
  conn.on("data", (d) => { if (d && typeof d === "object") handleNetMessage(d); });
  conn.on("close", () => { if (NET.conn === conn) handleNetMessage({ t: "peer-left" }); });
  conn.on("error", () => { if (NET.conn === conn) handleNetMessage({ t: "peer-left" }); });
}

function peerHost(attempt = 0) {
  if (typeof Peer === "undefined") { $("netError").textContent = "peerjs.min.js is missing."; return; }
  cleanupPeer();
  NET.role = "host";
  initLobby();
  let nextGid = 1;
  const code = randomCode();
  const peer = new Peer(PEER_PREFIX + code, PEER_OPTS);
  NET.peer = peer;
  $("roomCode").textContent = "----";
  $("hostUrl").textContent = "connecting…";
  showScreen("hostScreen");
  peer.on("open", () => {
    if (NET.peer !== peer) return;
    $("roomCode").textContent = code;
    const here = location.origin === "null" ? "this page" : location.origin + location.pathname;
    $("hostUrl").innerHTML =
      `other players open<br><b>${here}</b><br>(anywhere with internet) and join with this code`;
  });
  peer.on("connection", (conn) => {
    if (NET.peer !== peer) return;
    const meta = conn.metadata || {};
    if (meta.fast) {
      // second, unreliable channel from an existing guest — for state/input
      const fgid = meta.gid;
      conn.on("open", () => {
        if (!NET.guests.has(fgid)) { conn.close(); return; }
        NET.fastGuests.set(fgid, conn);
      });
      conn.on("data", (d) => {
        if (d && typeof d === "object" && NET.fastGuests.get(fgid) === conn) hostMsg(fgid, d);
      });
      const fgone = () => { if (NET.fastGuests.get(fgid) === conn) NET.fastGuests.delete(fgid); };
      conn.on("close", fgone);
      conn.on("error", fgone);
      return;
    }
    if (NET.guests.size >= 3 || G.running) { // room full / match in progress
      conn.on("open", () => conn.close());
      return;
    }
    const gid = nextGid++;
    conn.on("open", () => {
      NET.guests.set(gid, conn);
      conn.send({ t: "joined", game: G.type, gid });
      hostGuestIn(gid);
    });
    conn.on("data", (d) => {
      if (d && typeof d === "object" && NET.guests.get(gid) === conn) hostMsg(gid, d);
    });
    const gone = () => { if (NET.guests.get(gid) === conn) hostGuestOut(gid); };
    conn.on("close", gone);
    conn.on("error", gone);
  });
  peer.on("error", (err) => {
    if (NET.peer !== peer) return;
    if (err.type === "unavailable-id" && attempt < 3) { peerHost(attempt + 1); return; }
    $("netError").textContent = `Online connection failed (${err.type}).`;
    showScreen("modeMenu");
  });
}

function peerJoin(code) {
  if (typeof Peer === "undefined") { $("joinStatus").textContent = "peerjs.min.js is missing."; return; }
  cleanupPeer();
  NET.role = "guest";
  NET.joinCode = code;
  const peer = new Peer(PEER_OPTS);
  NET.peer = peer;
  let opened = false;
  peer.on("open", () => {
    if (NET.peer !== peer) return;
    $("joinStatus").textContent = "found the room — connecting to opponent…";
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    NET.conn = conn;
    wireConn(conn);
    conn.on("open", () => { opened = true; }); // host then sends {t:"joined", game}
    // cross-network connections relayed through TURN can take a while
    setTimeout(() => {
      if (!opened && NET.peer === peer) {
        $("joinStatus").textContent = "Could not reach that room — check the code and try again.";
        cleanupPeer();
      }
    }, 25000);
  });
  peer.on("error", (err) => {
    if (NET.peer !== peer) return;
    $("joinStatus").textContent = err.type === "peer-unavailable"
      ? "Room not found — check the code."
      : `Connection failed (${err.type}).`;
  });
}

function hostGame() {
  $("netError").textContent = "";
  if (NET.lan) {
    NET.role = "host";
    connect(() => netSend({ t: "create", game: G.type }));
  } else if (!navigator.onLine) {
    $("netError").textContent = "No internet — 1P and 2P modes still work offline.";
    $("fileHint").innerHTML =
      "For two devices on the same WiFi without internet,<br>run <b>node server.js</b> on a computer and open the address it prints.";
  } else {
    peerHost();
  }
}

function joinFlow() {
  $("joinStatus").textContent = "";
  $("codeInput").value = "";
  showScreen("joinScreen");
  $("codeInput").focus();
}

function doJoin() {
  // forgiving input: any case, ignore spaces/junk, map digit look-alikes
  const code = $("codeInput").value.toUpperCase()
    .replace(/0/g, "O").replace(/1/g, "I").replace(/5/g, "S").replace(/8/g, "B")
    .replace(/[^A-Z]/g, "");
  if (code.length !== 4) { $("joinStatus").textContent = "Code is 4 letters."; return; }
  $("joinStatus").textContent = "connecting…";
  if (NET.lan) {
    NET.role = "guest";
    connect(() => netSend({ t: "join", code }));
  } else {
    peerJoin(code);
  }
}

// ================= buttons =================
$("btnControls").onclick = async () => {
  $("ctrlHint").textContent = "";
  if (controlScheme === "buttons") {
    $("ctrlHint").textContent = "checking gyroscope…";
    const ok = await enableTilt();
    if (ok) {
      controlScheme = "tilt";
      $("ctrlHint").textContent = "Tilt to move, tap anywhere to jump.";
    } else {
      controlScheme = "finger";
      $("ctrlHint").textContent = "No gyro — FINGER mode: hold a finger where you want to go, second finger jumps.";
    }
  } else if (controlScheme === "tilt") {
    controlScheme = "finger";
    $("ctrlHint").textContent = "Hold a finger where you want to go — touch with a second finger to jump.";
  } else {
    controlScheme = "buttons";
    $("ctrlHint").textContent = "";
  }
  localStorage.setItem("slimeControls", controlScheme);
  applyControlScheme();
};
// restore a saved tilt preference; iPhone forgets the permission on reload,
// so if this silent attempt fails we re-arm on the next tap (armTilt) instead
// of falling back to buttons
if (IS_TOUCH && controlScheme === "tilt") {
  enableTilt().then((ok) => {
    if (!ok) $("ctrlHint").textContent = "Tilt activates when you start a game.";
  });
}

function setDiff(level) {
  aiLevel = level;
  localStorage.setItem("slimeAI", level);
  for (const [id, lv] of [["diffEasy", "easy"], ["diffMedium", "medium"], ["diffHard", "hard"]]) {
    $(id).classList.toggle("sel", lv === aiLevel);
  }
}
$("diffEasy").onclick = () => setDiff("easy");
$("diffMedium").onclick = () => setDiff("medium");
$("diffHard").onclick = () => setDiff("hard");
setDiff(aiLevel);

$("btnVolley").onclick = () => { G.type = "volley"; $("modeTitle").textContent = "\u{1F3D0} VOLLEYBALL"; showScreen("modeMenu"); };
$("btnSoccer").onclick = () => { G.type = "soccer"; $("modeTitle").textContent = "⚽ SOCCER"; showScreen("modeMenu"); };
$("btn1p").onclick = () => startGame("1p");
$("btn2p").onclick = () => startGame("2p");
$("btnHost").onclick = hostGame;
$("btnJoin").onclick = joinFlow;
$("btnBackMode").onclick = () => { $("netError").textContent = ""; $("fileHint").textContent = ""; showScreen("menu"); };
$("btnCancelHost").onclick = () => { if (NET.ws) { NET.ws.close(); NET.ws = null; } cleanupPeer(); showScreen("modeMenu"); };
$("btnBackJoin").onclick = () => { if (NET.ws) { NET.ws.close(); NET.ws = null; } cleanupPeer(); showScreen("modeMenu"); };
$("btnDoJoin").onclick = doJoin;
$("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
$("btnRematch").onclick = () => {
  if (G.mode === "host") netSendAll({ t: "restart" });
  startGame(G.mode);
};
$("btnStart").onclick = hostStart;
$("hostRed").onclick = () => {
  if (teamCount(0) - (LOBBY.hostTeam === 0 ? 1 : 0) < 2) { LOBBY.hostTeam = 0; syncHostTeamUI(); broadcastLobby(); renderLobby(); }
};
$("hostBlue").onclick = () => {
  if (teamCount(1) - (LOBBY.hostTeam === 1 ? 1 : 0) < 2) { LOBBY.hostTeam = 1; syncHostTeamUI(); broadcastLobby(); renderLobby(); }
};
$("teamRed").onclick = () => { armTilt(); chosenTeam = 0; netSend({ t: "team", team: 0 }); updateTeamUI(NET.lastLobby); };
$("teamBlue").onclick = () => { armTilt(); chosenTeam = 1; netSend({ t: "team", team: 1 }); updateTeamUI(NET.lastLobby); };
$("btnLeaveTeam").onclick = backToMenu;
$("btnMenu").onclick = backToMenu;
$("btnDcMenu").onclick = backToMenu;
$("btnPause").onclick = togglePause;
$("btnResume").onclick = togglePause;
$("btnQuit").onclick = backToMenu;

// gyro sensitivity slider (main menu + pause menu, touch devices only)
$("sensSlider").value = gyroSens;
$("sensVal").textContent = gyroSens;
$("sensSlider").addEventListener("input", () => {
  gyroSens = parseInt($("sensSlider").value, 10);
  $("sensVal").textContent = gyroSens;
  localStorage.setItem("slimeGyroSens", gyroSens);
  armTilt(); // slider drag is a gesture — good moment to (re)enable the gyro
});
function syncCurveBtn() {
  $("btnCurve").textContent = "MOVEMENT: " + (gyroCurve === "dynamic" ? "DYNAMIC" : "LINEAR");
}
$("btnCurve").onclick = () => {
  gyroCurve = gyroCurve === "dynamic" ? "linear" : "dynamic";
  localStorage.setItem("slimeGyroCurve", gyroCurve);
  syncCurveBtn();
  armTilt();
};
syncCurveBtn();
$("btnGyroReset").onclick = resetGyro;

// ================= update =================
function update() {
  if (G.mode === "guest") {
    const i = combinedInput();
    const msg = { t: "input", l: i.left, r: i.right, j: i.jump, q: ++NET.inSeq };
    if (typeof i.ax === "number") msg.a = Math.round(i.ax * 100) / 100;
    if (NET.fast && NET.fast.open) NET.fast.send(msg); // low-latency lane
    else netSend(msg);
    predictSelf(i); // own slime moves instantly; the host stays authoritative
    return;
  }

  if (G.freeze > 0) {
    G.freeze--;
    if (G.freeze === 0) {
      G.flash = null;
      const winner = G.score.findIndex((s) => s >= cfg().win);
      if (winner !== -1) {
        if (G.mode === "host") { sendSnapshot(); netSendAll({ t: "end", w: winner }); }
        endGame(winner);
        return;
      }
      resetRally(G.server);
    }
    if (G.mode === "host") sendSnapshot();
    return;
  }

  G.rallyT++;
  // during long rallies, periodically re-roll the AI's tendencies
  if (G.mode === "1p" && G.rallyT % 150 === 0) rollAI();

  if (G.mode === "host") {
    for (const s of slimes) {
      const input = s.gid === null ? combinedInput() : (NET.inputs.get(s.gid) || IDLE);
      stepSlime(s, input);
    }
  } else {
    const p2input = G.mode === "1p"
      ? (G.type === "volley" ? aiVolley() : aiSoccer())
      : arrowInput();
    const p1input = G.mode === "2p"
      ? { left: wasdInput().left || touch.l, right: wasdInput().right || touch.r, jump: wasdInput().jump || touch.j }
      : combinedInput();
    stepSlime(slimes[0], p1input);
    stepSlime(slimes[1], p2input);
  }
  slimeCollisions();
  stepBall();

  if (G.mode === "host") sendSnapshot();
}

// Client-side prediction: the guest simulates its OWN slime locally every
// frame so movement and jumps feel instant, then softly reconciles toward
// the host's authoritative position when they drift apart.
function predictSelf(input) {
  const s = NET.myIdx >= 0 ? slimes[NET.myIdx] : null;
  if (!s) return;
  stepSlime(s, input);
  const st = NET.lastState;
  const sp = st && st.p[NET.myIdx];
  if (!sp) return;
  if (st.fz > 0) { // rally reset: snap to the server's spawn position
    s.x = sp[0]; s.y = sp[1]; s.vx = 0; s.vy = 0;
    return;
  }
  const ex = sp[0] - s.x, ey = sp[1] - s.y;
  const d2 = ex * ex + ey * ey;
  if (d2 > 120 * 120) { s.x = sp[0]; s.y = sp[1]; }          // way off: snap
  else if (d2 > 24 * 24) { s.x += ex * 0.22; s.y += ey * 0.22; } // drifted: blend
}

let stateSeq = 0;
function sendSnapshot() {
  const rnd = (v) => Math.round(v * 10) / 10;
  const obj = {
    t: "state",
    q: ++stateSeq,
    p: slimes.map((s) => [rnd(s.x), rnd(s.y)]),
    b: [rnd(ball.x), rnd(ball.y)],
    sc: G.score,
    fl: G.flash,
    fz: G.freeze,
  };
  if (NET.lan) {
    netSendAll(obj);
  } else {
    // prefer each guest's unreliable fast lane; fall back to the reliable one
    for (const [gid, conn] of NET.guests) {
      const f = NET.fastGuests.get(gid);
      const ch = f && f.open ? f : conn;
      if (ch && ch.open) ch.send(obj);
    }
  }
}

// what to draw this frame (live sim, or the latest network snapshot)
function view() {
  if (G.mode === "guest" && NET.snaps.length) {
    // render slightly behind the newest snapshot, interpolating between the
    // two surrounding ones — smooths network jitter into fluid motion. The
    // delay adapts to the actual snapshot rate. Own slime: local prediction.
    const S = NET.snaps;
    const newest = S[S.length - 1];
    const delay = Math.min(120, Math.max(35, NET.gapEma * 2 + 8));
    const target = performance.now() - delay;
    let s0 = S[0], s1 = newest;
    for (let i = S.length - 1; i >= 0; i--) {
      if (S[i].at <= target) { s0 = S[i]; s1 = S[i + 1] || S[i]; break; }
    }
    const span = s1.at - s0.at;
    const f = span > 0 ? Math.min(1, Math.max(0, (target - s0.at) / span)) : 1;
    const L = (a, b) => a + (b - a) * f;
    return {
      slimes: newest.p.map((_, i) => {
        if (i === NET.myIdx && slimes[i]) {
          return { x: slimes[i].x, y: slimes[i].y, side: slimes[i].side, color: slimes[i].color };
        }
        return {
          x: s0.p[i] && s1.p[i] ? L(s0.p[i][0], s1.p[i][0]) : newest.p[i][0],
          y: s0.p[i] && s1.p[i] ? L(s0.p[i][1], s1.p[i][1]) : newest.p[i][1],
          side: roster[i] ? roster[i].team : 0,
          color: roster[i] ? roster[i].color : "#fff",
        };
      }),
      ball: { x: L(s0.b[0], s1.b[0]), y: L(s0.b[1], s1.b[1]) },
      score: newest.sc,
      flash: newest.fl,
      freeze: newest.fz,
    };
  }
  return { slimes, ball, score: G.score, flash: G.flash, freeze: G.freeze };
}

// ================= rendering =================
function drawSlime(s, v) {
  ctx.fillStyle = s.color;
  ctx.beginPath();
  ctx.arc(s.x, s.y, SLIME_R, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  const eyeOffX = s.side === 0 ? SLIME_R * 0.45 : -SLIME_R * 0.45;
  const ex = s.x + eyeOffX;
  const ey = s.y - SLIME_R * 0.55;
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(ex, ey, 8, 0, Math.PI * 2); ctx.fill();
  const a = Math.atan2(v.ball.y - ey, v.ball.x - ex);
  ctx.fillStyle = "#111";
  ctx.beginPath(); ctx.arc(ex + Math.cos(a) * 3.5, ey + Math.sin(a) * 3.5, 3.6, 0, Math.PI * 2); ctx.fill();
}

function drawVolleyCourt() {
  const grad = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  grad.addColorStop(0, "#10102a");
  grad.addColorStop(1, "#232345");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#666677";
  ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
  ctx.fillStyle = "#88889a";
  ctx.fillRect(0, FLOOR_Y, W, 4);
  ctx.fillStyle = "#dddde8";
  ctx.fillRect(W / 2 - NET_HALF, NET_TOP, NET_HALF * 2, FLOOR_Y - NET_TOP);
}

function drawSoccerPitch() {
  const c = CFG.soccer;
  const grad = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  grad.addColorStop(0, "#0e1a2e");
  grad.addColorStop(1, "#1d3a52");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // pitch
  ctx.fillStyle = "#2c6e31";
  ctx.fillRect(0, FLOOR_Y, W, H - FLOOR_Y);
  ctx.fillStyle = "#3d8a43";
  ctx.fillRect(0, FLOOR_Y, W, 5);
  // center line
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 12]);
  ctx.beginPath();
  ctx.moveTo(W / 2, FLOOR_Y - 180);
  ctx.lineTo(W / 2, FLOOR_Y);
  ctx.stroke();
  ctx.setLineDash([]);
  // goals
  const barY = FLOOR_Y - c.goalH;
  for (const left of [true, false]) {
    const x0 = left ? 0 : W - c.goalW;
    // net mesh
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    for (let gx = x0; gx <= x0 + c.goalW; gx += 12) {
      ctx.beginPath(); ctx.moveTo(gx, barY + c.barT); ctx.lineTo(gx, FLOOR_Y); ctx.stroke();
    }
    for (let gy = barY + c.barT; gy <= FLOOR_Y; gy += 12) {
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + c.goalW, gy); ctx.stroke();
    }
    // crossbar + back post
    ctx.fillStyle = "#e8e8f0";
    ctx.fillRect(x0, barY, c.goalW, c.barT);
    ctx.fillRect(left ? 0 : W - 4, barY, 4, c.goalH);
  }
}

function drawScore(v) {
  if (G.type === "volley") {
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < CFG.volley.win; i++) {
        const x = side === 0 ? 30 + i * 26 : W - 30 - i * 26;
        ctx.beginPath();
        ctx.arc(x, 34, 9, 0, Math.PI * 2);
        if (i < v.score[side]) { ctx.fillStyle = "#ffe14d"; ctx.fill(); }
        else { ctx.strokeStyle = "#444460"; ctx.lineWidth = 2; ctx.stroke(); }
      }
    }
  } else {
    ctx.textAlign = "center";
    ctx.font = "bold 40px 'Courier New', monospace";
    ctx.fillStyle = "#e8413c";
    ctx.fillText(String(v.score[0]), W / 2 - 60, 52);
    ctx.fillStyle = "#8888aa";
    ctx.fillText("–", W / 2, 50);
    ctx.fillStyle = "#3c6fe8";
    ctx.fillText(String(v.score[1]), W / 2 + 60, 52);
    ctx.textAlign = "left";
  }
}

function draw() {
  const v = view();
  if (G.type === "volley") drawVolleyCourt();
  else drawSoccerPitch();

  for (const s of v.slimes) drawSlime(s, v);

  const r = cfg().ballR;
  ctx.fillStyle = G.type === "volley" ? "#ffe14d" : "#f2f2f2";
  ctx.beginPath();
  ctx.arc(v.ball.x, v.ball.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = G.type === "volley" ? "#c9a800" : "#333";
  ctx.lineWidth = 2;
  ctx.stroke();

  drawScore(v);

  if (v.flash !== null && v.flash !== undefined && v.freeze > 0) {
    ctx.fillStyle = "#ffe14d";
    ctx.font = "bold 28px 'Courier New', monospace";
    ctx.textAlign = "center";
    const word = G.type === "soccer" ? "GOAL" : "POINT";
    const who = (G.mode === "host" || G.mode === "guest")
      ? teamName(v.flash) : playerNames()[v.flash];
    ctx.fillText(`${word} — ${who}`, W / 2, 120);
    ctx.textAlign = "left";
  }
}

// ================= main loop (fixed 60 Hz) =================
let last = performance.now();
let acc = 0;
const STEP = 1000 / 60;

function loop(now) {
  requestAnimationFrame(loop);
  acc += Math.min(now - last, 100);
  last = now;
  while (acc >= STEP) {
    if (G.running && !G.paused) update();
    acc -= STEP;
  }
  draw();
  // live tilt meter while the pause menu is open: tilt to test the response
  if (IS_TOUCH && !$("pauseScreen").classList.contains("hidden")) {
    const fill = $("sensMeterFill");
    const half = 115; // px, half the meter width
    const w = Math.abs(tilt.ax) * half;
    fill.style.width = w + "px";
    fill.style.left = tilt.ax < 0 ? (half - w) + "px" : half + "px";
  }
}
requestAnimationFrame(loop);

// offline support: after one online visit the game loads with no connection
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").then((reg) => {
    // when an update finishes installing, refresh once so the new version is
    // live immediately — but never in the middle of a game
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "activated" && navigator.serviceWorker.controller && !G.running) {
          location.reload();
        }
      });
    });
  }).catch(() => {});
}
