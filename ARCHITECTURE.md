# Stargazer architecture

Controls a Celestron Astro Fi 130 over its WiFi (raw AUX protocol over TCP 1.2.3.4:2000, see PROTOCOL.md).
**Must work fully offline** once the laptop joins the telescope's WiFi: no CDNs, no runtime downloads, all
catalogs bundled, system fonts only.

```
browser (React + three.js)  <--WS /ws JSON (packages/shared/src/api.ts)-->  server (Node, Fastify)  <--TCP AUX-->  telescope
                                                                                                    \-> simulator (dev) :2000 TCP, :2001 HTTP truth
```

## Packages (npm workspaces, TypeScript run directly via tsx / vite; no build step for shared)

| Package | Owns |
|---|---|
| `packages/shared` | `api.ts` (WS contract, **source of truth**), `aux.ts` (AUX packet codec, constants, 24-bit position math), `astro.ts` (time, J2000 to apparent alt-az with refraction and back, via `astronomy-engine`), `pointing.ts` (pointing model forward/inverse and least-squares fit, see PROTOCOL.md §7.2), `tonight.ts` (what's-up-tonight ranking). Pure, isomorphic, unit-tested. |
| `packages/simulator` | Fake Astro Fi: TCP server speaking AUX (motor controllers 0x10/0x11, WiFi 0xB5), realistic slew rates, goto fast/slow, guide-rate tracking, echo option, hidden mount errors. HTTP :2001 `/truth` (GET), `/config` (POST: location, hidden errors, echo on/off, latency). |
| `packages/server` | Fastify on :8080: serves `packages/web/dist` (and `data/` at `/data`), WS `/ws`. `AuxClient` (TCP, framing, request/response matching, timeouts, reconnect), `Mount` (poll, manual moves, two-stage goto, tracking loop, safety), alignment session, persisted state in `~/.stargazer/state.json` (location, alignment, last encoder snapshot). |
| `packages/web` | Vite React app. 3D sky dome (three.js) with stars, DSOs, planets, constellations, horizon, alt-az grid, telescope reticle; search; object info and GoTo; connection and mount status pane; manual slew pad (keyboard and gamepad); guided alignment wizard; tonight list; location settings; night (red) mode. Talks only via WS. Dev: vite (:5173) proxies `/ws` and `/data` to :8080. `?mock` swaps the WS for an in-browser fake mount (`state/mockMount.ts`) that follows the server's GoTo rules. |

## Offline data (`data/`, produced by `npm run fetch-data` while online; NOT committed, since upstream sources are pinned to exact commits so output is reproducible)

The server and GUI must detect missing data and show "run `npm run setup` while online" instead of failing silently (server: startup warning and the `/data/*` 404 body; GUI: a red banner).

All coordinates are J2000 in degrees.
- `data/stars.json`: `{ "fields": ["ra","dec","mag","bv","hip"], "rows": [[...], ...] }` for stars with mag ≤ 8.0, sorted by mag ascending. `hip` is 0 if none.
- `data/star-names.json`: `{ "<hip>": { "name": "Vega", "bayer": "α Lyr" } }`.
- `data/dso.json`: `[{ "id": "M31", "name": "Andromeda Galaxy", "type": "galaxy|open-cluster|globular-cluster|nebula|planetary-nebula|supernova-remnant|double-star|other", "ra": 10.68, "dec": 41.27, "mag": 3.4, "sizeArcmin": [190, 60], "con": "And", "alt": ["NGC 224"] }]`. All Messier objects, Caldwell objects and bright NGC/IC (mag ≤ ~11, ~500).
- `data/constellations.json`: `[{ "id": "Ori", "name": "Orion", "lines": [[[ra,dec],[ra,dec],...], ...], "label": [ra, dec] }]`.
- `data/milkyway.json`: optional outline polygons `[[[ra,dec],...], ...]` (d3-celestial mw.json, simplified).
- `data/cities.json`: about 500 major world cities `[{ "name": "Helsinki", "country": "FI", "lat": 60.17, "lon": 24.94 }]` for offline location pick.
- `data/SOURCES.md`: provenance and licenses.

## Key behaviours
- **Server owns all telescope logic** (tracking loop, pointing model, goto). The GUI is a thin client, so a reload never disturbs tracking.
- Location: the browser tries `navigator.geolocation` (works online) and caches it in localStorage. The user can also enter it manually or pick a city. It is sent to the server with `setLocation`, and the server persists it.
- Alignment flow: (1) user levels the tube and points it north with the slew pad, then presses "Home" (`alignHome`, quality rough). (2) GUI suggests bright stars that are well separated and above 20° altitude. The user picks one, the server GoTos it (roughly), the user centres it with the slew pad (finishing with up/right moves for backlash) and presses "Centred" (`alignAddPoint`). (3) Repeat for 2nd, 3rd, ... stars. After each point the server refits and later GoTos land closer. Per-star residuals and RMS are shown.
- Safety (server-enforced, SAFETY.md): GoTo is refused before Home (quality `none`), with a rough model while the Sun is up, within 20° of the Sun (only solar-filter mode turns this into a `confirm`), and outside the mechanical altitude limits [-5°, 70°] even with `force`; below the horizon needs `confirm`. `stop` always works; tracking is never left running on disconnect; a dropped WS client stops its manual moves. Alignment points are captured only after the mount has been still for `settleMs` (2.5 s).
- The GUI mirrors those rules from `MountState.limits` (`web/src/lib/safety.ts` `gotoBlockReason`) to disable buttons with the reason, and shows every server `error` as a toast. Latched faults and failed stops are structured (`health.fault`, `health.stopFailed`); a failed stop raises a full-screen "unplug the power" alert.
- Any rates or directions that hardware doesn't confirm are config values (`packages/server/src/config.ts`): AUX device IDs, tracking scale (1024), az direction sign, slew-rate table, goto approach offset (2°).

## Commands
- `npm run dev`: simulator (:2000/:2001) plus server (:8080, env from `packages/server/dev.env`: `TELESCOPE_HOST=127.0.0.1`, state in `.dev/`) plus vite (http://localhost:5173).
- `npm run build && npm start`: production. Open http://localhost:8080. The server binds 127.0.0.1; `HOST=0.0.0.0` exposes it to the WiFi (tablet).
- `npm test`: vitest across packages. `npm run typecheck`.
- `npm run e2e` (`scripts/e2e.ts`): realistic simulator + server + built GUI driven by headless Chrome (puppeteer-core): connect, Home, 3-star alignment, GoTo accuracy, tracking, STOP, dead-man.
