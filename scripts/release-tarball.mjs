#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Builds the release tarball for a tag: `git archive` of skills/interactive-map at that tag, gzip -9 with no name
// or timestamp in the gzip header. git writes the tagged commit id as the tar's pax global header comment, and
// every entry's mtime is the commit time, so the tar is reproducible from the tag. Entries are under
// skills/interactive-map/. Prints the file name and its sha256, and checks that the tagged manifest's tree_sha256
// matches the archived content.
//   node scripts/release-tarball.mjs v0.1.0 [out-dir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) { process.stderr.write('usage: release-tarball.mjs vX.Y.Z [out-dir]\n'); process.exit(2); }
const outDir = path.resolve(process.argv[3] || path.join(repo, 'dist'));
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 64 * 1024 * 1024 });

const commit = git('rev-parse', `${tag}^{commit}`).toString().trim();
const tar = git('archive', '--format=tar', commit, 'skills/interactive-map');
// Content check against the tagged manifest, straight from git objects.
const manifest = JSON.parse(git('show', `${commit}:skills/interactive-map/.instafy-pack.json`).toString());
const listing = git('ls-tree', '-r', '-z', '--full-tree', commit, 'skills/interactive-map/').toString().split('\0').filter(Boolean);
const prefix = 'skills/interactive-map/';
const entries = listing.map((l) => { const [meta, p] = l.split('\t'); const [mode, , sha] = meta.split(' '); return { mode, sha, rel: p.slice(prefix.length) }; })
  .filter((e) => e.rel !== '.instafy-pack.json')
  .sort((a, b) => Buffer.compare(Buffer.from(a.rel), Buffer.from(b.rel)));
const h = createHash('sha256');
for (const e of entries) {
  if (e.mode === '120000') throw new Error(`symlink in pack: ${e.rel}`);
  h.update(e.rel).update('\0').update(git('cat-file', 'blob', e.sha)).update('\0');
}
const tree = h.digest('hex');
if (tree !== manifest.tree_sha256) throw new Error(`tree_sha256 mismatch: manifest ${manifest.tree_sha256}, archive ${tree}`);
if (`v${manifest.version}` !== tag) throw new Error(`manifest version ${manifest.version} does not match tag ${tag}`);

const gz = zlib.gzipSync(tar, { level: 9 });
fs.mkdirSync(outDir, { recursive: true });
const name = `interactive-map-${tag}.tar.gz`;
fs.writeFileSync(path.join(outDir, name), gz);
const sha = createHash('sha256').update(gz).digest('hex');
fs.writeFileSync(path.join(outDir, `${name}.sha256`), `${sha}  ${name}\n`);
process.stdout.write(`${name}\nsha256 ${sha}\ncommit ${commit}\ntree_sha256 ${tree}\n`);
