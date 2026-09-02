/**
 * Renaming the cube, on the cube.
 *
 * The name shown in the header comes from the device's own /json/info, so
 * changing it has to be written to the device or it is not a rename, it is a
 * local nickname that disagrees with every other client.
 *
 * There is no clean way to do it. /json/cfg answers 501 on this firmware, so
 * the JSON config route does not exist. The name lives in the `DS` field
 * ("server description") of the settings form at /settings/ui, and that form
 * is a plain HTML POST.
 *
 * The trap, hit once and repaired: THE FORM SAVES EVERY FIELD AT ONCE.
 * Posting `DS` alone does rename the device, and simultaneously resets every
 * other field on the page to its empty value. Measured on a real unit, a
 * DS-only POST took CA 150 to 0, TD 8 to 0, TA 20 to 0, MS 81 to 0, and
 * cleared the RI, RB, RX and SD checkboxes.
 *
 * So the write is read-modify-write: fetch the page, recover the current
 * values, and post all of them back with one field changed. WLED renders that
 * state as a run of inline assignments (`d.Sf.CA.value=150;`), which is what
 * we parse. Empirically the set of fields it emits is exactly the set the form
 * persists: replaying it verbatim produced a byte-identical page.
 *
 * Because that is a scraped HTML form and not an API, every write is verified
 * afterwards. If anything other than the name moved, we say so rather than
 * reporting success.
 */

const TIMEOUT = 6000;

/** Field values WLED writes into the settings page to populate its own form. */
export function parseSettings(html) {
  const values = new Map();
  const checks = new Map();

  // d.Sf.CA.value=150      d.Sf.DS.value="My Cube"
  for (const m of html.matchAll(/d\.Sf\.([A-Za-z0-9_]+)\.value\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^;]*)/g)) {
    let raw = m[2].trim();
    if (/^["']/.test(raw)) {
      // JSON.parse handles the escaping WLED emits; fall back to a naive strip.
      try { raw = JSON.parse(raw.replace(/^'|'$/g, '"')); }
      catch { raw = raw.slice(1, -1); }
    }
    values.set(m[1], String(raw));
  }

  // d.Sf.RI.checked=1
  for (const m of html.matchAll(/d\.Sf\.([A-Za-z0-9_]+)\.checked\s*=\s*([^;]*)/g)) {
    const v = m[2].trim();
    checks.set(m[1], v === '1' || v === 'true');
  }

  return { values, checks };
}

/**
 * Rebuilds the form body.
 *
 * Unchecked boxes are omitted rather than sent as 0, which is how a browser
 * submits them and how the firmware expects to read them.
 */
function encodeForm({ values, checks }) {
  const body = new URLSearchParams();
  for (const [k, v] of values) body.set(k, v);
  for (const [k, on] of checks) if (on) body.set(k, 'on');
  return body;
}

const get = async (host, path) => {
  const r = await fetch(`http://${host}${path}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.text();
};

/**
 * Sets the device's display name.
 *
 * Resolves to `{ name, verified }`. `verified` is false when the write landed
 * but the read-back disagrees about some other field, which the caller should
 * surface rather than swallow.
 */
export async function setDeviceName(host, name) {
  const clean = String(name ?? '').trim().slice(0, 32);
  if (!clean) throw new Error('name cannot be empty');
  // The form is urlencoded and the firmware parses it loosely; a newline or a
  // quote in there corrupts the page it renders back.
  if (/[\r\n"<>]/.test(clean)) throw new Error('name cannot contain quotes, angle brackets or newlines');

  const before = parseSettings(await get(host, '/settings/ui'));
  if (!before.values.has('DS')) {
    // A firmware whose settings page we do not recognise. Refuse rather than
    // POST a form we cannot reconstruct - that is how settings get wiped.
    throw new Error('this firmware does not expose a name field we recognise');
  }

  const previous = before.values.get('DS');
  const next = { values: new Map(before.values), checks: new Map(before.checks) };
  next.values.set('DS', clean);

  const res = await fetch(`http://${host}/settings/ui`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encodeForm(next).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`device rejected the write (${res.status})`);

  // Read back and compare. Anything that moved other than DS is a bug in our
  // reconstruction, and the user needs to know before they find it themselves.
  const after = parseSettings(await get(host, '/settings/ui'));
  const drifted = [];
  for (const [k, v] of before.values) {
    if (k === 'DS') continue;
    if (after.values.get(k) !== v) drifted.push(`${k}: ${v} -> ${after.values.get(k)}`);
  }
  for (const [k, on] of before.checks) {
    if (after.checks.get(k) !== on) drifted.push(`${k}: ${on} -> ${after.checks.get(k)}`);
  }

  return {
    name: after.values.get('DS') ?? clean,
    previous,
    verified: drifted.length === 0,
    drifted,
  };
}
