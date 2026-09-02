/**
 * Settings-form parsing, which is what stands between a rename and a wiped
 * device configuration.
 *
 * The rename is read-modify-write against a scraped HTML form: whatever this
 * parser fails to recover does not get posted back, and the firmware treats a
 * missing field as empty. A silent miss here is not a wrong name, it is the
 * user's brightness limiter, their LED count and their sync settings reset to
 * zero. Every value below is taken from the real page a HyperCube Nano serves.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings } from '../src/device-name.mjs';

/* The state block WLED emits to populate its own form, verbatim from the unit. */
const REAL = `
<html><body><form id=form_s name=Sf method=post>
<script>
function GetV(){
d.Sf.CA.value=150;d.Sf.BP.value=1;d.Sf.TD.value=8;d.Sf.TA.value=20;d.Sf.TP.value=10;
d.Sf.PT.value=60;d.Sf.RP.checked=0;d.Sf.RI.checked=1;d.Sf.TL.value=60;d.Sf.MS.value=81;
d.Sf.DS.value="My Cube";d.Sf.UP.value=4;d.Sf.RB.checked=1;d.Sf.RX.checked=1;
d.Sf.SS.checked=0;d.Sf.SD.checked=1;F();Adv(true)
}
</script></form></body></html>`;

describe('parseSettings', () => {
  const { values, checks } = parseSettings(REAL);

  test('recovers every numeric field', () => {
    for (const [k, v] of Object.entries({
      CA: '150', BP: '1', TD: '8', TA: '20', TP: '10',
      PT: '60', TL: '60', MS: '81', UP: '4',
    })) {
      assert.equal(values.get(k), v, `${k} must round-trip`);
    }
  });

  test('recovers the name, unquoted, spaces intact', () => {
    assert.equal(values.get('DS'), 'My Cube');
  });

  test('distinguishes checked from unchecked', () => {
    // Unchecked boxes are omitted from the POST, so mixing these up is exactly
    // how RI/RB/RX/SD got cleared on the real device.
    assert.equal(checks.get('RI'), true);
    assert.equal(checks.get('RB'), true);
    assert.equal(checks.get('RX'), true);
    assert.equal(checks.get('SD'), true);
    assert.equal(checks.get('RP'), false);
    assert.equal(checks.get('SS'), false);
  });

  test('checkbox fields do not leak into the value map', () => {
    for (const k of ['RP', 'RI', 'RB', 'RX', 'SS', 'SD']) {
      assert.equal(values.has(k), false, `${k} is a checkbox, not a value`);
    }
  });

  test('recovers the exact field count the device emits', () => {
    // A firmware that grows a field should show up as a test failure here
    // rather than as a silently dropped setting on somebody's cube.
    // 9 numeric fields plus DS, which is a value like any other.
    assert.equal(values.size, 10);
    assert.equal(checks.size, 6);
  });

  test('trailing calls are not mistaken for fields', () => {
    assert.equal(values.has('F'), false);
    assert.equal(values.has('Adv'), false);
  });
});

describe('parseSettings on awkward input', () => {
  test('a name containing an escaped quote survives', () => {
    const { values } = parseSettings('d.Sf.DS.value="Ben\\"s Cube";');
    assert.equal(values.get('DS'), 'Ben"s Cube');
  });

  test('single-quoted values are handled', () => {
    const { values } = parseSettings("d.Sf.DS.value='Desk Cube';");
    assert.equal(values.get('DS'), 'Desk Cube');
  });

  test('whitespace around the assignment is tolerated', () => {
    const { values } = parseSettings('d.Sf.CA.value = 42 ;');
    assert.equal(values.get('CA'), '42');
  });

  test('an unrecognised page yields nothing rather than guessing', () => {
    // setDeviceName refuses to POST when DS is absent. That refusal is the
    // safety property; this asserts the parser reports absence honestly.
    const { values, checks } = parseSettings('<html><body>Not implemented</body></html>');
    assert.equal(values.size, 0);
    assert.equal(checks.size, 0);
    assert.equal(values.has('DS'), false);
  });

  test('empty input does not throw', () => {
    const { values } = parseSettings('');
    assert.equal(values.size, 0);
  });
});
