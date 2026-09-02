/**
 * Colours for the cube's own 27 palettes.
 *
 * These are OURS, not the firmware's. The device publishes palette names and
 * nothing else: /json/palx returns a bare string array, /json/fxdata answers
 * 501, and the cube's own web UI renders the palette picker as a plain text
 * <select> with no swatch of any kind. There is no endpoint that will tell you
 * what "Tiamat" looks like.
 *
 * So the stops below are read from each palette's name and, where the name
 * matches a known WLED/FastLED palette (Lava, Ocean, Forest, Sunset, Yelblu,
 * Ultraviolet, C9, Aurora, Pastel), from that palette's published definition.
 * They are close enough to pick by and are labelled in the UI as an
 * approximation, because that is what they are - the point is to answer "which
 * of these is the blue one" at a glance, not to predict the exact output.
 *
 * `Default` and `Custom` deliberately have no stops: Default means "whatever
 * this pattern wants", which is unknowable by the same argument, and Custom is
 * whatever the user last painted into the cube's own colour slots.
 */
export const DEVICE_PALETTES = {
  Default: null,
  Custom: null,
  Aurora: ['#00202b', '#0d6b6b', '#28c76f', '#7ef9a2', '#b8f7d4'],
  'Aurora II': ['#031a3d', '#1b4f9c', '#39b3a7', '#8ef0c0', '#e6fff2'],
  C9: ['#b80000', '#00951a', '#0b3ea8', '#ff8f00', '#ffffff'],
  Chromatic: ['#ff0040', '#ff9500', '#ffe600', '#00d26a', '#0084ff'],
  'Chromatic II': ['#8a00d4', '#d100b8', '#ff0066', '#ff7a00', '#ffd000'],
  Forest: ['#062d0a', '#12551a', '#2f8f21', '#79bf3a', '#c6e070'],
  'Green Giant': ['#001a05', '#00521a', '#00913a', '#3fd15f', '#a8f0a0'],
  Harmonious: ['#3b1f5e', '#6b3fa0', '#c06ac0', '#f0a3a3', '#ffe0b8'],
  'Kaleidoscope I': ['#ff0000', '#ffcc00', '#00cc44', '#0066ff', '#cc00ff'],
  'Kaleidoscope II': ['#ff2d95', '#ff9500', '#f7ff00', '#00ffc8', '#7a5cff'],
  Lava: ['#000000', '#6b0000', '#c62200', '#ff9000', '#ffe0a0'],
  Luminous: ['#1a0033', '#5c00a3', '#b400d1', '#ff5ad1', '#ffd6f5'],
  'Molten Sea': ['#03202e', '#0a5b6b', '#1fa3a0', '#ff7a3d', '#ffd08a'],
  Nebula: ['#05030f', '#2b0b5e', '#7a1fa8', '#d94fb0', '#ffd2f0'],
  Neptune: ['#00121f', '#003a63', '#0a7fa8', '#41c6d6', '#b6f2f5'],
  Ocean: ['#000a2b', '#00308f', '#0072c6', '#35b6e0', '#bfeaff'],
  Pastel: ['#ffd6e0', '#ffefc9', '#d6f5d6', '#cfe8ff', '#e6d6ff'],
  'Red Titan': ['#1a0000', '#6b0000', '#b81414', '#ff4d1a', '#ffb37a'],
  'Solar Skys': ['#0a1a4d', '#2b5ba8', '#7fb2e0', '#ffc46b', '#ff7a3d'],
  Spectral: ['#4b0082', '#0000ff', '#00ff00', '#ffff00', '#ff0000'],
  'Stellar Flare': ['#120000', '#7a1400', '#e04b00', '#ffb300', '#fff2b8'],
  Sunset: ['#120033', '#7a1f5e', '#e04b6b', '#ff9147', '#ffd98a'],
  Tiamat: ['#001a2b', '#0b5c8a', '#2ec4b6', '#b8f2e6', '#ff5c8a'],
  Ultraviolet: ['#0a0033', '#2e0a6b', '#6b1fc4', '#a85cff', '#e0b8ff'],
  Yelblu: ['#001a4d', '#0a4d9c', '#4d9cd6', '#c9e06b', '#fff07a'],
};

/** Stops for a palette by its device label, or null if we do not claim to know. */
export const paletteStops = (label) => DEVICE_PALETTES[label] ?? null;
