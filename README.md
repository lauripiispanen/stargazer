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
   wizard: level the tube and point it north, **Home** (or let a phone on the tube measure it, see
   **Auto-align with your phone**), then GoTo and centre 2–3 stars. GoTo stays disabled until
   Home is done, and while the Sun is up until the mount is star-aligned.

The server listens on `127.0.0.1` only, because anyone who can reach it can move the telescope. To use a tablet
or phone on the telescope WiFi, see **Phone remote** below.
Other settings (ports, limits, state file) are environment variables; see `packages/server/src/config.ts`.

## Phone remote

A phone can join the laptop's session as a remote: same telescope, alignment and observing list.

1. On the laptop: `npm run start:lan` (the same as `HOST=0.0.0.0 npm start`). Any device on the telescope WiFi can
   then control the telescope.
2. Join the phone to the telescope WiFi and scan the QR code under **Status → Phone remote** on the laptop (or open
   the `http://<laptop-ip>:8080` address shown there).

Phones (and windows narrower than 700 px) get a touch layout with a bottom tab bar: Control (connect, STOP, slew pad,
tracking, a small sky view, power & health), Search, Tonight, List, Align and Settings. It doesn't download the 3D
sky map. `?remote` or `?desktop` in the URL forces a layout, and both layouts have a toggle (phone icon / Settings).
Each device's press-and-hold slews are its own: if a phone drops off the WiFi, only the axis it was moving stops.
STOP on any device stops everything. The observing list (Add to list in Search, Tonight and the object card) is kept
on the server, so every device sees the same one.

## Auto-align with your phone

The phone remote can replace "level the tube, point it north, press Home": lay the phone on the tube and its
gravity sensor and compass measure where the tube points. You don't need to level it or point it north.

1. **Start the server with HTTPS**: `npm run start:lan:https`. Phones only give web pages their motion and
   compass sensors over a secure connection. On first run it creates a local certificate authority and a
   certificate for this laptop's LAN addresses in `~/.stargazer/tls/` (`.dev/tls/` in dev), using the `openssl`
   command. To use your own certificate, set `STARGAZER_TLS_CERT` and `STARGAZER_TLS_KEY`. Plain `npm run start:lan`
   (HTTP) still works for everything except the sensors.
2. **Accept the certificate once.** Scan the QR code under **Status › Phone remote**. The phone warns that the
   connection isn't private, because the laptop made the certificate itself:
   - iPhone (Safari): **Show Details › visit this website › Visit Website**.
   - Android (Chrome): **Advanced › Proceed to …**.
   The laptop card shows the start of the certificate's SHA-256 fingerprint so you can check it. If the remote
   loads but never connects (some iOS versions don't apply the exception to WebSockets), open
   `https://<laptop-ip>:8080/stargazer-ca.crt` on the phone, install the profile, and enable it under
   Settings › General › About › Certificate Trust Settings.
3. **Place the phone.** Lay it flat on top of the tube, screen up, with its **top edge toward the open (sky) end**.
   Tape it on or hold it so it can't slide. It can roll a little sideways on the round tube without affecting the
   reading. Keep the tube below ~50° (near level is best); above 75° the capture is refused.
4. **Align › Sensors › Start sensors** (iPhone asks for motion & orientation access). The screen shows the tube
   altitude, the true heading (magnetic heading plus the declination from the bundled World Magnetic Model
   WMM2025, worked out offline for your location and date) and a stability meter.
5. **Capture.** Keep your hands off for 3 s while it averages the readings. Check the summary ("points 12° up,
   toward NNE"), then tap **Set Home from sensors**. You can then take the phone off and continue with the stars
   as usual.

Caveats:
- A phone compass on a telescope is only good to a few degrees. The steel tube, the motors and a metal tripod all
  bend the magnetic field. Expect the first star within ~5–10° and use the finder to find it; each star you add
  refines the model, just as after a manual Home.
- Capture with the motors still, and keep the phone away from the focuser and other steel. If the heading
  jumps while the tube is still, or iOS reports poor compass accuracy, calibrate the compass by waving the phone
  slowly in a figure-8, then place it again.
- If the summary says the tube points **down** while it points up, the phone is the wrong way round.
- The safety rules don't change: a sensor Home is still a "rough" alignment, so the pre-alignment Sun rules and
  the mechanical limits apply exactly as after a manual Home.
- **Tripod level check** (in the same step): lay the phone on the mount base to see how far the base is from level.

For development without a phone, `?fakeSensors` simulates a phone on the simulator's tube (from `/truth`, with
`fakeHeadingErr=3`, `fakeAltErr=0.3` and `fakeNoise` in degrees); it only works when connected to the simulator.

## Development

```sh
npm run dev        # simulator (AUX :2000, HTTP :2001) + server (:8080) + Vite (http://localhost:5173)
npm test           # unit and integration tests
npm run typecheck
npm run e2e        # browser end-to-end test (needs Chrome; stop `npm run dev` first, it uses the same ports)
npm run e2e:mobile # phone remote + laptop on one server (touch, shared list, per-device dead-man); screenshots in e2e-output/mobile
                   # then e2e:sensors: fake-sensor Home + 3 stars vs manual Home, and HTTPS/WSS; screenshots in e2e-output/sensors
```

`npm run dev` points the server at the simulator (`packages/server/dev.env`) and keeps its state in `.dev/`
rather than `~/.stargazer`. Open http://localhost:5173 and connect to the **Simulator** preset (`127.0.0.1:2000`).
`?mock` runs the GUI with an in-browser fake mount and no server (`?mock&remote` for the phone layout).

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
