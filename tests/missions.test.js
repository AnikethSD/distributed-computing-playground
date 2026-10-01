/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

// Content and solvability tests for the case-study missions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDCP, stateFrom } = require('./helpers/load-dcp');

const D = loadDCP();
const words = (s) => s.split(/\s+/).filter(Boolean).length;

test('there are at least 20 missions with unique ids', () => {
  assert.ok(D.MISSIONS.length >= 20, `found ${D.MISSIONS.length}`);
  assert.equal(new Set(D.MISSIONS.map((m) => m.id)).size, D.MISSIONS.length);
});

test('every category is used and levels are mixed', () => {
  const cats = new Set(D.MISSIONS.map((m) => m.cat));
  for (const id of Object.keys(D.MISSION_CATS)) assert.ok(cats.has(id), `no mission in category ${id}`);
  const lvls = new Set(D.MISSIONS.map((m) => m.lvl));
  assert.deepEqual([...lvls].sort(), [1, 2, 3]);
});

for (const m of D.MISSIONS) {
  test(`mission "${m.id}" is well-formed`, () => {
    assert.ok(D.MISSION_CATS[m.cat], `category ${m.cat}`);
    assert.ok(D.MISSION_LEVELS[m.lvl], `level ${m.lvl}`);
    assert.ok(['spark', 'any'].includes(m.family), `family ${m.family}`);
    for (const f of ['icon', 'n', 'co', 'brief', 'q', 'debrief']) assert.ok(m[f], `missing ${f}`);
    assert.ok(m.story.length >= 3 && m.reqs.length >= 3 && m.env.length >= 3, 'story / requirements / environment');
    assert.ok(m.quote && m.quote.who && m.quote.t, 'executive quote');
    assert.ok(m.checks.length >= 3, 'at least 3 hidden goals');
    for (const c of m.checks) assert.ok(c.t && typeof c.f === 'function', 'check shape');

    const caseStudy = [...m.story, ...m.env, ...m.reqs, m.quote.t, m.q].join(' ');
    assert.ok(words(caseStudy) >= 250, `case study is only ${words(caseStudy)} words`);
  });

  test(`mission "${m.id}" is solvable by its reference answer`, () => {
    const fams = Object.keys(m.answer);
    assert.ok(fams.length >= 1, 'has a reference answer');
    if (m.family !== 'any') assert.deepEqual(fams, [m.family], 'answer matches mission family');
    for (const fam of fams) {
      const r = D.analyze(stateFrom(D, fam, m.answer[fam]));
      const failed = m.checks.filter((c) => !c.f(r)).map((c) => c.t);
      assert.deepEqual(failed, [], `${fam} answer fails goals`);
      assert.equal(r.errors, 0, `${fam} answer has configuration errors`);
      assert.equal(r.dangers, 0, `${fam} answer has dangerous settings`);
    }
  });

  test(`mission "${m.id}" is not solved by an empty or bare-engine job`, () => {
    const bare = D.analyze(stateFrom(D, 'spark', ['jvm']));
    assert.ok(m.checks.some((c) => !c.f(bare)), 'a bare JVM engine must not pass every goal');
  });
}

test('the obvious traps fail the missions that warn about them', () => {
  const byId = Object.fromEntries(D.MISSIONS.map((m) => [m.id, m]));
  const fails = (id, ids) => {
    const r = D.analyze(stateFrom(D, 'spark', ids));
    return byId[id].checks.some((c) => !c.f(r));
  };
  // Friday: the 2 GB broadcast threshold is the whole problem.
  assert.ok(fails('friday', [...byId.friday.answer.spark.filter((x) => x !== 'bcthreshold'), 'bchuge']));
  // Two hundred files: shuffle.partitions = 1 is the trap.
  assert.ok(fails('files200', [...byId.files200.answer.spark.filter((x) => x !== 'targetfiles'), 'shuffle1']));
  // Feature job: a row-at-a-time Python UDF.
  assert.ok(fails('udf', [...byId.udf.answer.spark, 'pyudf']));
  // Spot: dropping shuffle protection brings back FetchFailed.
  assert.ok(fails('spot', byId.spot.answer.spark.filter((x) => !['celeborn', 'decommission', 'dynalloc'].includes(x))));
  // Small files: ignoreCorruptFiles hides data loss.
  assert.ok(fails('smallfiles', [...byId.smallfiles.answer.spark, 'ignorecorrupt']));
  // Sakura: filtering on month(pickup_ts) means no partition pruning.
  assert.ok(fails('maya', byId.maya.answer.spark.filter((x) => x !== 'partitionfilter')));
  // Photon: partitionBy alongside liquid clustering is rejected by the platform.
  assert.ok(fails('photon', [...byId.photon.answer.spark, 'partitionby']));
});
