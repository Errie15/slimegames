# Slime Games 🏐⚽

Slime Volleyball + Slime Soccer — playable solo vs AI, two players on one
keyboard, two players over the **internet**, or two devices on the same
**WiFi with no internet at all** (no accounts, no app stores).

## Play online (hosted on GitHub Pages)

Open the site, pick a game → **HOST GAME**, and share the 4-letter code.
Your friend opens the same site anywhere in the world and hits **JOIN GAME**.
The connection is peer-to-peer (WebRTC); a free broker only does the
introduction.

The site is a PWA: after one visit with internet, it **loads and plays
offline** (1P vs AI and shared-keyboard 2P). Add it to your phone's home
screen for the full-screen app feel.

## Play locally (single device)

Just open `index.html` in a browser — or revisit the hosted URL offline.
1P and 2P shared-keyboard modes work with no connection.

## Play across devices (same WiFi)

```
node server.js
```

The server prints the URLs:

- open the **localhost** one on this machine
- open the **network** one (e.g. `http://192.168.x.x:3000`) on the other device
- for **tilt controls on phones**, use the **https** one (port 3443) and accept
  the certificate warning once — phone browsers only allow gyroscope access on
  secure pages

One player picks a game → **HOST GAME** and gets a 4-letter room code.
The other picks **JOIN GAME** and types the code. That's it.

**Platforms:** players can be on anything with a modern browser — iPhone,
Android, Windows, Mac, Linux, in any combination. Only the machine running
`server.js` needs Node installed (Mac, Windows PC, or Linux all work).

The server is pure Node with zero dependencies — it serves the files and
relays messages between the two browsers. The host's browser runs the
physics; the guest streams inputs and renders snapshots.

## Controls

|            | Move        | Jump |
|------------|-------------|------|
| Player 1   | A / D       | W    |
| Player 2   | ◄ / ►       | ▲    |

On phones, touch buttons appear automatically. `P` pauses.

On touch devices the main menu shows a **CONTROLS** toggle:
**BUTTONS** (on-screen arrows + jump) or **TILT + TAP** (tilt the phone to
move, tap anywhere to jump). The choice is remembered per device. Tilt needs
the https:// address and, on iPhone, a one-time motion-sensor permission.

- **Volleyball**: first to 7 points. Ball touching your floor = opponent scores.
- **Soccer**: first to 5 goals. Both slimes roam the whole pitch; watch the crossbar.

## Tuning

All the physics knobs (`GRAVITY`, `JUMP_VEL`, `SLIME_SPEED`, per-game ball
gravity/speed and win scores) are constants at the top of `game.js`.
