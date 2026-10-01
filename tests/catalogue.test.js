/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

// Integrity tests for the component catalogue, workloads, presets and platforms.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDCP, stateFrom } = require('./helpers/load-dcp');

const D = loadDCP();
const DIM_IDS = new Set(D.DIMS.map((d) => d.id));
const SLOT_IDS = new Set(D.SLOTS.map((s) => s.id));

test('has 9 colour-coded layers with exactly one required slot', () => {
  assert.equal(D.SLOTS.length, 9);
  for (const s of D.SLOTS) assert.match(s.color, /^#[0-9a-f]{6}$/i, `slot ${s.id} colour`);
  assert.deepEqual(D.SLOTS.filter((s) => s.required).map((s) => s.id), ['engine']);
  assert.deepEqual(D.SLOTS.filter((s) => !s.multi).map((s) => s.id).sort(), ['cluster', 'engine', 'format']);
});

test('component ids are unique, belong to a known family and slot', () => {
  const seen = new Set();
  for (const c of D.COMPONENTS) {
    assert.ok(!seen.has(c.id), `duplicate id ${c.id}`);
    seen.add(c.id);
    assert.ok(Object.keys(D.PRESETS).includes(c.b), `${c.id} family ${c.b}`);
    assert.ok(SLOT_IDS.has(c.slot), `${c.id} slot ${c.slot}`);
    assert.ok(c.n && c.d && c.icon, `${c.id} needs a name, description and icon`);
  }
  assert.ok(D.COMPONENTS.length >= 100, `catalogue size ${D.COMPONENTS.length}`);
});

test('engines define a full base score; other components only use known dimensions', () => {
  for (const c of D.COMPONENTS) {
    if (c.slot === 'engine') {
      assert.ok(c.base, `${c.id} base`);
      for (const k of DIM_IDS) assert.equal(typeof c.base[k], 'number', `${c.id} base.${k}`);
      assert.equal(typeof c.sim.speed, 'number', `${c.id} needs a sim.speed factor`);
    } else {
      assert.ok(!c.base, `${c.id} is not an engine but has base scores`);
    }
    for (const k of Object.keys(c.fx || {})) assert.ok(DIM_IDS.has(k), `${c.id} fx.${k}`);
    if (c.note) assert.ok(['info', 'warn', 'danger'].includes(c.note.lvl), `${c.id} note level`);
  }
  assert.deepEqual(D.NATIVE.filter((id) => !D.byId[id]), [], 'NATIVE ids exist');
});

test('needs / engines / conflicts reference real components; flavors are known platforms', () => {
  for (const c of D.COMPONENTS) {
    const refs = [...(c.needs ? c.needs.any : []), ...(c.engines || []), ...(c.conflicts || []).map((x) => x.id)];
    for (const id of refs) {
      const ref = D.byId[id];
      assert.ok(ref, `${c.id} references unknown ${id}`);
      assert.equal(ref.b, c.b, `${c.id} references other-family ${id}`);
    }
    for (const e of c.engines || []) assert.equal(D.byId[e].slot, 'engine', `${c.id}.engines → ${e}`);
    for (const f of c.flavors || []) assert.ok(D.PLATFORMS.includes(f), `${c.id} flavor ${f}`);
    if (c.needs) assert.ok(c.needs.msg, `${c.id} needs.msg`);
  }
});

test('synergies reference real components', () => {
  for (const s of D.SYNERGIES) {
    for (const id of s.all) assert.ok(D.byId[id], `synergy references unknown ${id}`);
    for (const k of Object.keys(s.fx)) assert.ok(DIM_IDS.has(k), `synergy fx.${k}`);
  }
});

test('every workload has weights summing to 1, code and a plan spec', () => {
  for (const w of D.WORKLOADS) {
    const sum = Object.values(w.w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${w.id} weights sum ${sum}`);
    for (const k of Object.keys(w.w)) assert.ok(DIM_IDS.has(k), `${w.id} weight ${k}`);
    assert.ok(w.code && w.icon && w.n && w.blurb, `${w.id} presentation fields`);
    assert.ok(['batch', 'stream'].includes(w.plan.kind), `${w.id} plan.kind`);
    if (w.req) assert.ok(w.reqMsg, `${w.id} reqMsg`);
  }
});

test('every preset loads without errors or dangers and has an engine', () => {
  for (const base of Object.keys(D.PRESETS)) {
    for (const p of D.PRESETS[base]) {
      const r = D.analyze(stateFrom(D, base, p.ids));
      const errs = r.checks.filter((c) => c.lvl === 'error' || c.lvl === 'danger').map((c) => c.t);
      assert.deepEqual(errs, [], `${base} preset "${p.n}"`);
      assert.ok(r.engine, `${base} preset "${p.n}" has an engine`);
      assert.ok(r.flavors.length >= 1, `${base} preset "${p.n}" runs on at least one platform`);
    }
  }
});

test('achievements are well-formed and reachable by the presets collectively', () => {
  const unlocked = new Set();
  for (const p of D.PRESETS.spark) {
    const r = D.analyze(stateFrom(D, 'spark', p.ids));
    for (const a of D.ACHIEVEMENTS) if (a.f(r)) unlocked.add(a.id);
  }
  for (const a of D.ACHIEVEMENTS) assert.ok(a.id && a.n && a.d && a.icon && typeof a.f === 'function', `achievement ${a.id}`);
  assert.ok(unlocked.has('ignition') && unlocked.has('mapside') && unlocked.has('grand'), [...unlocked].join(','));
});
