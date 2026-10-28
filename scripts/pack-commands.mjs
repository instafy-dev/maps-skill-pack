// SPDX-License-Identifier: AGPL-3.0-only
// The pack's commands for .instafy-pack.json, and the rules a runtime checks them by.
//
// `bin` names the commands a runtime puts on PATH: `uw` runs scripts/uw.mjs with node, in every shell.
// `activity` gives each `uw` subcommand a short, fixed label for the chat's activity line ("Looking up places…",
// then "looked up 14 places"). Labels are plain words written here, never text from a command's output or a page;
// the only value a runtime fills in is a count ({n}). A runtime that does not know `bin` or `activity` ignores them.
import fs from 'node:fs';
import path from 'node:path';

export const BIN = { uw: 'scripts/uw.mjs' };

const forms = (one, other, some) => ({ one, other, some });
// A quiet step shows only while it runs and in the step list; its `done` is that list's past tense for a finished row.
const quiet = { live: 'Working on the map', done: 'worked on the map', role: 'quiet' };
const same = (names, label) => Object.fromEntries(names.map((name) => [name, label]));

export const ACTIVITY = {
  uw: {
    'add-point': { live: 'Looking up places', done: forms('looked up a place', 'looked up {n} places', 'looked up places') },
    cite: { live: 'Reading a source', done: forms('read a source', 'read {n} sources', 'read sources') },
    places: { live: 'Finding places nearby', done: 'found places nearby' },
    ...same(['enrich', 'route', 'legs', 'isochrone'], { live: 'Working out walks and routes', done: 'worked out walks and routes' }),
    ...same(['lines', 'station', 'transit'], { live: 'Looking up transit', done: 'looked up transit' }),
    stay: { live: 'Finding places to stay', done: 'found places to stay' },
    handoff: { live: 'Reading the research notes', done: 'read the research notes' },
    plan: { live: 'Planning the days', done: 'planned the days' },
    ...same(['feel', 'areas'], { live: 'Judging calm and lively areas', done: 'judged calm and lively areas' }),
    ...same(['air', 'wiki', 'doorstep', 'photos', 'adapter'], { live: 'Adding details', done: 'added details' }),
    question: { live: 'Weighing the options', done: 'weighed the options' },
    validate: { live: 'Checking the map', done: 'built the map', role: 'outcome', when: 'success' },
    ...same(['new', 'geocode', 'fit', 'set', 'snapshot', 'host', 'serve', 'reload', 'upgrade', 'lookups', 'wait', 'doctor', '*'], quiet),
  },
};

// The limits a runtime applies (Instafy: skill_packs.rs and scripts/install-skill-packs.mjs).
export const MAX_BINS = 8;
export const MAX_SUBCOMMANDS = 64;
const BIN_NAME = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED = new Set(['instafy', 'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'git', 'sh', 'bash', 'zsh',
  'dash', 'env', 'python', 'python3', 'pip', 'codex', 'runtime-agent', 'curl', 'wget', 'sudo', 'make']);
const PLAIN_PATH = /^[A-Za-z0-9._/-]+$/;
const SUBCOMMAND = /^(\*|[a-z][a-z0-9-]{0,31})$/;
// control characters, bidi controls, links, mentions and markup never appear in a label
const FORBIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]|:\/\/|www\.|[@<>[\]{}]/iu;

/** The problems with `bin` for the pack folder `root`: a list of messages, empty when it checks out. */
export function binProblems(bin, root) {
  const problems = [];
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return ['bin must map command names to files in the pack'];
  const entries = Object.entries(bin);
  if (entries.length > MAX_BINS) problems.push(`bin lists ${entries.length} commands, over ${MAX_BINS}`);
  for (const [name, entry] of entries) {
    if (!BIN_NAME.test(name) || RESERVED.has(name)) problems.push(`bin ${JSON.stringify(name)} is not a plain, unreserved command name`);
    const inside = typeof entry === 'string' && PLAIN_PATH.test(entry) && entry.split('/').every((s) => s && s !== '.' && s !== '..');
    let file = false;
    try { file = inside && fs.lstatSync(path.join(root, entry)).isFile(); } catch { file = false; }
    if (!file) problems.push(`bin ${JSON.stringify(name)} runs ${JSON.stringify(entry)}, which is not a file inside the pack`);
  }
  return problems;
}

function labelProblems(text, where, { first, placeholder }) {
  const problems = [];
  if (typeof text !== 'string' || !text) return [`${where} must be text`];
  if (first === 'upper' && !/^\p{Lu}/u.test(text)) problems.push(`${where} must start with an upper-case letter`);
  if (first === 'lower' && !/^\p{Ll}/u.test(text)) problems.push(`${where} must start with a lower-case letter`);
  const filled = text.replaceAll('{n}', '999');
  if (text.includes('{n}') && !placeholder) problems.push(`${where} may not hold {n}`);
  if (placeholder && !text.includes('{n}')) problems.push(`${where} needs {n}`);
  if (FORBIDDEN.test(filled)) problems.push(`${where} holds a link, a mention, markup, a brace or a control character`);
  const max = first === 'upper' ? 40 : 48;
  if ([...filled].length > max) problems.push(`${where} is over ${max} characters`);
  return problems;
}

/** The problems with `activity` given the declared `bin`: a list of messages, empty when it checks out. */
export function activityProblems(activity, bin) {
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return ['activity must map commands to subcommand labels'];
  const problems = [];
  for (const [command, table] of Object.entries(activity)) {
    if (!Object.hasOwn(bin || {}, command)) problems.push(`activity.${command}: not a command in bin`);
    if (!table || typeof table !== 'object' || Array.isArray(table)) { problems.push(`activity.${command} must map subcommands to labels`); continue; }
    const subs = Object.entries(table);
    if (subs.length > MAX_SUBCOMMANDS) problems.push(`activity.${command} has ${subs.length} subcommands, over ${MAX_SUBCOMMANDS}`);
    for (const [sub, label] of subs) {
      const where = `activity.${command}.${sub}`;
      if (!SUBCOMMAND.test(sub)) problems.push(`${where}: not a subcommand name`);
      if (!label || typeof label !== 'object') { problems.push(`${where} must be an object`); continue; }
      const known = new Set(['live', 'done', 'role', 'when']);
      for (const key of Object.keys(label)) if (!known.has(key)) problems.push(`${where}.${key}: unknown key`);
      problems.push(...labelProblems(label.live, `${where}.live`, { first: 'upper' }));
      const role = label.role ?? 'content';
      if (!['content', 'outcome', 'quiet'].includes(role)) problems.push(`${where}.role must be content, outcome or quiet`);
      if (label.when !== undefined && label.when !== 'success') problems.push(`${where}.when may only be "success"`);
      const done = label.done;
      if (done === undefined) {
        if (role !== 'quiet') problems.push(`${where}.done is required unless the step is quiet`);
      } else if (typeof done === 'string') {
        problems.push(...labelProblems(done, `${where}.done`, { first: 'lower' }));
      } else if (done && typeof done === 'object' && !Array.isArray(done)) {
        for (const key of Object.keys(done)) if (!['one', 'other', 'some'].includes(key)) problems.push(`${where}.done.${key}: unknown form`);
        if (done.one === undefined) problems.push(`${where}.done.one is required`);
        else problems.push(...labelProblems(done.one, `${where}.done.one`, { first: 'lower' }));
        if (done.other !== undefined) {
          problems.push(...labelProblems(done.other, `${where}.done.other`, { first: 'lower', placeholder: true }));
          if (done.some === undefined) problems.push(`${where}.done.some is required with done.other`);
        }
        if (done.some !== undefined) problems.push(...labelProblems(done.some, `${where}.done.some`, { first: 'lower' }));
      } else problems.push(`${where}.done must be text or {one, other, some}`);
    }
  }
  return problems;
}
