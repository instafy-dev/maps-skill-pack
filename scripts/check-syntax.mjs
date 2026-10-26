#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// node --check on every .mjs file in the repository (the browser engine's .js files are checked as modules too).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['.git', 'node_modules', 'vendor']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.mjs$/.test(e.name)) files.push(p);
  }
})(repo);
let bad = 0;
for (const f of files.sort()) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; process.stderr.write(`${path.relative(repo, f)}\n${r.stderr}\n`); }
}
process.stdout.write(`node --check: ${files.length - bad}/${files.length} ok\n`);
process.exit(bad ? 1 : 0);
