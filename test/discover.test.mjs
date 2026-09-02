/**
 * mDNS response parsing.
 *
 * The fixture is a real 127-byte answer captured off a HyperCube Nano on the
 * bench, not something built with our own encoder - which would only prove the
 * encoder and parser agree with each other. It exercises the two things most
 * likely to break: name compression pointers (this packet has four, one of
 * which points into the middle of another record's rdata) and record walking
 * across the additional section.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecords, isHostAddress } from '../src/discover.mjs';

/*
 * A real answer to a PTR query for _wled._tcp.local, with the device identity
 * replaced byte for byte: the MAC becomes aa:bb:cc:dd:ee:ff and the address
 * becomes the documented 192.168.1.50 placeholder. Each substitution is the
 * same length as what it replaces, so every compression pointer still lands
 * exactly where it did on the wire, which is the part under test. Nobody's MAC
 * or LAN address belongs in a public repository.
 */
const REAL = Buffer.from(
  '000084000000000300000001055f776c6564045f746370056c6f63616c00000c0001000011' +
  '94000c0968732d646465656666c00cc028002100010000007800120000000000500968732d' +
  '646465656666c017c02800100001000011940011106d61633d616162626363646465656666' +
  'c04600010001000000780004c0a80132',
  'hex',
);

describe('parseRecords', () => {
  const records = parseRecords(REAL);

  test('reads every record in the packet', () => {
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((r) => r.type), ['PTR', 'SRV', 'TXT', 'A']);
  });

  test('PTR names the service instance', () => {
    const ptr = records.find((r) => r.type === 'PTR');
    assert.equal(ptr.name, '_wled._tcp.local');
    assert.equal(ptr.value, 'hs-ddeeff._wled._tcp.local');
  });

  test('SRV resolves target and port through a compression pointer', () => {
    const srv = records.find((r) => r.type === 'SRV');
    assert.equal(srv.name, 'hs-ddeeff._wled._tcp.local');
    assert.equal(srv.target, 'hs-ddeeff.local');
    assert.equal(srv.port, 80);
  });

  test('A record carries the address, pointer into rdata resolved', () => {
    const a = records.find((r) => r.type === 'A');
    // c046 points at a label sequence that begins inside the SRV rdata. Getting
    // this wrong yields an unaddressable device rather than a visible error.
    assert.equal(a.name, 'hs-ddeeff.local');
    assert.equal(a.address, '192.168.1.50');
  });

  test('TXT is decoded as length-prefixed strings', () => {
    const txt = records.find((r) => r.type === 'TXT');
    assert.deepEqual(txt.txt, ['mac=aabbccddeeff']);
  });

  test('the SRV target resolves against the A record', () => {
    // This is the join discover() actually performs; if these two names ever
    // disagree the device is found and then silently dropped.
    const srv = records.find((r) => r.type === 'SRV');
    const a = records.find((r) => r.type === 'A');
    assert.equal(srv.target, a.name);
  });
});

describe('parseRecords rejects junk without throwing', () => {
  for (const [label, buf] of [
    ['empty', Buffer.alloc(0)],
    ['header only', Buffer.alloc(12)],
    ['truncated mid-name', REAL.subarray(0, 20)],
    ['truncated mid-rdata', REAL.subarray(0, 50)],
    ['counts lie about content', Buffer.concat([Buffer.from('0000840000000900000000', 'hex'), Buffer.alloc(4)])],
    ['random bytes', Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) & 255))],
  ]) {
    test(label, () => {
      // A malformed datagram on 5353 is somebody else's problem, not a crash:
      // this socket receives whatever the network sends it.
      const out = parseRecords(buf);
      assert.ok(Array.isArray(out), 'must always return an array');
    });
  }

  test('a pointer loop terminates', () => {
    // 0xC00C at offset 12 points at itself. Without the guard this spins.
    const loop = Buffer.concat([
      Buffer.from('000084000000000100000000', 'hex'),
      Buffer.from('c00c', 'hex'),
      Buffer.from('000c00010000000000020000', 'hex'),
    ]);
    assert.ok(Array.isArray(parseRecords(loop)));
  });
});

describe('isHostAddress', () => {
  test('an ordinary host on a /24 is a host', () => {
    assert.equal(isHostAddress({ address: '192.168.1.20', netmask: '255.255.255.0' }), true);
  });
  test('the network address of a /24 is not (an idle Internet Sharing bridge reports one)', () => {
    assert.equal(isHostAddress({ address: '192.168.194.0', netmask: '255.255.255.0' }), false);
  });
  test('the broadcast address of a /24 is not', () => {
    assert.equal(isHostAddress({ address: '192.168.1.255', netmask: '255.255.255.0' }), false);
  });
  test('a /32 tunnel address is a host even though its host bits are zero', () => {
    assert.equal(isHostAddress({ address: '10.8.0.2', netmask: '255.255.255.255' }), true);
  });
  test('a /31 point-to-point address is a host', () => {
    assert.equal(isHostAddress({ address: '10.0.0.0', netmask: '255.255.255.254' }), true);
  });
  test('no netmask means nothing to judge by, so it passes', () => {
    assert.equal(isHostAddress({ address: '192.168.1.20' }), true);
  });
});
