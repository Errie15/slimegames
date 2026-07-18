# Slime Games 🏐⚽

Slime Volleyball + Slime Soccer — playable solo vs AI, two players on one
keyboard, or two players on **different devices over your WiFi** (no internet,
no accounts, no app stores).

## Play locally (single device)

Just open `index.html` in a browser. 1P and 2P shared-keyboard modes work
straight from the file.

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
