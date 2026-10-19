# Stargazer safety and equipment-protection spec

Scope: what the Stargazer server and GUI must do to protect **eyes, people, the Astro Fi 130 and its firmware**. Read it alongside PROTOCOL.md (wire format) and ARCHITECTURE.md (who owns what).

Researched 2026-10-18 without hardware. Confidence tags follow PROTOCOL.md, with one addition:

| Tag | Meaning |
|---|---|
| **[V-src]** | Verified in open-source driver/simulator code (INDI `indi-celestronaux`, jochym `caux-simulator`) |
| **[V-cap]** | Verified in a real SkySafari ↔ NexStar **Evolution** WiFi packet capture (jochym/nexstar-evo `analysis/`) |
| **[V-doc]** | Stated by Celestron (manuals, firmware history, knowledge base), SkySafari docs, or Paquette's AUX document |
| **[V-forum]** | Reported by several owners on forums or in reviews. Plausible, but not official |
| **[I]** | Inferred, or our own engineering recommendation |
| **[?]** | Unknown. Measure on the real scope (see §8) |

**Main conclusions**

1. The motor controller (MC) has **no slew limits, no Sun awareness and no host watchdog**. Every limit lives in the app. Stargazer is the *only* thing between a bad command and the tube hitting the tripod, the power cable wrapping, or the scope pointing at the Sun.
2. Once the TCP link drops, **we cannot stop the mount**. A GoTo runs to its target. A `MOVE` keeps running, and so does a tracking rate, until a stop command, a collision or a power-off. The design must keep open-ended motion short and bounded, and the user must know where to cut power.
3. **No battery or voltage readout is expected on the Astro Fi.** The battery device `0xB6` exists only on the NexStar Evolution. We can probe for it with one safe GET, and otherwise show proxies (§5).

---

## 1. Mechanical limits

### 1.1 Facts and evidence

| Item | Finding | Tag |
|---|---|---|
| Tube | 130 mm f/5 Newtonian, 650 mm focal length, **optical tube length 66 cm (26 in)**, on a single fork arm. Kit weight 17 lb. | [V-doc] Astro Fi manual specs |
| Mount family | Same single-arm SLT-class mount as the NexStar 130 SLT (same 130/650 tube) | [V-forum]/[I] |
| Near-zenith collision | On the 130 SLT: "there is bound to be a region around the zenith … that cannot be accessed". The HC "will not attempt to drive to an elevation which might cause the bottom of the telescope tube to foul the mount or tripod", with an "altitude slew limit of 65 degrees which I suspect is a little conservative". Owners reach the zenith only by making sure "the mirror-cell end … drops down between the tripod tubes". One owner bumped a leg several times in the dark and advises avoiding the "20+ degrees around the zenith". | [V-forum] jb.man.ac.uk 130SLT review; Cloudy Nights 130 SLT detailed review |
| Collision depends on azimuth | The mirror end clears the tripod between legs but hits a leg if it's over one. Clearance also depends on where the tube sits in the dovetail (balance) and on accessories (diagonal, camera, phone adapter). A 90SLT with a DSLR topped out at 77.0° (inclinometer). | [V-forum] CN "90SLT slew limit" |
| App defaults | SkySafari/SkyPortal: "Altazimuth mounts default to a 70° altitude slew limit as some mounts cannot point all the way to zenith." Max limit range 0–90°. The **minimum** limit is for obstructed horizons. | [V-doc] SkySafari Celestron Wi-Fi help |
| HC defaults | SLT manual: slew limits "prevent the telescope tube from slewing to an object below the horizon or … high enough that the tube might hit one of the tripod legs". Set 90° only if "certain that the tube will not hit the tripod legs". | [V-doc] NexStar SLT manual |
| Below horizontal | No reports of the front end or focuser hitting anything down to a few degrees below level. The front (open) end is ~30–35 cm from the alt axis and swings down over the tripod tray. The real lower limit is unmeasured. | [?] |
| Firmware limits | **None in the MC.** Limits are app-side: they "do not work until the telescope is aligned", are "relative to the base of the mount not the horizon", and the HC and app each remember their own value. No MC command for altitude limits exists in Paquette's table, INDI or the capture. | [V-doc] SkySafari help; [V-forum] CN "SkyPortal and SkySafari ignoring slew limits" / "HC & Sky Portal Slew Limit settings"; [V-src] absence |
| Hard stops | No documentation of mechanical alt end-stops on the Astro Fi. Assume the motor will happily drive the tube into the tripod or arm. | [?] |
| No clutch | Manual: "Do not try to move the telescope left and right while it is off." There's no clutch or slow-motion: the gear train is always engaged. A block means the motor stalls against the gears; it can't slip. | [V-doc] Astro Fi manual; [V-forum] reviews ("can't be moved manually") |
| INDI | Optional per-axis angle limits (`SLEW_LIMIT_AXIS1_MIN/MAX`, `enforceSlewLimits()` checked every `TimerHit`, calls `Abort()` on violation). Defaults are the full range, so they're effectively off. | [V-src] celestronaux.cpp |
| CPWI | Documents only RA limits for EQ mounts. Owners use CPWI's altitude limits to stop the image train hitting the base. | [V-doc]/[V-forum] |

### 1.2 Azimuth cord wrap

| Item | Finding | Tag |
|---|---|---|
| Where the cable goes | Astro Fi "POWER Connector – located on the fork arm". The arm rotates in azimuth. The manual says to "Leave the battery pack in the accessory tray", which is fixed to the tripod. **So the power lead wraps around the base as azimuth accumulates.** A 12 V lead from the ground behaves the same way. | [V-doc] nexstarsite PortsAstroFi; Astro Fi manual |
| Max safe turns | Not published. It depends on lead length and where the pack sits. Assume **±1/2 to ±3/4 turn** from cable-neutral until measured. | [?] |
| MC cordwrap | `MC_SET_CORDWRAP_POS`/`MC_ENABLE_CORDWRAP` make the MC avoid crossing one azimuth position during GoTo. Paquette: set it to "current AZM position + 180° mod 360°". INDI sets 0xC00000 (270°) after zeroing. Whether it also limits `MOVE` and guide-rate motion is unknown (probably not). How the MC picks the direction for targets >180° away is unknown. | [V-doc][V-src][?] |
| Nothing counts turns for us | The 24-bit AZM position wraps modulo 360°. The MC doesn't tell us how many turns have accumulated. | [V-src] |

### 1.3 Recommended software limits (defaults until measured)

All limits are in the **mechanical frame**: mechanical altitude `h_mech = E_e + IE_level`, where `IE_level` is the encoder reading when the tube is physically level. They are not in sky altitude. A tilted tripod shifts sky altitude, not where the tube hits the legs.

| Limit | Default before measurement | After day-one measurement | Tag |
|---|---|---|---|
| Max mechanical alt | **+70°** (SkySafari default, between the 65° SLT HC and 77° DSLR reports) | measured worst-case collision altitude (over a leg, with the usual eyepiece/diagonal) **minus 3°** | [I] |
| Min mechanical alt | **−5°** | measured lower clearance minus 3°, and never below −10° | [I] |
| Min *sky* alt for GoTo targets | 0° (confirm), 10° default for the "tonight" list | user setting for local horizon | [I] |
| Azimuth soft wrap | **±200°** unwrapped from cable-neutral: refuse new GoTos beyond it, stop tracking and offer "Unwind" | ± measured safe wrap minus 20° | [I] |
| Azimuth hard wrap | **±240°**: stop everything immediately | ± measured safe wrap | [I] |
| Az GoTo leg length | Never command one AZM GOTO more than **170°** from the current position. Split longer moves into legs, so the MC can't pick the "other way round" whatever its cordwrap logic does. This also makes the Sun path check valid (§3.3). | | [I] |

`config.ts` currently has `altLimitsDeg: [-5, 90]`. **Change the upper default to 70** until it's measured.

**Before the altitude reference is known** (quality `none`: the encoder reads 0 at power-on, wherever the tube points [I]):
- Hard alt limits are meaningless. The GUI must ask at connect: "Is the tube level (within ~5°)?"
- If the answer is no or unknown: no GoTo, manual moves at **rate ≤ 6** only, and an alt envelope of **±30° from the power-on position** until the user does "Home" (tube level, `alignHome`). Show this state prominently.

### 1.4 How to measure limits on day one

See §8, steps 12–15. Summary:
1. Level the tube with a phone inclinometer, then Home.
2. Rotate azimuth so the mirror end is **directly over a tripod leg** (worst case). With the usual diagonal/eyepiece fitted, raise the tube at rate 5–6 (~0.1–0.5°/s), with a hand on the power plug. Stop when about 2 cm of clearance is left and record `h_mech`.
3. Repeat between legs, and for the downward direction.
4. For wrap: mark the cable at neutral and rotate azimuth slowly (rate 7) each way until the lead is snug but not tight. Record the unwrapped angle.

---

## 2. Motor and gear protection

### 2.1 Known firmware hazards (Astro Fi MC)

| Version | Celestron note | Consequence for us | Tag |
|---|---|---|---|
| Astro Fi MC **7.13.6110** (Mar 2017) | "Bug Fix: **Tracking command sent during slew caused mount slew forever**." | On older firmware, sending `SET_POS/NEG_GUIDERATE` during a GOTO causes a runaway. Even on newer firmware, **never send guide-rate commands while either axis is in GOTO.** | [V-doc] celestron.com firmware-update-history |
| Astro Fi MC **7.15.8160** (Feb 2018) | "Feedback loop retuned to make slewing at rate 2-6 smoother", goto drop error reduced | Recommended minimum. Warn if the MC reports < 7.15. | [V-doc] |
| Evolution MC 7.18.2214 (Aug 2024) | "Rapid tapping on slew buttons in the direction opposite to tracking" bumped the OTA ±¼° | Same MC family: debounce and rate-limit direction changes (§2.3). | [V-doc] |
| CFM 2.7.7070 (May 2018) | "package delays in serial packets exceeding 200ms cause problems" (in the firmware tool) | Don't let a packet's bytes trickle out. Write whole packets in one `socket.write`. | [V-doc] |
| Paquette (MC 4.x) | "Polling the MC board very frequently can cause some operations to fail … the MC may miss its destination and keep on rotating." | Poll at 2–4 Hz, one request outstanding. | [V-doc] |

### 2.2 Stall and runaway detection

The MC reports no stall or fault flag [V-src: none exists in any known command set]. Detect both from polled encoder positions (2–4 Hz):

- **Stall:** an axis is commanded to move (MOVE rate ≥ 4, or GOTO with `SLEW_DONE = 00` after a 1.0 s acceleration grace period), but the observed speed stays below **25% of the expected speed for 1.5 s**. Expected speeds come from the configurable rate table and the measured GOTO_FAST cruise speed (default 3°/s [V-doc spec]).
  - **Action:** stop both axes immediately and latch a "Possible obstruction" fault. The user must acknowledge it and check the scope before any motion. On the Astro Fi a stall means the motor is pushing against the gear train (no clutch), so there's no slipping to protect it.
- **GoTo not progressing:** distance to target not shrinking by ≥ 0.2° over 3 s during the fast phase → same action.
- **Runaway:** position changes faster than **1.5× the expected rate** (or > 0.3°/s while nothing but tracking is commanded), or keeps moving more than **2 s after a stop** (allowing deceleration from 3°/s) → escalate the stop (§2.5). If it's still moving after escalation: tell the user to **cut power now**.
- **Limit overrun:** the predicted position at the next poll (`pos + v·Δt`) is past a soft limit → stop now (don't wait for the limit to be reached).
- **Brown-out signature:** both encoders suddenly read near (0,0) while the last snapshot was elsewhere, or the MC answers again after > 2 s of silence with a reset-looking position → the alignment is invalid. Treat it as a power event (§5).

### 2.3 Timeouts, reversals, command pacing

| Rule | Value | Rationale | Tag |
|---|---|---|---|
| GoTo timeout (per leg) | `1.5 × (Δ/v_max + 2·v_max/a) + 10 s`, capped at **150 s** (the current `gotoTimeoutMs: 240_000` is too generous) | A 360° move at 3°/s is 120 s. Anything longer means something is wrong. | [I] |
| Manual move max duration | **30 s** continuous at rate ≥ 7, **120 s** at rate ≤ 6, then auto-stop; the user presses again to continue | A stuck key or lost key-up event must not drive into a limit | [I] |
| Reversal | Before reversing direction on an axis (MOVE+ → MOVE−, or a GOTO target behind the current motion): send rate 0, then wait until the observed speed is < 0.05°/s, or 400 ms if it was already slow (≤ rate 6) | Avoids shock loading the gear train. Celestron fixed an MC "bump" from rapid opposite taps. | [V-doc] evo 7.18.2214; [I] |
| Command rate | ≤ 5 motion commands/s per axis. Collapse repeated identical commands. One AUX request outstanding at a time. Poll position at 2–4 Hz. | Paquette's polling warning; INDI sleeps 50 ms after each write | [V-doc][V-src] |
| Dedup tracking | Send a new guide rate only when it changes by more than 0.5″/s, at most once per second | INDI dedups with `m_LastTrackRate` | [V-src] |
| No guide rates during GOTO | Zero the guide rates *before* `GOTO_FAST`. Send no `0x06`/`0x07` again until **both** axes report `SLEW_DONE = ff` | MC 7.13 runaway bug | [V-doc] |

### 2.4 Link loss behaviour (WiFi or TCP drops mid-motion)

| Situation | What the mount does | Tag |
|---|---|---|
| `GOTO_FAST`/`GOTO_SLOW` in progress | Continues to its target and stops. It's bounded by the target. | [I] (the MC executes autonomously; no keepalive exists) |
| `MOVE_POS`/`MOVE_NEG` at rate N | **Keeps moving indefinitely** until a stop command, a collision, or a power-off. There's no firmware timeout or limit. | [I], strongly supported: Paquette's move protocol is start/stop pairs; owners report the "mount, if slewing, continuing to slew out of control" after a tablet disconnect and fitted a power kill switch (Stargazers Lounge, Evolution 8 WiFi thread) |
| Guide rate (tracking) | **Keeps running indefinitely.** SkySafari deliberately leaves tracking running when it disconnects. At sidereal rates that's ≤ ~15°/h per axis, so it reaches a limit only after hours, but it does get there. | [V-cap] (disconnect sequence ends with `SET_POS_GUIDERATE`) |
| Laptop sleeps or the server process hangs | TCP may stay "open". Same as link loss. | [I] |
| Detecting loss | INDI takes > 60 s to notice. Use an app-level timeout: 3 consecutive failed polls (~3 s) means disconnected. Enable TCP keepalive. | [V-src] ISSUES.md |

**Watchdog strategy**

What we **can** guarantee:
- **Browser → server dead-man.** While the user holds a slew button or key, the GUI sends a `move` heartbeat every 200 ms. If none arrives for 600 ms (WS drop, tab hidden, blur, gamepad disconnect), the server sends stop to that axis. Also stop on `visibilitychange`→hidden and on window blur.
- **Server-side bounds.** Every motion has a timeout (above). The tracking loop stops tracking when the target is within 2° of an alt limit or the soft wrap.
- **Bounded fast jogs (SHOULD).** For rates ≥ 7, implement press-and-hold as a rolling `GOTO_FAST` to a target no more than **~3 s of travel** ahead of the current position, re-targeted every ≤ 500 ms while held. If the link dies, the mount stops within ~3 s of travel instead of never. Re-targeting a running GOTO is [V-src sim]/[?] on hardware, so verify it on day one (§8 step 18). Fall back to `MOVE` if it misbehaves.
- **Keep the laptop awake** during a session: on macOS run `caffeinate -i -w <server pid>`, and warn if on battery with lid-close sleep.
- **On (re)connect, first action is stop:** `MOVE_POS 0` + guide rate 0 on both axes, *then* read positions. Exception: if a GoTo is known to be in progress from persisted state, just poll `SLEW_DONE`.

What we **cannot** guarantee:
- Stopping the mount once the TCP link is gone.

What to tell the user (GUI, persistent and plain):
> "If Stargazer loses connection, the telescope may keep moving (a manual slew continues until stopped; tracking continues for hours). Keep the power plug within reach. To stop it for certain, unplug the power."

Show a red banner while disconnected with a motion possibly in progress, including the elapsed time since the last command.

### 2.5 Stop/abort reliability

1. `stop` bypasses the request queue: it goes next, after the single outstanding request, whose timeout is ≤ 800 ms. Never block it behind retries.
2. Sequence per axis (AZM then ALT), as INDI `Abort()`:
   - `MOVE_POS 00`: AZM `3b 04 20 10 24 00 a8`, ALT `3b 04 20 11 24 00 a7`
   - `SET_POS_GUIDERATE 000000`: AZM `3b 06 20 10 06 00 00 00 c4`, ALT `3b 06 20 11 06 00 00 00 c3` [V-src][V-cap]
3. Send the sequence **twice**, about 150 ms apart (idempotent). Not more: don't hammer.
4. **Verify** by polling both positions at 4–5 Hz. Speed must fall below 0.05°/s within **2 s**. That `MOVE_POS 0` aborts a GOTO is [I] (INDI relies on it), so test it on day one.
5. Escalate if still moving: re-send; then `GOTO_SLOW` to the current position (re-target to here) [I]; then show a full-screen alert, "STOP FAILED — UNPLUG POWER".
6. A `stop` UI control is visible on every screen. Keyboard: **Space and Esc**. It works even with an invalid alignment and while disconnected, where it queues and fires on reconnect, and the GUI says so.

### 2.6 Low voltage

| Finding | Tag |
|---|---|
| Astro Fi power: **8 × AA** or a **12 V DC source ≥ 1 A** (or PowerTank), tip-positive barrel | [V-doc] manual, spec page |
| SLT-class mounts run well at 12–14 V. "Keep your voltage above 11.5v; that is when the mounts start to go flaky." Another owner: OK at 11 V, struggled at 10 V. | [V-forum] CN "Nexstar GT/SLT mounts; supply voltage resilience?" and Eneloop thread |
| Symptoms: erratic slewing first ("despite a good initial alignment"), runaways during high-current slews (loose 5.5×2.1/2.5 mm plug), "No response" errors, and resets that wipe the alignment. "No damage at low voltage." | [V-forum] CN SLT battery threads; nexstarsite NoResponse; Stargazers Lounge |
| NiMH (1.2 V/cell → 9.6 V for 8 cells) starts underpowered | [V-doc] nexstarsite PowerSources; [V-forum] |
| SLT current: ~90 mA idle, ~160 mA tracking, ~220–350 mA slewing (owner measurements); Celestron: ~0.3 A tracking for SLT-class | [V-forum]; [V-doc] Celestron battery guide |
| Cold drains AA quickly; the Astro Fi "struggled under frosty conditions" | [V-forum] Space.com review (paraphrased) |

Rules: recommend a regulated 12 V supply or LiFePO4/PowerTank for anything beyond a short session. Discourage NiMH AAs. When proxies suggest low power (§5.3), **disable GoTo at rate 9** and suggest swapping power before the alignment is lost.

---

## 3. Optical and eye safety

### 3.1 Hazards

- A 130 mm f/5 Newtonian pointed at the Sun gathers about **345× the light of the eye** [V-doc spec]. That means instant, permanent eye injury, and heat damage to the secondary holder, eyepiece and plastic parts. Celestron: "Never look directly at the Sun … Permanent and irreversible eye damage may result"; "never point the telescope at the Sun during the day without using a proper full aperture solar filter"; never use eyepiece filters or project the image [V-doc manual].
- **The StarPointer finder** is co-aligned with the tube, so it looks at the Sun whenever the tube does. A red-dot finder doesn't concentrate light like an optical finder, but anyone looking through it is staring at the Sun, and its plastic can be heated. Also: the **phone adapter in the lens cap** (manual §8) can put a camera behind unfiltered optics.
- **Model error before alignment** can be tens of degrees (unknown azimuth zero, unknown tube elevation at power-on). With quality `none` or `rough`, *Stargazer does not know where the Sun is in encoder space*.
- **GoTo paths sweep.** Both axes move simultaneously and independently with different durations, so the path is a curve in the sky. It can pass close to the Sun even when the start and target are far from it.
- **Moon:** safe to view but dazzling in a 130 mm at 26×, especially after dark adaptation. Venus is similar, to a lesser degree.

### 3.2 Rules

| Condition | Policy |
|---|---|
| Sun altitude > −6° (civil twilight, with margin for model error) **and** quality `none`/`rough` | **Block all server-initiated motion** (GoTo, alignment GoTos, tracking start). Manual moves are allowed only after the per-session confirmation "Main tube AND finder are capped, or a full-aperture solar filter is fitted and the finder is capped/removed". The confirmation expires after 2 h, on disconnect, or when quality changes. |
| Sun altitude > −6° **and** quality `aligned` | GoTo allowed if (a) the target is ≥ **20°** from the Sun (`sunSafetyDeg`), and (b) the planned path keeps ≥ **15° + 3 × model RMS** from the Sun at every sample (§3.3). Otherwise route around or refuse. `force` may override (a) only in "Solar filter mode". It **never** overrides (b) or the unaligned block. |
| "Solar filter mode" (explicit toggle, confirmation checklist: full-aperture filter fitted and secure; finder capped or removed; phone adapter not in use without a filter) | Allows a GoTo to the Sun and tracking it. Auto-expires after 2 h and on disconnect or reconnect. The GUI shows a persistent yellow banner "SOLAR FILTER MODE". |
| Manual slew with quality `aligned`, Sun up | Stop the axis automatically when the predicted pointing (pos + v·0.5 s) enters 15° of the Sun, unless in solar filter mode. |
| Sun below −6° | No Sun checks are needed for motion (still apply them for GoTo-to-Sun requests, which are refused) |
| Moon/Venus GoTo at night | Non-blocking notice: "Bright: expect dazzle; consider a Moon filter." |

### 3.3 Path check and route-around

1. Simulate each axis independently: a trapezoid (measured accel and max speed per axis, defaults 3°/s and 3°/s²) for the `GOTO_FAST` leg to the pre-target, then the `GOTO_SLOW` leg. Use the **unwrapped azimuth direction** the server will command; legs are ≤ 170°, so the direction is deterministic (§1.3).
2. Sample every 0.1 s. Convert the encoder pair to sky (alt, az) through the pointing model and compute the angular separation from the Sun's apparent position, refracted (astronomy-engine).
3. If the minimum separation is below the keep-out, try alternatives in order and take the first that passes:
   1. alt-first then az (two sequential single-axis legs)
   2. az-first then alt
   3. the other azimuth direction, if within the wrap budget
   4. via a waypoint at low altitude (alt = max(min_alt+5°, 10°)), then az, then up
4. If nothing passes: refuse with an explanation.
5. Show the planned path on the sky dome, with the Sun keep-out circle.
6. The same check applies to alignment GoTos, "Unwind" slews and the rolling jog targets.

---

## 4. Firmware safety

### 4.1 Dangerous commands

| Device | Cmd | Name | Danger | Tag |
|---|---|---|---|---|
| MC 0x10/0x11 (and likely every device) | **0x81** | MC_PROGRAM_ENTER | "places the MC into a programming mode … prevents normal MC commands from being executed" | [V-doc] Paquette |
| same | **0x82 / 0x83 / 0x84** | PROGRAM_INIT / DATA / END | firmware erase/write | [V-doc] |
| any | IDs not in the known tables | – | "Message IDs not listed … may cause damage to the part and some of the listed message types can erase the firmware." "sending one message of each type to a device would almost certainly cause it to get into a bad state." | [V-doc] Paquette |
| any | – | Firmware updates really do work **over the WiFi bridge**: CFM "AstroFi/Evolution programming through WiFi" | the bootloader path is reachable over our TCP socket | [V-doc] Celestron software-update-history |
| MC | 0x0C, 0x0D, 0x15, 0x16 | PEC record/playback | not applicable to alt-az, unknown persistence | [V-doc] |
| MC | 0x0B LEVEL_START, 0x19 SEEK_INDEX | autonomous motion to index/level sensors the Astro Fi may not have | could drive with no end | [V-doc]/[?] |
| MC | 0x14 | unknown ("Always returns 0xff") | unknown | [V-doc] |
| MC | 0x47 | GET_AUTOGUIDE_RATE | replies with CMD `0xF0`: a firmware quirk; "the firmware breaks if you try to program it" (jochym) | [V-cap][V-forum] |
| **0xB6** | **0x10 means GET_VOLTAGE here**, but on an MC **0x10 is SET_POS_BACKLASH** | the same ID does different things per device, so the allow-list **must key on (device, cmd, payload length)**, never on cmd alone | [V-src] |
| 0xB6 | 0x18 *with payload* | sets the external power current limit (mA) | [V-src] caux notes |
| 0xB7 | 0x10 with payload | sets the charger mode | [V-src] |
| 0xBF | 0x10 with 2 bytes | sets light levels | [V-src] |
| 0xB5/0xB9 | 0x30, 0x31, 0x32, 0x49 | SkyPortal → WiFi module time, location, config, "ping". Semantics are partly guessed. 0x32 "config" could reconfigure the bridge. | [V-src] caux tests; [?] |
| 0xB5 | 0x10 | "get status. Probably to enable/disable commands as well (cannot test these!)" | could switch the WiFi off | [V-src] caux notes |
| bridge | any other TCP port or HTTP on 1.2.3.4 | the AMW00x module has its own config and firmware interfaces | [I] |

### 4.2 What persists in non-volatile memory

The evidence is thin. Treat every `SET_*` register as **possibly persistent**.

| Register | Evidence | Treat as |
|---|---|---|
| Backlash (0x10/0x11 set) | Celestron: backlash values are stored in the **hand control**, which "will remember the entered values and apply them each time you turn it on". One CN owner reports that Evolution values survived short power-offs but not a day. Another claims MC flash. SkySafari writes 0 on connect **and** disconnect. | possibly persistent → **never write** |
| Max rate (0x20), enable (0x22), approach (0xFD), autoguide rate (0x46) | SkySafari rewrites them on every connect/disconnect, so at least they survive between app sessions while powered | **never write** (read only to log) |
| Cordwrap pos/enable (0x3A/0x38) | INDI and SkySafari set them every session. Persistence unknown. | optional; if used, set every session and log |
| Position (0x04 SET_POSITION) | Encoders appear to reset at power-on [I] | session-only; allowed only for "Home" |
| Battery current limit, charger mode, lights | Evolution-only devices | never write |

### 4.3 Allow-list (MUST be enforced in `AuxClient`, below every caller)

Every outgoing packet must match an entry exactly: `SRC = 0x20`, `(DST, CMD, payload length)`, and value checks. Anything else throws and is logged. The simulator must not get a wider list. A unit test must assert that the encoder refuses `0x81–0x84` to every device.

**A. Read-only (safe any time)**

| DST | CMD | Len | Name | Bytes (AZM / ALT) |
|---|---|---|---|---|
| 0x10, 0x11 | 0x01 | 0 | GET_POSITION | `3b 03 20 10 01 cc` / `3b 03 20 11 01 cb` |
| 0x10, 0x11 | 0x13 | 0 | SLEW_DONE | `3b 03 20 10 13 ba` / `3b 03 20 11 13 b9` |
| 0x10, 0x11 | 0xFE | 0 | GET_VER | `3b 03 20 10 fe cf` / `3b 03 20 11 fe ce` |
| 0x10, 0x11 | 0x05 | 0 | GET_MODEL | `3b 03 20 10 05 c8` / `3b 03 20 11 05 c7` |
| 0x10, 0x11 | 0x21 | 0 | GET_MAXRATE | `3b 03 20 10 21 ac` / `3b 03 20 11 21 ab` |
| 0x10, 0x11 | 0x23 | 0 | MAXRATE_ENABLED | `3b 03 20 10 23 aa` / `3b 03 20 11 23 a9` |
| 0x10, 0x11 | 0x40 | 0 | GET_POS_BACKLASH | `3b 03 20 10 40 8d` / `3b 03 20 11 40 8c` |
| 0x10, 0x11 | 0x41 | 0 | GET_NEG_BACKLASH | `3b 03 20 10 41 8c` / `3b 03 20 11 41 8b` |
| 0x10, 0x11 | 0xFC | 0 | GET_APPROACH | `3b 03 20 10 fc d1` / `3b 03 20 11 fc d0` |
| 0x10 | 0x3B | 0 | POLL_CORDWRAP | `3b 03 20 10 3b 92` |
| 0x10 | 0x3C | 0 | GET_CORDWRAP_POS | `3b 03 20 10 3c 91` |
| discovery set† | 0xFE | 0 | GET_VER | see §5.4 |
| 0xB6 (only if it answered GET_VER) | 0x10 | 0 | BAT GET_VOLTAGE/status | `3b 03 20 b6 10 17` |

† GET_VER only, once per connect, to the known IDs `0x01, 0x04, 0x0D, 0x0E, 0x12, 0xB0, 0xB4, 0xB5, 0xB6, 0xB7, 0xBF`. INDI sends GET_VER to MB, HC, HCP, AZM, ALT, GPS, WiFi, FOCUS and BAT on every connect [V-src], so this has precedent. **No other command goes to a device that hasn't answered GET_VER.**

**B. Motion (value-checked, gated by the safety layer)**

| DST | CMD | Len | Name | Checks |
|---|---|---|---|---|
| 0x10, 0x11 | 0x24 / 0x25 | 1 | MOVE_POS / MOVE_NEG | rate 0–9; rate > 0 needs safety clearance; rate 0 always allowed |
| 0x10, 0x11 | 0x02 | 3 | GOTO_FAST | target within mechanical limits; AZM ≤ 170° from current; Sun path check passed |
| 0x10, 0x11 | 0x17 | 3 | GOTO_SLOW | same; ≤ 5° from current |
| 0x10, 0x11 | 0x06 / 0x07 | 3 | SET_POS/NEG_GUIDERATE | 3-byte form only (no `ffff/fffe/fffd` specials); magnitude ≤ 0x384000 (1°/s); **refused while any GOTO is active** unless the value is 0 and part of `stop` |

**C. Session configuration (rare, explicit, logged)**

| DST | CMD | Len | Name | Checks |
|---|---|---|---|---|
| 0x10, 0x11 | 0x04 | 3 | SET_POSITION | only from "Home"; both axes stopped; user confirmed |
| 0x10 | 0x3A | 3 | SET_CORDWRAP_POS | optional; once per session |
| 0x10 | 0x38 | 0 | ENABLE_CORDWRAP | optional; once per session |

**Everything else is forbidden**, explicitly including: `0x81–0x84` anywhere; `0x10`/`0x11` (backlash), `0x20`, `0x22`, `0xFD`, `0x46`, `0x47`, `0x26`, `0x0B`, `0x19`, `0x0C–0x0D`, `0x14–0x16` to the MCs; anything with a payload to 0xB5/0xB6/0xB7/0xBF/0xB9; anything to `0x00` (broadcast); any SRC other than `0x20`; the ASCII strings `$$$` and HC protocol letters.

### 4.4 Hand controller or second app on the bus

- Detect it: GET_VER answered by `0x04` (HC), `0x0D` (NexStar+), `0x0E` (StarSense HC), **or** any packet seen with SRC ∈ {0x04, 0x0D, 0x0E}. Paquette notes the bus broadcasts every packet, so we will see HC traffic [V-doc].
- If an HC is detected: **don't fight it.** Enter read-only "observer" mode (positions only, no motion, no tracking). Tell the user: "A hand controller is attached and controls the mount. Unplug it (with power off) to use Stargazer." An aligned HC runs its own tracking, so our rates would conflict.
- If we see echoes or responses addressed to `0x20` that we didn't request (another app on the same ID), or the TCP connect is refused or reset repeatedly: report "another device (phone with SkyPortal?) may be connected" and stop motion.

---

## 5. Power and battery telemetry

### 5.1 Verdict

**The Astro Fi almost certainly exposes no battery level, voltage or current over AUX.**

| Evidence | Tag |
|---|---|
| SkySafari's Celestron settings: "Battery Status (**NexStar Evolution only**) – Displays the battery voltage, whether it's discharging or charging, and High, Medium, or Low status." | [V-doc] SkySafari help |
| INDI defines the battery property only `if (m_ModelVersion == Evolution_Nexstar \|\| m_BATVersion[0] \|\| m_BATVersion[1])`, i.e. only when the mount is an Evolution or device `0xB6` answers GET_VER | [V-src] celestronaux.cpp |
| The battery/power controller `0xB6` and charge port `0xB7` belong to the Evolution's internal Li battery and charger. The Astro Fi has neither: it runs from an external 8×AA pack or 12 V through a barrel jack. | [V-doc] manual; [V-src] caux notes |
| No voltage, current or status GET exists in the MC command set (Paquette, caux motor model, INDI enum, Evolution capture) | [V-doc][V-src][V-cap] |
| CPWI 2.2.3: "Battery monitoring for mounts with batteries" | [V-doc] |
| Evolution MC 7.18.5028 added "automatic shutdown of aux bus powered devices when battery is extremely low", an Evolution battery-board feature | [V-doc] |

Still worth one probe on day one: if `0xB6` answers GET_VER on the Astro Fi (unexpected), the decoder below applies.

### 5.2 Exact battery commands (Evolution; applies only if 0xB6 exists)

| Purpose | Request | Response | Decode | Tag |
|---|---|---|---|---|
| Presence | `3b 03 20 b6 fe 29` (GET_VER → BAT) | version bytes or silence | silence = absent | [V-src] |
| Status + voltage | `3b 03 20 b6 10 17` (GET_VOLTAGE, cmd 0x10 → BAT) | `3b 09 b6 20 10 [s0] [s1] [v3 v2 v1 v0] ck` | `s0`: INDI 0 = discharging, 1 = charging, 2 = full (jochym: charging 0/1). `s1`: 0 = LOW, 1 = MEDIUM, 2 = HIGH. `v`: **uint32 big-endian microvolts** | [V-src][V-cap] |
| Real example | `3b 03 20 b6 10 17` | `3b 09 b6 20 10 02 02 00 a0 01 60 0c` | s0 = 2, s1 = 2 (HIGH), 0x00A00160 = 10,486,112 µV = **10.49 V**; checksum verified | [V-cap] nexstar-evo connect-goto-disconnect |
| Current limit | `3b 03 20 b6 18 0f` | `3b 05 b6 20 18 07 d0 36` | 0x07D0 = 2000 mA. **This is a setting (external power current limit), not a measured current.** With a payload it *writes*. Not on our allow-list. | [V-cap][V-src] |
| Poll interval | every 30 s (INDI). SkySafari: every few seconds. | | | [V-src][V-cap] |

The `caux-simulator` power model also answers 0x01/0x02/0x03 (voltage/current/status) on 0xB6, but those are simulator inventions with no capture behind them. Don't send them.

### 5.3 Proxies to show instead (Astro Fi)

Show a **"Power health"** card in the mount pane. Mark everything on it as estimated:

1. **Power source and session clock.** The user picks *8×AA alkaline / 8×AA lithium / 8×AA NiMH / 12 V external*, and the server persists it. Show time on this power source (reset with a "fresh batteries" button), plus a rough remaining-time estimate. Assumptions to state in the UI: alkaline AA ~2000 mAh at these loads, and current from the SLT figures in §2.6 (~0.16 A tracking, ~0.3 A slewing), so **~8–10 h tracking at 20 °C, much less in the cold**. NiMH gets a warning: 9.6 V nominal, below the comfortable range. [I], rough.
2. **Slew-speed health (best proxy).** A DC servo's top speed is voltage-limited. During each `GOTO_FAST` leg longer than 15°, measure peak axis speed from polled positions and compare with the session baseline (first long slew) and a stored fresh-power baseline from day one. Warn at < 85% and alert at < 70% (thresholds [I], tune on hardware). Also flag GoTo legs taking > 1.3× their predicted time.
3. **Link and response health.** AUX RTT (median, p95), timeouts and retries per minute, resyncs and bad checksums. Rising timeouts with good WiFi signal suggest weak power ("a common source [of No Response errors] is faulty power, either low voltage … or a loose connector" [V-doc] nexstarsite).
4. **Brown-out events.** An unexpected encoder reset or MC silence followed by reappearance (§2.2) → red alert: "Power dipped; the telescope reset. Alignment lost. Replace batteries or check the plug." This is a definitive event, not an estimate.
5. **Motor current:** not available over AUX [V-src: no command].

### 5.4 Day-one telemetry discovery scan (GET-only)

Run once on connect, at ≥ 100 ms spacing, 500 ms timeout each, no retries for optional devices. Log raw hex.

| Order | Packet | Expect on Astro Fi |
|---|---|---|
| 1 | `3b 03 20 10 fe cf` GET_VER AZM | 4 bytes, e.g. 7.15.xxxx (required) |
| 2 | `3b 03 20 11 fe ce` GET_VER ALT | 4 bytes (required) |
| 3 | `3b 03 20 10 05 c8` GET_MODEL AZM | 2 bytes, Astro Fi value [?] |
| 4 | `3b 03 20 b5 fe 2a` GET_VER WiFi | version [I] |
| 5 | `3b 03 20 01 fe de` MB | silence [I] |
| 6 | `3b 03 20 04 fe db`, `3b 03 20 0d fe d2`, `3b 03 20 0e fe d1` HC/HC+/StarSense HC | silence; a reply triggers observer mode (§4.4) |
| 7 | `3b 03 20 12 fe cd` focuser, `3b 03 20 b0 fe 2f` GPS, `3b 03 20 b4 fe 2b` StarSense cam | silence unless accessories are fitted |
| 8 | `3b 03 20 b6 fe 29` BAT, `3b 03 20 b7 fe 28` CHG, `3b 03 20 bf fe 20` LIGHT | silence expected. If BAT answers, then also send `3b 03 20 b6 10 17` |
| 9 | Per axis: `0x21`, `0x23`, `0x40`, `0x41`, `0xFC`; AZM `0x3B`, `0x3C` (bytes in §4.3A) | log to a "Mount info" panel; never written back |

### 5.5 Other telemetry worth showing

- MC firmware AZM/ALT (warn if < 7.15.8160), MC model, WiFi bridge version.
- Live axis positions, speeds, `SLEW_DONE` flags, active guide rates, unwrapped azimuth and wrap gauge, alt-limit gauge.
- Read-only registers: backlash, approach, max rate and enabled flag, cordwrap enabled and position.
- Link: RTT, timeouts, last-response age, connection uptime.
- **Laptop-side WiFi signal:** `system_profiler SPAirPortDataType` prints `Signal / Noise: -63 dBm / -89 dBm` for the current network without sudo (checked on macOS 15.6). It's slow (1–3 s), so poll every 15–30 s off the main loop. The mount side exposes no RSSI over AUX [I]. The `airport` CLI is gone on recent macOS.
- Hand controller or other bus masters detected.

---

## 6. Operational guidance (GUI help pages and checklists)

**Power-on and connect checklist** (show on first connect of a session)
1. Tripod on firm, level ground, legs fully spread, leg locks tight, and one leg pointing roughly south (northern hemisphere) so the north-facing zenith clearance is predictable. Hang nothing heavy from the tube. The single-arm mount wobbles with large tubes [V-forum].
2. Lens cap on and finder off/capped **in daylight**.
3. Battery pack in the tray (or 12 V lead routed), cable **un-wrapped**: note the "cable-neutral" direction. Barrel plug fully seated (loose plugs cause runaways [V-forum]).
4. Tube roughly level (phone inclinometer) and pointing north, so the alt reference is usable from power-on.
5. WiFi switch **RIGHT** (Direct). Power on, wait for the WiFi LED and SSID, then join `Celestron-xx`. Forget competing networks. Make sure no phone running SkyPortal is joined.
6. Connect in Stargazer: it reads versions and stops both axes. Confirm "tube level?" and the power source.
7. Know where the power plug is: it's the emergency stop.

**Night setup**
- Red-light (night) mode on the laptop. Dim the screen.
- Dew: the open Newtonian tube with an exposed secondary and the StarPointer window dew up. Use a dew shield or a gentle heater on the secondary/finder. Never use a hair dryer on the mirror at full heat. If 12 V dew heaters share the scope's supply, the voltage sags: give them a separate supply. [I]
- Cool-down: let the tube reach ambient (30–45 min for a 130 mm) for sharp views. [I]

**People and eyes**
- Before any GoTo, the GUI shows "Telescope will move: keep heads and hands clear of the tube", plus an audible cue. The eyepiece end moves fast (3°/s at ~35 cm radius ≈ 2 cm/s, plus inertia). Kids lean in.
- Celestron: "Do not leave the telescope unsupervised, either when children are present or adults who may not be familiar with the correct operating procedures" [V-doc manual]. In daytime with kids present, keep the solar-filter or lens-cap rule strictly. Default the daytime GUI to "manual slews only".

**Cold weather**
- Grease stiffens: slews slow and stalls are more likely, and alkaline AA capacity drops sharply. Expect lower slew-speed health readings. Stall thresholds use measured speed, so allow a one-time "cold recalibration" (a short rate-9 move to re-baseline). The Astro Fi "struggled under frosty conditions" [V-forum]. Prefer 12 V external power below ~5 °C. [I]
- Condensation on the electronics when bringing the scope back indoors: let it warm up capped. [I]

**Settling**
- The single-arm mount and aluminium tripod ring after slews. Wait **≥ 2–3 s after `SLEW_DONE`** before alignment "Centred" captures or photos (configurable; measure the damping time on day one by watching a star at 65×). [I]/[V-forum: wobble]

**After the session**
- Park: tube level-ish, unwind the cable to neutral, power off, cap it. Remove AA batteries for storage (corrosion) [V-doc Celestron SLT battery KB].

---

## 7. Software requirements

MUST = required before using real hardware. SHOULD = strongly recommended.

### Limits and geometry
1. **MUST** keep altitude limits in the mechanical frame (`h_mech = E_e + IE_level`). Defaults: **−5° … +70°**. Configurable, persisted, settable from the day-one measurement wizard. *Rationale: the MC has no limits; app limits are relative to the base; 65–77° is reported for this mount class (§1.1).*
2. **MUST** refuse any GOTO target outside the limits (no `force` override for mechanical limits) and stop manual moves predictively before a limit (`pos + v·Δt_poll`). *Rationale: collision with tripod or arm, no clutch.*
3. **MUST** restrict motion to rate ≤ 6 within ±30° of the power-on alt, and allow no GoTo, while the alt reference is unknown (quality `none` and the user hasn't confirmed "tube level"). *Rationale: the encoders read 0 wherever the tube was at power-on.*
4. **MUST** track unwrapped azimuth (accumulate deltas each poll; at ≤ 3°/s and ≥ 2 Hz the step is unambiguous). Persist it with the encoder snapshot. Enforce a soft wrap of ±200° (refuse and offer Unwind) and a hard wrap of ±240° (stop). After a detected power cycle, require the user to confirm the cable is at neutral. *Rationale: the power socket is on the rotating arm.*
5. **MUST** split AZM GoTos into legs ≤ 170°. *Rationale: makes the direction deterministic whatever the MC's cordwrap and shortest-path rules, which keeps the wrap and Sun path checks valid.*

### Sun and optics
6. **MUST** block all server-initiated motion while the Sun's altitude is > −6° and quality is `none`/`rough`. Allow manual moves only after an expiring "tube and finder capped / full-aperture filter fitted" confirmation. *Rationale: before alignment we don't know where the Sun is in encoder space.*
7. **MUST** refuse GoTo targets within 20° of the Sun, except in an explicit, expiring "Solar filter mode".
8. **MUST** run the path check (§3.3) for every GoTo, alignment GoTo, unwind and rolling jog while the Sun is up, with keep-out 15° + 3×RMS. Route around or refuse. No `force` override. *Rationale: GoTo paths sweep across the sky.*
9. **MUST** auto-stop manual slews entering the Sun keep-out (aligned case), and warn about the finder and the phone adapter in all Sun dialogs.
10. **SHOULD** show the Sun keep-out circle and the planned path on the sky dome, and show a non-blocking brightness notice for the Moon and Venus.

### Motion control and protection
11. **MUST** enforce the allow-list in §4.3 inside the packet encoder/`AuxClient`, keyed on (DST, CMD, payload length) with value checks, plus unit tests that `0x81–0x84` and backlash/max-rate/approach writes are refused for every device.
12. **MUST** never send guide-rate commands while either axis is in GOTO. Zero them before `GOTO_FAST`. *Rationale: Astro Fi MC 7.13.6110 runaway bug.*
13. **MUST** warn if the MC firmware is < 7.15.8160 and recommend updating with Celestron CFM. Stargazer never performs updates.
14. **MUST** implement stall, no-progress, runaway and brown-out detection (§2.2), with immediate stop and a latched fault that needs user acknowledgement.
15. **MUST** time out every motion: GoTo leg ≤ `1.5×predicted + 10 s` (cap 150 s); manual ≤ 30 s at rate ≥ 7 and ≤ 120 s at rate ≤ 6.
16. **MUST** decelerate before reversing (rate 0, wait for < 0.05°/s or 400 ms), and rate-limit motion commands (≤ 5/s per axis, dedup identical commands, one AUX request outstanding, 2–4 Hz polling).
17. **MUST** give `stop` queue priority, send it twice, verify motion stopped within 2 s, escalate, and finally show "UNPLUG POWER" (§2.5). Space/Esc always stop. The stop control is visible on every screen.
18. **MUST** apply a browser→server dead-man for press-and-hold moves: 200 ms heartbeat, stop after 600 ms of silence or on blur/hidden/WS close.
19. **SHOULD** implement fast jogs (rate ≥ 7) as rolling bounded `GOTO_FAST` targets ≤ 3 s of travel ahead, once day-one tests confirm that re-targeting works. *Rationale: bounds runaway after link loss.*
20. **MUST** detect link loss within ~3 s (3 failed polls) and enable TCP keepalive. On disconnect: stop the tracking loop, show a red "telescope may still be moving" banner with the time since the last command, and tell the user to unplug power if it doesn't stop. On reconnect: stop both axes first (unless a persisted GoTo is in progress), then poll, then check for a power cycle.
21. **MUST** stop tracking server-side when the tracked target is within 2° of an alt limit or the soft wrap, and when the target sets below the minimum sky altitude.
22. **SHOULD** keep the Mac awake during a session (`caffeinate -i -w <pid>`), and warn on laptop battery or low laptop battery.
23. **MUST** enter read-only observer mode when a hand controller (0x04/0x0D/0x0E) or a foreign bus master is detected.
24. **MUST NOT** write backlash, approach, max rate, autoguide rate or any 0xB5/0xB6/0xB7/0xBF register. Read them for display only.
25. **MUST** allow `SET_POSITION` only from the explicit Home action, both axes stopped, with confirmation.

### Telemetry and UX
26. **MUST** run the GET-only discovery scan (§5.4) once per connect, and show firmware, model, WiFi version and detected devices.
27. **MUST** show the Power-health card (§5.3): source, session time, slew-speed health, link health, brown-out alerts, with a clear "estimated" label. Show real voltage only if `0xB6` answers.
28. **SHOULD** show laptop-side WiFi RSSI from `system_profiler` every 15–30 s.
29. **MUST** show a pre-GoTo "keep clear" notice (dismissible per session at night, always in daytime) and the settling delay before alignment captures (default 2.5 s).
30. **MUST** log every TX/RX packet (hex + timestamp) to a rotating file. *Rationale: diagnosing day-one surprises.*

### Config changes implied for `packages/server/src/config.ts`
- `altLimitsDeg: [-5, 70]` (from `[-5, 90]`)
- `gotoTimeoutMs` → computed per leg, cap 150 000
- new: `azWrapSoftDeg: 200`, `azWrapHardDeg: 240`, `azMaxLegDeg: 170`, `sunPathKeepoutDeg: 15`, `sunAltBlockDeg: -6`, `stallSpeedFraction: 0.25`, `stallWindowMs: 1500`, `stopVerifyMs: 2000`, `reversalWaitMs: 400`, `moveMaxMsFast: 30000`, `moveMaxMsSlow: 120000`, `deadmanMs: 600`, `settleMs: 2500`, `minMcVersion: "7.15.8160"`

---

## 8. Day-one hardware verification checklist

Do this in **daylight with the lens cap on and the finder capped, or at night**. Tripod on firm ground, area clear. **One hand near the power plug for every motion step.** Stargazer runs in "commissioning" mode: all limits at the conservative defaults, maximum manual rate 6 except where noted, packet log on.

**Phase A: GET only, nothing moves**
1. Power on with the tube level (inclinometer) pointing north, cable at neutral. Join the WiFi and open the TCP connection. Note any banner bytes before the first `0x3B`.
2. Send `3b 03 20 10 fe cf` and `3b 03 20 11 fe ce`. Confirm the echo + response pattern (PROTOCOL.md §3.2) and record the MC versions (≥ 7.15.8160?).
3. Run the discovery scan (§5.4). Record which devices answer, and specifically whether **0xB6** does (expected: no).
4. Read the registers (§4.3A rows 4–11) and record the backlash, approach, max-rate and cordwrap values. *Don't change them.*
5. Poll positions at 2 Hz for 60 s. Confirm they're steady and near 0,0 at fresh power-on.
6. Stop the server, reconnect, and confirm the encoders kept their values (no reset on TCP reconnect).

**Phase B: stop commands only**
7. Send the stop sequence (§2.5) to both axes. Confirm acks; nothing should move.

**Phase C: tiny, slow moves (rate 3, about 1–4× sidereal, so motion is barely visible)**
8. `MOVE_POS ALT 3` (`3b 04 20 11 24 03 a4`) for 2 s, then stop (`3b 04 20 11 24 00 a7`). Confirm the tube went **up** and the ALT encoder **increased**. Repeat `MOVE_NEG` (`3b 04 20 11 25 03 a3`).
9. `MOVE_POS AZM 3` (`3b 04 20 10 24 03 a5`) for 2 s, then stop (`3b 04 20 10 24 00 a8`). Record the direction seen from above (CW?) and the sign of the encoder change.
10. Measure the rate table: for rates 1–6 on each axis, move 5 s and compute deg/s from the encoders. Rates 7–9 come later (step 16).
11. Guide-rate scale: `SET_POS_GUIDERATE AZM 00 3c 2a` (sidereal) for 60 s. Expect ≈ 0.25° (15.04″/s × 60 s). Then stop.

**Phase D: limits (watch closely, rate ≤ 6)**
12. Fit the usual diagonal or eyepiece. Rotate azimuth so the mirror end is **over a tripod leg**. Raise the alt at rate 6, then rate 5 near the end. Stop at about 2 cm of clearance and record `h_mech`. If the tube approaches anything before 60°, stop immediately and note it.
13. Repeat between legs (informational). Use the worst case for the limit, minus 3°.
14. Lower the alt at rate 5 to the lowest point with clearance and record it, plus how far it is from any hard stop.
15. Cable wrap: from neutral, rotate AZM at rate 7 (short bursts, ≤ 30 s), watching the lead. Stop when it's snug and record the unwrapped angle each way. Set the wrap limits.

**Phase E: fast motion and stop behaviour (Sun down or capped)**
16. Rates 7–9 on each axis for ≤ 5 s each. Record the speeds; this is the **fresh-power slew baseline** for the power-health proxy.
17. `GOTO_FAST` AZM +30°: record peak speed, acceleration, `SLEW_DONE` behaviour, overshoot and settle time.
18. Mid-GoTo abort: start `GOTO_FAST` AZM +60°, then after 3 s send `MOVE_POS 00` + guide rate 0. Record whether and how fast it stops (validates §2.5). Then test **re-targeting**: start `GOTO_FAST` +60° and after 2 s send `GOTO_FAST` to +20°. Does it decelerate and go to the new target? (Decides requirement 19.)
19. Direction test: GOTO an AZM target 200° away **as one command** (with cordwrap in its as-read state) and record which way it went. This tells us whether the MC takes the shortest path. (Requirement 5 still applies regardless.)
20. Guide rate during GOTO: **do not test.** It's a known runaway on old firmware.
21. Stall detection dry run: during a rate-6 move, gently resist the tube **by hand, briefly**, or just simulate it in the simulator if you're uncomfortable doing that. Confirm the server detects the slowdown and stops. Don't block a fast slew.

**Phase F: link loss (with a hand on the power plug)**
22. Start `MOVE_POS AZM 4` (slow), then turn off the laptop WiFi. Confirm the mount **keeps moving** (expected), then cut power or reconnect and stop. Record the time to reconnect. This confirms what the GUI tells the user.
23. Repeat with tracking only (sidereal). Confirm it continues after disconnect.

**Phase G: power**
24. If a variable bench supply is available: run a rate-9 slew at 12.0, 11.0, 10.5 and 10.0 V. Record the speed versus voltage (calibrates the slew-speed proxy) and the voltage at which the WiFi or MC resets.
25. Otherwise: record the rate-9 speed on fresh alkaline AAs and on 12 V, and again at the end of a long session.
26. Write all measured values into `config.ts` (via env or a config file) and into a short hardware notes section of PROTOCOL.md §10.

---

## 9. Sources

Celestron and SkySafari
- Astro Fi manual (solar warnings, power, WiFi switch, "Do not try to move the telescope … while it is off", specs): https://celestron-site-support-files.s3.amazonaws.com/support_files/22201_22202_22203_Astro%20Fi_Telescope_Manual_5languages_USA_F_BW.pdf
- Astro Fi 130 product page (slew up to 3°/s, 12 V 1 A): https://www.celestron.com/products/astro-fi-130mm-newtonian-telescope
- Firmware update history (Astro Fi MC 7.13.6110 "Tracking command sent during slew caused mount slew forever", 7.15.8160; Evolution 7.18.x): https://www.celestron.com/pages/firmware-update-history
- Software update history (CFM "AstroFi/Evolution programming through WiFi", 200 ms packet delay fix, CPWI battery monitoring): https://www.celestron.com/pages/software-update-history
- SkySafari Celestron Wi-Fi help (70° alt-az default slew limit, "does not work until the telescope is aligned", Battery Status "NexStar Evolution only"): https://userguide.skysafariastronomy.com/app-specific/settings-help/telescope-control-help/celestron-wi-fi-help
- NexStar SLT manual (slew limits, tripod legs): https://s3.amazonaws.com/celestron-site-support-files/support_files/NexStar_SLT_manual.pdf
- Celestron KB, backlash stored in the hand control: https://www.celestron.com/blogs/knowledgebase/controlling-backlash-in-your-mount
- Celestron KB, SLT batteries: https://www.celestron.com/blogs/knowledgebase/what-do-i-need-to-know-about-my-nexstar-slt-and-batteries
- Celestron battery guide (SLT ~0.3 A): https://www.celestron.com/blogs/knowledgebase/the-ultimate-telescope-battery-guide-getting-to-know-celestron-powertank-and-powertank-lithium

Protocol and source code
- INDI celestronaux (`auxproto.h`: `GET_VOLTAGE = 0x10`, `BAT = 0xb6`, `CHG = 0xb7`, `LIGHT = 0xbf`; `celestronaux.cpp`: `getBatteryStatus`, µV decode, `enforceSlewLimits`, `Abort`, `getVersions`; `ISSUES.md`: > 60 s disconnect detection): https://github.com/indilib/indi-3rdparty/tree/master/indi-celestronaux
- jochym/caux-simulator (`docs/notes.md`: 0xB5/0xB6/0xB7/0xBF semantics; `devices/power.py`, `wifi.py`, `light.py`): https://github.com/jochym/caux-simulator
- jochym/nexstar-evo capture `analysis/connect-goto-disconnect.txt` (battery query and response `3b 09 b6 20 10 02 02 00 a0 01 60 0c`): https://github.com/jochym/nexstar-evo
- Andre Paquette, *NexStar AUX Command Set* 1.0 (MC_PROGRAM_ENTER 0x81–0x84, unlisted-ID warning, polling caution, cordwrap +180°): copy at https://github.com/jochym/caux-simulator/blob/main/docs/NexStar_AUX_Commands_10.pdf

Community
- nexstarsite Astro Fi ports (power connector on the fork arm): https://www.nexstarsite.com/OddsNEnds/PortsAstroFi.htm
- nexstarsite power sources (NiMH, regulated 12 V): https://www.nexstarsite.com/OddsNEnds/PowerSources.htm
- nexstarsite No Response errors (low voltage, loose connector): https://www.nexstarsite.com/OddsNEnds/NoResponse.htm
- 130 SLT review, 65° limit and zenith blind spot: https://www.jb.man.ac.uk/public/im/cel130SLT.html
- CN NexStar 130 SLT detailed review (mirror end between the legs, avoid 20° around the zenith): https://www.cloudynights.com/forums/topic/60666-nexstar-130-slt-detailed-review/
- CN 90SLT slew limit (77° with DSLR): https://www.cloudynights.com/forums/topic/795862-90slt-slew-limit/
- CN SkyPortal/SkySafari ignoring slew limits (limits only after alignment, relative to the base): https://www.cloudynights.com/topic/767376-skyportal-and-skysafari-ignoring-slew-limits/
- CN HC & SkyPortal slew limit settings: https://www.cloudynights.com/forums/topic/1006560-hc-sky-portal-slew-limit-settings
- CN GT/SLT supply voltage resilience (> 11.5 V): https://www.cloudynights.com/forums/topic/703839-nexstar-gtslt-mounts-supply-voltage-resilience/
- CN SLT battery question (current draw, erratic slewing on voltage drop): https://www.cloudynights.com/forums/topic/191623-nexstar-slt-mount-battery-question/
- CN Eneloop AA rechargeables on NexStar: https://www.cloudynights.com/topic/729536-adventures-in-powering-the-nexstar-mount-with-eneloop-rechargeables/
- CN where are anti-backlash settings saved: https://www.cloudynights.com/topic/591397-where-are-the-anti-backlash-settings-saved/
- Stargazers Lounge, Evolution 8 WiFi: disconnect while slewing kept slewing, power kill switch: https://stargazerslounge.com/topic/235737-evolution-8-wifi-connection-issues/
- Space.com Astro Fi 130 review (cold, no manual movement): https://www.space.com/celestron-astro-fi-130-telescope-review.html
