// Slime Games — local network server.
// Zero dependencies: serves the game files and relays messages between
// a host browser and a guest browser using 4-letter room codes.
//
//   node server.js          (default port 3000)
//   PORT=8080 node server.js
//
// Then open http://<this-machine's-LAN-IP>:3000 on both devices.

"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const ROOT = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// ---------- self-signed cert (needed so phone gyro APIs work: they require https) ----------
const CERT_DIR = path.join(ROOT, "certs");
function ensureCert() {
  const keyFile = path.join(CERT_DIR, "key.pem");
  const certFile = path.join(CERT_DIR, "cert.pem");
  try {
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      fs.mkdirSync(CERT_DIR, { recursive: true });
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", keyFile, "-out", certFile,
        "-days", "3650", "-nodes", "-subj", "/CN=slime-games",
      ], { stdio: "ignore" });
    }
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch {
    return null; // no openssl — http only, gyro controls unavailable on phones
  }
}
const tlsOptions = ensureCert();

// ---------- HTTP: static files + /info ----------
function handleRequest(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ port: PORT, httpsPort: tlsOptions ? HTTPS_PORT : null, ips: lanIPs() }));
    return;
  }
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(handleRequest);
const secureServer = tlsOptions ? https.createServer(tlsOptions, handleRequest) : null;

// ---------- WebSocket (hand-rolled, RFC 6455) ----------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function handleUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  makeClient(socket);
}
server.on("upgrade", handleUpgrade);
if (secureServer) secureServer.on("upgrade", handleUpgrade);

function makeClient(socket) {
  const c = { socket, buffer: Buffer.alloc(0), room: null, role: null, alive: true };
  socket.on("data", (chunk) => {
    c.buffer = Buffer.concat([c.buffer, chunk]);
    let frame;
    while (c.alive && (frame = parseFrame(c)) !== null) {
      if (frame.opcode === 8) { closeClient(c); return; }        // close
      if (frame.opcode === 9) { send(c, frame.payload, 10); continue; } // ping -> pong
      if (frame.opcode === 1) handleMessage(c, frame.payload.toString("utf8"));
    }
  });
  socket.on("close", () => closeClient(c));
  socket.on("error", () => closeClient(c));
  return c;
}

function parseFrame(c) {
  const buf = c.buffer;
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.subarray(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  c.buffer = buf.subarray(off + maskLen + len);
  return { opcode, payload };
}

function send(c, data, opcode = 1) {
  if (!c.alive) return;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  c.socket.write(Buffer.concat([header, payload]));
}

// ---------- rooms (host + up to 3 guests for team play) ----------
const rooms = new Map(); // code -> { host, guests: Map<gid, client>, game, nextGid }

function newCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // letters only
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(s) ? newCode() : s;
}

function handleMessage(c, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  if (msg.t === "create") {
    if (c.room) return;
    const code = newCode();
    rooms.set(code, {
      host: c,
      guests: new Map(),
      game: msg.game === "soccer" ? "soccer" : "volley",
      nextGid: 1,
    });
    c.room = code; c.role = "host";
    send(c, JSON.stringify({ t: "created", code }));
  } else if (msg.t === "join") {
    const code = String(msg.code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || room.guests.size >= 3) {
      send(c, JSON.stringify({ t: "error", reason: room ? "Room is full" : "Room not found" }));
      return;
    }
    const gid = room.nextGid++;
    room.guests.set(gid, c);
    c.room = code; c.role = "guest"; c.gid = gid;
    send(c, JSON.stringify({ t: "joined", game: room.game, gid }));
    send(room.host, JSON.stringify({ t: "guest-in", gid }));
  } else {
    // gameplay traffic
    const room = rooms.get(c.room);
    if (!room) return;
    if (c.role === "guest") {
      // guest -> host, tagged with the guest's id
      if (room.host.alive) send(room.host, JSON.stringify({ ...msg, gid: c.gid }));
    } else if (msg.to != null) {
      // host -> one guest
      const g = room.guests.get(msg.to);
      if (g && g.alive) send(g, text);
    } else {
      // host -> all guests
      for (const g of room.guests.values()) if (g.alive) send(g, text);
    }
  }
}

function closeClient(c) {
  if (!c.alive) return;
  c.alive = false;
  try { c.socket.destroy(); } catch {}
  if (c.room) {
    const room = rooms.get(c.room);
    if (room) {
      if (c.role === "host") {
        for (const g of room.guests.values()) {
          g.room = null;
          if (g.alive) send(g, JSON.stringify({ t: "peer-left" }));
        }
        rooms.delete(c.room);
      } else {
        room.guests.delete(c.gid);
        if (room.host.alive) send(room.host, JSON.stringify({ t: "guest-out", gid: c.gid }));
      }
    }
    c.room = null;
  }
}

server.listen(PORT, () => {
  const ips = lanIPs();
  console.log("");
  console.log("  Slime Games server running!");
  console.log("");
  console.log(`  On this machine:  http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`  On your network:  http://${ip}:${PORT}   <- open this on other devices`);
  }
  if (tlsOptions) {
    for (const ip of ips) {
      console.log(`  For TILT controls on phones use:  https://${ip}:${HTTPS_PORT}`);
    }
    console.log(`  (phones require https for gyro access — accept the certificate warning once)`);
  } else {
    console.log("  (openssl not found: https disabled, tilt controls unavailable on phones)");
  }
  console.log("");
  console.log("  Both players must be on the same WiFi. Ctrl+C to stop.");
  console.log("");
});
if (secureServer) secureServer.listen(HTTPS_PORT);
