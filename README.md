# Stargazer

Control a **Celestron Astro Fi 130** from your laptop: a 3D star map, GoTo, guided multi-star alignment,
"what's up tonight", and keyboard/gamepad slewing. Everything runs locally, which matters because the
laptop loses Internet access while it's on the telescope's WiFi.

> ⚠️ Work in progress. The protocol is based on research on the NexStar Evolution and hasn't been
> verified on Astro Fi hardware yet. Read [SAFETY.md](SAFETY.md) before connecting to a real telescope.

## Setup (while online)

```sh
npm run setup      # installs dependencies and downloads star/deep-sky catalogs into data/
npm run build      # builds the web UI
```

If `data/` is missing, the server log and the GUI both say so: run `npm run setup` while online.

## Use with the telescope

1. Set the telescope's WiFi switch to Direct, power it on, and join the `Celestron-XX` network.
2. `npm start`, then open http://localhost:8080.
3. Press **Connect** (default `1.2.3.4:2000`, or `TELESCOPE_HOST`/`TELESCOPE_PORT`), then follow the alignment
   wizard: level the tube and point it north, **Home**, then GoTo and centre 2–3 stars. GoTo stays disabled until
   Home is done, and while the Sun is up until the mount is star-aligned.

The server listens on `127.0.0.1` only, because anyone who can reach it can move the telescope. To use a tablet
or phone on the telescope WiFi, start it with `HOST=0.0.0.0 npm start` and open `http://<laptop-ip>:8080`.
Other settings (ports, limits, state file) are environment variables; see `packages/server/src/config.ts`.

## Development

```sh
npm run dev        # simulator (AUX :2000, HTTP :2001) + server (:8080) + Vite (http://localhost:5173)
npm test           # unit and integration tests
npm run typecheck
npm run e2e        # browser end-to-end test (needs Chrome; stop `npm run dev` first, it uses the same ports)
```

`npm run dev` points the server at the simulator (`packages/server/dev.env`) and keeps its state in `.dev/`
rather than `~/.stargazer`. Open http://localhost:5173 and connect to the **Simulator** preset (`127.0.0.1:2000`).
`?mock` runs the GUI with an in-browser fake mount and no server.

The dev simulator starts level and pointing north with no mount errors. For alignment practice, run it with
`npm run sim -- --realistic` (random orientation and hidden mount errors) or change the errors with
`POST http://localhost:2001/config`. `GET http://localhost:2001/truth` shows where it really points.

## Docs

- [PROTOCOL.md](PROTOCOL.md): Celestron AUX protocol over WiFi
- [SAFETY.md](SAFETY.md): limits, Sun avoidance, and the day-one hardware checklist
- [ARCHITECTURE.md](ARCHITECTURE.md): packages, data formats, and the WS contract

## Data

Catalogs aren't included in the repo. `npm run fetch-data` builds them from pinned upstream sources:
HYG and OpenNGC (CC BY-SA 4.0), d3-celestial (BSD-3) and GeoNames (CC BY 4.0). See `data/SOURCES.md`.
