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
};

const NET = {
  ws: null,              // LAN transport (node server.js relay)
  peer: null,            // online transport (WebRTC via PeerJS)
  conn: null,
  lan: false,            // true when the local relay server is reachable
  connected: false,
  role: null,
  remoteInput: { l: false, r: false, j: false },
  lastState: null,       // latest snapshot (guest side)
  info: null,            // {ips, port} from /info
};

// LAN relay available? (fails on GitHub Pages / Firebase / file:// -> online mode)
fetch("/info")
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then((info) => { NET.lan = true; NET.info = info; })
  .catch(() => { NET.lan = false; });

function makeSlime(side) {
  return {
    side,
    x: side === 0 ? W * 0.25 : W * 0.75,
    y: FLOOR_Y,
    vx: 0, vy: 0,
    color: side === 0 ? "#e8413c" : "#3c6fe8",
  };
}
const slimes = [makeSlime(0), makeSlime(1)];
const ball = { x: 0, y: 0, vx: 0, vy: 0 };

function cfg() { return CFG[G.type]; }

function resetRally(servingSide) {
  const startX = G.type === "volley" ? [W * 0.25, W * 0.75] : [W * 0.2, W * 0.8];
  for (let i = 0; i < 2; i++) {
    slimes[i].x = startX[i];
    slimes[i].y = FLOOR_Y;
    slimes[i].vx = 0; slimes[i].vy = 0;
  }
  if (G.type === "volley") {
    ball.x = servingSide === 0 ? W * 0.25 : W * 0.75;
    ball.y = FLOOR_Y - 220;
  } else {
    ball.x = W / 2;
    ball.y = FLOOR_Y - 250;
  }
  ball.vx = 0;
  ball.vy = 0;
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
function bindTouch(id, flag) {
  const el = document.getElementById(id);
  const on = (e) => { e.preventDefault(); touch[flag] = true; el.classList.add("pressed"); };
  const off = (e) => { e.preventDefault(); touch[flag] = false; el.classList.remove("pressed"); };
  el.addEventListener("touchstart", on, { passive: false });
  el.addEventListener("touchend", off, { passive: false });
  el.addEventListener("touchcancel", off, { passive: false });
}
if (IS_TOUCH) {
  bindTouch("tLeft", "l");
  bindTouch("tRight", "r");
  bindTouch("tJump", "j");
}

// ---- tilt controls (gyro to move, tap anywhere to jump) ----
const tilt = { dir: 0, tap: false, seen: false };
let controlScheme = localStorage.getItem("slimeControls") || "buttons";

function orientationHandler(e) {
  if (e.gamma === null && e.beta === null) return;
  tilt.seen = true;
  // map the physical left/right tilt to whichever sensor axis matches
  // the current screen rotation
  let angle = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  // portrait screen but the app is CSS-rotated to landscape: the user is
  // holding the phone sideways, so treat it as a 90° rotation
  if ((angle === 0 || angle === 180) && matchMedia("(orientation: portrait) and (pointer: coarse)").matches) {
    angle = 90;
  }
  let t;
  if (angle === 90) t = e.beta;
  else if (angle === 270 || angle === -90) t = -e.beta;
  else if (angle === 180) t = -e.gamma;
  else t = e.gamma;
  const DEAD = 8; // degrees of tilt before the slime moves
  tilt.dir = t > DEAD ? 1 : t < -DEAD ? -1 : 0;
}

function enableTilt() {
  return new Promise((resolve) => {
    const attach = () => {
      addEventListener("deviceorientation", orientationHandler);
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

// tap anywhere on the court to jump (tilt mode only)
canvas.addEventListener("touchstart", (e) => {
  if (controlScheme === "tilt") { e.preventDefault(); tilt.tap = true; }
}, { passive: false });
canvas.addEventListener("touchend", (e) => {
  if (controlScheme === "tilt") { e.preventDefault(); tilt.tap = false; }
}, { passive: false });
canvas.addEventListener("touchcancel", () => { tilt.tap = false; }, { passive: false });

function applyControlScheme() {
  document.getElementById("touchControls")
    .classList.toggle("active", IS_TOUCH && controlScheme === "buttons");
  const btn = document.getElementById("btnControls");
  btn.classList.toggle("hidden", !IS_TOUCH);
  btn.textContent = controlScheme === "tilt" ? "CONTROLS: TILT + TAP" : "CONTROLS: BUTTONS";
}
applyControlScheme();

function wasdInput() {
  return { left: !!keys["KeyA"], right: !!keys["KeyD"], jump: !!keys["KeyW"] };
}
function arrowInput() {
  return { left: !!keys["ArrowLeft"], right: !!keys["ArrowRight"], jump: !!keys["ArrowUp"] };
}
// any control scheme + touch/tilt — used when only one local player
function combinedInput() {
  const a = wasdInput(), b = arrowInput();
  const useTilt = controlScheme === "tilt";
  return {
    left: a.left || b.left || touch.l || (useTilt && tilt.dir === -1),
    right: a.right || b.right || touch.r || (useTilt && tilt.dir === 1),
    jump: a.jump || b.jump || touch.j || (useTilt && tilt.tap),
  };
}

// ================= AI =================
function aiVolley() {
  const s = slimes[1];
  const onMySide = ball.x > W / 2;
  let targetX;
  if (onMySide || ball.vx > 0) {
    const lead = Math.min(20, Math.max(4, (FLOOR_Y - ball.y) / 8));
    targetX = ball.x + ball.vx * lead * 0.35;
    targetX = Math.max(W / 2 + NET_HALF + SLIME_R, Math.min(W - SLIME_R, targetX));
    targetX += 14; // stand slightly behind the ball so hits go forward
  } else {
    targetX = W * 0.72;
  }
  const input = { left: false, right: false, jump: false };
  if (s.x < targetX - 8) input.right = true;
  else if (s.x > targetX + 8) input.left = true;

  const dx = ball.x - s.x, dy = ball.y - s.y;
  if (Math.abs(dx) < 90 && dy > -160 && dy < 0 && ball.vy > -2 && onMySide) input.jump = true;
  return input;
}

function aiSoccer() {
  const s = slimes[1]; // AI attacks the left goal
  let targetX = ball.x + 34; // stay right of the ball to knock it left
  // ball pinned near own goal: get on top of it instead of pushing it in
  if (targetX > W - SLIME_R - 10) targetX = ball.x;
  targetX = Math.max(SLIME_R, Math.min(W - SLIME_R, targetX));

  const input = { left: false, right: false, jump: false };
  if (s.x < targetX - 8) input.right = true;
  else if (s.x > targetX + 8) input.left = true;

  const dx = ball.x - s.x, dy = ball.y - s.y;
  const close = Math.abs(dx) < 85;
  if (close && dy < -30 && dy > -190) input.jump = true;           // ball overhead
  if (close && ball.x > W - 140 && s.y >= FLOOR_Y) input.jump = true; // clear own corner
  return input;
}

// ================= physics =================
function stepSlime(s, input) {
  s.vx = 0;
  if (input.left) s.vx = -SLIME_SPEED;
  if (input.right) s.vx = SLIME_SPEED;

  if (input.jump && s.y >= FLOOR_Y) s.vy = JUMP_VEL;
  s.vy += GRAVITY;
  s.x += s.vx;
  s.y += s.vy;
  if (s.y > FLOOR_Y) { s.y = FLOOR_Y; s.vy = 0; }

  let minX, maxX;
  if (G.type === "volley") {
    minX = s.side === 0 ? SLIME_R : W / 2 + NET_HALF + SLIME_R;
    maxX = s.side === 0 ? W / 2 - NET_HALF - SLIME_R : W - SLIME_R;
  } else {
    minX = SLIME_R; maxX = W - SLIME_R; // soccer: whole pitch
  }
  s.x = Math.max(minX, Math.min(maxX, s.x));
}

function slimeVsSlime() {
  const [a, b] = slimes;
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.001 && d < SLIME_R * 2) {
    const push = (SLIME_R * 2 - d) / 2;
    const ux = dx / d, uy = dy / d;
    a.x -= ux * push; b.x += ux * push;
    if (uy < -0.3) a.y = Math.min(FLOOR_Y, a.y + push);  // a landed on b
    if (uy > 0.3) b.y = Math.min(FLOOR_Y, b.y + push);   // b landed on a
    a.x = Math.max(SLIME_R, Math.min(W - SLIME_R, a.x));
    b.x = Math.max(SLIME_R, Math.min(W - SLIME_R, b.x));
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
const screens = ["menu", "modeMenu", "hostScreen", "joinScreen", "winScreen", "pauseScreen", "dcScreen"];
function showScreen(id) {
  for (const s of screens) $(s).classList.toggle("hidden", s !== id);
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
  G.mode = mode;
  G.score = [0, 0];
  G.server = 0;
  G.running = true;
  G.paused = false;
  G.freeze = 0;
  G.flash = null;
  NET.lastState = null;
  resetRally(0);
  hideAllScreens();
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
  const n = playerNames();
  $("winText").textContent = n[winner] === "YOU" ? "YOU WIN! \u{1F3C6}"
    : n[winner] + (n[winner].endsWith("S") ? " WIN!" : " WINS!");
  const isGuest = G.mode === "guest";
  $("btnRematch").classList.toggle("hidden", isGuest);
  $("guestWait").classList.toggle("hidden", !isGuest);
  showScreen("winScreen");
}

function togglePause() {
  if (!G.running || G.mode === "guest") return;
  G.paused = !G.paused;
  $("pauseScreen").classList.toggle("hidden", !G.paused);
  if (G.mode === "host") netSend({ t: "pause", on: G.paused });
}

function backToMenu() {
  G.running = false;
  G.paused = false;
  if (NET.ws) { NET.ws.close(); NET.ws = null; }
  cleanupPeer();
  NET.connected = false;
  showScreen("menu");
}

// ================= networking (client side) =================
function netSend(obj) {
  if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(obj));
  else if (NET.conn && NET.conn.open) NET.conn.send(obj);
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
  switch (msg.t) {
    case "created":
      $("roomCode").textContent = msg.code;
      showScreen("hostScreen");
      fetch("/info").then((r) => r.json()).then((info) => {
        NET.info = info;
        const ip = info.ips[0];
        if (!ip) {
          $("hostUrl").textContent = "other player opens this same address and joins with the code";
          return;
        }
        let html = `other player opens:<br><b>http://${ip}:${info.port}</b>`;
        if (info.httpsPort) {
          html += `<br>(or <b>https://${ip}:${info.httpsPort}</b> for tilt controls)`;
        }
        $("hostUrl").innerHTML = html + "<br>then JOIN GAME with this code";
      }).catch(() => {});
      break;
    case "joined":
      if (msg.game) G.type = msg.game;                 // guest learns the game type
      startGame(NET.role === "host" ? "host" : "guest");
      break;
    case "error":
      $("joinStatus").textContent = msg.reason || "Something went wrong.";
      break;
    case "input":
      NET.remoteInput = { l: msg.l, r: msg.r, j: msg.j };
      break;
    case "state":
      NET.lastState = msg;
      break;
    case "end":
      if (G.mode === "guest") endGame(msg.w);
      break;
    case "restart":
      if (G.mode === "guest") startGame("guest");
      break;
    case "pause":
      if (G.mode === "guest") {
        G.paused = msg.on;
        $("pauseScreen").classList.toggle("hidden", !msg.on);
      }
      break;
    case "peer-left":
      G.running = false;
      $("dcReason").textContent = "The other player disconnected.";
      showScreen("dcScreen");
      break;
  }
}

// ---- online transport: WebRTC peer-to-peer, PeerJS cloud for the handshake ----
const PEER_PREFIX = "slime-games-errie15-";

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function cleanupPeer() {
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
  const code = randomCode();
  const peer = new Peer(PEER_PREFIX + code);
  NET.peer = peer;
  $("roomCode").textContent = "----";
  $("hostUrl").textContent = "connecting…";
  showScreen("hostScreen");
  peer.on("open", () => {
    if (NET.peer !== peer) return;
    $("roomCode").textContent = code;
    const here = location.origin === "null" ? "this page" : location.origin + location.pathname;
    $("hostUrl").innerHTML =
      `other player opens<br><b>${here}</b><br>(anywhere with internet) and joins with this code`;
  });
  peer.on("connection", (conn) => {
    if (NET.conn) { conn.close(); return; } // room already full
    NET.conn = conn;
    wireConn(conn);
    conn.on("open", () => {
      conn.send({ t: "joined", game: G.type });
      handleNetMessage({ t: "joined" });
    });
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
  const peer = new Peer();
  NET.peer = peer;
  let opened = false;
  peer.on("open", () => {
    if (NET.peer !== peer) return;
    const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
    NET.conn = conn;
    wireConn(conn);
    conn.on("open", () => { opened = true; }); // host then sends {t:"joined", game}
    setTimeout(() => {
      if (!opened && NET.peer === peer) {
        $("joinStatus").textContent = "Could not reach that room — check the code.";
        cleanupPeer();
      }
    }, 10000);
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
  const code = $("codeInput").value.trim().toUpperCase();
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
    if (!ok) {
      $("ctrlHint").textContent = window.isSecureContext
        ? "No gyroscope data — tilt controls need a phone or tablet."
        : "Phones only allow gyro on a secure page — open the https:// address the server prints, then try again.";
      return;
    }
    controlScheme = "tilt";
    $("ctrlHint").textContent = "Tilt to move, tap anywhere to jump.";
  } else {
    controlScheme = "buttons";
  }
  localStorage.setItem("slimeControls", controlScheme);
  applyControlScheme();
};
// restore a saved tilt preference (may need a fresh permission tap on iPhone)
if (IS_TOUCH && controlScheme === "tilt") {
  enableTilt().then((ok) => {
    if (!ok) {
      controlScheme = "buttons";
      applyControlScheme();
      $("ctrlHint").textContent = "Tap CONTROLS to re-enable tilt.";
    }
  });
}

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
  if (G.mode === "host") netSend({ t: "restart" });
  startGame(G.mode);
};
$("btnMenu").onclick = backToMenu;
$("btnDcMenu").onclick = backToMenu;

// ================= update =================
function update() {
  if (G.mode === "guest") {
    const i = combinedInput();
    netSend({ t: "input", l: i.left, r: i.right, j: i.jump });
    return; // guest doesn't simulate — it renders host snapshots
  }

  if (G.freeze > 0) {
    G.freeze--;
    if (G.freeze === 0) {
      G.flash = null;
      const winner = G.score.findIndex((s) => s >= cfg().win);
      if (winner !== -1) {
        if (G.mode === "host") { sendSnapshot(); netSend({ t: "end", w: winner }); }
        endGame(winner);
        return;
      }
      resetRally(G.server);
    }
    if (G.mode === "host") sendSnapshot();
    return;
  }

  const p2input =
    G.mode === "1p" ? (G.type === "volley" ? aiVolley() : aiSoccer())
    : G.mode === "2p" ? arrowInput()
    : { left: NET.remoteInput.l, right: NET.remoteInput.r, jump: NET.remoteInput.j };
  const p1input = G.mode === "2p"
    ? { left: wasdInput().left || touch.l, right: wasdInput().right || touch.r, jump: wasdInput().jump || touch.j }
    : combinedInput();

  stepSlime(slimes[0], p1input);
  stepSlime(slimes[1], p2input);
  if (G.type === "soccer") slimeVsSlime();
  stepBall();

  if (G.mode === "host") sendSnapshot();
}

function sendSnapshot() {
  const rnd = (v) => Math.round(v * 10) / 10;
  netSend({
    t: "state",
    p: slimes.map((s) => [rnd(s.x), rnd(s.y)]),
    b: [rnd(ball.x), rnd(ball.y)],
    sc: G.score,
    fl: G.flash,
    fz: G.freeze,
  });
}

// what to draw this frame (live sim, or the latest network snapshot)
function view() {
  if (G.mode === "guest" && NET.lastState) {
    const st = NET.lastState;
    return {
      slimes: st.p.map((p, i) => ({ x: p[0], y: p[1], side: i, color: slimes[i].color })),
      ball: { x: st.b[0], y: st.b[1] },
      score: st.sc,
      flash: st.fl,
      freeze: st.fz,
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
    const n = playerNames();
    ctx.fillStyle = "#ffe14d";
    ctx.font = "bold 28px 'Courier New', monospace";
    ctx.textAlign = "center";
    const word = G.type === "soccer" ? "GOAL" : "POINT";
    ctx.fillText(`${word} — ${n[v.flash]}`, W / 2, 120);
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
}
requestAnimationFrame(loop);

// offline support: after one online visit the game loads with no connection
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
