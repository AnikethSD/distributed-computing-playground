/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */
/* Analysis engine: turns the placed components into scores, checks, capabilities,
 * workload fit, a generated spark-submit / conf, and a job plan per workload.
 * Pure function of state — no DOM, no network.
 *
 * The job simulator (planFor) is deliberately simple arithmetic, not a Spark fork:
 * it reproduces the *shape* of what the Spark UI and explain() would show for the
 * stack you built (tasks, stages, shuffle bytes, join strategy, rough wall time),
 * following the mechanics described in "What actually happens when you call spark.read?". */
(function () {
  const { SLOTS, DIMS, SYNERGIES, byId, WORKLOADS, PLATFORMS, PLATFORM_NAMES, NATIVE, TABLEFMT } = window.DCP;
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const fmtMB = (mb) => mb >= 1024 * 1024 ? `${(mb / 1024 / 1024).toFixed(1)} TB` : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  const fmtTime = (sec) => sec < 90 ? `${Math.max(1, Math.round(sec))} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`;
  const NATIVE_PREFIX = { gluten: 'Velox', comet: 'Comet', photon: 'Photon', rapids: 'Gpu' };

  /** Merge the sim knobs of all active components into one object. */
  function mergeSim(active, engine) {
    const sim = { speedMul: 1, pyFactor: 1 };
    active.forEach((c) => {
      Object.entries(c.sim || {}).forEach(([k, v]) => {
        if (k === 'pyFactor') sim.pyFactor = Math.max(sim.pyFactor, v);
        else if (k === 'speedMul') sim.speedMul *= v;
        else if (k === 'speed') { if (c.slot === 'engine') sim.engineSpeed = v; else if (c.slot === 'format') sim.formatSpeed = v; }
        else sim[k] = v;
      });
    });
    sim.engineId = engine ? engine.id : null;
    sim.native = !!(engine && NATIVE.includes(engine.id));
    return sim;
  }

  // ── Job simulator ─────────────────────────────────────────────────────────
  function planFor(w, sim, has) {
    const p = w.plan;
    if (p.kind === 'stream') return planStream(w, sim, has);
    const notes = [];
    const stages = [];
    const jobs = [];

    // Cluster: how many task slots run at once.
    let slots = sim.slots || 8;
    if (!sim.slots) notes.push('No cluster manager placed: running as local[*] with 8 cores.');
    if (sim.elastic && slots > 8) slots = 100;

    // Engine and format speed factors (seconds of one core per MB read ≈ 1/50 for JVM + Parquet).
    let engineSpeed = sim.engineSpeed || 1;
    let prefix = sim.native && NATIVE_PREFIX[sim.engineId] ? NATIVE_PREFIX[sim.engineId] : '';
    if (sim.native && (sim.blackbox || sim.rdd)) {
      engineSpeed = 1; prefix = '';
      notes.push('A UDF / RDD stage forces the native engine to fall back to the JVM row engine (ColumnarToRow + RowToColumnar on each side).');
    }
    const formatSpeed = sim.formatSpeed || 1.3;
    if (!sim.formatSpeed) notes.push('No file format placed: assuming plain Parquet-like files.');
    const pyFactor = p.python ? sim.pyFactor : (sim.pyFactor > 1 ? 1 + (sim.pyFactor - 1) * 0.3 : 1);

    // Listing & schema.
    const totalMB = p.dataTB * 1024 * 1024;
    let files = p.files;
    if (sim.tinyFiles) { files = Math.max(files, 40e6); notes.push('partitionBy(user_id) exploded the dataset into ~40 M tiny files.'); }
    let listSec = sim.metadata ? 2 : Math.ceil(files / 5000) + 1;
    const inferSec = sim.infer && sim.text ? (totalMB / 50 / slots) * formatSpeed : 0;
    if (inferSec) notes.push('inferSchema = True: a full extra pass over the data before the real job starts.');
    const mergeSec = sim.mergeSchema ? files / 2000 : 0;

    // Partition pruning.
    const pruned = !!(sim.partitioned && (sim.pruneOK || (p.dppJoin && sim.dpp)) && p.filterDays < p.days);
    const frac = pruned ? p.filterDays / p.days : 1;
    if (sim.partitioned && !pruned && p.filterDays < p.days) notes.push('Data is partitioned by date, but the filter is not pushdown-friendly: PartitionFilters: [] → all partitions scanned.');
    if (!sim.partitioned && p.filterDays < p.days) notes.push('Not partitioned by date: every file is opened; only row-group statistics can skip data.');
    const scanFiles = Math.max(1, Math.ceil(files * frac));
    const scanMB = totalMB * frac;
    const colFrac = sim.columnar ? p.needCols / p.cols : 1;
    const readMB = scanMB * colFrac;
    if (!sim.columnar) notes.push('Row-oriented / text format: every column is read even though the query needs a few.');

    // Scan tasks (FileSourceScanExec bin-packing).
    let fileMB = scanMB / scanFiles;
    let packFiles = scanFiles;
    if (sim.compaction && fileMB < 256) { fileMB = 256; packFiles = Math.max(1, Math.ceil(scanMB / 256)); }
    const maxPart = sim.maxPartitionMB || 128;
    let scanTasks;
    if (sim.splittable === false) {
      scanTasks = packFiles;
      notes.push(`Unsplittable (gzip) input: ${fmtInt(packFiles)} file${packFiles === 1 ? '' : 's'} → ${fmtInt(packFiles)} task${packFiles === 1 ? '' : 's'}, each decompressing a whole file on one core.`);
    } else {
      scanTasks = Math.max(1, Math.ceil(packFiles * (fileMB + 4) / maxPart));
    }
    const scanCoreSec = (readMB / 50) * formatSpeed * engineSpeed * pyFactor * sim.speedMul;
    const scanWall = scanCoreSec / Math.min(slots, scanTasks) + scanTasks * 0.02 / Math.min(slots, scanTasks) * 10; // + scheduling overhead
    stages.push({ n: `Scan ${p.dimMB ? 'fact' : 'input'}`, tasks: scanTasks, bytes: readMB, note: pruned ? `${fmtInt(scanFiles)} of ${fmtInt(files)} files after partition pruning` : `${fmtInt(scanFiles)} files, no partition pruning` });

    // Join.
    let join = 'NONE'; let joinLabel = 'no join'; let shuffleMB = 0; let shuffleWall = 0; let reducers = 0; let skew = null;
    const sp0 = sim.shufflePartitions === 1 ? 1 : sim.shufflePartitions === 'tuned' ? null : 200;
    const partsFor = (mb) => {
      if (sp0 === 1) return 1;
      let n = sp0 == null ? Math.max(1, Math.ceil(mb / 128)) : 200;
      if (sim.coalesce && mb / n < 64) n = Math.max(1, Math.ceil(mb / 64));
      return n;
    };
    const shuffleSec = (mb, parts) => {
      let perCore = 30 * (sim.fastDisk ? 1.4 : 1) * (sim.remoteShuffle ? 1.15 : 1) * (sim.shuffleCompress === false ? 0.6 : 1);
      if (sim.native) perCore *= 1.3;
      return (mb / perCore) / Math.min(slots, Math.max(1, parts));
    };
    if (p.dimMB) {
      const threshold = sim.broadcastMB || 10;
      const dimAfter = p.dimMB * (p.dimFilter || 1);
      // Without statistics Catalyst sizes the dimension from its files, not from the filtered result.
      const staticSize = sim.cbo ? dimAfter : p.dimMB;
      if (!sim.cbo && dimAfter < p.dimMB / 2 && !sim.hint) notes.push(`The dimension filter keeps ${fmtMB(dimAfter)} of ${fmtMB(p.dimMB)}, but without statistics the planner still sizes it at ${fmtMB(p.dimMB)}.`);
      if (p.bigJoin) {
        if (sim.bucketed) { join = 'BUCKET'; joinLabel = 'SortMergeJoin on bucketed tables (no Exchange)'; notes.push('Both sides bucketed on trip_id with the same bucket count: Spark skips both shuffles.'); }
        else { join = 'SMJ'; joinLabel = 'SortMergeJoin (both sides shuffled)'; shuffleMB += readMB * 2; }
      } else if (sim.hint || staticSize <= threshold) {
        join = 'BHJ'; joinLabel = `BroadcastHashJoin (${sim.hint ? 'hint' : `${fmtMB(staticSize)} ≤ autoBroadcastJoinThreshold`})`;
        const driverGB = sim.driverGB || 4;
        if (p.dimMB * 8 > driverGB * 1024) notes.push(`Broadcast build: ~${fmtMB(p.dimMB)} on disk ≈ ${fmtMB(p.dimMB * 8)} of hashed rows on a ${driverGB} GB driver — expect "Could not execute broadcast in 300 secs" or a driver OOM.`);
        stages.push({ n: 'Broadcast dimension', tasks: Math.max(1, Math.ceil(p.dimMB / 128)), bytes: p.dimMB, note: 'collected on the driver, sent to every executor' });
      } else {
        join = 'SMJ'; joinLabel = `SortMergeJoin (${fmtMB(staticSize)} > ${fmtMB(threshold)} threshold)`;
        shuffleMB += readMB + dimAfter;
        if (sim.aqeBroadcast && dimAfter <= 10) { join = 'AQE_BHJ'; joinLabel = 'SortMergeJoin → BroadcastHashJoin at runtime (local shuffle read)'; shuffleMB = dimAfter + readMB * 0.05; }
      }
      if (p.skewKey && (join === 'SMJ' || join === 'BUCKET')) {
        if (sim.skewJoin) skew = { kind: 'split', t: 'AQE splits the airport partition into several reader tasks (OptimizeSkewedJoin).' };
        else if (sim.salting) skew = { kind: 'salt', t: 'Salted key spreads the airport rows over 16 partitions.' };
        else skew = { kind: 'straggler', t: 'One reducer receives ~30% of all rows: the stage is as slow as that task.' };
      }
      if (join !== 'BHJ' && join !== 'BUCKET') {
        reducers = partsFor(shuffleMB);
        stages.push({ n: 'Exchange hashpartitioning(join key)', tasks: reducers, bytes: shuffleMB, note: sim.coalesce && reducers !== 200 && sp0 === 200 ? 'coalesced by AQE' : `${reducers} shuffle partitions` });
        let s = shuffleSec(shuffleMB, reducers);
        if (skew && skew.kind === 'straggler') s = Math.max(s, (shuffleMB * 0.3) / 30);
        if (skew && skew.kind === 'salt') s *= 1.1;
        shuffleWall += s;
      }
    }

    // Aggregation.
    let aggMB = 0;
    if (p.agg) {
      aggMB = Math.max(1, readMB * 0.05);
      const parts = partsFor(aggMB);
      shuffleMB += aggMB;
      stages.push({ n: 'Exchange hashpartitioning(group keys)', tasks: parts, bytes: aggMB, note: parts === 1 ? 'ONE task does all the reduce work' : `partial_sum on the map side, ${parts} reducers` });
      shuffleWall += shuffleSec(aggMB, parts);
      reducers = parts;
    }

    // Sort.
    let sortNote = null;
    if (p.sort === 'topk') sortNote = 'ORDER BY … LIMIT becomes TakeOrderedAndProject: no global sort, no extra shuffle.';
    if (p.sort === 'global') {
      const outMB = p.agg ? aggMB : readMB * 0.6;
      const parts = partsFor(outMB);
      shuffleMB += outMB;
      stages.push({ n: 'Exchange rangepartitioning(delta DESC)', tasks: parts, bytes: outMB, note: 'preceded by a sampling job (100 rows per partition) to pick range bounds' });
      jobs.push('Job: range-bound sampling (reservoir sample of the input)');
      shuffleWall += shuffleSec(outMB, parts) * 1.3;
      sortNote = 'Global orderBy: a sampling job, then a range-partitioned shuffle and a per-partition sort.';
      reducers = parts;
    }

    // Output.
    const outMB = p.agg ? aggMB * 0.4 : readMB * 0.5;
    const finalParts = reducers || scanTasks;
    let outputFiles = sim.outputFiles ? Math.max(1, Math.ceil(outMB / 128)) : finalParts;
    if (outMB > 0 && !sim.outputFiles && outputFiles > 20 && outMB / outputFiles < 16) notes.push(`Output inherits ${fmtInt(outputFiles)} partitions → ${fmtInt(outputFiles)} files of ~${fmtMB(outMB / outputFiles)}. Tomorrow's small-files problem.`);
    let commitSec = 0;
    if (!sim.committer && !sim.table && outputFiles > 0) commitSec = outputFiles * 0.08 + 2;
    if (commitSec > 20) notes.push('Rename-based commit on object storage: the driver renames every output file one by one at the end.');
    stages.push({ n: 'Write output', tasks: finalParts, bytes: outMB, note: `${fmtInt(outputFiles)} file${outputFiles === 1 ? '' : 's'}` });

    // Wall clock.
    let totalSec = listSec + inferSec + mergeSec + scanWall + shuffleWall + commitSec;
    if (sim.spot && !(sim.remoteShuffle || sim.decommission || sim.ess)) { totalSec *= 1.35; notes.push('Spot nodes without shuffle protection: expect FetchFailed → stage re-runs (+35%).'); }
    if (sim.speculation) totalSec *= 0.95;
    if (sim.cache && w.id === 'interactive') totalSec *= 0.4;

    // Jobs (AQE: each shuffle map stage is submitted as its own job).
    const exchanges = stages.filter((s) => s.n.startsWith('Exchange')).length;
    if (sim.aqe) { for (let i = 0; i < exchanges; i++) jobs.push(`Job: shuffle map stage ${i + 1} (AQE re-plans after it)`); jobs.push('Job: final stage + write'); }
    else jobs.push(`Job: ${exchanges + 1} stage${exchanges ? 's' : ''} in one DAG`);

    const lines = explainLines(w, { prefix, sim, join, pruned, p, reducers, skew, scanTasks, outputFiles });
    return {
      lines, stages, jobs, notes, join, joinLabel, skew, sortNote, pruned,
      tasks: stages.reduce((s, x) => s + x.tasks, 0), scanTasks, readMB, shuffleMB, outputFiles, listSec, slots,
      est: { seconds: totalSec, label: fmtTime(totalSec) },
      summary: `${fmtInt(scanTasks)} scan tasks over ${fmtMB(readMB)} · ${fmtMB(shuffleMB)} shuffled · ${joinLabel} · ≈ ${fmtTime(totalSec)} on ${slots} cores`,
    };
  }

  function explainLines(w, o) {
    const { prefix, sim, join, pruned, p, reducers, skew, scanTasks } = o;
    const op = (n) => `${prefix}${n}`;
    const codegen = prefix ? '' : '*(1) ';
    const key = p.bigJoin ? 'trip_id' : p.dppJoin ? 'dt' : 'zone_id';
    const fmt = sim.text ? (sim.splittable === false ? 'csv (gzip)' : 'csv') : sim.columnar === false ? 'avro' : 'parquet';
    const partFilters = pruned ? `PartitionFilters: [isnotnull(dt), (dt >= 2026-03-01), (dt <= 2026-03-31)]` : 'PartitionFilters: []';
    const pushed = sim.pushdown && !(sim.blackbox && p.python) ? `PushedFilters: [IsNotNull(${key})]` : 'PushedFilters: []';
    const scan = `${codegen}FileScan ${fmt} trips[${p.needCols} of ${p.cols} cols] Batched: ${sim.columnar ? 'true' : 'false'}, ${partFilters}, ${pushed}, ${fmtInt(scanTasks)} tasks`;
    const L = ['== Physical Plan =='];
    let ind = '';
    let root = false;
    const push = (s) => { if (!root && s.startsWith('+- ')) s = s.slice(3); root = true; L.push(ind + s); };
    if (sim.aqe) { push('AdaptiveSparkPlan isFinalPlan=true'); push('+- == Final Plan =='); ind = '   '; }
    if (p.sort === 'global') { push(`${op('Sort')} [delta DESC NULLS LAST], true`); push(`+- AQEShuffleRead / Exchange rangepartitioning(delta DESC, ${reducers})`); push(`   +- Job: sampling 100 rows per partition for range bounds`); ind += '      '; }
    if (p.sort === 'topk') { push('TakeOrderedAndProject(limit=20, orderBy=[trips DESC])'); ind += '+- '; }
    if (p.agg) {
      push(`${op('HashAggregate')}(keys=[zone_id], functions=[sum(fare), count(1)])`);
      if (sim.coalesce) push(`+- AQEShuffleRead coalesced (${reducers} partitions)`);
      push(`${sim.coalesce ? '   ' : ''}+- Exchange hashpartitioning(zone_id, ${reducers || 200}), ENSURE_REQUIREMENTS`);
      ind += sim.coalesce ? '      ' : '   ';
      push(`+- ${op('HashAggregate')}(keys=[zone_id], functions=[partial_sum(fare), partial_count(1)])`);
      ind += '   ';
    }
    if (p.python && sim.pyFactor > 1) {
      const kind = sim.pyFactor >= 6 ? 'BatchEvalPython' : sim.pyFactor >= 2.5 ? 'ArrowEvalPython' : 'MapInPandas';
      push(`+- ${kind} [score(...)], [#, …]   ← Python workers; opaque to Catalyst`);
      ind += '   ';
    }
    if (join === 'BHJ' || join === 'AQE_BHJ') {
      push(`+- ${op('BroadcastHashJoin')} [${key}], [${key}], Inner, BuildRight${join === 'AQE_BHJ' ? '   (converted from SMJ by AQE)' : ''}`);
      push(`   :- ${scan}`);
      push(`   +- BroadcastQueryStage / BroadcastExchange HashedRelationBroadcastMode(${key})`);
      push(`      +- ${codegen}FileScan parquet dim_zones[zone_id, zone_name]`);
    } else if (join === 'SMJ' || join === 'BUCKET') {
      push(`+- ${op('SortMergeJoin')} [${key}], [${key}], Inner${skew && skew.kind === 'split' ? '   isSkew=true' : ''}`);
      if (join === 'BUCKET') {
        push(`   :- ${op('Sort')} [trip_id ASC]   (bucketed: no Exchange)`);
        push(`   :  +- ${scan}, SelectedBucketsCount: 256 out of 256`);
        push(`   +- ${op('Sort')} [trip_id ASC]`);
        push(`      +- ${codegen}FileScan parquet payments[trip_id, amount_captured], bucketed`);
      } else {
        push(`   :- ${op('Sort')} [${key} ASC]`);
        push(`   :  +- ${skew && skew.kind === 'split' ? 'AQEShuffleRead skewed' : sim.coalesce ? 'AQEShuffleRead coalesced' : 'ShuffleQueryStage'} / Exchange hashpartitioning(${key}, ${reducers || 200})`);
        push(`   :     +- ${scan}`);
        push(`   +- ${op('Sort')} [${key} ASC]`);
        push(`      +- Exchange hashpartitioning(${key}, ${reducers || 200})`);
        push(`         +- ${codegen}FileScan parquet ${p.bigJoin ? 'payments' : 'dim'}[…]`);
      }
    } else {
      push(`+- ${codegen}Project [${p.needCols} columns]`);
      push(`   +- ${scan}`);
    }
    if (sim.native && (sim.blackbox || sim.rdd)) L.push('', '-- ColumnarToRow / RowToColumnar inserted around the UDF stage (native engine fallback)');
    if (skew) L.push('', `-- skew: ${skew.t}`);
    return L;
  }

  function planStream(w, sim, has) {
    const p = w.plan;
    const notes = [];
    const parts = sim.shufflePartitions === 1 ? 1 : 200;
    const stateGB = (p.stateKeys * 200) / 1024 / 1024 / 1024;
    const bounded = has('watermark');
    const rocks = has('rocksdb');
    if (!bounded) notes.push('No watermark: the window state grows forever; the executors will eventually OOM or spill without bound.');
    if (!rocks) notes.push('HDFS-backed state store keeps all state as JVM objects on the executor heap: GC pauses grow with state size.');
    if (sim.shufflePartitions === 1) notes.push('spark.sql.shuffle.partitions = 1 is frozen into the checkpoint: one state store task forever.');
    else notes.push(`The ${parts} state-store partitions are fixed for the life of the checkpoint; changing shuffle.partitions later has no effect.`);
    if (sim.native) notes.push('Native engines (Gluten / Comet / RAPIDS) have limited or no Structured Streaming support: expect full JVM fallback.');
    const exactlyOnce = has('foreachbatch') || sim.table;
    if (!exactlyOnce) notes.push('Sink is not idempotent / transactional: a replayed micro-batch after a failure writes duplicates.');
    const trigger = 60;
    const batchSec = Math.max(3, (p.eventsPerSec * trigger) / 400000 * (rocks ? 1 : 1.6) * (sim.speedMul || 1));
    const lines = [
      '== Physical Plan ==',
      'WriteToDataSourceV2 MicroBatchWrite[epoch: 1,207] ' + (exactlyOnce ? '(idempotent by batchId)' : '(append, no idempotency)'),
      `+- HashAggregate(keys=[window, zone_id], functions=[count(1), avg(surge)])`,
      `   +- StateStoreSave [window, zone_id], state info [ checkpoint = s3a://ridehub/chk/per_zone/, runId = …, opId = 0, ver = 1207, numPartitions = ${parts}], Update, ${bounded ? '10 minutes watermark' : 'NO watermark'}, ${rocks ? 'RocksDBStateStoreProvider' : 'HDFSBackedStateStoreProvider'}`,
      `      +- HashAggregate(keys=[window, zone_id], functions=[merge_count(1), merge_avg(surge)])`,
      `         +- StateStoreRestore [window, zone_id]`,
      `            +- Exchange hashpartitioning(window, zone_id, ${parts})`,
      `               +- HashAggregate(keys=[window, zone_id], functions=[partial_count(1), partial_avg(surge)])`,
      `                  +- ${bounded ? 'EventTimeWatermark event_ts: 10 minutes' : '(no EventTimeWatermark)'}`,
      `                     +- Project [from_json(value) …]`,
      `                        +- MicroBatchScan[key, value, topic, partition, offset, timestamp] KafkaV2[Subscribe[ride_events]]`,
    ];
    const stages = [
      { n: 'Kafka micro-batch read', tasks: 48, bytes: (p.eventsPerSec * trigger * 0.5) / 1024, note: '1 task per Kafka partition (48)' },
      { n: 'Exchange hashpartitioning(window, zone_id)', tasks: parts, bytes: (p.eventsPerSec * trigger * 0.1) / 1024, note: `${parts} state partitions` },
      { n: 'StateStore save + sink write', tasks: parts, bytes: stateGB * 1024, note: `${stateGB.toFixed(1)} GB of state ${rocks ? 'in RocksDB (off-heap)' : 'on the JVM heap'}` },
    ];
    const totalSec = batchSec + (exactlyOnce ? 2 : 0.5);
    const summary = `micro-batch every ${trigger} s · ${fmtInt(p.eventsPerSec * trigger)} events per batch · ${parts} state partitions · ${stateGB.toFixed(1)} GB state · ≈ ${fmtTime(totalSec)} per batch`;
    return {
      lines, stages, jobs: ['Job per micro-batch (every trigger interval)', 'Offsets committed to the checkpoint before each batch, commits after'], notes,
      join: 'NONE', joinLabel: 'streaming aggregation', skew: null, sortNote: null, pruned: false,
      tasks: stages.reduce((s, x) => s + x.tasks, 0), scanTasks: 48, readMB: 0, shuffleMB: 0, outputFiles: parts, listSec: 0, slots: sim.slots || 8,
      est: { seconds: totalSec, label: `${fmtTime(totalSec)} / batch` }, summary,
      stateGB, bounded, rocks, exactlyOnce, parts,
    };
  }

  // ── Analysis ──────────────────────────────────────────────────────────────
  function analyze(state) {
    const placed = SLOTS.flatMap((s) => (state.slots[s.id] || []).map((id) => byId[id]).filter(Boolean));
    const ids = new Set(placed.map((c) => c.id));
    const has = (id) => ids.has(id);
    const hasAny = (arr) => arr.some(has);
    const engine = placed.find((c) => c.slot === 'engine') || null;
    const cluster = placed.find((c) => c.slot === 'cluster') || null;

    const checks = [];
    const caps = new Set();
    const conf = [];
    const code = [];
    const add = (lvl, t) => checks.push({ lvl, t });
    const inactive = new Set();

    const scores = Object.fromEntries(DIMS.map((d) => [d.id, 0]));
    if (engine) Object.assign(scores, engine.base);
    const apply = (fx) => Object.entries(fx || {}).forEach(([k, v]) => { scores[k] += v; });

    placed.forEach((c) => {
      let ok = true;
      if (c.needs && !hasAny(c.needs.any)) { ok = false; add('error', `${c.n} ${c.needs.msg}`); }
      if (engine && c.engines && !c.engines.includes(engine.id)) { ok = false; add('error', `${c.n} doesn't apply to the ${engine.n} engine.`); }
      (c.conflicts || []).forEach((x) => { if (has(x.id)) { ok = false; add('error', `${c.n} ✕ ${byId[x.id].n}: ${x.msg}`); } });
      if (c.note) add(c.note.lvl, c.note.t);
      if (!ok) { inactive.add(c.id); return; }
      if (c.slot !== 'engine') apply(c.fx);
      (c.caps || []).forEach((x) => caps.add(x));
      if (c.conf) conf.push(`# ${c.n}\n${c.conf}`);
      if (c.code) code.push(`# ${c.n}\n${c.code}`);
    });
    const active = placed.filter((c) => !inactive.has(c.id));
    const activeHas = (id) => has(id) && !inactive.has(id);

    SYNERGIES.forEach((s) => {
      if (s.all.every((id) => activeHas(id))) {
        apply(s.fx);
        if (s.cap) caps.add(s.cap);
      }
    });

    // ── Custom rules ──────────────────────────────────────────────
    const isNative = !!(engine && NATIVE.includes(engine.id));
    const udfLike = hasAny(['pyudf', 'arrowudf', 'pandasudf', 'mapinpandas']);
    const streaming = activeHas('streaming');
    if (!engine) add('info', 'Drop an execution engine into layer 3 to bring your Spark job to life.');
    if (engine && !cluster) add('info', 'No cluster manager: the job runs as local[*] on one machine. Fine for explain(), not for 2 TB.');
    if ((engine?.id === 'gluten' || engine?.id === 'comet') && !has('offheap')) add('warn', `${engine.n} runs its operators in off-heap memory. Add Off-heap memory (and size it) or the native side starves while the JVM heap sits idle.`);
    if (isNative && (hasAny(['pyudf', 'arrowudf', 'pandasudf', 'mapinpandas', 'scalaudf']) || has('rdd'))) add('warn', `${engine.n} cannot run UDFs or RDD code natively: those stages fall back to the JVM with a columnar-to-row conversion on each side, often erasing the speed-up.`);
    if (isNative && streaming && engine.id !== 'photon') add('warn', `${engine.n} has little or no Structured Streaming support; the streaming query will run on the JVM engine.`);
    if (has('spot') && !hasAny(['decommission', 'celeborn', 'uniffle', 'ess', 'efm'])) add('warn', 'Spot workers with nothing protecting shuffle files: every preemption means FetchFailed and a stage re-run. Add graceful decommissioning, a remote shuffle service or EFM.');
    if (hasAny(['csv', 'csvgz', 'json']) && !has('schema') && !has('inferschema')) add('tip', 'Text formats have no schema: without an explicit schema every column is a string (CSV) or Spark runs an inference pass (JSON).');
    if (udfLike && !has('overhead')) add('tip', 'Python workers live outside the JVM heap. Add memory overhead / pyspark.memory or YARN and Kubernetes will kill executors for exceeding their container.');
    if (streaming && !has('rocksdb')) add('tip', 'The default state store keeps all streaming state on the JVM heap. For millions of keys add the RocksDB state store.');
    if (streaming && !has('watermark')) add('tip', 'Stateful streaming without a watermark keeps state forever. Add a watermark so old windows are dropped.');
    if (streaming && !has('foreachbatch') && !hasAny(TABLEFMT)) add('tip', 'For exactly-once output, write to a transactional table format or use foreachBatch with an idempotent MERGE keyed by batchId.');
    if (has('partitionby') && !has('partitionfilter') && !has('dpp')) add('tip', 'Partitioned data only helps if the filter can be pushed to the partition column: add pushdown-friendly predicates.');
    if (engine && !has('aqe')) add('tip', 'Adaptive Query Execution is on by default since Spark 3.2. Add it to model coalescing, skew handling and runtime broadcast.');
    if (has('speculation') && !hasAny([...TABLEFMT, 's3committer'])) add('warn', 'Speculative execution duplicates side effects. Without a transactional sink or a proper output committer, duplicated tasks can leave duplicate output files.');
    if (cluster?.id === 'local' && hasAny(['dynalloc', 'spot', 'decommission', 'celeborn', 'uniffle'])) add('warn', 'local[*] has one JVM and no executors to add, remove or lose. Cluster-level features do nothing here.');
    if (has('connect') && has('rdd')) add('warn', 'The RDD API is not available over Spark Connect: the thin client only speaks DataFrame / SQL.');
    if (has('liquid') && hasAny(['partitionby', 'zorder'])) add('warn', 'Liquid clustering replaces partitionBy and Z-ORDER; Databricks does not allow combining them on one table.');
    if (has('bucketjoin') && !has('bucketing') && !has('iceberg')) add('tip', 'Bucketed joins need both tables written with bucketBy(n, key) into a metastore table (or Iceberg storage-partitioned joins).');
    if (has('stagelevel') && !has('dynalloc')) add('tip', 'Stage-level scheduling requests new executor shapes per stage, which needs dynamic allocation to actually acquire them.');
    if (has('collectall') && has('arrow')) add('info', 'Arrow makes toPandas() faster, not smaller: the whole result still has to fit on the driver.');
    if (has('bchuge') && has('drivermem')) add('info', 'A 16 GB driver does not make a 2 GB broadcast threshold safe: the hashed relation is several times the on-disk size and the broadcast timeout is 300 s.');
    if (has('cachemem') && !hasAny(['thrift', 'connect', 'pandasapi'])) add('tip', 'cache() only pays off when the DataFrame is read more than once. In a single-pass ETL it adds a materialisation for nothing.');
    if (has('thrift') && !has('fair')) add('tip', 'A shared JDBC endpoint uses FIFO scheduling by default: one heavy dashboard query blocks everyone else. Add FAIR pools.');
    if (hasAny(['k8s', 'serverless']) && has('localdisk')) add('info', 'On Kubernetes map spark.local.dir to a hostPath / local SSD volume, otherwise shuffle spills land on the overlay filesystem.');

    // Platform resolution (flavors).
    let flavors = PLATFORMS.slice();
    const need = [];
    placed.forEach((c) => {
      if (c.flavors) { flavors = flavors.filter((f) => c.flavors.includes(f)); need.push(c); }
    });
    if (!flavors.length) {
      const detail = need.map((c) => `${c.n} → ${c.flavors.join('/')}`).join('; ');
      add('error', `No single platform offers all of these: ${detail}.`);
    }

    DIMS.forEach((d) => { scores[d.id] = engine ? clamp(scores[d.id]) : 0; });

    // Job plans per workload.
    const sim = mergeSim(active, engine);
    const plans = Object.fromEntries(WORKLOADS.map((w) => [w.id, planFor(w, sim, activeHas)]));

    // Workload fit.
    const r0 = { has, scores };
    const fits = WORKLOADS.map((w) => {
      let fit = Object.entries(w.w).reduce((s, [k, v]) => s + v * scores[k], 0);
      const gated = w.req && !w.req(r0);
      if (gated) fit *= 0.35;
      else if (w.req) fit += 8;
      const dims = Object.entries(w.w).map(([k, wt]) => ({ k, v: scores[k], c: wt * scores[k] }));
      const strong = dims.slice().sort((a, b) => b.c - a.c)[0];
      const weak = dims.slice().sort((a, b) => a.v - b.v)[0];
      return { w, fit: engine ? clamp(fit) : 0, gated, strong, weak, plan: plans[w.id] };
    }).sort((a, b) => b.fit - a.fit);

    const errors = checks.filter((c) => c.lvl === 'error').length;
    const dangers = checks.filter((c) => c.lvl === 'danger').length;
    const best = fits[0]?.fit || 0;
    const score = engine ? clamp(best - errors * 8 - dangers * 12) : 0;
    const grade = !engine ? '–' : score >= 90 ? 'S' : score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';

    // Config output.
    const master = cluster ? ({ local: 'local[*]', standalone: 'spark://master:7077', yarn: 'yarn', k8s: 'k8s://https://k8s-api:6443', serverless: '<managed by the platform>' })[cluster.id] : 'local[*]';
    const submit = [`spark-submit --master ${master}${cluster && cluster.id !== 'local' ? ' --deploy-mode cluster' : ''} \\`, '  --properties-file spark-defaults.conf \\', '  job.py'];
    const lines = ['# ── spark-submit ──', ...submit, '', '# ── spark-defaults.conf (or --conf key=value) ──'];
    if (!conf.length) lines.push('# (no configuration changes: Spark defaults)');
    conf.forEach((c) => lines.push(c));
    if (code.length) { lines.push('', '# ── PySpark ──'); code.forEach((s) => lines.push(s)); }
    const config = engine ? lines.join('\n') : '';

    const order = { danger: 0, error: 1, warn: 2, info: 3, tip: 4 };
    checks.sort((a, b) => order[a.lvl] - order[b.lvl]);

    return {
      base: state.base, engine, cluster, placed, has, inactive, scores, checks, caps: [...caps], fits, plans, sim, score, grade, errors, dangers, config,
      flavors: flavors.map((f) => PLATFORM_NAMES[f]),
      filledSlots: SLOTS.filter((s) => (state.slots[s.id] || []).length).length,
      countIn: (slot) => (state.slots[slot] || []).length,
    };
  }

  window.DCP.analyze = analyze;
  window.DCP.planFor = planFor;
  window.DCP.mergeSim = mergeSim;
  window.DCP.fmt = { int: fmtInt, mb: fmtMB, time: fmtTime };
})();
