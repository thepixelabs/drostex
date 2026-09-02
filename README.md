# Drostex

**[drostex.pixelabs.net](https://drostex.pixelabs.net)**

Drostex is a local web studio for driving a **HyperCube Nano**, a WLED-based
LED infinity-mirror cube. You run a small Node server on your own machine; it
serves a UI in your browser and owns a UDP socket that streams computed
pixels to the cube at 40fps by default (configurable up to 60).

- **Proven.** HyperCube Nano, firmware `hs-2.0`, tested on one unit. 95
  effects at last count: `listEffects()` reads that from the device itself
  at runtime, so a different firmware build may report a different number.
- **Plausible, untested.** Streamed looks on any WLED device that accepts
  DRGB on UDP port 21324. Run `scripts/blink.mjs` against it first to
  confirm the protocol actually lands.
- **Will not work.** The Built-in effects tab, on stock WLED. Verify this
  yourself: `MODE_RANGES` and `isSoundReactive` in `server/index.mjs` are
  index ranges read off this firmware's own effect list, and `warp`,
  segment `sym`, and the three-step `sparkle` are vendor extensions plain
  WLED doesn't ship.

## Quick start

```sh
git clone https://github.com/thepixelabs/drostex.git
cd drostex
npm start
```

That's it. This opens `http://127.0.0.1:7847` in your default browser. If
you haven't configured a device yet, the server spends its first couple of
seconds looking for one on the network and uses what it finds for that run,
printing the line to add to `config.json` to make it permanent. See
[Finding and configuring your device](#finding-and-configuring-your-device)
for when that doesn't work.

Day one looks like this: click a pattern and it's already running on the
cube before you let go of the mouse. Hit **Shuffle** until something
surprises you. **Save** it. Turn on **Auto-cycle** and walk away: it keeps
working through your saved looks and the firmware's own effects with nobody
at the keyboard.

Two things you may want to change:

- **A different port.** `PORT=7848 npm start`.
- **Don't auto-open a browser tab.** `npm start -- --no-open` (or
  `node server/index.mjs --no-open` directly).

Requires Node 20 or newer. There are no runtime dependencies to install: see
[How it works](#how-it-works) for why that's a deliberate constraint, not an
accident.

## Finding and configuring your device

On a fresh clone there's no `config.json` yet. On startup, if the address
would otherwise be the placeholder from `config.example.json` rather than a
real choice, the server looks for a WLED device on the LAN over mDNS
(`_wled._tcp.local`) and uses the first thing it finds for that run,
printing what it found and the line to add to `config.json` to keep using
it. A configured host always wins and skips the query entirely.

This is best-effort, not guaranteed: mDNS doesn't cross VLANs, and plenty of
consumer routers and corporate networks block multicast outright. If
discovery finds nothing, or the wrong device, set the address by hand. The
offline banner in the app has a "Find my cube" button that reruns the same
search on demand.

`config.json` is gitignored, since it holds your LAN address, which doesn't
belong in source. Copy it from `config.example.json` and fill in your own
device. Field by field:

- **`device.host`.** Your cube's LAN IP (e.g. `192.168.1.50`). With
  discovery in place, this is a fallback rather than a required step: leave
  it unset and the server tries to find one for you first.
- **`device.mac`.** Optional, for your own records. Nothing in the running
  app reads it back out of config; the diagnostic scripts capture the
  device's own reported MAC independently, from `/json/info`.
- **`device.name`.** Optional label, printed in the server's startup log.
  It is not the name shown in the page header: that comes from the cube's
  own `/json/info` at runtime (or from renaming it inside the app, see
  [Using it](#using-it)), so the two can legitimately differ.
- **`transport.*`.** Protocol and ports. The defaults (`wled-drgb` on UDP
  `21324`, sACN on `5568` universe `1`) are what was measured working on
  the Nano; see
  [What was measured, not documented](#what-was-measured-not-documented).
  You shouldn't need to touch these unless you're on different firmware.
- **`leds.*`.** `count` (addresses the controller reports), `working`
  (addresses that actually drive an LED), `perEdge`. The defaults are `88`,
  `44`, and `11`, measured on the Nano. If you're on a different unit, see
  [`docs/hardware-probing.md`](docs/hardware-probing.md) to find your own
  numbers before trusting anything Drostex computes against them.

If `config.json` still doesn't exist and discovery finds nothing either,
the server and scripts fall back to `config.example.json`'s placeholder
host and print a warning. That's useful for a first look at the UI; it's
useless for actually reaching a cube, since that file's host is a
placeholder.

For a device you don't know anything about yet, start with
`scripts/blink.mjs`. It probes which realtime UDP protocol the firmware
actually accepts, before you build anything on top of an assumption. From
there, [`docs/hardware-probing.md`](docs/hardware-probing.md) covers
characterizing a cube's own geometry, and doubles as a guide to
characterizing your own device if it isn't a Nano.

## How it works

A browser cannot open a raw UDP socket. (WebRTC data channels and
WebTransport both ride on UDP under the hood, but neither hands you a raw
socket you can point at an arbitrary host and port, which is what WLED's
realtime protocol needs.) So something local has to own that socket:
Drostex's Node server does. It holds the UDP connection and runs the
animation loop; the browser page only ever sends control messages over
HTTP (`/api/*`) and polls status back. That's what lets an animation keep
running after you close the tab: it isn't computed in the page, it's
computed in the server process.

There are **two independent pixel sources**, and exactly one drives the LEDs
at a time:

1. **Streamed looks.** Animations computed in Node (`src/animations.mjs`),
   pushed over WLED DRGB UDP to port `21324`. Every packet is stamped with a
   2-second revert timeout, so if the server dies mid-stream the cube falls
   back to its own state on its own, rather than freezing on the last frame.
2. **The firmware's own built-in effects.** ~95 named effects plus 3
   `Mode:` playlists, selected over the cube's JSON HTTP API
   (`/json/state`). When one of these is running, Drostex is not the pixel
   source: it's just a remote control.

Only one direction needs an explicit handoff. Selecting an onboard effect
while a look is streaming releases the renderer first, via
`renderer.stop({ blank: false })` in both `/api/device/state` and
`Cycler#apply`, so the socket goes quiet before the effect request reaches
the device. Starting a stream while an effect is running needs no
equivalent step: WLED's realtime protocol overrides whatever effect is
selected the moment UDP packets start arriving, so the streamed pixels
simply win. If you ever see a button that seems to require "stopping"
something before it visibly does anything, this is the direction that
needs it.

## Using it

The page has two tabs, plus a rail of controls that sit outside both because
they apply regardless of which source is active.

Click the device name at the top of the page to rename the cube. The write
goes to the device itself, not to a local nickname, so every client
(including the cube's own onboard UI) agrees on the name afterward.

The inspector panel includes a live preview: a wireframe cube whose edges
light up from the same buffer the server actually sent, read back over
`/api/pixels`. It's a readback, not a simulation, so if the preview and the
real object ever disagree, the bug is downstream of the render loop. It
only lights up while Drostex is the pixel source: during a firmware effect
the server has no idea what the LEDs are doing, so the panel dims and says
"not streaming" rather than showing a stale frame as if it were live. Edges
within the same address block are electrically ganged and always share a
colour, which the preview shows correctly; which physical edge belongs to
which block is still unconfirmed (see [Rough edges](#rough-edges)), so read
the layout as approximate.

**My looks**: your streamed animations.

- **Start from a pattern**: 11 built-in patterns (Rainbow, Comet, Fire,
  Plasma, Aurora, Snake, and others) plus **Custom**, a small signal chain
  (space → wave → colour) for building your own look without writing code.
  Click a card to start it immediately; the inspector on the right shows its
  parameters as sliders, colour pickers, and dropdowns, generated straight
  from the pattern's own schema.
- **Shuffle** randomises every parameter within its declared range or
  option list: the fastest way from "adjusting something" to "look I
  didn't expect." **Reset** restores the pattern's declared defaults.
- **Save** captures the current pattern, its parameter values, and playback
  speed as a named preset under **Saved**. Brightness is deliberately not
  saved: it's a property of the room you're in, not of the look, and
  recalling a preset shouldn't fight the brightness you'd already set.
- Playback controls: **Speed** (0.1× to 3.0×), **Frame rate** (10 to
  60fps, default 40), **Sparkle** (continuous, computed locally: reaches
  all 44 working addresses, unlike the firmware's own version, which
  can't reach streamed pixels at all; see [Rough edges](#rough-edges)),
  and **Symmetry** (6 modes that fold the sampling index before a pattern
  is evaluated: none, reverse, mirror, cyclic ×2, cyclic ×4, edge-mirror).
- **Stop & release** blanks the LEDs and hands control back to the cube's
  last onboard state.

**Built-in effects**: the firmware's own catalogue.

- Search box, filter chips (All / Starred / Sound-reactive / Static), and a
  palette picker. Of the firmware's 27 palettes, 25 get hand-identified dot
  swatches; `Default` (each effect's own colours) and `Custom` deliberately
  show none, because neither is a fixed, knowable colour set.
- **Symmetry, Effect speed, Intensity and Palette** each carry an "owner"
  label. The device reports `0` in `sym`, `sx`, `ix` and `pal` to mean "the
  pattern is deciding, not you," so the label reads "the pattern's own" in
  that state and "yours" the moment you touch the control, with a
  "hand back" button to return it. Effect speed and Intensity are sliders
  running 1 to 255, parked at their midpoint while the pattern owns them.
  Symmetry here is the firmware's own geometry-aware modes (Cubic,
  Helical, Trigonal, and others), unrelated to the space-folding Symmetry
  under **My looks** above; the two run on different sources and never
  interact.
- **Sparkle** here is the firmware's own three-step version (Off/Low/High)
  and only affects onboard effects, not streamed looks. That's why there
  are two separate sparkle controls in the app, one per source.
- **Pulse to music** uses the cube's own onboard microphone; Drostex sends
  no audio anywhere. It does nothing useful in a silent room.
- **Warp drive** triggers a one-shot vendor animation with a 15-second
  cooldown, matching the cube's own UI.
- **The cube's own rotations** are the 3 `Mode:` playlists: kaleidoscopic
  patterns, a slow/calm set, and a sound-reactive set. Each rotates its own
  block of effects on the firmware itself: holds one for 60s, refreshes
  colours every 10s, and keeps going with no computer involved, including
  after you close Drostex. "See its N patterns →" filters the effect grid
  below down to just that playlist's members.
- **Single effects** lists every named effect individually; sound-reactive
  ones carry a small icon.

**Global modifiers** (outside both tabs): **Power**, and one **Brightness**
slider. There's only one, deliberately: see [Rough edges](#rough-edges) for
why a second one used to exist and made things worse.

**Auto-cycle** rotates through a chosen pool on an interval, across both
sources at once. Pools: your saved looks, your favourites (spanning all
three star locations), your patterns, or the firmware's effects (all /
sound-reactive / static / everything). The interval slider runs 5s to
600s; the floor exists because below ~5s the cube spends more time
transitioning than showing anything (the API behind it will in fact accept
up to an hour, if you drive it directly). Shuffle order exhausts the whole
pool once before repeating, rather than picking uniformly at random each
tick, which is what "shuffle" actually means to a listener. If the pool
includes onboard effects, the rotation is driven by Drostex and stops when
the server does; for something that keeps rotating on its own, use the
cube's own `Mode:` playlists instead.

**Starring**: patterns and firmware effects star into `favorites.json`
(gitignored, keyed by kind + id: they're fixed catalogues with nowhere of
their own to hold a flag). A saved look stores its own star inline in
`presets.json`, so deleting the look takes the star with it for free.

## The CLI scripts

Everything in `scripts/` resolves the device address the same way
(`scripts/lib/config.mjs`): a bare IPv4 CLI argument, then `DROSTEX_HOST`,
then `config.json`, then `config.example.json`.

- **`scripts/play.mjs`**: headless CLI player. Runs the exact same
  `Renderer` the server uses, so the two can't drift apart. Good for a
  quick look with no browser, or for running on a machine with none.
  `node scripts/play.mjs --list`, `node scripts/play.mjs comet --fps=40
  --bri=0.7 --speed=1.5`, or `npm run play -- <name>`.
- **`scripts/blink.mjs`**: the original transport probe. Sends the same
  single red pixel over DDP, WLED-DRGB, sACN (two universes), and Art-Net in
  turn, and asks the cube's own `/json/info` whether it noticed. This is how
  DDP and Art-Net were found to be closed on the Nano's firmware. `--chase`
  walks the strip one LED at a time afterward so you can watch the wiring
  order; `--runs` walks whole address blocks instead; `--skip-probe` skips
  straight to WLED DRGB; `--hold=<seconds>` controls how long each step is
  held.

Characterizing a cube's own geometry (how many addresses respond, which
edges they drive, where they sit) takes longer and needs a human watching
the cube: see [`docs/hardware-probing.md`](docs/hardware-probing.md) for
`scripts/diagnose.mjs`, `scripts/colors.mjs`, `scripts/edges.mjs`,
`scripts/map.mjs`, and `scripts/structure.mjs`, and for how to run the same
process against a device that isn't a Nano.

## Writing your own animation

This is a one-file change. An animation is a pure function
`(ctx) => [r, g, b]` in `0..1`, plus a declared `params` schema the UI
builds its controls from automatically. Add a parameter here and it
appears as a slider or picker in the inspector with no UI code written.

A real, complete one from `src/animations.mjs`:

```js
rainbow: {
  label: 'Rainbow',
  desc: 'a hue cycle travelling around the loop',
  params: {
    cycles: num('Cycles', 1, 1, 4, 1),
    saturation: num('Saturation', 0.95, 0, 1),
    drift: num('Drift', 0.15, -1, 1, 0.01, 'how fast the whole pattern rotates'),
  },
  fn: ({ uw, t, speed, p }) => hsv(uw * p.cycles + t * p.drift * speed, p.saturation, 1),
},
```

`ctx` carries three flavours of position, and the difference matters:

- **`u`**: `i / (N-1)`, `0..1` inclusive. Endpoint-exact, **not** seamless.
- **`uw`**: `i / N`, `0..1` exclusive. Wraps.
- **`e`**: position along the current edge, `0..1`, wrapping every
  `perEdge` LEDs.

The strip is a **closed loop**: its two ends meet at the corner the cube
stands on, and each per-edge run meets the next at every other corner. Use
`u` for a hue ramp and you get a visible colour break at that seam: the
inclusive form guarantees the two ends land on different colours. `uw` is
what `rainbow` uses above, and it's why the ramp is continuous all the way
around instead of snapping back at the mounting corner.

To add your own: pick a unique key in the `ANIMATIONS` object in
`src/animations.mjs`, write `fn`, declare `params` with the `num` / `col` /
`bool` / `pick` / `pal` helpers already in that file. Nothing else needs
touching: `/api/animations` and the inspector both read the object
directly. Try it with `node scripts/play.mjs <your-key>` before touching
the UI at all (there's no hot reload; see [Rough edges](#rough-edges)).

## What was measured, not documented

Some of this the vendor does publish: the spec sheet's 12 edges of 11 LEDs
each, 132 LEDs total, holds up against measurement. Everything else came
from probing the device directly, because the controller's own numbers
disagree with the spec sheet and nothing in between is written down
anywhere. See `profiles/nano-topology.json` for the full record and
[`docs/hardware-probing.md`](docs/hardware-probing.md) for how each fact
was extracted.

- The controller reports **88 LED addresses**, but only the **first 44**
  drive anything. The rest are configured by the vendor with no physical
  tap behind them.
- There is no single "LEDs per address" figure, and that isn't a gap in the
  measurement, it's the actual shape of the hardware. The wiring is
  branching-parallel: one data line enters on an edge and splits at every
  corner, and everything downstream of a split shows the same colour. The
  four address blocks drive **1, 2, 4 and 5 edges** respectively (44
  addresses across those four blocks, 12 edges total, 132 LEDs). An earlier
  pass divided 132 by 44, got a clean-looking 3, and shipped that as
  "3 LEDs per address, WS2811-style." It was wrong. `scripts/diagnose.mjs`
  now warns explicitly against drawing that conclusion from arithmetic
  alone, and the uneven fan-out is why a moving point can appear on one
  edge in one part of the cube and five edges at once in another.
- **12 edges × 11 LEDs = 132** physical LEDs total. This is the one number
  the vendor's own spec sheet and the measured wiring agree on.
- **DDP** and **Art-Net** ports are closed on this firmware (ICMP
  port-unreachable on probe). **WLED DRGB** (UDP 21324) and **sACN**
  universe 1 (UDP 5568) both work: DRGB is what Drostex actually uses.
- `/json/fxdata` answers **HTTP 501**. There is no endpoint that reports
  what a palette or an onboard effect's own colours look like, which is
  why the palette swatches in the UI are approximations authored by hand
  (`src/device-palettes.mjs`), not device data.

## Limitations

### What it does not do

What is in scope, and what is not.

- **One product.** Built and tested against a HyperCube Nano on firmware
  `hs-2.0`, the build that reports the 95 effects mentioned above. See the
  claim ladder at the top of this file for what's expected to work on
  other WLED gear, and what almost certainly won't.
- **One device at a time.** There's a single `Renderer`, a single UDP
  socket, one configured host.
- **No authentication.** Binds to `127.0.0.1` only, and checks the
  request's `Host` header on every request. That's a guard, not a security
  model. Do not expose this to a network.
- **No multi-user support.** Two browser tabs pointed at the same server
  will fight. There's no locking, so whichever poll lands last quietly
  wins, and the other tab keeps showing stale state until its own next
  2-second poll catches up.
- **Not packaged.** This is Node, a terminal, and a process you leave
  running: no installer, no system service, nothing that starts on boot.
  Close the laptop and the animation stops the moment it sleeps.
- **Sound-reactive effects need a microphone on the cube itself.** They
  look broken in a silent room; that's expected, not a bug. Drostex never
  sends audio, it only tells the firmware which effect to run.

### Rough edges

Known quirks in day to day use.

- **Approximate palette swatches.** The device publishes palette *names*
  and nothing else. 25 of the firmware's 27 palettes get hand-authored
  swatches, matched against known WLED/FastLED palette definitions where
  one exists (`src/device-palettes.mjs`); the other two, `Default` and
  `Custom`, don't have a fixed colour set to show. This is a best guess at
  what "Tiamat" looks like, not a read-out of it.
- **One brightness slider by design.** An earlier version had a separate
  device-side slider too, and the two fought: the device slider would
  overwrite the 255 that streaming needs, and Stop would then revert
  whatever the user had just set. There's one slider now; while streaming,
  it *is* the brightness the room sees.
- **A device reading of 255 is never trusted as your saved preference.**
  Whatever brightness the device reports before Drostex touches it is
  normally restored on a clean stop, but a reading of exactly 255 is
  refused outright and discarded, because 255 is what streaming itself
  leaves the device at. An earlier version adopted it anyway, which meant
  the brightness slider silently jumped to full every time a preset loaded
  after a mid-stream kill. The tradeoff: a cube that's genuinely,
  deliberately at full brightness the first time Drostex sees it doesn't
  get that recorded as a preference either. Kill the process mid-stream
  and the device sits at 255 until the next clean stop reads a sane value
  back.
- **The firmware's own sparkle doesn't reach streamed pixels.** It runs
  inside the firmware's effect renderer, and realtime UDP data replaces the
  frame buffer afterward, so nothing the firmware draws survives once
  Drostex is streaming. (An earlier belief that it did survive came from
  watching the cube's reported power draw fluctuate during testing; that
  reading covers all 88 configured addresses, not just the 44 with real
  LEDs behind them, so the firmware was sparkling into pixels that don't
  exist.)
- **No hot reload for your own animations.** Edit `src/animations.mjs`,
  restart the server.
- **The live cube preview's edge layout is nominal, not confirmed.** It
  correctly shows how many edges move together per address block (1, 2, 4
  and 5), because that much is measured. Which physical edge is *which*
  within that grouping isn't known yet, for any unit, including this one.
  It's the single most useful thing a contributor with a cube on their
  desk could nail down; see [CONTRIBUTING.md](CONTRIBUTING.md).

## What it is not

Not a WLED replacement: WLED's own UI still exists and still works, this
just adds a layer on top for one specific cube. Not a DMX console. Not a
cloud service: every network call this app makes targets either your
cube's own LAN address or its own local `/api/*`, nothing leaves your
machine.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers running it with no cube attached,
the zero-dependency rule, and how to add an animation or an endpoint.

Two things are worth more than the rest:

- **Which physical edge belongs to which address block.** The block sizes
  are measured, the edge identities are not, and every unit may be wired
  differently. This needs somebody with a cube, a camera and some
  patience, and it is the one finding that would improve the preview for
  everyone.
- **Whether any of this works on other WLED hardware.** Streamed looks
  should. The Built-in effects tab will not. Nobody has checked either.
  Run `scripts/blink.mjs` against your device and open an issue with what
  came back, including your `/json/info`.

New patterns are welcome and cost one function in `src/animations.mjs`.
Measurements about hardware should arrive with the script that produced
them, so the next person can re-run it rather than take your word for it.

## License

MIT. See [LICENSE](LICENSE).
