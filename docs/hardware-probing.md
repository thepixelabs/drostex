# Characterizing a HyperCube Nano, or your own device

This page answers the two questions nothing about this hardware documents:
how many addresses actually drive an LED, and which physical edges they
drive. `profiles/nano-topology.json` is the answer for the unit this
project was built against. If you're mapping a different cube, this is the
order to run things in.

## If you have a HyperCube10-SE or 15-SE

You are the tester this project is missing. `src/models.mjs` already knows
the vendor's counts for your cube (216 LEDs at 18 per edge, or 336 at 28),
so `npm start` should recognise it and stream to it. What it does not know
is whether the controller reports more addresses than drive LEDs, the way
the Nano does (88 reported, 44 real), or how the edges gang together. Run
`scripts/blink.mjs`, then `scripts/diagnose.mjs`, then `scripts/colors.mjs`,
in that order, and open an issue with what you saw, even if it's "every
address lit and nothing was odd". If you get as far as a block layout, a
`profiles/hc10-se-topology.json` in the shape of the Nano's, plus the
matching `reported`, `working` and `blocks` in `src/models.mjs`, is the PR.

Everything below resolves the device address the same way as the rest of
the project (`scripts/lib/config.mjs`): a bare IPv4 CLI argument, then
`DROSTEX_HOST`, then `config.json`, then `config.example.json`. Start with
`scripts/blink.mjs` (see the [README](../README.md#the-cli-scripts)) to
confirm which transport your device actually accepts before running any of
these.

## `scripts/diagnose.mjs`

Interactive binary search for how many addresses respond at all, plus one
direct question: "how many LEDs light up, side by side?" when address 0
alone is lit. Writes `profiles/nano-diagnostic.json` (gitignored: it
captures your device's MAC and IP).

Read the "Implied physical LEDs" line it prints at the end
(`workingAddresses × ledsPerAddress`) as a hypothesis, not an answer. It
multiplies whatever a single address happened to show across every working
address, which silently assumes every address drives the same number of
LEDs. On the Nano that assumption is false: address 0 sits in a block that
drives exactly 1 edge, while another block drives 5, so the honest answer
depends on which address you probed. Cross-check with `scripts/colors.mjs`
and `scripts/edges.mjs`, which look at more than one address, before
trusting a single-address figure.

## `scripts/colors.mjs`

Lights fixed-brightness colour blocks across the addressable range and
holds them, so you can walk around the cube and read the address-to-edge
mapping by eye instead of answering yes/no questions about it. Every block
is generated at a fixed total drive level, so a bright colour can't
visually out-shout a dim one and skew what you see. `--blocks=N` (default
4), `--all` (spread across all 88 addresses, including the dead half),
`--sacn2` (send as two sACN universes).

## `scripts/edges.mjs`

Interactive probe for a cube standing balanced on a corner: no top or
bottom face, so the 12 edges are asked about in the three groups that
geometry actually produces (3 meeting at the top point, 6 zig-zagging
around the middle, 3 at the bottom). Counting within a group is far more
reliable than trying to name one edge in isolation.

## `scripts/map.mjs`

Interactive; the CLI ancestor of a mapping wizard that was never built as
UI. Lights one addressable run at a time and asks which physical line it
is and which direction it runs, to build an address-to-edge map by hand.

## `scripts/structure.mjs`

Lights a set of predicted patterns for a specific structural hypothesis
and asks you to confirm or deny each one. Read it as a template for
writing your own confirmation pass once `colors.mjs` and `edges.mjs` have
told you roughly what to expect, not as a source of truth about the Nano:
the hypothesis its comments currently describe (4 even groups of 3 LEDs
per address) is the one that clean arithmetic made attractive and that
`profiles/nano-topology.json` later disproved. The real wiring is
branching-parallel with an uneven 1/2/4/5 edge split per block, not 4 even
groups.

## What "done" looks like

`profiles/nano-topology.json` is the target shape: a `blocks` array with
`addresses`, `edgeCount`, `leds`, and a plain-English `observed` note per
block, plus a `consequences` array spelling out what the topology means
for pattern design. If you map a different unit, that file (or your own
copy of it) is what a PR should update, per
[CONTRIBUTING.md](../CONTRIBUTING.md#what-a-good-pr-looks-like): a number
with no method behind it is a guess wearing a measurement's clothes.
