/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */
'use strict';

// Behavioural tests for the pure analysis engine (DCP.analyze) and the job simulator (DCP.planFor).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDCP, stateFrom } = require('./helpers/load-dcp');

const D = loadDCP();
const analyze = (ids) => D.analyze(stateFrom(D, 'spark', ids));
const levels = (r, lvl) => r.checks.filter((c) => c.lvl === lvl).map((c) => c.t);
const BASE = ['yarn', 'dfapi', 'jvm', 'parquet', 'partitionby', 'partitionfilter', 'ess', 'execsize'];

test('an empty job has no engine, zero scores and a prompt to add one', () => {
  const r = analyze([]);
  assert.equal(r.engine, null);
  assert.equal(r.score, 0);
  assert.equal(r.grade, '–');
  assert.ok(Object.values(r.scores).every((v) => v === 0));
  assert.ok(levels(r, 'info').some((t) => t.includes('execution engine')));
});

test('scores are always clamped to 0..100', () => {
  const r = analyze(['jvm', 'csvgz', 'overpartition', 'collectall', 'bchuge', 'shuffle1', 'noretries']);
  for (const [k, v] of Object.entries(r.scores)) assert.ok(v >= 0 && v <= 100, `${k}=${v}`);
  assert.equal(r.scores.memory, 0);
  const hi = analyze(D.PRESETS.spark[0].ids);
  assert.equal(hi.scores.throughput, 100);
});

test('a component with an unmet prerequisite is inactive and reported as an error', () => {
  const r = analyze(['jvm', 'k8s', 'ess']);
  assert.ok(r.inactive.has('ess'));
  assert.ok(levels(r, 'error').some((t) => t.includes('Kubernetes has no external shuffle service')));
  const fixed = analyze(['jvm', 'yarn', 'ess']);
  assert.ok(!fixed.inactive.has('ess'));
  assert.equal(fixed.scores.resilience - analyze(['jvm', 'yarn']).scores.resilience, 15, 'ESS fx applies once active');
});

test('dynamic allocation needs somewhere safe for shuffle files', () => {
  const bare = analyze(['jvm', 'k8s', 'dynalloc']);
  assert.ok(bare.inactive.has('dynalloc'));
  const ok = analyze(['jvm', 'k8s', 'shuffletracking', 'dynalloc']);
  assert.ok(!ok.inactive.has('dynalloc'));
  const rss = analyze(['jvm', 'k8s', 'celeborn', 'dynalloc']);
  assert.ok(!rss.inactive.has('dynalloc'));
});

test('conflicting components are flagged as errors', () => {
  const r = analyze(['jvm', 'shufflepartitions', 'shuffle1']);
  assert.ok(r.inactive.has('shufflepartitions'));
  assert.ok(r.errors >= 1);
});

test('dangerous settings are penalised harder than warnings', () => {
  const safe = analyze(BASE);
  const risky = analyze([...BASE, 'bchuge']);
  assert.equal(risky.dangers, 1);
  assert.ok(risky.score < safe.score);
});

test('synergies add capability when all parts are active', () => {
  const without = analyze(['jvm', 'gluten'].slice(1));
  const withOffheap = analyze(['gluten', 'offheap']);
  assert.equal(withOffheap.scores.memory - without.scores.memory, 10 + 10, 'off-heap fx + Gluten synergy');
  assert.ok(withOffheap.caps.includes('Native engine with proper off-heap memory'));
});

test('platform-specific components narrow the list of platforms', () => {
  const any = analyze(['jvm', 'yarn']);
  assert.equal(any.flavors.length, D.PLATFORMS.length);
  const dbx = analyze(['photon', 'serverless', 'delta', 'liquid']);
  assert.deepEqual(dbx.flavors, ['Databricks']);
  const impossible = analyze(['photon', 'yarn', 'ess', 'magnet']);
  assert.equal(impossible.flavors.length, 0);
  assert.ok(levels(impossible, 'error').some((t) => t.includes('No single platform')));
});

test('custom rules: native engines warn about off-heap, UDF fallback and streaming', () => {
  const g = analyze(['gluten', 'pyudf', 'streaming']);
  const warns = levels(g, 'warn').join(' ');
  assert.match(warns, /off-heap/);
  assert.match(warns, /fall back to the JVM/);
  assert.match(warns, /Structured Streaming/);
  const fine = analyze(['gluten', 'offheap', 'sqlfuncs']);
  assert.ok(!levels(fine, 'warn').some((t) => t.includes('off-heap')));
});

test('custom rules: spot without shuffle protection, speculation without idempotent sink, local + cluster features', () => {
  assert.ok(levels(analyze(['jvm', 'k8s', 'spot']), 'warn').some((t) => t.includes('Spot workers')));
  assert.ok(!levels(analyze(['jvm', 'k8s', 'spot', 'celeborn']), 'warn').some((t) => t.includes('Spot workers')));
  assert.ok(levels(analyze(['jvm', 'speculation', 'parquet']), 'warn').some((t) => t.includes('Speculative')));
  assert.ok(!levels(analyze(['jvm', 'speculation', 'delta']), 'warn').some((t) => t.includes('Speculative')));
  assert.ok(levels(analyze(['jvm', 'local', 'yarn'].slice(0, 2).concat(['celeborn'])), 'warn').some((t) => t.includes('local[*]')));
});

test('workload fit ranks the obvious workload first and gates workloads with unmet requirements', () => {
  const ml = analyze(D.PRESETS.spark.find((p) => p.n.includes('PySpark')).ids);
  assert.equal(ml.fits[0].w.id, 'ml');
  const streaming = analyze(D.PRESETS.spark.find((p) => p.n.includes('Streaming')).ids);
  assert.equal(streaming.fits[0].w.id, 'streaming');
  const noStream = analyze(BASE);
  assert.ok(noStream.fits.find((f) => f.w.id === 'streaming').gated);
  assert.ok(noStream.fits.find((f) => f.w.id === 'lakehouse').gated);
});

test('grades follow the documented thresholds', () => {
  for (const p of D.PRESETS.spark) {
    const r = analyze(p.ids);
    const expected = r.score >= 90 ? 'S' : r.score >= 80 ? 'A' : r.score >= 65 ? 'B' : r.score >= 50 ? 'C' : 'D';
    assert.equal(r.grade, expected);
  }
});

test('generated config has a spark-submit line, conf lines and PySpark sections', () => {
  const r = analyze([...BASE, 'broadcasthint']);
  assert.match(r.config, /spark-submit --master yarn --deploy-mode cluster/);
  assert.match(r.config, /spark\.shuffle\.service\.enabled=true/);
  assert.match(r.config, /# ── PySpark ──/);
  assert.match(r.config, /F\.broadcast\(zones\)/);
  assert.match(analyze(['jvm']).config, /--master local\[\*\]/);
});

// ── Job simulator ──────────────────────────────────────────────────────────

test('partition pruning only happens with a partitioned layout and a pushdown-friendly predicate', () => {
  const none = analyze(['jvm', 'yarn', 'parquet']).plans.etl;
  const partitioned = analyze(['jvm', 'yarn', 'parquet', 'partitionby']).plans.etl;
  const pruned = analyze(['jvm', 'yarn', 'parquet', 'partitionby', 'partitionfilter']).plans.etl;
  assert.ok(!none.pruned && !partitioned.pruned && pruned.pruned);
  assert.ok(pruned.scanTasks < partitioned.scanTasks / 5, `${pruned.scanTasks} vs ${partitioned.scanTasks}`);
  assert.ok(pruned.est.seconds < partitioned.est.seconds);
  assert.ok(pruned.lines.some((l) => l.includes('PartitionFilters: [isnotnull(dt)')));
  assert.ok(partitioned.lines.some((l) => l.includes('PartitionFilters: []')));
});

test('join strategy: SMJ by default, BHJ with a hint or a larger threshold, AQE conversion for small dims', () => {
  const smj = analyze(['jvm', 'yarn', 'parquet']).plans.etl;
  assert.equal(smj.join, 'SMJ');
  assert.ok(smj.lines.some((l) => l.includes('SortMergeJoin')));
  const hint = analyze(['jvm', 'yarn', 'parquet', 'broadcasthint']).plans.etl;
  assert.equal(hint.join, 'BHJ');
  assert.ok(hint.lines.some((l) => l.includes('BroadcastHashJoin')));
  assert.ok(hint.shuffleMB < smj.shuffleMB);
  const thr = analyze(['jvm', 'yarn', 'parquet', 'bcthreshold']).plans.etl;
  assert.equal(thr.join, 'BHJ');
  const star = analyze(['jvm', 'yarn', 'parquet']).plans.starjoin;
  assert.equal(star.join, 'SMJ', 'without statistics the filtered dimension is sized from its files');
  const cbo = analyze(['jvm', 'yarn', 'parquet', 'cbo']).plans.starjoin;
  assert.equal(cbo.join, 'BHJ', 'with statistics the planner sees the filtered size');
  const aqe = analyze(['jvm', 'yarn', 'parquet', 'aqe', 'aqebroadcast']).plans.starjoin;
  assert.equal(aqe.join, 'AQE_BHJ', 'the filtered calendar dimension becomes a runtime broadcast');
});

test('bucketed tables remove the Exchange from a big-to-big join', () => {
  const smj = analyze(['jvm', 'yarn', 'hive']).plans.bigjoin;
  const bucket = analyze(['jvm', 'yarn', 'hive', 'bucketing', 'bucketjoin']).plans.bigjoin;
  assert.equal(smj.join, 'SMJ');
  assert.equal(bucket.join, 'BUCKET');
  assert.ok(bucket.shuffleMB < smj.shuffleMB / 2);
  assert.ok(bucket.lines.some((l) => l.includes('no Exchange')));
});

test('gzip text is unsplittable: one task per file, far slower than Parquet', () => {
  const gz = analyze(['jvm', 'yarn', 'csvgz']).plans.etl;
  const pq = analyze(['jvm', 'yarn', 'parquet']).plans.etl;
  assert.equal(gz.scanTasks, 16000);
  assert.ok(gz.notes.some((n) => n.includes('Unsplittable')));
  assert.ok(gz.est.seconds > pq.est.seconds * 2);
});

test('skew: straggler by default, handled by AQE skew join or salting', () => {
  const s = analyze(['jvm', 'yarn', 'parquet']).plans.skewed;
  assert.equal(s.skew.kind, 'straggler');
  const aqe = analyze(['jvm', 'yarn', 'parquet', 'aqe', 'aqeskew']).plans.skewed;
  assert.equal(aqe.skew.kind, 'split');
  assert.ok(aqe.est.seconds < s.est.seconds / 2);
  const salt = analyze(['jvm', 'yarn', 'parquet', 'salting']).plans.skewed;
  assert.equal(salt.skew.kind, 'salt');
});

test('shuffle.partitions = 1 serialises the reduce side; AQE coalescing right-sizes it', () => {
  const one = analyze(['jvm', 'yarn', 'parquet', 'shuffle1']).plans.etl;
  const def = analyze(['jvm', 'yarn', 'parquet']).plans.etl;
  const coalesced = analyze(['jvm', 'yarn', 'parquet', 'partitionby', 'partitionfilter', 'aqe', 'aqecoalesce']).plans.etl;
  assert.equal(one.outputFiles, 1);
  assert.ok(one.est.seconds > def.est.seconds);
  assert.equal(def.outputFiles, 200);
  assert.ok(coalesced.outputFiles < 200 && coalesced.outputFiles > 1);
  assert.ok(coalesced.lines.some((l) => l.includes('AQEShuffleRead coalesced')));
});

test('compaction and maxPartitionBytes shrink the tiny-files task count', () => {
  const tiny = analyze(['jvm', 'yarn', 'parquet']).plans.smallfiles;
  const fixed = analyze(['jvm', 'yarn', 'parquet', 'compaction', 'maxpartbytes']).plans.smallfiles;
  assert.ok(tiny.scanTasks > 50000, `${tiny.scanTasks}`);
  assert.ok(fixed.scanTasks < 5000, `${fixed.scanTasks}`);
  assert.ok(fixed.listSec < tiny.listSec || fixed.est.seconds < tiny.est.seconds);
});

test('native engines speed up SQL stages but fall back around UDFs', () => {
  const jvm = analyze(['jvm', 'yarn', 'parquet', 'partitionby', 'partitionfilter']).plans.etl;
  const gluten = analyze(['gluten', 'yarn', 'parquet', 'partitionby', 'partitionfilter', 'offheap']).plans.etl;
  assert.ok(gluten.est.seconds < jvm.est.seconds);
  assert.ok(gluten.lines.some((l) => l.includes('VeloxHashAggregate')));
  const udf = analyze(['gluten', 'yarn', 'parquet', 'partitionby', 'partitionfilter', 'offheap', 'pyudf']).plans.etl;
  assert.ok(udf.notes.some((n) => n.includes('fall back')));
  assert.ok(udf.est.seconds > gluten.est.seconds);
});

test('streaming plan reports state store, watermark and exactly-once facts', () => {
  const bare = analyze(['jvm', 'k8s', 'streaming']).plans.streaming;
  assert.ok(!bare.bounded && !bare.rocks && !bare.exactlyOnce);
  assert.ok(bare.lines.some((l) => l.includes('HDFSBackedStateStoreProvider')));
  const good = analyze(['jvm', 'k8s', 'streaming', 'rocksdb', 'watermark', 'foreachbatch', 'delta']).plans.streaming;
  assert.ok(good.bounded && good.rocks && good.exactlyOnce);
  assert.ok(good.lines.some((l) => l.includes('RocksDBStateStoreProvider')));
  assert.equal(good.parts, 200);
});

test('AQE turns each shuffle map stage into its own job', () => {
  const noAqe = analyze(['jvm', 'yarn', 'parquet']).plans.etl;
  const aqe = analyze(['jvm', 'yarn', 'parquet', 'aqe']).plans.etl;
  assert.equal(noAqe.jobs.length, 1);
  assert.ok(aqe.jobs.length >= 3, aqe.jobs.join(' | '));
  assert.ok(aqe.lines[1].includes('AdaptiveSparkPlan'));
});

test('a global sort adds a sampling job and a range exchange; a top-k does not', () => {
  const big = analyze(['jvm', 'yarn', 'parquet']).plans.bigjoin;
  assert.ok(big.jobs.some((j) => j.includes('sampling')));
  assert.ok(big.stages.some((s) => s.n.includes('rangepartitioning')));
  const topk = analyze(['jvm', 'yarn', 'parquet']).plans.interactive;
  assert.ok(topk.lines.some((l) => l.includes('TakeOrderedAndProject')));
  assert.ok(!topk.stages.some((s) => s.n.includes('rangepartitioning')));
});
