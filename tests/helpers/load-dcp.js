/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

/**
 * Loads the browser data + engine scripts with a fresh, fake `window` object and
 * returns the populated `window.DCP` namespace. The app is written as classic
 * scripts (so it runs from file://), so this mirrors the <script> order used
 * in index.html without needing a DOM.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS = [
  'src/data/components.js',
  'src/data/workloads.js',
  'src/data/missions.js',
  'src/core/engine.js',
];

function loadDCP() {
  // Run in this realm (not node:vm) so arrays/objects compare cleanly with assert.
  const window = {};
  for (const rel of SCRIPTS) {
    const file = path.join(ROOT, rel);
    const src = `${fs.readFileSync(file, 'utf8')}\n//# sourceURL=${file}`;
    new Function('window', src)(window); // eslint-disable-line no-new-func
  }
  return window.DCP;
}

/** Builds an app state object from a list of component ids. */
function stateFrom(DCP, base, ids) {
  const slots = Object.fromEntries(DCP.SLOTS.map((s) => [s.id, []]));
  for (const id of ids) {
    const c = DCP.byId[id];
    if (!c) throw new Error(`Unknown component id: ${id}`);
    if (c.b !== base) throw new Error(`Component ${id} belongs to "${c.b}", not "${base}"`);
    slots[c.slot].push(id);
  }
  return { base, slots };
}

module.exports = { loadDCP, stateFrom, ROOT };
