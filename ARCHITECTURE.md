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
| `packages/web` | Vite React app. 3D sky dome (three.js) with stars, DSOs, planets, constellations, horizon, alt-az grid, telescope reticle; search; object info and GoTo; connection and mount status pane; manual slew pad (keyboard and gamepad); guided alignment wizard; tonight list; location settings; night (red) mode. Talks only via WS. Dev: vite proxies `/ws` and `/data` to :8080. |

## Offline data (`data/`, produced by `npm run fetch-data` while online, committed to the repo)

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
- Safety: refuse GoTo within 20° of the Sun or below 0° altitude unless `force`; clamp alt to [-5°, 90°]; `stop` always works; tracking is never left running on disconnect.
- Any rates or directions that hardware doesn't confirm are config values (`packages/server/src/config.ts`): AUX device IDs, tracking scale (1024), az direction sign, slew-rate table, goto approach offset (2°).

## Commands
- `npm run dev`: simulator plus server (connects to 127.0.0.1:2000 when `TELESCOPE_HOST=127.0.0.1`) plus vite.
- `npm run build && npm start`: production. Open http://localhost:8080.
- `npm test`: vitest across packages.
