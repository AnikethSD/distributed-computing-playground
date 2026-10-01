# Architecture

This document describes how the playground is put together: the data model, the analysis algorithm, the job simulator and the design decisions behind them.

## Goals and constraints

| Constraint | Consequence |
| :-- | :-- |
| Runs by double-clicking `index.html` | Classic `<script>` tags that share one `window.DCP` namespace. ES modules are blocked on `file://`. |
| Fully offline, no third-party code | No frameworks, CDNs, fonts or analytics. Plain DOM APIs only. |
| Easy to extend with new content | All knowledge (components, workloads, missions) lives in declarative data files. |
| Testable without a browser | The analysis engine and the job simulator are pure functions of state and have no DOM access. |
| Ready for a second engine family | Every component, preset and mission carries a family tag (`b: 'spark'`). The UI's family switch and the `usedBases` achievement logic already handle more than one. |

## Module map

Scripts are loaded in this order by `index.html`. Each one adds to `window.DCP`.

| File | Adds to `DCP` | Depends on |
| :-- | :-- | :-- |
| `src/data/components.js` | `SLOTS`, `DIMS`, `COMPONENTS`, `SYNERGIES`, `byId`, `NATIVE`, `COLUMNAR`, `TABLEFMT` | — |
| `src/data/workloads.js` | `WORKLOADS`, `ACHIEVEMENTS`, `PRESETS`, `PLATFORMS`, `PLATFORM_NAMES` | `SLOTS` |
| `src/data/missions.js` | `MISSIONS`, `MISSION_CATS`, `MISSION_LEVELS` | — |
| `src/core/engine.js` | `analyze(state)`, `planFor(workload, sim, has)`, `mergeSim(active, engine)`, `fmt` | all of the above |
| `src/ui/app.js` | *(nothing; wires the DOM)* | all of the above |

## Data model

### Layers (`SLOTS`)

There are nine slots, grouped into six physical layers, from "where executors come from" down to "how bytes sit on disk":

| Slot | Layer | Name | Multi | Required |
| :-- | :-- | :-- | :-- | :-- |
| `cluster` | 1 | Cluster manager | no | no (empty = `local[*]`) |
| `api` | 2 | Code & APIs | yes | no |
| `engine` | 3 | Execution engine | no | **yes** |
| `planner` | 3 | Planner, joins & AQE | yes | no |
| `shuffle` | 4 | Shuffle | yes | no |
| `memory` | 4 | Memory, caching & serialization | yes | no |
| `sched` | 5 | Scheduling & resilience | yes | no |
| `format` | 6 | File / table format | no | no |
| `layout` | 6 | Data layout & read path | yes | no |

Each slot has a `color`, which drives the whole colour system in the UI, and a `hint` shown in the empty drop zone.

### Capability dimensions (`DIMS`)

Eleven dimensions, each scored from 0 to 100:

`throughput`, `latency`, `shuffle`, `memory`, `skew`, `io`, `resilience`, `cost`, `python`, `streaming`, `simplicity`

### Components

```js
{
  id: 'broadcasthint',          // unique, lower-case
  b: 'spark',                   // family
  slot: 'planner',              // which layer it belongs to
  n: 'Broadcast hint on small tables',
  icon: '📣',
  d: 'Forces a BroadcastHashJoin regardless of the size estimate…',
  base: { … },                  // engines only: starting score for every dimension
  fx: { shuffle: 15, latency: 5 },                      // capability deltas while active
  needs: { any: ['dfapi', 'sqlapi'], msg: '…' },        // prerequisite
  engines: ['jvm', 'gluten'],                           // compatible engines (omit = all)
  conflicts: [{ id: 'bc2g', msg: '…' }],
  flavors: ['Databricks'],      // platforms that ship it (omit = all)
  note: { lvl: 'warn', t: '…' },                        // surfaced as a check
  danger: true,                 // red dot; counts against the score
  caps: ['Map-side join without an Exchange'],          // "what it can do"
  conf: 'spark.sql.autoBroadcastJoinThreshold=100m',    // spark-defaults line
  code: 'df.join(broadcast(dim), "zone_id")',           // PySpark line
  sim: { hint: true },          // simulator flags, see below
}
```

### Workloads

Each workload describes a job in two ways: weights for the capability dimensions (`w`) used by the fit score, and a `plan` spec used by the simulator.

```js
{
  id: 'etl', icon: '🌙', n: 'Nightly aggregation + join',
  blurb: '…', code: 'trips = spark.read.parquet(…)',
  w: { throughput: 3, shuffle: 2, io: 2, cost: 1, … },
  req: { any: ['parquet', 'orc', 'delta', …], why: '…' },   // optional gate
  plan: {
    kind: 'batch',          // or 'stream'
    dataTB: 2, files: 16000, days: 365, filterDays: 31,
    cols: 40, needCols: 6,  // column pruning
    dimMB: 50, dimFilter: 1, // join to a dimension (dimFilter < 1 = selective filter)
    agg: true, sort: null,  // or sort: 'global' | 'window'
    bigJoin: false, skewed: false, outMB: …, gzipCsv: …,
  },
}
```

### State

The state is persisted to `localStorage` under the key `dcp-playground-v1`:

```js
{
  base: 'spark',
  slots: { cluster: [id], api: [ids], engine: [id], planner: [ids], … },
  mission, completed, stars, hints, qShown,     // mission progress
  unlocked, usedBases, mistakes,                // achievements
  theme, learn, openGroup, tab, workload,       // UI preferences  (tab: overview | plan | config)
}
```

## The analysis algorithm (`analyze(state)`)

1. **Collect** the placed components in layer order and find the engine.
2. **Start** each score from the engine's `base`. With no engine, everything is 0.
3. **Evaluate each component.** A component becomes **inactive**, and adds an `error` check, if:
   - none of its `needs.any` is present;
   - the chosen engine is not in its `engines`;
   - a component listed in its `conflicts` is present.

   Active components apply their `fx`, contribute `caps` and emit `conf` / `code` lines.
4. **Apply synergies:** pairs that are worth more together, such as AQE + skew join handling, or dynamic allocation + shuffle tracking on Kubernetes.
5. **Apply Spark-specific rules** that add warnings and tips. Examples: "native engine with a Python UDF falls back to the JVM row by row", "spot executors without decommissioning or a remote shuffle service", "streaming without a watermark", "speculation with a non-idempotent sink".
6. **Resolve the platform.** Intersect the `flavors` of every component. An empty intersection is the error *No single platform offers all of these*.
7. **Clamp** every score to 0..100.
8. **Merge simulator flags** (`mergeSim`) from every active component and **run the simulator** for every workload (`planFor`).
9. **Compute workload fit.** Fit is the weighted sum of scores. Workloads with an unmet `req` are multiplied by 0.35; workloads whose `req` is met get +8.
10. **Compute score and grade.** Score = best fit − 8·errors − 12·dangers. The grade is S ≥ 90, A ≥ 80, B ≥ 65, C ≥ 50, else D.

The result object is consumed by the UI, by the mission checks (`check.f(result)`) and by the tests. The most useful fields are `scores`, `has(id)`, `inactive`, `errors`, `dangers`, `flavors`, `fits`, `plans[workloadId]` and `config`.

## The job simulator (`planFor(workload, sim, has)`)

The simulator never looks at component ids. It reads only the **merged flags** (`sim`), so adding a new component usually means adding a flag, not a rule.

### Merging flags (`mergeSim`)

- `pyFactor` takes the **maximum** (the slowest Python path wins).
- `speedMul` values **multiply**.
- `speed` becomes `engineSpeed` when it comes from the engine slot and `formatSpeed` when it comes from the format slot.
- `native` is derived from the engine (`NATIVE` list).
- Every other flag is simply assigned (last writer wins; the catalogue avoids conflicts).

### Flags the simulator understands

| Area | Flags |
| :-- | :-- |
| Cluster | `slots` (task slots), `elastic` (dynamic allocation / serverless; caps at 100) |
| Code | `rdd`, `pyFactor`, `blackbox` (UDF blocks pushdown), `longRunning`, `streaming`, `arrow` |
| Engine | `speed`, `native`, `gpu`, `columnar` |
| Planner | `aqe`, `coalesce`, `skewJoin`, `aqeBroadcast`, `hint`, `broadcastMB`, `dpp`, `cbo`, `salting`, `bucketed`, `shufflePartitions` (`'tuned'` or a number), `pruneOK` |
| Shuffle | `ess`, `remoteShuffle`, `fastDisk`, `speedMul` |
| Memory | `overhead`, `offheap`, `cache`, `driverGB` |
| Scheduling | `speculation`, `decommission`, `spot` |
| Format | `columnar`, `pushdown`, `splittable`, `text`, `metadata`, `table` |
| Layout | `partitioned`, `tinyFiles`, `clustered`, `compaction`, `outputFiles`, `schema`, `infer`, `maxPartitionMB`, `committer`, `mergeSchema` |

### Batch pipeline

1. **Slots.** `sim.slots`, 8 when no cluster manager is placed, 100 when elastic.
2. **File listing.** `listSec` grows with the number of files unless `metadata` (manifest-based table format) is set.
3. **Partition pruning.** Happens when the layout is `partitioned` **and** either the predicate is pushdown-friendly (`pruneOK`) or the workload is a star join with `dpp`. Pruned reads scale `files` and bytes by `filterDays / days`.
4. **Column pruning.** Columnar formats read `needCols / cols` of the bytes; a `blackbox` UDF disables both pushdown and column pruning.
5. **Scan tasks.** `ceil(files × (fileMB + 4) / maxPartitionMB)`; unsplittable inputs (gzip CSV) produce one task per file; `compaction` rewrites to 256 MB files first.
6. **Join strategy.** The static size of the dimension is `dimMB × dimFilter` when `cbo` is set and `dimMB` otherwise (without statistics the planner sizes the dimension from its files). If that is ≤ `broadcastMB` (default 10) or `hint` is set, the plan is `BHJ`. If AQE runtime broadcast is on and the *runtime* size is ≤ 10 MB, `AQE_BHJ`. Big-to-big joins become `BUCKET` when `bucketed`; otherwise `SMJ`.
7. **Shuffle partitions.** 200 by default, `ceil(shuffleMB / 128)` when tuned, or the literal number; AQE `coalesce` shrinks to `ceil(shuffleMB / 64)`.
8. **Skew.** Skewed workloads get `skew.kind = 'split'` with AQE skew join, `'salt'` with salting, otherwise a `'straggler'` whose time dominates the stage.
9. **Sort.** Global sorts add a range-partitioning exchange and a note; window sorts add a per-partition sort.
10. **Output files.** `ceil(outMB / 128)` when `outputFiles` (coalesce / target file size) is set, otherwise one file per final partition. Writes to object storage pay a rename penalty unless `committer` or `table` is set.
11. **Estimate.** Sum of stage times, each `tasks × secondsPerTask / slots`, scaled by `engineSpeed`, `formatSpeed`, `speedMul` and `pyFactor`; spot nodes without protection multiply by 1.35.
12. **Jobs.** One job per Exchange when AQE is on (it re-plans at each boundary), plus the final stage.

`explainLines()` renders the same facts as an `explain()`-style tree, so what you read in the Job plan tab is derived from the same numbers as the stage table.

### Streaming pipeline (`planStream`)

Streaming workloads skip the batch pipeline and compute `stateGB` (bounded by a watermark or not), whether the state store is RocksDB, whether the sink is exactly-once, and micro-batch partitions.

## UI architecture (`src/ui/app.js`)

- **Render loop.** `update()` calls `analyze`, then runs `renderPalette`, `renderStack`, `renderMission`, `checkAchievements` and `renderAnalysis`, then saves. Each renderer rebuilds its region with `replaceChildren`.
- **DOM helper `h(tag, attrs, …children)`.** Text is always set via `textContent` and text nodes, never `innerHTML` with data.
- **Drag and drop.** Native HTML5 DnD. A drop on the wrong slot counts as a miss. Dragging a placed chip back to the palette removes it. With *Guide me* on, the body gets `.is-dragging.guide`, the matching slot gets `.target`, and CSS dims every other slot.
- **Hover card.** A single floating `#pop` element, positioned next to the anchor, flipped if there isn't room and clamped to the viewport.
- **Job plan tab.** Shows the best-fit workloads; selecting one shows its PySpark code, a one-line estimate, the explain tree, the stage table and the job list from `result.plans[workload]`.
- **Mission board.** A native `<dialog>` with a category-filtered list and a case-study pane.

## Styling

- **Design tokens.** `:root` holds the light theme and `[data-theme="dark"]` the dark theme.
- **Per-layer colour.** Every layer-related element gets `style="--c: <slot colour>"`. Tints are computed with `color-mix(in srgb, var(--c) N%, var(--panel))`, so both themes stay coherent without extra rules.
- **Mission categories** use the same technique with `--mc`.
- **Wide plan output.** `.tab-body` uses `grid-template-columns: minmax(0, 1fr)` so the `white-space: pre` explain block scrolls inside the analysis column instead of widening it.
