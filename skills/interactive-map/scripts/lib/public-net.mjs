// Public-address guard for the pack's own page reads (`uw cite`, `uw handoff`'s source check): only public http(s)
// hosts, checked before the request, on every redirect hop and again at connect time (DNS rebinding). Loopback,
// private, link-local (cloud metadata), CGNAT and LAN addresses are refused unless UW_ALLOW_LOCAL=1 (tests, a local
// mirror). The same rules as instafy-bind's src/net.mjs, which this copies; keep the two in step.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const allowLocalFromEnv = () => process.env.UW_ALLOW_LOCAL === '1';

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isPrivateV4(ip) {
  const value = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function expandV6(ip) {
  let address = ip.toLowerCase().replace(/%.*$/, "");
  let tail = [];
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    tail = [(n >>> 16).toString(16), (n & 0xffff).toString(16)];
    address = address.slice(0, -v4[1].length).replace(/:$/, "") || ":";
    if (address === ":") address = "::";
  }
  const [head, rest] = address.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = rest !== undefined ? (rest ? rest.split(":").filter(Boolean) : []) : null;
  const known = left.length + (right ? right.length : 0) + tail.length;
  const middle = right === null ? [] : Array(Math.max(0, 8 - known)).fill("0");
  return [...left, ...middle, ...(right || []), ...tail].map((h) => parseInt(h, 16) || 0);
}

function isPrivateV6(ip) {
  const g = expandV6(ip);
  if (g.length !== 8) return true;
  const allZeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(8)) return true; // ::
  if (allZeroUpTo(7) && g[7] === 1) return true; // ::1
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (allZeroUpTo(5) && g[5] === 0xffff) return isPrivateV4(embedded()); // ::ffff:a.b.c.d
  if (allZeroUpTo(6)) return true; // ::a.b.c.d (deprecated compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embedded()); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // 2001::/32 Teredo (tunnels to arbitrary IPv4)
  if (g[0] === 0x2002) return isPrivateV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 2002::/16 6to4
  return false;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and documentation addresses. */
export function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true;
}

const LOCAL_NAME_RE = /(^|\.)(localhost|local|internal|lan|home|intranet|localdomain)$/i;

/**
 * Check that a URL points at a public http(s) host. Resolves DNS names.
 * Returns {ok: true, addresses} or {ok: false, reason}.
 */
export async function checkPublicUrl(raw, { allowLocal = false, lookup = dns.promises.lookup } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "only http(s) URLs are allowed" };
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not allowed" };
  if (allowLocal) return { ok: true, addresses: [] };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    return isPrivateAddress(host) ? { ok: false, reason: `${host} is a private or local address` } : { ok: true, addresses: [host] };
  }
  if (LOCAL_NAME_RE.test(host) || !host.includes(".")) return { ok: false, reason: `${host} is a local host name` };
  let addresses;
  try {
    addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  } catch (error) {
    return { ok: false, reason: `${host} does not resolve (${error.code || error.message})` };
  }
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) return { ok: false, reason: `${host} resolves to a private address` };
  return { ok: true, addresses };
}

/** A dns.lookup wrapper that refuses private addresses at connect time (covers DNS rebinding). */
export function guardedLookup(allowLocal) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      if (!allowLocal) {
        const blocked = list.find((entry) => isPrivateAddress(entry.address));
        if (blocked) {
          const refusal = new Error(`refusing to connect to private address for ${hostname}`);
          refusal.code = "EPRIVATE";
          return callback(refusal);
        }
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}


/**
 * GET one public URL, never following redirects (callers check each hop and call again). Resolves
 * { status, location, type, text, url }. Throws { code: 'policy' } for a refused address.
 */
export async function publicGet(raw, { headers = {}, maxBytes = 2_000_000, timeoutMs = 20000, allowLocal = allowLocalFromEnv() } = {}) {
  const check = await checkPublicUrl(raw, { allowLocal });
  if (!check.ok) throw Object.assign(new Error(`blocked: ${check.reason}`), { code: 'policy' });
  const url = new URL(raw);
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const request = lib.request(url, {
      method: 'GET',
      headers,
      lookup: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : guardedLookup(allowLocal),
      timeout: timeoutMs,
      maxHeaderSize: 128 * 1024,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (size >= maxBytes) return;
        size += chunk.length;
        chunks.push(chunk);
        if (size >= maxBytes) res.destroy();
      });
      const done = () => resolve({
        status: res.statusCode, location: res.headers.location || null, type: String(res.headers['content-type'] || ''),
        text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), url: url.toString(),
      });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('request timed out'), { name: 'AbortError' })));
    request.on('error', (error) => reject(error.code === 'EPRIVATE' ? Object.assign(error, { code: 'policy' }) : error));
    request.end();
  });
}
