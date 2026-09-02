/**
 * Finds WLED devices on the LAN over mDNS.
 *
 * Typing an IP address into a config file is a bad first five minutes, and it
 * is the step most likely to go wrong: the cube gets a new lease and the app
 * stops working for a reason that looks nothing like DHCP. WLED advertises
 * itself as `_wled._tcp.local`, so we can just ask.
 *
 * Written against node:dgram rather than a library, because the whole project
 * has no runtime dependencies and one PTR query is not worth breaking that
 * for. What follows is a deliberately partial DNS implementation: enough to
 * ask one question and read PTR, SRV, A and TXT out of the answer, and
 * nothing else.
 *
 * We set the QU bit (unicast-response) on the question so replies come back to
 * our ephemeral source port. Binding 5353 directly would fight mDNSResponder
 * on macOS and systemd-resolved on Linux, and needs privileges we should not
 * be asking for. Some responders ignore QU and answer by multicast anyway;
 * those we simply miss, which is why a manually configured host always wins
 * over anything found here.
 */

import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_wled._tcp.local';

const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 };

/** Encodes a dotted name as length-prefixed labels. */
function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const out = [];
  for (const label of parts) {
    const b = Buffer.from(label, 'utf8');
    out.push(Buffer.from([b.length]), b);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

/**
 * Reads a name at `off`, following compression pointers.
 *
 * Returns the name and the offset just past the name AS WRITTEN AT `off` -
 * which for a pointer is 2 bytes, not the length of what it expands to. Record
 * walking depends on that distinction.
 */
function decodeName(buf, off) {
  const labels = [];
  let jumped = false;
  let next = off;
  let guard = 0;

  while (off < buf.length) {
    if (guard++ > 128) break;              // malformed / pointer loop
    const len = buf[off];
    if (len === 0) { off++; if (!jumped) next = off; break; }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) next = off + 2;
      jumped = true;
      off = ptr;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
    if (!jumped) next = off;
  }
  return [labels.join('.'), next];
}

/**
 * Parses a response into a flat record list. Returns [] on anything malformed.
 *
 * Exported for tests, which run it against a real captured response from a
 * HyperCube Nano rather than one we built ourselves. A hand-made fixture would
 * only prove the encoder and decoder agree with each other.
 */
export function parseRecords(buf) {
  try {
    if (buf.length < 12) return [];
    const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
    let off = 12;

    for (let i = 0; i < counts[0]; i++) {      // questions
      [, off] = decodeName(buf, off);
      off += 4;
    }

    const out = [];
    const total = counts[1] + counts[2] + counts[3];
    for (let i = 0; i < total && off + 10 <= buf.length; i++) {
      let name;
      [name, off] = decodeName(buf, off);
      const type = buf.readUInt16BE(off);
      const rdlen = buf.readUInt16BE(off + 8);
      const rdata = off + 10;
      if (rdata + rdlen > buf.length) break;

      if (type === TYPE.PTR) {
        out.push({ type: 'PTR', name, value: decodeName(buf, rdata)[0] });
      } else if (type === TYPE.SRV) {
        out.push({
          type: 'SRV', name,
          port: buf.readUInt16BE(rdata + 4),
          target: decodeName(buf, rdata + 6)[0],
        });
      } else if (type === TYPE.A && rdlen === 4) {
        out.push({ type: 'A', name, address: Array.from(buf.subarray(rdata, rdata + 4)).join('.') });
      } else if (type === TYPE.TXT) {
        const txt = [];
        let p = rdata;
        while (p < rdata + rdlen) { const l = buf[p]; txt.push(buf.toString('utf8', p + 1, p + 1 + l)); p += 1 + l; }
        out.push({ type: 'TXT', name, txt });
      }
      off = rdata + rdlen;
    }
    return out;
  } catch {
    return [];                                // a bad packet is not our problem
  }
}

/** One standard query, QU bit set so the answer comes back to us directly. */
function query(name, type) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);                 // QDCOUNT
  return Buffer.concat([
    header,
    encodeName(name),
    Buffer.from([0, type, 0x80, 0x01]),       // QTYPE, QCLASS with QU bit
  ]);
}

const toInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) >>> 0) + (Number(o) & 255), 0) >>> 0;

/**
 * Whether an interface entry is a host, rather than one of the two addresses
 * in a subnet that name the subnet itself: host bits all zero (the network)
 * or all one (broadcast). An idle macOS Internet Sharing bridge reports its
 * network address (…194.0) as if it were its own; binding to it works and
 * nothing ever arrives, so offered to a phone it is a dead QR. A /31 or /32,
 * which is what a VPN tunnel usually has, has no such addresses and is
 * always a host. Exported for the tests; the OS hands us the entries.
 */
export function isHostAddress({ address, netmask }) {
  if (!address || !netmask) return Boolean(address);
  const ip = toInt(address), mask = toInt(netmask);
  const hostMask = (~mask) >>> 0;
  if (hostMask <= 1) return true;
  const host = (ip & hostMask) >>> 0;
  return host !== 0 && host !== hostMask;
}

/**
 * Every non-internal IPv4 host address this machine has, so a multi-homed
 * machine still finds things. Exported because the server needs the same list
 * for the opposite direction: which addresses a phone may use to reach it.
 */
export function localAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isHostAddress(a)) out.push(a.address);
    }
  }
  return out;
}

/**
 * Asks each found device what it calls itself.
 *
 * mDNS gives us `hs-a1b2c3`, derived from the MAC. The name the owner actually
 * chose lives in /json/info, and picking between two cubes by MAC fragment is
 * no better than picking between two IP addresses. Failures are silent and
 * leave the mDNS name in place, because a device we cannot reach over HTTP is
 * still worth showing: it tells you the thing is powered on.
 */
async function enrich(devices) {
  return Promise.all(devices.map(async (d) => {
    try {
      const r = await fetch(`http://${d.host}/json/info`, { signal: AbortSignal.timeout(1500) });
      const info = await r.json();
      return {
        ...d,
        name: info.name || d.name,
        mdns: d.name,
        product: [info.brand, info.product].filter(Boolean).join(' ') || null,
        version: info.ver ?? null,
        leds: info.leds?.count ?? null,
      };
    } catch {
      return { ...d, mdns: d.name, product: null, version: null, leds: null };
    }
  }));
}

/**
 * Looks for WLED devices for `timeout` ms.
 *
 * Resolves to `[{ name, host, port, mdns, product, version, leds }]`,
 * best-effort and possibly empty. Never rejects: discovery failing is a normal
 * outcome on a locked-down network, and a caller that has a configured host
 * does not care why.
 */
export async function discover({ timeout = 2000, describe = true } = {}) {
  const found = await sweepForDevices(timeout);
  return describe ? enrich(found) : found;
}

function sweepForDevices(timeout) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const ptr = new Map();                    // instance -> {}
    const srv = new Map();                    // instance -> { target, port }
    const a = new Map();                      // hostname -> address
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }

      const found = [];
      for (const instance of ptr.keys()) {
        const s = srv.get(instance);
        // An instance we never got an SRV for is not addressable, so it is not
        // a result. Reporting a name with no address just moves the confusion.
        if (!s) continue;
        const host = a.get(s.target);
        if (!host) continue;
        found.push({
          // '_wled._tcp.local' is noise on screen; the leading label is the
          // device, which is what someone is choosing between.
          name: instance.replace(/\.\_wled\._tcp\.local$/, '').replace(/\.local$/, ''),
          host,
          port: s.port,
        });
      }
      found.sort((x, y) => x.name.localeCompare(y.name));
      resolve(found);
    };

    const timer = setTimeout(finish, timeout);

    sock.on('error', finish);                 // no network, no results
    sock.on('message', (msg) => {
      for (const r of parseRecords(msg)) {
        if (r.type === 'PTR' && r.name === SERVICE) ptr.set(r.value, true);
        else if (r.type === 'SRV') srv.set(r.name, { target: r.target, port: r.port });
        else if (r.type === 'A') a.set(r.name, r.address);
      }
    });

    /**
     * Sends one query, optionally pinned to an interface.
     *
     * Awaiting the send callback is not optional. setMulticastInterface takes
     * effect immediately but send() queues, so a plain for-loop retargets the
     * socket before any of its own packets have flushed and every one of them
     * leaves via the last interface set. That failed silently: five sends all
     * reported success, and every one went out a bridge the cube is not on.
     */
    const sendOnce = (nic) => new Promise((res) => {
      try { if (nic) sock.setMulticastInterface(nic); } catch { /* not multicast-capable */ }
      try { sock.send(query(SERVICE, TYPE.PTR), MDNS_PORT, MDNS_ADDR, () => res()); }
      catch { res(); }
    });

    const sweep = async () => {
      // Default route first: it is the common case, and it needs no juggling.
      await sendOnce(null);
      // Then each interface explicitly. On a laptop with Wi-Fi, a VPN and a
      // few Docker bridges up, the default route is regularly not the one the
      // cube is on.
      for (const nic of localAddresses()) {
        if (done) return;
        await sendOnce(nic);
      }
    };

    sock.bind(0, async () => {
      try {
        sock.setMulticastTTL(255);
        await sweep();
        // Once more shortly after: mDNS is UDP, and the first packet is the
        // one most likely to be dropped while an interface is still settling.
        setTimeout(() => { if (!done) sweep(); }, 300);
      } catch {
        finish();
      }
    });
  });
}
