#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Writes (or with --check, verifies) skills/interactive-map/.instafy-pack.json.
//
// tree_sha256 is the sha256 over every file in the pack root except the manifest itself, in sorted path order
// (byte order of the "/"-separated relative path), each fed as: path, NUL, file bytes, NUL. Symlinks are refused.
// It identifies the pack's content independently of how a tarball was compressed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'skills', 'interactive-map');
const MANIFEST = '.instafy-pack.json';
const MAX_FILES = 256;
const MAX_BYTES = 8 * 1024 * 1024;

function fail(msg) {
  process.stderr.write(`manifest: ${msg}\n`);
  process.exit(1);
}

export function listFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.DS_Store') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) fail(`refusing symlink in the pack: ${r}`);
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile() && r !== MANIFEST) out.push(r);
  }
  return out.sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0));
}

export function treeDigest(dir) {
  const files = listFiles(dir);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    const data = fs.readFileSync(path.join(dir, rel));
    bytes += data.length;
    hash.update(rel).update('\0').update(data).update('\0');
  }
  return { files: files.length, bytes, tree_sha256: hash.digest('hex') };
}

function frontMatter(skillMd, key) {
  const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const line = m && m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : null;
}

function build() {
  const skillMd = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const name = frontMatter(skillMd, 'name');
  if (name !== 'interactive-map') fail(`SKILL.md name is ${JSON.stringify(name)}, expected "interactive-map"`);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const tree = treeDigest(root);
  if (tree.files > MAX_FILES) fail(`${tree.files} files, over the ${MAX_FILES}-file limit`);
  if (tree.bytes > MAX_BYTES) fail(`${tree.bytes} bytes, over the ${MAX_BYTES}-byte limit`);
  return {
    schema: 1,
    name,
    version: pkg.version,
    description: pkg.description,
    license: 'AGPL-3.0-only',
    homepage: 'https://github.com/instafy-dev/maps-skill-pack',
    engines: { node: '>=22' },
    skills: ['SKILL.md'],
    entry: 'scripts/uw.mjs',
    ...tree,
  };
}

const want = `${JSON.stringify(build(), null, 2)}\n`;
const file = path.join(root, MANIFEST);
if (process.argv.includes('--check')) {
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (have !== want) fail(`${path.relative(repo, file)} is stale; run: node scripts/manifest.mjs`);
  process.stdout.write(`manifest up to date\n`);
} else {
  fs.writeFileSync(file, want);
  process.stdout.write(want);
}
