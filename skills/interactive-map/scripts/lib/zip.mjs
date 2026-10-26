// Minimal zip reader: central directory + stored/deflate entries (zlib.inflateRawSync). Enough for data.gov.tw zips.
// No zip64, no encryption. Entry names are decoded as UTF-8 (flag bit 11) or, failing that, latin1.
import zlib from 'node:zlib';

export function listZip(buf) {
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('zip64 archives are not supported');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central directory entry at ${off}`);
    const flags = buf.readUInt16LE(off + 8), method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const raw = buf.subarray(off + 46, off + 46 + nlen);
    const name = flags & 0x800 ? raw.toString('utf8') : (() => { const s = raw.toString('utf8'); return s.includes('�') ? raw.toString('latin1') : s; })();
    entries.push({ name, method, csize, usize, local, flags });
    off += 46 + nlen + xlen + clen;
  }
  return entries;
}

export function readZipEntry(buf, entry) {
  const o = entry.local;
  if (buf.readUInt32LE(o) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  if (entry.flags & 1) throw new Error(`${entry.name} is encrypted`);
  const nlen = buf.readUInt16LE(o + 26), xlen = buf.readUInt16LE(o + 28);
  const start = o + 30 + nlen + xlen;
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.usize, 1) + 1024 });
  throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

// Read one file by exact name or by a predicate/regex on the name.
export function unzipOne(buf, match) {
  const entries = listZip(buf);
  const test = typeof match === 'function' ? match : match instanceof RegExp ? (n) => match.test(n) : (n) => n === match;
  const e = entries.find((x) => test(x.name));
  if (!e) throw new Error(`zip has no entry matching ${match} (entries: ${entries.map((x) => x.name).join(', ')})`);
  return { name: e.name, data: readZipEntry(buf, e) };
}
