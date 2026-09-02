# Contributing to Drostex

## Running it without hardware

You don't need a cube on your network to work on most of this codebase.

`npm start` works with no device reachable: `config.example.json`'s
placeholder host is used as a fallback if `config.json` doesn't exist (with
a console warning), the server binds and serves the UI regardless, and
`Renderer.captureFromDevice()` at startup fails silently if there's nothing
to reach.

One side effect of automatic discovery worth knowing about: if
`config.json` doesn't exist yet, startup spends up to ~2.5 seconds sweeping
mDNS (`src/discover.mjs`) before it falls back to the placeholder host.
That delay before the server starts listening is expected, not a hang.

What still works with the device offline:

- The **My looks** tab fully loads and is interactive: the pattern list,
  the parameter inspector, Shuffle, Reset, saving and loading presets. None
  of that depends on the device; `/api/animations` and `/api/palettes` are
  computed entirely server-side from `src/animations.mjs`.
- Clicking a pattern actually runs the render loop and sends UDP frames;
  they just go to an address nothing is listening on. `dgram` doesn't error
  on that (the socket's `error` handler is a deliberate no-op, so ICMP noise
  from an unreachable host can't kill the loop). Good enough for testing
  animation logic, parameter wiring, or preset save/load end to end.

What breaks:

- After ~3 missed polls (~6s) the offline banner appears, and stays up.
  This is `/api/status` correctly reporting the device unreachable, not a
  bug to chase.
- The **Built-in effects** tab fails to load (`/api/effects` proxies
  `/json` on the device; with nothing there it 500s, and the tab shows a
  retry message instead of a grid). Anything gated on the firmware's own
  JSON API (palette picker, effect grid, mode playlists, Warp drive) is
  unavailable.
- Device-targeted writes (brightness when not streaming, symmetry, sparkle
  on the effects side) fail silently: they're wrapped in `try/catch` on
  purpose, since a control the user just touched shouldn't throw at them
  for a network problem.

If your change touches device-facing behavior, you'll want a real cube (or
a WLED-compatible device) to verify against before calling it done. Reading
the `/json/state` and `/json/info` shapes referenced in `src/renderer.mjs`
and `server/index.mjs` will get you close if you're building something that
degrades gracefully, but "degrades gracefully" itself needs to be checked
against the real failure mode, not just imagined. A guess about what an
unreachable device does is worth writing down as an assumption in the PR
description, not shipping as tested behavior.

## Zero runtime dependencies

`package.json` has no `dependencies`: everything is `node:http`,
`node:dgram`, `node:fs`, `node:crypto`, and so on. This is a rule, not an
accident: it's the difference between "clone and run" and "clone and debug
node-gyp." Before adding a dependency, ask whether the ~20 lines it would
save are worth losing that property for everyone who clones this repo
afterward. In almost every case so far, the answer has been no: see how
`server/index.mjs` implements its own tiny static file server and JSON body
reader rather than pulling in a framework, or how `src/discover.mjs`
hand-rolls just enough of mDNS (encode one query, decode PTR/SRV/A/TXT
records) to find a WLED device on the LAN, rather than pulling in a
service-discovery library to save itself maybe twenty lines.

If you genuinely believe a dependency is warranted, say so explicitly in
the PR description with the specific alternative you considered and why
hand-rolling it isn't reasonable. Don't add it quietly.

## Code style

- ES modules, `.mjs` extension, `type: module` in `package.json`. No
  build step, no transpilation: what you write is what runs.
- Comments explain **why**, not **what**. The codebase leans hard on this;
  read a few file headers (`src/renderer.mjs`, `src/animations.mjs`,
  `src/cycler.mjs`) before writing your own. A comment restating the next
  line in English is worse than no comment: it's a second thing that can
  go stale.
- Functions are kept small and mostly pure where the domain allows it,
  see `src/animations.mjs`'s `(ctx) => [r,g,b]` shape. State lives in a few
  well-named places (`Renderer`, `Cycler`) rather than scattered globals.
- Match the existing formatting (2-space indent, semicolons, single
  quotes) rather than introducing a formatter/linter config as part of an
  unrelated change.

## Adding an animation

See the README's [Writing your own animation](README.md#writing-your-own-animation)
section for the concept: the `(ctx) => [r,g,b]` shape, the `params`
schema, and why `u` / `uw` / `e` are different things.

Mechanically: add one entry to the `ANIMATIONS` object in
`src/animations.mjs`. That's the whole change: `/api/animations` and the
UI's parameter inspector both read that object directly, so there is no
second file to update for a new pattern to appear fully wired in the UI.

Before opening a PR:

- Run it headless first: `node scripts/play.mjs <your-key>` (add
  `--bri=`/`--speed=`/`--fps=` as needed). If you have a device, watch it
  actually render before wiring it into the UI at all.
- Give every parameter a `min`/`max` that makes sense at the extremes: the
  Shuffle button in the UI picks uniformly at random across the whole
  declared range, so a bad bound is a bad random look, not just a bad
  default.
- Only set `swatch` if the pattern's own parameters can't produce an
  honest colour preview (see the comment above `swatchFor()` in
  `web/app.js` for what "honest" means here: it used to default to a
  rainbow for everything, which was a lie for patterns like Fire).

## Adding an API endpoint

Endpoints live as sequential `if (p === '/api/...')` blocks inside the
single `http.createServer` handler in `server/index.mjs`. There's no
router. Add your block **before** the catch-all `/api/` 404
(`if (p.startsWith('/api/')) { ... }` near the end of that function) and
after the ones it doesn't conflict with; order among endpoints themselves
doesn't matter.

Conventions to match:

- Use the `json(res, code, body)` helper for every response.
- For anything that needs to read the request body, use `readBody(req)`:
  it already caps input size and swallows malformed JSON to `{}` rather
  than crashing the request.
- For anything that talks to the cube's own JSON API, go through the
  existing `device(path, init)` proxy rather than calling `fetch` directly:
  it centralizes the timeout and base URL.
- If your endpoint changes which pixel source is driving the LEDs (i.e. it
  starts an onboard effect, or starts/stops streaming), look at how
  `/api/device/state` and `/api/warp` release the other source first.
  Getting this wrong doesn't error: it just makes the button look broken
  because the next frame from the other source overwrites what you just
  set.

## Writing to `/settings/ui`: a cautionary example

`src/device-name.mjs` is worth reading before you touch anything else that
writes to the device outside `/json/state`, because it's the one place in
this codebase talking to something that isn't actually an API.

`/json/cfg` answers HTTP 501 on this firmware, so there's no JSON route to
set the device's name. The name lives in the `DS` field of the plain HTML
settings form at `/settings/ui`, and that form saves every field on the
page at once. A `DS`-only POST does rename the device, and simultaneously
resets everything else on the page to its empty value. Measured on a real
unit: a `DS`-only write took `CA` from 150 to 0, `TD` from 8 to 0, `TA`
from 20 to 0, `MS` from 81 to 0, and cleared four checkboxes.

So the write is read-modify-write: fetch `/settings/ui`, parse the current
field values out of the inline `d.Sf.FIELD.value = ...` assignments WLED
renders into the page, change only `DS`, and POST the whole form back.
Every write is then verified by fetching the page again and diffing it
against what was there before the write. If anything besides `DS` moved,
the caller is told so explicitly (`{ verified: false, drifted: [...] }`)
rather than getting a bare success.

If you're adding another device-facing write that isn't `/json/state`,
assume the same trap applies until you've confirmed otherwise: check
whether a JSON route actually exists (a firmware answering `/json/cfg`
with 501 isn't obvious from the outside), and if it doesn't, read the
settings form back before and after your write and diff it, the way
`setDeviceName()` does.

## Tests

`test/` uses the built-in `node:test` runner. `npm test` runs it (bare
`node --test`, which auto-discovers `test/**/*.test.mjs`). Don't run
`node --test test/` directly: it throws `MODULE_NOT_FOUND` on Node 22,
because that form tries to `require()` the directory as a module instead
of treating it as a glob. As of this doc there are 151 tests across 28
suites, all passing.

If you're adding behavior with a test-worthy seam, pure functions in
`src/animations.mjs`, `src/cycler.mjs`, and the parsing half of
`src/device-name.mjs` (`parseSettings()`) are the easiest targets: they
don't need a device or a socket. Add a test alongside your change rather
than leaving coverage for later.

Anything that requires the physical device isn't something a unit test can
exercise honestly: verify those by hand, and in the PR description say
what you ran and what you saw.

## What a good PR looks like

- **One change per PR.** Explain what it does and why in the description.
  A list of touched files isn't a substitute for that.
- **Verified, not assumed.** If it touches device-facing behavior, say
  what you tested it against (which firmware, what you observed).
  "Should work" isn't a substitute for having run it. If it's UI-only or
  server-logic-only and you tested it with the device offline per the
  section above, say that instead.
- **Measurements travel with the script that produced them.** If a PR
  changes or adds a fact about the hardware (an LED count, a working
  transport, a palette's real colours), include the script or the exact
  steps that produced it, not just the resulting number.
  `profiles/nano-topology.json` and the `$comment` fields throughout
  `config.example.json` are the model to follow. A number with no method
  behind it is a guess wearing a measurement's clothes, and the next
  person has no way to tell the difference. The same goes for
  `src/models.mjs`: the vendor's counts there cite the product page they
  came from, and a model only moves from `spec-sheet` to `measured` with a
  profile behind it. If you own a HyperCube10-SE or 15-SE, that PR is the
  most useful one this project can get right now.
- **No unrelated formatting churn.** Keep diffs readable by touching only
  what the change requires.
- **Comments explain why, code shows what.** If you catch yourself writing
  a comment that just restates the next line, delete it; if you catch
  yourself making a non-obvious choice with no comment, add one.
