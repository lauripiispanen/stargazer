# Celestron Astro Fi 130: WiFi / AUX protocol reference

Reference for implementing (a) a Node/TypeScript client that drives an Astro Fi 130 over its built-in WiFi and (b) a fake-telescope simulator that behaves the same way.

Researched 2026-10-18 without hardware. Every claim carries a confidence tag:

| Tag | Meaning |
|---|---|
| **[V-src]** | Verified in open-source driver/simulator source code (INDI `indi-celestronaux`, jochym simulators) |
| **[V-cap]** | Verified in a real packet capture (SkySafari ↔ NexStar **Evolution** over WiFi, jochym/nexstar-evo `analysis/`) |
| **[V-doc]** | Stated in Andre Paquette's *NexStar AUX Command Set* (2003, NexStar GPS era) or official Celestron docs |
| **[I]** | Inferred: consistent with sources, but nobody has confirmed it on an Astro Fi |
| **[?]** | Unknown / conflicting. Must be checked on real hardware |

> **Main caveat:** almost all wire-level evidence comes from the NexStar **Evolution**, which has the same family of built-in WiFi bridge, the same MC firmware family (7.x) and the same apps. Nobody has published an Astro Fi-specific capture. Celestron says the built-in WiFi on Evolution and Astro Fi "works the same way as the SkyPortal module", and the INDI AUX driver is reported working with an Astro Fi 5 (INDI forum). Everything below should hold, but check the items under "Open questions" on day one with the real scope.

---

## 1. Overview

- The Astro Fi is a single-fork-arm alt-az mount with DC servo motors and encoders. It has **no hand controller**. Its electronics are a motor-control (MC) board with two controllers (AZM = `0x10`, ALT = `0x11`) on Celestron's internal serial **AUX bus**, plus a built-in WiFi-to-serial bridge. **[V-doc]** (Celestron spec page; nexstarsite)
- The WiFi bridge is a **transparent TCP-to-AUX-bus pipe**. TCP port 2000 carries **raw AUX binary packets** (`0x3B` preamble…). It does **not** speak the NexStar hand-controller ASCII protocol (`e`, `r`, `b`, `P`, `V`, `K`, …), because those commands are interpreted by the hand controller, which isn't there. **[V-src][V-cap]** (Cloudy Nights: "'AUX' bus protocol, which is what Celestron WiFi provides, the same as a direct serial/USB connection to the mount".) Sending HC ASCII commands gets no reply.
- The MC knows only two axis encoder positions. It has no RA/Dec, no time, no location, no alignment model, and no alt-az sidereal tracking of its own. **The app (SkyPortal/SkySafari, CPWI, INDI, or our server) does everything**:
  - holds the pointing model (alignment)
  - converts RA/Dec to encoder targets
  - runs the GoTo sequence (fast slew, then slow approach)
  - computes and continuously refreshes per-axis tracking rates
  **[V-doc][V-src]** Supporting evidence: Paquette documents the HC refreshing alt-az rates every 30 s. The INDI forum shows an alignment done in SkySafari is invisible to INDI. nexstarsite notes the app "loses alignment" when the phone switches networks.

---

## 2. Network layer

### 2.1 WiFi access point

| Item | Value | Confidence |
|---|---|---|
| SSID | `Celestron-XX` (2nd-gen-equivalent bridge, CFM model AMW006) or `Celestron-XXX` (3rd-gen, AMW007). Astro Fi has "built-in equivalents of the 2nd and 3rd generation modules". `SkyQLink-XX` was the 1st-gen WiFly module (early Evolution, COSMOS 90GT), not Astro Fi. | [V-doc] nexstarsite |
| Security | Open network, no password (manual just says "connect to Celestron-xx"; jochym: SkyQLink network is "unprotected") | [I] |
| Scope IP | `1.2.3.4` (INDI `CAUX_DEFAULT_IP "1.2.3.4"`) | [V-src] |
| TCP port | `2000` (INDI `CAUX_DEFAULT_PORT 2000`) | [V-src] |
| DHCP | Hands out `1.2.3.10+` in /24, **default gateway and DNS = 1.2.3.4** (jochym, SkyQLink). AMW006/7 may differ. | [V-doc] (Evolution) / [?] Astro Fi |
| Mode switch | Small switch near the Astro Fi power socket. The manual says **RIGHT** position for normal (Direct Connect) use. Other Celestron hardware uses up = Direct Connect, down = Access Point (joins home WiFi). | [V-doc] |

**Gotchas**
- `1.2.3.4` is a public, routable address. While on the scope's AP the laptop's default route and DNS point at the scope. That's harmless because we're offline, but keep the web GUI on `localhost`. Make the host/port configurable: the simulator runs on `127.0.0.1:2000`, and the scope may use a DHCP address in AP mode.
- **Access Point (station) mode:** the scope joins a router and gets a DHCP address. Apps discover it via UDP (§2.3). Configuring it requires SkyPortal ("Configure Access Point", "Send Configuration to WiFi module"). Low priority for us.

### 2.2 TCP connection

- The connection is a plain TCP client to `1.2.3.4:2000`. The stream is a byte pipe to the AUX bus. **TCP segmentation is arbitrary**: echo and response often arrive in one segment (seen in the capture, e.g. `3b 03 20 10 fe cf 3b 07 10 20 fe 07 0a 10 0d 9d`), and packets may also split across reads. **Always use a buffering, resyncing parser.** [V-cap]
- **Possible ASCII noise:**
  - The 1st-gen WiFly bridge sends `*HELLO*` to a new TCP client by default (WiFly `set comm remote` default).
  - SkySafari (2016 capture) enters WiFly command mode with `$$$`, sends `set comm open 0`, `set comm remote 0`, `set comm close 0`, `exit` (replies `CMD\r\n`, `AOK\r\n<2.40-CEL> `, `EXIT\r\n`), then sends AUX packets.
  - Whether the AMW006/AMW007 bridges in the Astro Fi emit any banner is **[?]**. **Client rule:** skip bytes until `0x3B`, never send `$$$`.
- **Concurrent clients:** treat as **single client**. The ESP8266 clone bridge serves one client. Celestron/nexstarsite warn that two devices connected to one scope "cause problems". Each app also uses source ID `0x20`, so two apps would steal each other's responses. Our server owns the one TCP connection and multiplexes for browsers. [I]
- **Idle timeout / keepalive:** WiFly's idle timer defaults to 0 (never). AMW behaviour is [?]. Poll positions at ≥1 Hz anyway; this doubles as a heartbeat.
- **Disconnect detection:** INDI notes it takes >60 s to notice a dead TCP link (ISSUES.md). Use an app-level timeout: no valid response to N consecutive polls (e.g. 3 s) means disconnected. Also enable TCP keepalive.
- **Pacing:** INDI sleeps 50 ms after every write and reads with a 50 ms receive timeout [V-src]. The bus runs at 19200 baud, so one 9-byte packet takes about 4.7 ms on the wire, plus echo and response. Recommendation: keep **one outstanding request at a time** (strict request queue) with a 500–1000 ms timeout and up to 3 retries (Paquette's recommendation). Expect about 10–20 ms round trip.
- **Polling caution:** "Polling the MC board very frequently can cause some operations to fail… the MC may miss its destination and keep on rotating" (Paquette, MC fw 4.x, 2003) [V-doc]. Modern SkySafari polls position plus SLEW_DONE continuously at its readout rate (default 4/s) without trouble [V-cap]. **Use 2–4 Hz.**

### 2.3 Discovery (UDP)

- The WiFly module broadcasts a 110-byte UDP "hello" to `255.255.255.255:55555` every 7 s by default. The payload holds MAC, channel, RSSI, port, time, version and so on (WiFly manual §11.4) [V-doc].
- jochym's simulator mimics this: 110×`'X'` from source port 2000 to port 55555 every 5 s, with the comment "the app does not care for the payload" [V-src]. Apps presumably use the sender IP to find the scope in Access Point mode.
- Whether AMW006/007 broadcast the same is [?]. **Client:** default to `1.2.3.4:2000`, and optionally listen on UDP 55555 and offer any sender IP as a candidate. **Simulator:** optionally emit the broadcast.

---

## 3. AUX packet format

```
+------+-----+-----+-----+-----+-----------+-----+
| 0x3B | LEN | SRC | DST | CMD | DATA[0..n]| CK  |
+------+-----+-----+-----+-----+-----------+-----+
 LEN = 3 + n           (counts SRC, DST, CMD, DATA; not 0x3B, LEN or CK)
 total packet length = LEN + 3
 CK  = (-(LEN + SRC + DST + CMD + ΣDATA)) & 0xFF      (two's complement of byte sum)
```
[V-src][V-doc][V-cap]

INDI implementation, quoted from `auxproto.cpp`:
```cpp
buf[0] = 0x3b; buf[1] = len; buf[2] = m_Source; buf[3] = m_Destination; buf[4] = m_Command;
...
for (int i = 1; i < l + 2; i++) cs += buf[i];
return (unsigned char)(((~cs) + 1) & 0xFF);
```

**Multi-byte integers are big-endian.** Positions and rates are 3 bytes (24-bit). [V-src]

**Checksum example** (GET_VER APP→AZM): `03+20+10+fe = 0x131`, `-0x131 & 0xFF = 0xCF` gives `3b 03 20 10 fe cf` (identical to the capture).

### 3.1 Device IDs

| ID | Name | Present on Astro Fi? |
|---|---|---|
| `0x00` | ANY (broadcast) | – |
| `0x01` | MB, main/interconnect board | Evolution MB is **silent** (no GET_VER reply) [V-src caux note "GPS (0xB0), Main Board (0x01)… are SILENT in nsevo.log scan"]. Astro Fi [?], likely the same |
| `0x04` | HC, NexStar hand controller | only if a HC is plugged into AUX |
| `0x0D` | HC+, NexStar+ hand controller | only if plugged in |
| `0x0E` | StarSense HC | optional accessory |
| `0x10` | **AZM motor controller** | **yes** |
| `0x11` | **ALT motor controller** | **yes** |
| `0x12` | Focuser | no |
| `0x20` | **APP**: the source ID used by SkySafari/SkyPortal/INDI ("Network device (skyPortal app)") | **use this as our SRC** |
| `0xB0` | GPS (SkySync) | optional accessory |
| `0xB4` | StarSense camera | optional |
| `0xB5` | WiFi bridge | yes [I]; answers GET_VER |
| `0xB6`/`0xB7`/`0xBF` | Battery / charge port / lights | Evolution only. Astro Fi has none [I] |
| `0xB9` | Unknown target that SkySafari 7 sends `0x49`, `0x32`, `0x31` to (from caux-simulator tests based on an "ss7.log") | [?] |

### 3.2 Echo behaviour

- The bus echoes every packet, so **you receive your own request back first**, followed by the device's response. Paquette: "When the HC sends a packet, the main/interconnect board responds with an echo of the same packet". The Evolution WiFi capture shows `request-echo` + `response` for every command. [V-doc][V-cap] On the Astro Fi: [I], very likely.
- Response packet: `SRC` = the queried device, `DST` = `0x20`, `CMD` = same command ID, `DATA` = the payload (empty for "ack"). For example, the ack of `MOVE_POS` is `3b 03 10 20 24 a9`. [V-cap]
- **Client rule (Paquette):** "wait for the expected response packet and ignore the echo". Accept a packet only if `DST == 0x20 && SRC == expected device && CMD == expected cmd`. Drop everything else: echoes (`SRC == 0x20`), traffic between other devices, bad checksums. Do not depend on the echo arriving either.
- **Unknown or absent device:** no response, so the request times out. Don't treat it as fatal, except for AZM/ALT.

---

## 4. Command reference (motor controllers `0x10` / `0x11`)

Request: `SRC=0x20, DST=0x10|0x11`. "Ack" means a response with empty data (`LEN=3`).

| Cmd | Name | Request data | Response data | Notes / confidence |
|---|---|---|---|---|
| `0x01` | MC_GET_POSITION | – | 3 B position | 24-bit fraction of a revolution, §5 [V-cap] |
| `0x02` | MC_GOTO_FAST | 3 B target (2 B allowed) | ack | Slews at max rate and decelerates to the target. Re-sending re-targets [V-src sim] [V-doc] |
| `0x04` | MC_SET_POSITION | 3 B | ack | Redefines the current encoder value (no motion) [V-doc][V-src] |
| `0x05` | MC_GET_MODEL | – | 2 B model | Evolution `16 87` [V-cap]. Known values (INDI): SLT `0x0783`, SE `0x0b83`/`0x0c82`, Evolution `0x1687`. **Astro Fi value [?]** (it's described as an SLT-class mount) |
| `0x06` | MC_SET_POS_GUIDERATE | 3 B rate, or 2 B special | ack | Continuous rate in the + direction, §6. 2-byte specials: `ffff` sidereal, `fffe` solar, `fffd` lunar (EQ modes only) [V-doc][V-cap] |
| `0x07` | MC_SET_NEG_GUIDERATE | same | ack | Same in the − direction |
| `0x0B` | MC_LEVEL_START | – | ack | ALT leveling (index switch). **Probably unsupported on Astro Fi; don't use** [?] |
| `0x10` | MC_SET_POS_BACKLASH | 1 B (0–99) | ack | SkySafari writes `00` on both axes [V-cap] |
| `0x11` | MC_SET_NEG_BACKLASH | 1 B (0–99) | ack | ditto |
| `0x12` | MC_LEVEL_DONE | – | 1 B (`00` not done, `ff` done) | ALT only |
| `0x13` | **MC_SLEW_DONE** | – | 1 B: `00` = moving, `ff` = done | Poll per axis after GOTO [V-cap] |
| `0x17` | MC_GOTO_SLOW | 3 B target | ack | Slow, precise final approach [V-cap] |
| `0x18` | MC_SEEK_DONE / AT_INDEX | – | 1 B | AZM index sensor; avoid |
| `0x19` | MC_SEEK_INDEX | – | ack | avoid |
| `0x20` | MC_SET_MAXRATE | 2 B | ack | Units are probably 0.001 °/s. SkySafari sends `0d b8` (3512 ≈ 3.5 °/s) [V-cap], units [I] |
| `0x21` | MC_GET_MAXRATE | – | 4 B (two u16) | Evolution: `0f 90 11 94` = 3984 / 4500 [V-cap] |
| `0x22` | MC_ENABLE_MAXRATE | 1 B (`01`/`00`) | ack | [V-cap] |
| `0x23` | MC_MAXRATE_ENABLED | – | 1 B | [V-cap] |
| `0x24` | **MC_MOVE_POS** | 1 B rate 0–9 | ack | Manual move + (AZM: right/CW, ALT: up). **Rate 0 = stop** [V-doc][V-cap] |
| `0x25` | **MC_MOVE_NEG** | 1 B rate 0–9 | ack | Manual move − (left/down) |
| `0x26` | MC_AUX_GUIDE | s8 %sidereal, u8 duration×10 ms | ack | Pulse guide; not needed |
| `0x27` | MC_AUX_GUIDE_ACTIVE | – | 1 B | |
| `0x38` | MC_ENABLE_CORDWRAP | – | ack | AZM only [V-cap] |
| `0x39` | MC_DISABLE_CORDWRAP | – | ack | AZM only |
| `0x3A` | MC_SET_CORDWRAP_POS | 3 B position | ack | SkySafari: `7f ff ff` (180°) [V-cap]. Paquette: set it to "current AZM position + 180° mod 360°" |
| `0x3B` | MC_POLL_CORDWRAP | – | 1 B `ff` enabled / `00` disabled | |
| `0x3C` | MC_GET_CORDWRAP_POS | – | 3 B | |
| `0x40` | MC_GET_POS_BACKLASH | – | 1 B | Evolution `00` [V-cap] |
| `0x41` | MC_GET_NEG_BACKLASH | – | 1 B | |
| `0x46` | MC_SET_AUTOGUIDE_RATE | 1 B (pct = 100·v/256) | ack | not needed |
| `0x47` | MC_GET_AUTOGUIDE_RATE | – | 1 B | **Firmware quirk:** Evolution replies `3b 04 10 20 f0 47 95`, i.e. CMD=`0xF0`, data=`0x47` [V-cap]. Don't send it; the parser must tolerate it |
| `0xFC` | MC_GET_APPROACH | – | 1 B: 0 = positive, 1 = negative | Evolution: AZM `00`, ALT `01` [V-cap] |
| `0xFD` | MC_SET_APPROACH | 1 B | ack | SkySafari writes AZM `00`, ALT `01` [V-cap] |
| `0xFE` | GET_VER | – | 4 B on modern MC (`major minor build_hi build_lo`), 2 B on 2003 firmware | Evolution: `07 0a 10 0d` = 7.10.4109 [V-cap]. Astro Fi MC reported as 7.13 → 7.15 (forum) |

Other targets (only the ones we need):

| Target | Cmd | Notes |
|---|---|---|
| `0xB5` WiFi | `0xFE` GET_VER | returns a version [I]. Optional |
| `0xB0` GPS | `0x01` lat, `0x02` long (3 B signed fraction), `0x33` time, `0x36`, `0x37` | Only if a SkySync GPS is plugged in. Use the laptop's location/time instead |

Do **not** send unknown command IDs. Paquette: some IDs (e.g. `0x81`–`0x84`) enter firmware-programming mode.

### 4.1 Hex examples

```
GET_VER AZM            → 3b 03 20 10 fe cf
  echo                 ← 3b 03 20 10 fe cf
  response (7.10.4109) ← 3b 07 10 20 fe 07 0a 10 0d 9d                      [V-cap]

GET_POSITION AZM       → 3b 03 20 10 01 cc
  response             ← 3b 06 10 20 01 00 c0 1a ef   (0x00c01a = 49178 → 1.0553°) [V-cap]
GET_POSITION ALT       → 3b 03 20 11 01 cb
  response             ← 3b 06 11 20 01 ff ff ac 1e   (0xffffac = −84 → −0.0018°)  [V-cap]

GOTO_FAST AZM to 90°   → 3b 06 20 10 02 40 00 00 88   (0x400000 = 2^24/4)
  ack                  ← 3b 03 10 20 02 cb                                   [V-cap ack form]
GOTO_FAST ALT to −1°   → 3b 06 20 11 02 ff 49 f5 8a   (−46603 & 0xFFFFFF)
GOTO_SLOW AZM to 90°   → 3b 06 20 10 17 40 00 00 73
SLEW_DONE AZM          → 3b 03 20 10 13 ba
  moving               ← 3b 04 10 20 13 00 b9
  done                 ← 3b 04 10 20 13 ff ba                                [V-cap]

MOVE_POS ALT rate 9    → 3b 04 20 11 24 09 9e
MOVE_POS ALT stop      → 3b 04 20 11 24 00 a7                                [V-cap]
MOVE_NEG AZM rate 5    → 3b 04 20 10 25 05 a2                                [V-cap]

SET_POS_GUIDERATE AZM 15.041"/s (×1024 = 15402 = 0x003c2a)
                       → 3b 06 20 10 06 00 3c 2a 5e
SET_NEG_GUIDERATE ALT same → 3b 06 20 11 07 00 3c 2a 5c
SET_POS_GUIDERATE AZM 0 (stop tracking) → 3b 06 20 10 06 00 00 00 c4
SkySafari tracking example → 3b 06 20 10 06 00 2e 4f 47   (11855/1024 = 11.58"/s) [V-cap]

SET_POSITION AZM 0     → 3b 06 20 10 04 00 00 00 c6
SET_POSITION ALT 0     → 3b 06 20 11 04 00 00 00 c5
SET_CORDWRAP_POS 180°  → 3b 06 20 10 3a 7f ff ff 13                         [V-cap]
ENABLE_CORDWRAP        → 3b 03 20 10 38 95                                   [V-cap]
```

### 4.2 Observed SkySafari session (Evolution, real capture) [V-cap]

Connect (after the WiFly `$$$` dance): `GET_VER AZM` → `GET_MODEL AZM` → `MOVE_POS 0` AZM and ALT (stop) → `GET_POS_BACKLASH` ×2 → `GET_APPROACH` ×2 → `GET_MAXRATE` → `MAXRATE_ENABLED` → `GET_AUTOGUIDE_RATE` ×N (gets the `f0 47` quirk) → lights/charger/battery queries → `GET_POSITION` ×2 → `SET_POS_GUIDERATE` AZM `00 2e 4f`, ALT `00 00 83` (tracking starts straight away) → `SET_CORDWRAP_POS 7fffff` → `ENABLE_CORDWRAP` → continuous `GET_POSITION` AZM/ALT polling, plus a battery query every few seconds.

Manual move: `MOVE_NEG AZM 05` … polling … `MOVE_POS AZM 00` (stop) → re-send `SET_POS_GUIDERATE` (tracking resumes).

GoTo (two observed):

| | AZM fast target | AZM slow target | Δ | ALT fast | ALT slow | Δ |
|---|---|---|---|---|---|---|
| #1 | `02 0b 4f` | `03 79 14` | **+1.99°** | `03 93 f5` | `02 27 fc` | **−2.00°** |
| #2 | `ff ed 13` (−0.10°) | `00 59 d7` | +0.60° | `03 9a d8` | `02 2e c4` | **−2.00°** |

Sequence: `GOTO_FAST` AZM + ALT → poll `GET_POSITION` + `SLEW_DONE` both axes until **both** read `ff` → `GOTO_SLOW` both (recomputed target) → poll until both `ff` → `SET_POS_GUIDERATE` both (tracking).

What this shows:
- The fast slew deliberately stops **short of the target on the side opposite the approach direction**, so the final slow move always arrives in the approach direction (AZM approach = 0/positive, so it arrives moving +; ALT approach = 1/negative, so it arrives moving down). This takes up backlash consistently.
- The offset is about 2° (why AZM got 0.6° in #2 is unknown).
- The MC itself does not seem to apply the approach; the app does. [I]

Disconnect: sets backlash 0 on all four registers, `SET_APPROACH` AZM 0 / ALT 1, `ENABLE_MAXRATE 01`, `SET_MAXRATE 0db8` both, lights/charger settings, cordwrap again, and leaves tracking running (`SET_POS_GUIDERATE`).

### 4.3 Recommended client init sequence (Astro Fi)

1. TCP connect (5 s timeout). Discard any non-`0x3B` bytes.
2. `GET_VER` AZM and ALT. Both must respond, otherwise fail (same as INDI `Handshake()`). Optionally `GET_VER` WiFi `0xB5` and `GET_MODEL` AZM; log the results.
3. Stop both axes: `SET_POS_GUIDERATE 00 00 00` + `MOVE_POS 00`.
4. `GET_POSITION` both.
5. **Encoder zero handling:**
   - INDI: "Only reset if both encoders report zero. If mount was initialized before, then we shouldn't reset the value". It then calls `startupWithoutHC()`: `SET_POSITION 0` on both axes (`0x400000` for EQ-GEM ALT), then `SET_CORDWRAP_POS 0xc00000` and `ENABLE_CORDWRAP`. [V-src]
   - SkySafari never sends `SET_POSITION`. It works with raw encoder values. [V-cap]
   - Our choice: never require `SET_POSITION`. Model the offsets in the pointing model (§7). Optionally offer a "home: tube level, pointing north" step that sends `SET_POSITION 0,0` for a good starting guess.
6. `SET_CORDWRAP_POS` (current AZM + 180°) and `ENABLE_CORDWRAP`. Optional, since the Astro Fi has no external cables to wrap apart from the power lead [I].
7. Poll `GET_POSITION` AZM/ALT at 2–4 Hz. Poll `SLEW_DONE` during GoTos.
8. Persist {encoder snapshot, alignment model, timestamp}. On reconnect, if the encoders are near 0,0 and much time has passed, assume a power cycle and invalidate the alignment (§8).

---

## 5. Position math

- One revolution = **2^24 = 16,777,216 steps**. 1 step = 360°/2^24 ≈ **0.0772″**. 1° = 46,603.38 steps. [V-src] (INDI: "AUX commands use 24bit integer as a representation of angle in units of fractional revolutions. Thus 2^24 steps makes full revolution.") This is a protocol unit, not the true encoder resolution. The real mechanical resolution is coarser [?].
- **AZM:** unsigned, wraps modulo 2^24. `deg = steps * 360 / 2^24`.
- **ALT:** treat as **signed 24-bit two's complement** (`if (v >= 0x800000) v -= 0x1000000`), giving −180…+180°. Real capture: ALT `ff ff ac` = −84 steps when the tube was just below level [V-cap]. Paquette calls positions "signed fraction". jochym argued they are unsigned. Both read the same once you interpret ALT as signed. Send negative ALT targets as `value & 0xFFFFFF`.
- Encoding:
  ```ts
  const STEPS = 1 << 24;
  const toSteps = (deg: number) => ((Math.round(deg / 360 * STEPS) % STEPS) + STEPS) % STEPS;
  const fromStepsAz = (s: number) => s * 360 / STEPS;                       // 0..360
  const fromStepsAlt = (s: number) => (s >= 0x800000 ? s - STEPS : s) * 360 / STEPS; // -180..180
  const be24 = (v: number) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  ```
- **Direction convention:** `MOVE_POS` = AZM "right", ALT "up" [V-doc]. INDI maps AZM encoder degrees directly to azimuth (N=0°, E=90°) in the northern hemisphere (`DegreesToAzimuth()` returns the same value), so increasing AZM steps means azimuth increasing N→E, clockwise seen from above [I from INDI]. **Verify on day one** (MOVE_POS AZM rate 6 for 2 s and watch). A pointing model built from rotations cannot absorb a mirrored axis.
- **Zero point:** encoders are relative. At power-on they are believed to read 0,0, whatever the physical orientation (INDI checks for exactly 0,0 to detect "fresh"; the Evolution capture at connect showed values near 0) [I]. Physical azimuth zero and the tube's elevation at power-on are both unknown, so the pointing model must solve for both azimuth and altitude offsets.

---

## 6. Rates, slewing, GoTo, tracking

### 6.1 Variable ("guide") rate: 0x06 / 0x07

- **3-byte value = angular rate in arcsec/s × 1024** (unit = 1/1024 ″/s). Equivalently steps/s × 79.1015625 (= 10125/128). [V-src] INDI: "Logical unit for guiding commands is 1/1024 arcsec/sec … Rate based on geometric analysis and testing against SkySafari 7, simulator and real mount … GAIN_STEPS = 10125/128". jochym's simulator: "The 1024 factor is taken from the AUXBUS scanner to fit the actual hardware".
- **Sign:** `0x06` = positive direction, `0x07` = negative direction, with an unsigned magnitude. Zero (`0x06 00 00 00`) stops the guide motion.
- Max magnitude `0xFFFFFF` ≈ 16,383 ″/s ≈ 4.55 °/s.
- Sidereal 15.041 ″/s → 15402 (`00 3c 2a`).
- 2-byte specials `ffff`/`fffe`/`fffd` (sidereal/solar/lunar) only make sense for an EQ-wedge setup on the AZM axis. Don't use them for alt-az.
- 2-byte vs 3-byte forms: the 2-byte form is a rate in units of ¼″/s (HC `P`-command docs). The 3-byte form is the same value shifted 8 bits left, which gives ×1024 [I].
- **Discrepancy [?]:** Paquette's 2003 alt-az example (NexStar GPS, MC 4.x) shows encoder motion that doesn't match the ×1024 interpretation. INDI's modern value was validated against real 7.x mounts, so use ×1024 and **verify on hardware**: command a known rate, measure Δsteps/Δt.
- Interaction with other commands is [?]. INDI always zeroes the guide rate before a GOTO or MOVE (`slewTo()`/`slewByRate()` call `trackByRate(axis, 0)` first), and stops with guide rate 0 + `MOVE_POS 0`. **Do the same.**

### 6.2 Fixed slew rates: 0x24 / 0x25 (rate 0–9)

Rate meanings belong to the firmware; Celestron doesn't document them for the Astro Fi. SLT-class nominal values (the Astro Fi is often described as "an SLT with a hidden WiFi module"; spec "up to 3°/s"):

| Rate | SLT manual (nominal) | nexstarsite measured (SLT) | caux-simulator (Evolution) |
|---|---|---|---|
| 1 | 2× sidereal (0.008°/s) | 0.5× | 0.008°/s |
| 2 | 4× | 1× | 0.017°/s |
| 3 | 8× | 4× | 0.033°/s |
| 4 | 16× | 8× | 0.067°/s |
| 5 | 32× | 16× | 0.133°/s |
| 6 | 64× / 0.3–0.5°/s | 64× | 0.5°/s |
| 7 | 1°/s | 1°/s | 1°/s |
| 8 | 2°/s | 1.75°/s | 2°/s |
| 9 | 3–4°/s | 2.75°/s | 4°/s |

[?] for the Astro Fi. Make the table configurable in the simulator and measure on hardware. A press-and-hold GUI should send rate N on press and rate 0 on release. Send the stop more than once if the network is flaky.

### 6.3 GoTo

- `MC_GOTO_FAST` drives the axis at its max slew rate (`MAXRATE`; Astro Fi ~3°/s) with firmware-controlled accel/decel to the target. `MC_GOTO_SLOW` moves to the target at a slow rate (value [?]; simulators use 0.2–0.5°/s).
- Axes are independent. Poll `MC_SLEW_DONE` on each until `0xFF`. Once one axis reports done, keep polling only the other (Paquette).
- **Recommended algorithm** (SkySafari-like; INDI uses the same pattern with a 0.5° offset):
  1. Compute the target encoder position at `t_now + estimated_slew_time` using the pointing model. Optionally iterate once.
  2. Pre-target = target − approach_dir × 2° per axis (AZM approach +, ALT approach −, or derive the direction from the tracking vector as INDI's `APPROACH_TRACKING_VECTOR` does: "rewind" 60 s).
  3. Zero the guide rates, send `GOTO_FAST` pre-target on both axes, poll until both are done.
  4. Recompute the target for now, send `GOTO_SLOW` on both, poll until done.
  5. Start tracking (§6.4) immediately.
- **AZM shortest path / cordwrap:** with cordwrap enabled the MC is supposed to avoid crossing the cordwrap position and take the long way round [I from Paquette's description]. Which way the MC rotates for a target more than 180° away, with cordwrap disabled, is [?]. Treat GOTO targets as absolute encoder values. The client decides the unwrapped target (keep a software notion of accumulated azimuth turns if wrap avoidance matters).
- **Altitude limits:** no firmware alt limit is documented [?]. The client must clamp, e.g. ALT −5° … +90°, so the Newtonian doesn't hit the arm/base. Measure the real limits.
- **Abort:** `MOVE_POS 00` on both axes plus guide rate 0 (INDI `Abort()`) [V-src]. That this halts an in-progress GOTO on real hardware is [I], since INDI relies on it.

### 6.4 Alt-az tracking (client-side, mandatory)

The MC can't track an alt-az mount by itself, so the client must keep sending rates. Celestron's HC re-computed rates "every 30 seconds depending on the current ALT/AZM position" (Paquette). SkySafari re-sends on state changes. INDI updates every poll (~1 s) with a predictive rate plus an optional PID correction.

Recommended loop (period T = 1 s, at most 2 s):
```
target(t)   = model.skyToEncoder(raDec, t)            // degrees per axis (AZM unwrapped)
rate_pred   = (target(t+5s) - target(t-5s)) / 10s     // central difference, deg/s (INDI uses ±5 s)
err         = wrap180(target(t) - encoderNow)         // deg
rate_cmd    = rate_pred + clamp(err / τ, ±maxCorr)    // τ ≈ 5–20 s; maxCorr e.g. 30″/s
value       = round(|rate_cmd| * 3600 * 1024)         // 24-bit, clamp to 0xFFFFFF
send (rate_cmd >= 0 ? 0x06 : 0x07, axis, be24(value))
```
- Skip the send if the value hasn't changed (INDI deduplicates with `m_LastTrackRate`).
- Near the zenith the azimuth rate diverges, so clamp it and expect tracking to degrade there ("keyhole").
- Use the latest polled encoder value with its timestamp. Extrapolate by `rate × latency`.
- The pointing model (§7) belongs in `skyToEncoder`. Don't track in pure ideal alt-az, or residual tilt shows up as drift.

---

## 7. Alignment / pointing model

### 7.1 What Celestron does

- **SkyAlign** (HC and SkyPortal):
  - The user enters or gets time and location, then centres any 3 bright objects (stars of mag ≤ 2.5, the four brightest planets, the Moon) without naming them.
  - The software identifies them by matching measured angular separations against the catalog.
  - "Only two of the objects (those with widest separation) will actually be used for calculating the model of the sky; the third provides a positive identification of the other two."
  - [V-doc] Celestron/nexstarsite. The exact math isn't published.
- **3-Star Align / Solar System Align** (the Astro Fi spec lists "SkyAlign, 3-Star Align, Solar System Align"): user-named objects.
- **StarSense:** a camera accessory (`0xB4`) that plate-solves; not built into the Astro Fi.
- In the Astro Fi setup the model lives **in the app** (SkyPortal "Connect and Align"). Nothing is stored in the mount, and it is lost on disconnect or power cycle [V-doc/forum].
- CPWI (Celestron's Windows HC replacement) and INDI keep their own models. INDI's alignment subsystem uses Toshimi Taki's matrix method, plus "Nearest"/SVD math plugins.

### 7.2 Recommended model for our server

**Frames.**
- Topocentric apparent (Az, Alt) of a star = catalog J2000 → precession, nutation, aberration (apparent of date) → hour angle from laptop UTC + longitude → alt-az → **add atmospheric refraction**, since the scope sees the refracted position.
- Mount frame (A_e, E_e) = encoder degrees.

**Parameters** (TPOINT naming):

| Param | Meaning | Required? |
|---|---|---|
| `IA` | azimuth encoder zero offset | **yes** (arbitrary at power-on) |
| `IE` | altitude encoder zero offset (tube elevation at power-on) | **yes** (arbitrary at power-on) |
| `AN`, `AW` | tilt of the azimuth axis N-S / E-W (tripod not level) | yes (tripods are rarely level to <0.5°) |
| `CA` | collimation (optical axis ⟂ alt axis error) | optional, ≥3 stars |
| `NPAE` | alt axis not ⟂ az axis | optional, ≥4 stars |

**Forward model** (sky → encoder):
1. Convert (Az, Alt) to a unit vector `v`.
2. `v' = R(AN, AW) · v`, where R is a small rotation tilting the vertical by the base tilt.
3. Convert `v'` to spherical (A', E').
4. `A_e = A' − IA + CA·sec E' + NPAE·tan E'` and `E_e = E' − IE`.

Invert numerically for encoder → sky (2–3 fixed-point/Newton iterations), or fit both directions. Signs and conventions are free, as long as forward and inverse are consistent and the simulator uses the same definitions for its "truth".

**Fitting.**
- Each alignment star i gives measured (A_e,i, E_e,i) at time t_i and predicted (Az_i, Alt_i) at t_i.
- Minimise Σ[(ΔA·cos E)² + ΔE²] with Levenberg-Marquardt.
- Initial guess from the first star: `IA = A_e1 − Az1`, `IE = E_e1 − Alt1`, tilts = 0.

| Stars | Unknowns solved | Result |
|---|---|---|
| 1 | IA, IE (assume level) | usable rough GoTo |
| 2 | IA, IE, AN, AW (4 eq / 4 unknowns, exact) | equivalent to Celestron's 2-star model. Pick stars ≥ 60° apart in azimuth, neither near the zenith |
| 3+ | add CA (and NPAE with ≥4) | least squares. Report RMS residual per star |

**Taki 2/3-star matrix method** (closed form; build orthonormal triads `(v1, v2, v1×v2)` in both frames and solve `T = M·S⁻¹`):
- Fast and robust **only if IE ≈ 0**. An altitude encoder offset is not a rotation of the sphere.
- Use it as an initialiser or after a "home: tube level" `SET_POSITION 0,0`.
- Reference: Taki, "Matrix Method for Coordinates Transformation". The INDI alignment white paper warns the "simple method proposed by Toshimi Taki … can result in matrices that are not true transforms".

**SkyAlign-style auto-ID** (optional):
- Measured separations are invariant to IA and tilt but **not** to IE.
- Solve IE jointly, or require a rough "level tube at power-on" start.
- Then match triangles of measured separations against bright-star triples above the horizon. The third star confirms the pair.

**Sync / refine:** after centring an object, add it as a model point and refit. Or, for a quick local correction, adjust IA/IE only.

**Practical notes**
- Time: laptop clock (no Internet in the field). 1 s of error ≈ 15″ RA, fine for visual use. Warn if the clock looks unsynced.
- Location: user input or a browser geolocation cache. The Astro Fi has no GPS.
- Backlash: for alignment points, always approach the final centring from the same direction as GoTo's approach (the GUI should finish with the "up" and "right" buttons, which is Celestron's standard advice).

---

## 8. Astro Fi 130 hardware and session gotchas

- **Mount:** computerized alt-az, single fork arm, DC servo motors, slew up to 3°/s, tracking modes Alt-Az / EQ North / EQ South, sidereal/solar/lunar, no PEC, payload 3.6 kg, 12 V DC 1 A tip-positive, 2× AUX (RJ-12, TTL 19200 bd), no USB, no autoguide port, no HC included [V-doc Celestron spec page]. Gear ratios and real encoder counts aren't published [?]. They don't matter for the protocol (24-bit abstraction), but they set backlash and the real resolution (likely arc-minute-ish).
- **No manual clutches/slow-motion:** the tube can't easily be pushed by hand (reviews note it needs app and power). If someone forces it, the encoders may not see the motion, so re-align.
- **Power-on order:**
  1. Set the WiFi switch to RIGHT (Direct).
  2. Power on.
  3. Wait for the WiFi LED and SSID.
  4. Join `Celestron-XX`.
  5. Then open the TCP connection.
  - Power cycling the scope resets the encoders (to 0,0 [I]) and drops TCP. The alignment is then invalid.
  - App reconnects **without** a power cycle keep the encoders, so the alignment can be reused. Persist the model and detect power cycles (encoders ≈ 0,0 after a disconnect while the last known position was elsewhere).
- **Laptop gotchas:** the network has no Internet. macOS keeps the association but may try other known networks; tell the user to "forget" competing networks (nexstarsite: auto-reconnect to the home network makes the app lose alignment). Phones with SkyPortal nearby may auto-join and connect, so make sure only one client is active.
- **Firmware updates** (CFM) can run over WiFi. Not our concern, but never send `0x81`–`0x84`.
- **Hand controller attached:** if a NexStar+ HC is plugged into AUX it also sits on the bus (`0x0D`) and does its own tracking. Packets from SRC `0x0D` will then appear. Ignore them, and warn the user that HC tracking and our tracking will fight.

---

## 9. Simulator requirements

Base it conceptually on jochym's `nse_simulator.py`/`nse_telescope.py` (INDI repo) and the newer `caux-simulator` (PyPI), with the fixes listed below.

**Transport**
- [ ] TCP server, configurable host/port (default `127.0.0.1:2000`). Option: accept one client, refuse or close a second (configurable).
- [ ] Optional UDP broadcast of 110 bytes to `255.255.255.255:55555` every 5–7 s.
- [ ] Optional WiFly emulation: send `*HELLO*` on connect. `$$$` enters command mode → reply `CMD\r\n`. Other lines → echo + `\r\nAOK\r\n<2.40-CEL> `. `exit` → `\r\nEXIT\r\n`.
- [ ] **Stream parser with buffering.** The original sim assumes whole packets per `read()`; ours must handle fragmentation and coalescing. Resync on `0x3B`. **Drop bad-checksum packets silently.**
- [ ] For each valid packet: write the **echo** (exact bytes), then, if the target device exists and knows the command, write the response `3b, 3+n, dst, src, cmd, data…, ck`. Unknown device or command: echo only, no response. (caux suppresses the echo for absent devices. That's unverified, so make it configurable.)
- [ ] Configurable response latency (default 10–20 ms) and jitter, plus optional loss, corruption and stall injection. Option to coalesce echo + response into one write (as the real bridge does) or split them.
- [ ] Optional quirk: `0x47` returns CMD `0xF0` data `0x47`.

**Devices**
- [ ] AZM `0x10`, ALT `0x11`: all commands in §4 (positions, gotos, moves, guide rates, slew done, cordwrap regs, backlash regs, approach regs, max-rate regs, GET_VER `07 0f xx xx` (configurable), GET_MODEL configurable (default SLT `07 83`? [?])).
- [ ] WiFi `0xB5`: GET_VER only. MB/GPS/BAT absent (silent) by default.

**Motor physics (per axis, integer steps)**
- [ ] Position: 24-bit integer. AZM wraps mod 2^24. ALT signed, with configurable **mechanical limits** (stops at the limit; GOTO beyond the limit never completes, or clamps, configurable).
- [ ] Superposed motion = slew component (MOVE rate table or GOTO profile) + guide-rate component (value/1024 ″/s → steps/s = value × 128/10125).
- [ ] MOVE rate 0 stops the slew component. GOTO_FAST: trapezoidal profile with accel (e.g. 3°/s²) and max (config, default 3°/s). GOTO_SLOW: slow constant rate (config 0.3°/s). Completion tolerance a few steps. A new GOTO re-targets. SLEW_DONE = `00` while slewing, `ff` otherwise.
- [ ] Option: GOTO/MOVE zero the guide rate (behaviour [?]; default off, since the client zeroes it explicitly anyway).
- [ ] Cordwrap: when enabled, an AZM GOTO doesn't cross the cordwrap position (takes the long way).
- [ ] Optional physical backlash (hysteresis between encoder and optical axis, as caux's `BACKLASH_PLAN.md`) and firmware backlash compensation from regs `0x10`/`0x11`.

**Sky truth (for testing alignment and tracking)**
- [ ] Hidden "true" mount orientation: random azimuth of encoder zero (IA), random tube elevation at power-on (IE), base tilt AN/AW (0–1°), cone error CA, NPAE, optional refraction, optional periodic error. Encoders start at 0,0 at "power-on".
- [ ] Observer location and clock (system clock with optional offset or warp) to compute true RA/Dec under the crosshair.
- [ ] Debug side channel (HTTP/WS on another port, not port 2000) exposing the true pointing RA/Dec/Alt/Az, the true parameters, and controls: power-cycle (encoders → 0,0, keep physical orientation, drop TCP), randomise setup, fault injection. Tests assert GoTo accuracy against this truth.
- [ ] Log every packet with a timestamp (hex) for golden-trace tests. Replay the §4.2 SkySafari sequence as a conformance test.

---

## 10. Open questions (verify with real hardware)

1. **[?]** Does the Astro Fi bridge (AMW006/AMW007) **echo** our packets like the Evolution? (The client must work either way.)
2. **[?]** Any ASCII banner (`*HELLO*`) on TCP connect? Does it react to `$$$`? (Never send `$$$`.)
3. **[?]** SSID security (open?), DHCP range and gateway on Astro Fi. Does it UDP-broadcast on 55555?
4. **[?]** Concurrent TCP clients accepted? What happens to the first when a second connects?
5. **[?]** `GET_MODEL` / `GET_VER` values on Astro Fi MC; `GET_VER` on `0xB5`; presence of MB `0x01`.
6. **[?]** **Guide-rate scaling** (×1024 ″/s) on Astro Fi firmware: measure Δsteps/Δt for value 15402.
7. **[?]** Rate 0–9 actual speeds, GOTO_FAST max speed / accel (MAXRATE regs), GOTO_SLOW speed.
8. **[?]** AZM direction sign (MOVE_POS = clockwise from above?) and ALT sign (MOVE_POS = up).
9. **[?]** Encoder values at power-on (0,0?). Persistence across TCP reconnects.
10. **[?]** Does GOTO/MOVE cancel an active guide rate, or add to it? Does `MOVE_POS 0` abort a GOTO?
11. **[?]** Cordwrap semantics on Astro Fi; behaviour for AZM targets >180° away.
12. **[?]** Mechanical ALT limits (can the OTA pass the zenith or hit the base?). Any firmware limits?
13. **[?]** What SkyPortal sends to `0xB9`/`0xB5` (`0x30` time, `0x31` location, `0x32`, `0x49`). From caux test data, `0x31` carries lat/lon as **big-endian float32** (`42 48 b7 32 41 9e 46 aa` → 50.18, 19.78), even though caux's handler decodes little-endian. Not needed for control.
14. **[?]** Real backlash magnitude (needed for approach offset and simulator defaults).

---

## 11. References

Source code
- INDI `indi-celestronaux` driver (Jochym, Pollastri, Mutlaq): https://github.com/indilib/indi-3rdparty/tree/master/indi-celestronaux
  - `auxproto.h` / `auxproto.cpp` (command and device enums, packet build, checksum, default IP/port)
  - `celestronaux.cpp` (`Handshake`, `startupWithoutHC`, `slewTo`, `trackByRate`, `Goto` approach logic, `TimerHit` alt-az tracking, `tcpReadResponse`, `processResponse`)
  - `celestronaux.h` (`STEPS_PER_REVOLUTION`, `GAIN_STEPS = 10125/128`, model IDs)
  - `simulator/nse_simulator.py`, `simulator/nse_telescope.py` (TCP 2000, UDP 55555 broadcast, WiFly `$$$` emulation, echo + response)
  - `ISSUES.md` (connection-loss latency, 30 s HC tracking note)
- jochym/caux-simulator (unified AUX simulator; motor physics, backlash, device profile from a real Evolution scan): https://github.com/jochym/caux-simulator (PyPI `caux-simulator`)
  - `src/caux_simulator/devices/motor.py`, `bus/aux_bus.py`, `devices/wifi.py`, `docs/notes.md`, `BACKLASH_PLAN.md`
- jochym/nexstar-evo (notes and **real SkySafari↔Evolution captures**): https://github.com/jochym/nexstar-evo
  - `analysis/connect-goto-disconnect.txt` / `.uniq_cmds`, `doc/notes.md`, `doc/NexStar_AUX_Commands_10.pdf`
- jochym/indi-nexstarevo (original INDI driver): https://github.com/jochym/indi-nexstarevo
- Wixely/CelestronESPWifi (ESP8266 clone of the Celestron WiFi bridge: AP, 1.2.3.4, TCP 2000, raw UART pipe, single client): https://github.com/Wixely/CelestronESPWifi

Protocol documents
- Andre Paquette, *NexStar AUX Command Set* v1.0 (2003): copy in the repos above; original site http://www.paquettefamily.ca/nexstar/
- Roving Networks *WiFly GSX/EZX User Manual* 2.31 (UDP broadcast 55555, `$$$`, `*HELLO*`): https://github.com/jochym/nexstar-evo/tree/master/doc

Celestron / community
- Astro Fi 130 specs: https://www.celestron.com/products/astro-fi-130mm-newtonian-telescope
- Astro Fi manual (WiFi switch, "Celestron-xx", "Connect and Align"): https://celestron-site-support-files.s3.amazonaws.com/support_files/22201_22202_22203_Astro%20Fi_Telescope_Manual_5languages_USA_F_BW.pdf
- nexstarsite WiFi troubleshooting (SSID generations, Direct vs Access Point, multi-device warnings): https://www.nexstarsite.com/PCControl/WiFiControlProblems.htm
- nexstarsite WiFi bridge firmware (AMW007; Astro Fi = same as SkyPortal module): https://www.nexstarsite.com/OddsNEnds/WiFiBridgeFirmwareUpgradeHowTo.htm
- nexstarsite Astro Fi ports: https://www.nexstarsite.com/OddsNEnds/PortsAstroFi.htm
- nexstarsite SLT slew rates (measured): https://www.nexstarsite.com/OddsNEnds/SLTSlewRates.htm
- Cloudy Nights, Celestron WiFi = AUX protocol, port 2000: https://www.cloudynights.com/forums/topic/884910-nexstar-wifi-control-through-asiair/ and https://www.cloudynights.com/forums/topic/560277-celestron-skyportal-wifi-connect-to-pc-and-ascom-it-works33/
- INDI forum, Astro Fi 5 with the INDI Celestron driver (alignment lives in the client): https://indilib.org/forum/stellarmate/8610-kstars-celestron-alignment-issue-i-think.html
- Celestron SkyAlign description: https://www.celestron.com/pages/skyalign-technology and https://www.nexstarsite.com/Book/Updates/SkyAlign.htm
- CPWI manual (Celestron PC software over WiFi): https://celestron-site-support-files.s3.amazonaws.com/support_files/CPWI%20Software%20Manual_ENG_F.pdf
- Stellarium desktop has no native Celestron-WiFi/AUX support (users bridge via CPWI/ASCOM or INDI): https://www.cloudynights.com/forums/topic/690394-wifi-and-stellatium-configuration/

Alignment math
- Toshimi Taki, *Matrix Method for Coordinates Transformation*: http://takitoshimi.starfree.jp/matrix/matrix.htm
- INDI Alignment Subsystem white paper: https://www.indilib.org/api/md_libs_alignment_alignment_white_paper.html
