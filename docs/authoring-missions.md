# Authoring missions

Missions are on-call tickets written as exam-style case studies, in the spirit of Google Cloud Professional Data Engineer questions: a story with real constraints and a few distractors, then a hidden question. Players must infer the goals from the story.

All missions live in [`src/data/missions.js`](../src/data/missions.js).

## Schema

```js
{
  id: 'straggler',                 // unique, lower-case, stable (used in localStorage)
  icon: '🐢',                      // one emoji, shown on the board and the mission card
  n: 'One task, three hours',      // title
  co: 'Akatsuki Logistics',         // fictional company
  cat: 'shuffle',                  // perf | shuffle | memory | storage | cost | python | streaming | reliability
  family: 'spark',                 // 'spark' or 'any'
  lvl: 1,                          // 1 Associate, 2 Professional, 3 Expert
  brief: '199 reducers finish in a minute. One runs for three hours.',   // one-liner for the board
  story: [ '…company overview…', '…the incident…' ],                     // paragraphs
  reqs: [ '…', '…' ],              // business + technical requirements, including red herrings
  quote: { who: 'Tsunade Senju, Head of Data Platform', t: '…' },
  q: 'Which configuration change…?',                                     // the hidden question
  checks: [                        // hidden goals, each { t, f(result) }
    has2('aqe', 'aqeskew'),
    plan('skewed', 'Hot-key join plan splits the skewed partition', (p) => p.skew && p.skew.kind === 'split'),
    { t: 'No manual salting', f: (r) => not(r, 'salting') },
    min('skew', 'Skew resilience', 80),
    noErr, noDanger,
  ],
  answer: { spark: ['yarn', 'dfapi', 'jvm', 'aqe', 'aqeskew', …] },      // reference build
  debrief: 'Why the answer works, and why each trap is wrong…',
}
```

Two more sections are kept in lookup tables at the bottom of the file, keyed by mission `id`:

- `ENV[id]`: 3–5 bullets for the *existing technical environment*.
- `MORE[id]`: an optional extra story paragraph (timeline, politics, rejected options).

### Helpers for checks

| Helper | Meaning |
| :-- | :-- |
| `has(r, ...ids)` | at least one of the components is placed **and active** |
| `not(r, ...ids)` | none of the components is placed |
| `min(dim, label, v)` | `result.scores[dim] >= v` |
| `plan(workloadId, label, f)` | `f(result.plans[workloadId])`: a goal about the *simulated plan* |
| `noErr` | no configuration errors |
| `noDanger` | no dangerous settings |

`r` is the full result of `analyze()`. Checks can also use `r.engine.id`, `r.errors`, `r.dangers`, `r.flavors`, `r.sim` and `r.countIn(slot)`.

### Plan facts you can assert on

`r.plans.<workloadId>` is the output of the job simulator for that workload. Workload ids: `etl`, `interactive`, `ml`, `streaming`, `starjoin`, `smallfiles`, `skewed`, `lakehouse`, `spotbatch`, `bigjoin`.

| Field | Type | Meaning |
| :-- | :-- | :-- |
| `pruned` | boolean | `PartitionFilters` is populated |
| `join` | `'NONE' \| 'BHJ' \| 'SMJ' \| 'AQE_BHJ' \| 'BUCKET'` | join strategy chosen |
| `skew` | `{ kind: 'split' \| 'salt' \| 'straggler' } \| null` | how a hot key is handled |
| `scanTasks`, `tasks` | number | scan tasks / total tasks |
| `readMB`, `shuffleMB` | number | bytes read from storage / bytes exchanged |
| `outputFiles` | number | files written |
| `listSec` | number | seconds spent listing files |
| `slots` | number | concurrent task slots |
| `est.seconds` | number | estimated runtime |
| `jobs` | string[] | Spark jobs the driver would submit |
| `stages` | `{ n, tasks, bytes, note }[]` | stage table |
| *(stream only)* `stateGB`, `bounded`, `rocks`, `exactlyOnce` | | streaming facts |

Prefer plan goals over score goals whenever the story is about behaviour ("the join must not shuffle the dimension" → `p.join === 'BHJ'`), and score goals for broad qualities ("the job must be cheap" → `min('cost', …)`).

## Writing checklist

- [ ] **Around 300 words** across story, environment, requirements, quote and question. The tests enforce at least 200.
- [ ] The constraints are **inferable from the story**. Don't write "enable AQE skew join"; write "199 tasks finish in a minute and one runs for three hours".
- [ ] Include **at least one tempting trap** in the story (for example "a consultant suggests raising the broadcast threshold to 2 GB") and make sure a check fails when it is used.
- [ ] Add **1–2 irrelevant requirements** ("the dashboards are moving to a new BI tool").
- [ ] Every check should be **necessary**: the reference answer passes it, and a plausible wrong answer fails it.
- [ ] Mention real Spark UI evidence: empty `PartitionFilters`, `SortMergeJoin` with two `Exchange`s, spill sizes, GC time, `AQEShuffleRead`.
- [ ] The **debrief** explains *why*, including why each trap is wrong.
- [ ] Use **fictional** companies and people — by convention, names from the **Naruto** or **Dragon Ball Z** universes (e.g. `Capsule Corp`, `Hyuga Logistics`, `Kakashi Hatake`). Never a real company, person or product.

## Verify

```bash
npm test          # missions.test.js proves every answer passes its checks with 0 errors and 0 dangers
npm run test:ui   # optional: full UI flow
```

If you add a trap, consider adding an assertion to the *traps* test in [`tests/missions.test.js`](../tests/missions.test.js). If you add a new simulator flag to make a goal checkable, add a lever test to [`tests/engine.test.js`](../tests/engine.test.js).
