// Which Host `uw host` and `uw serve` answer for (__uw/* and the site's files alike). A web page the user visits can
// point its own name at 127.0.0.1 (DNS rebinding): the browser then sends Host and Origin "evil.test:4173", which match
// each other, so an Origin == Host check alone lets any site queue handlers, read job events, or read the site's files
// (data/records/*.json, handlers/, bound.json) same-origin. A rebinding name is always a domain the attacker controls,
// so the server answers only for:
//   - this computer: localhost, *.localhost, 127.0.0.0/8, ::1
//   - an IP literal (a phone on the same Wi-Fi with --host 0.0.0.0): DNS rebinding cannot produce one
//   - a URL given with --public-url / UW_PUBLIC_URL (comma-separated), e.g. a third-party tunnel
//   - an Instafy tunnel or private preview of this port (`instafy tunnel start` / `instafy preview open` record them
//     in ~/.instafy/cli-tunnel-state.json and cli-preview-state.json). A preview host is p-<label>--<preview id>.<domain>:
//     the preview id is not a secret (every viewer's frame address carries it), so the domain is pinned too, to the
//     hostSuffix the CLI recorded for that preview. A preview entry without one is never accepted.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

/** "Example.test:4173" → { hostname: "example.test", port: 4173 }; "[::1]:80" → { hostname: "::1", port: 80 } */
export function splitHost(h) {
  const s = String(h || '').trim().toLowerCase();
  if (!s) return null;
  let m = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(s);
  if (m) return { hostname: m[1], port: m[2] ? Number(m[2]) : null };
  m = /^([^:[\]]+)(?::(\d+))?$/.exec(s);
  return m ? { hostname: m[1].replace(/\.$/, ''), port: m[2] ? Number(m[2]) : null } : null;
}

export function isLocalHostname(hn) {
  if (!hn) return false;
  if (hn === 'localhost' || hn.endsWith('.localhost')) return true;
  // any IP literal: loopback, or the LAN address a phone on the same Wi-Fi uses
  return net.isIP(hn) !== 0;
}

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const hostnameOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };

const PREVIEW_HOST = /^p-[a-z2-7]{26}--([0-9a-f]{32})\.(.+)$/;

/** hostnames of Instafy tunnels to this port, and for each private preview of it (by id) the host suffixes it is viewed under */
export function instafyForwards(port, home = os.homedir()) {
  const dir = path.join(home, '.instafy');
  const hosts = new Set(), previews = new Map();
  for (const t of readJSON(path.join(dir, 'cli-tunnel-state.json'))?.tunnels || []) {
    if (!t || t.localPort !== port) continue;
    if (typeof t.hostname === 'string') hosts.add(t.hostname.toLowerCase());
    const u = hostnameOf(t.url); if (u) hosts.add(u);
  }
  for (const p of readJSON(path.join(dir, 'cli-preview-state.json'))?.previews || []) {
    if (!p || p.localPort !== port || typeof p.previewId !== 'string' || typeof p.hostSuffix !== 'string') continue;
    const suffix = p.hostSuffix.trim().toLowerCase().replace(/^\.+/, '');
    if (!suffix) continue;
    const id = p.previewId.replace(/-/g, '').toLowerCase();
    if (!previews.has(id)) previews.set(id, new Set());
    previews.get(id).add(suffix);
  }
  return { hosts, previews };
}

/** the hostnames given with --public-url and UW_PUBLIC_URL */
export function publicHostnames(urls = [], env = process.env) {
  const all = [...urls, ...String(env.UW_PUBLIC_URL || '').split(',')].map((s) => String(s).trim()).filter(Boolean);
  return all.map((u) => hostnameOf(/^[a-z]+:\/\//i.test(u) ? u : 'http://' + u)).filter(Boolean);
}

/** null when a request with this Host header may use __uw/*, else why not */
export function hostRefusal(hostHeader, { port, publicHosts = [], home } = {}) {
  const h = splitHost(hostHeader);
  if (!h) return 'missing Host header';
  if (isLocalHostname(h.hostname) || publicHosts.includes(h.hostname)) return null;
  const fw = instafyForwards(port, home);
  if (fw.hosts.has(h.hostname)) return null;
  // the exact capability host shape on the recorded preview domain (and port): p-<26 base32>--<id>.<hostSuffix>
  const pv = PREVIEW_HOST.exec(h.port ? `${h.hostname}:${h.port}` : h.hostname);
  if (pv && fw.previews.get(pv[1])?.has(pv[2])) return null;
  return `host "${h.hostname}" is not this computer, a LAN address or a known tunnel/preview of port ${port} (add it with --public-url)`;
}

/** an Origin header (when the browser sent one) must be the page this Host serves */
export function originRefusal(origin, hostHeader) {
  if (!origin) return null;
  const own = [`http://${hostHeader}`, `https://${hostHeader}`].map((s) => s.toLowerCase());
  return own.includes(String(origin).toLowerCase()) ? null : 'cross-origin requests are not accepted';
}
