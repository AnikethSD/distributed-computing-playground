/**
 * @license
 * Copyright 2026 AnikethSD
 * SPDX-License-Identifier: Apache-2.0
 */
/* Workload archetypes (each with a job sketch the simulator can plan), achievements,
 * presets and the platform list. Missions live in missions.js.
 *
 * Workload fields
 *   id, icon, n, blurb, w (fit weights over DIMS, sum to 1), req(r)?, reqMsg?
 *   code  – the PySpark the player is "running" for this workload
 *   plan  – inputs for core/engine.js planFor():
 *           kind 'batch' | 'stream', dataTB, files, days, filterDays, cols, needCols,
 *           dimMB (0 = no join), dimFilter (fraction of the dimension that survives its filter),
 *           bigJoin, skewKey, agg, sort (null | 'topk' | 'global'), python
 */
(function () {
  const has = (r, ...ids) => ids.some((id) => r.has(id));

  const WORKLOADS = [
    {
      id: 'etl', icon: '🌙', n: 'Nightly aggregation + join', blurb: '2 TB of trips, one month filtered, joined to a 50 MB zones table, summed per zone.',
      w: { throughput: 0.3, shuffle: 0.2, io: 0.2, memory: 0.1, resilience: 0.1, cost: 0.1 },
      code: 'trips = spark.read.parquet("s3a://capsule/trips/")          # 2 TB, 16,000 files, 365 days\nzones = spark.read.parquet("s3a://capsule/dim_zones/")      # 50 MB\n\nmarch = trips.filter(F.col("dt").between("2026-03-01", "2026-03-31"))\nreport = (march.join(zones, "zone_id")\n          .groupBy("zone_id", "zone_name")\n          .agg(F.sum("fare").alias("revenue"), F.count("*").alias("trips")))\nreport.write.mode("overwrite").parquet("s3a://capsule/reports/zone_revenue/")',
      plan: { kind: 'batch', dataTB: 2, files: 16000, days: 365, filterDays: 31, cols: 40, needCols: 6, dimMB: 50, dimFilter: 1, agg: true, sort: null },
    },
    {
      id: 'interactive', icon: '📊', n: 'Interactive BI dashboards', blurb: 'Analysts slice last week\'s trips from a BI tool and expect answers in seconds, not minutes.',
      w: { latency: 0.45, io: 0.2, shuffle: 0.1, memory: 0.1, simplicity: 0.15 },
      code: '-- Tableau / Superset over JDBC\nSELECT z.zone_name, count(*) AS trips, avg(t.fare) AS avg_fare\nFROM   trips t JOIN dim_zones z USING (zone_id)\nWHERE  t.dt >= date_sub(current_date(), 7)\nGROUP  BY z.zone_name\nORDER  BY trips DESC\nLIMIT  20',
      plan: { kind: 'batch', dataTB: 0.5, files: 4000, days: 365, filterDays: 7, cols: 30, needCols: 4, dimMB: 20, dimFilter: 1, agg: true, sort: 'topk' },
    },
    {
      id: 'ml', icon: '🐍', n: 'PySpark feature pipeline', blurb: 'Python scoring over 1 TB of rider features; the model is a pickled scikit-learn object.',
      w: { python: 0.4, throughput: 0.2, memory: 0.2, cost: 0.1, simplicity: 0.1 },
      req: (r) => has(r, 'pandasudf', 'mapinpandas', 'arrowudf', 'pyudf', 'pandasapi'), reqMsg: 'needs Python logic: a UDF, mapInPandas or the pandas API',
      code: 'features = spark.read.parquet("s3a://capsule/features/")   # 1 TB, 90 days, 60 columns\n\ndef score(batches):\n    model = load_model()                      # once per task\n    for pdf in batches:\n        pdf["churn_p"] = model.predict_proba(pdf[FEATURES])[:, 1]\n        yield pdf[["rider_id", "churn_p"]]\n\nscored = features.mapInPandas(score, schema="rider_id long, churn_p double")\nscored.write.mode("overwrite").parquet("s3a://capsule/scores/")',
      plan: { kind: 'batch', dataTB: 1, files: 8000, days: 90, filterDays: 90, cols: 60, needCols: 25, dimMB: 0, agg: false, sort: null, python: true },
    },
    {
      id: 'streaming', icon: '🌊', n: 'Kafka → lakehouse streaming', blurb: 'Ride events from Kafka, 5-minute windows per zone, exactly-once into a table.',
      w: { streaming: 0.45, resilience: 0.2, memory: 0.15, latency: 0.1, simplicity: 0.1 },
      req: (r) => has(r, 'streaming'), reqMsg: 'needs Structured Streaming in Code & APIs',
      code: 'events = (spark.readStream.format("kafka")\n          .option("kafka.bootstrap.servers", "kafka:9092")\n          .option("subscribe", "ride_events").load()\n          .select(F.from_json(F.col("value").cast("string"), schema).alias("e")).select("e.*"))\n\nper_zone = (events.withWatermark("event_ts", "10 minutes")\n            .groupBy(F.window("event_ts", "5 minutes"), "zone_id")\n            .agg(F.count("*").alias("rides"), F.avg("surge").alias("avg_surge")))\n\n(per_zone.writeStream.outputMode("update")\n   .option("checkpointLocation", "s3a://capsule/chk/per_zone/")\n   .trigger(processingTime="1 minute")\n   .toTable("capsule.zone_demand"))',
      plan: { kind: 'stream', eventsPerSec: 40000, stateKeys: 2000000, windowMin: 5 },
    },
    {
      id: 'starjoin', icon: '⭐', n: 'Star-schema reporting', blurb: 'A 5 TB fact table joined to drivers, zones and a calendar; the calendar filter should prune the fact.',
      w: { shuffle: 0.3, throughput: 0.25, io: 0.25, memory: 0.1, latency: 0.1 },
      code: 'fact = spark.read.table("capsule.fact_trips")            # 5 TB, partitioned by dt\ndrivers = spark.read.table("capsule.dim_drivers")        # 300 MB\ncal = spark.read.table("capsule.dim_calendar").filter("fiscal_quarter = \'FY26Q1\'")\n\nq = (fact.join(cal, "dt")                                 # DPP: cal prunes fact partitions\n         .join(drivers, "driver_id")\n         .groupBy("fiscal_quarter", "driver_tier")\n         .agg(F.sum("fare"), F.countDistinct("rider_id")))',
      plan: { kind: 'batch', dataTB: 5, files: 40000, days: 730, filterDays: 90, cols: 50, needCols: 8, dimMB: 300, dimFilter: 0.02, agg: true, sort: null, dppJoin: true },
    },
    {
      id: 'smallfiles', icon: '🧩', n: 'Two million tiny files', blurb: 'An IoT landing zone wrote one 400 KB file per device per hour. Now a full scan takes forever.',
      w: { io: 0.45, throughput: 0.2, cost: 0.15, simplicity: 0.1, latency: 0.1 },
      code: 'telemetry = spark.read.parquet("s3a://capsule/telemetry/")   # 2,000,000 files × 400 KB\n\ndaily = (telemetry.groupBy("device_id", F.to_date("ts").alias("d"))\n         .agg(F.avg("battery"), F.max("speed")))\ndaily.write.mode("overwrite").parquet("s3a://capsule/telemetry_daily/")',
      plan: { kind: 'batch', dataTB: 0.8, files: 2000000, days: 365, filterDays: 365, cols: 20, needCols: 5, dimMB: 0, agg: true, sort: null },
    },
    {
      id: 'skewed', icon: '🔥', n: 'Hot-key join', blurb: 'Airport pickups are 30% of all trips. One reducer gets the airport, 199 get the suburbs.',
      w: { skew: 0.4, shuffle: 0.25, throughput: 0.15, memory: 0.1, resilience: 0.1 },
      code: 'trips = spark.read.parquet("s3a://capsule/trips/")           # 3 TB\npromos = spark.read.parquet("s3a://capsule/zone_promos/")    # 800 MB, keyed by zone_id\n\n# zone_id = AIRPORT holds ~30% of all rows\njoined = trips.filter("dt >= \'2026-03-01\'").join(promos, "zone_id")\nsummary = joined.groupBy("zone_id", "promo_id").agg(F.sum("discount"))',
      plan: { kind: 'batch', dataTB: 3, files: 24000, days: 365, filterDays: 30, cols: 40, needCols: 6, dimMB: 800, dimFilter: 1, agg: true, sort: null, skewKey: true },
    },
    {
      id: 'lakehouse', icon: '🏞️', n: 'Lakehouse upserts & deletes', blurb: 'Late-arriving corrections, GDPR deletes by rider_id, and auditors who want yesterday\'s version.',
      w: { io: 0.3, resilience: 0.25, simplicity: 0.2, throughput: 0.15, cost: 0.1 },
      req: (r) => has(r, 'delta', 'iceberg', 'hudi'), reqMsg: 'needs a table format (Delta, Iceberg or Hudi): plain Parquet cannot MERGE or DELETE',
      code: 'spark.sql("""\n  MERGE INTO capsule.trips t\n  USING corrections c ON t.trip_id = c.trip_id AND t.dt = c.dt\n  WHEN MATCHED THEN UPDATE SET fare = c.fare\n  WHEN NOT MATCHED THEN INSERT *\n""")\nspark.sql("DELETE FROM capsule.trips WHERE rider_id IN (SELECT rider_id FROM gdpr_requests)")\nspark.read.option("versionAsOf", 41).table("capsule.trips")   # what auditors saw',
      plan: { kind: 'batch', dataTB: 4, files: 30000, days: 1095, filterDays: 1, cols: 40, needCols: 10, dimMB: 0, agg: false, sort: null },
    },
    {
      id: 'spotbatch', icon: '🎟️', n: 'Cost-optimised batch on spot', blurb: 'The same nightly ETL, but finance wants it on 70%-cheaper nodes that vanish without warning.',
      w: { cost: 0.4, resilience: 0.3, throughput: 0.15, shuffle: 0.15 },
      code: '# Same job as the nightly ETL, submitted to a pool of spot / preemptible executors.\n# The question is not the code: it is what happens to shuffle files when a node disappears.\nreport = (trips.filter(F.col("dt").between("2026-03-01", "2026-03-31"))\n          .join(zones, "zone_id").groupBy("zone_id").agg(F.sum("fare")))',
      plan: { kind: 'batch', dataTB: 2, files: 16000, days: 365, filterDays: 31, cols: 40, needCols: 6, dimMB: 50, dimFilter: 1, agg: true, sort: null },
    },
    {
      id: 'bigjoin', icon: '🏋️', n: 'Big-to-big join + ranked export', blurb: 'Trips (5 TB) joined to payments (5 TB) on trip_id, then a globally sorted export for the auditors.',
      w: { shuffle: 0.4, throughput: 0.25, memory: 0.2, skew: 0.15 },
      code: 'trips = spark.read.table("capsule.trips")        # 5 TB\npays = spark.read.table("capsule.payments")      # 5 TB\n\nrecon = (trips.join(pays, "trip_id")\n         .select("trip_id", "fare", "amount_captured", (F.col("fare") - F.col("amount_captured")).alias("delta")))\n(recon.orderBy(F.col("delta").desc())             # global sort → range partitioning\n      .write.mode("overwrite").parquet("s3a://capsule/recon/"))',
      plan: { kind: 'batch', dataTB: 5, files: 40000, days: 365, filterDays: 365, cols: 30, needCols: 4, dimMB: 5 * 1024 * 1024, dimFilter: 1, bigJoin: true, agg: false, sort: 'global' },
    },
  ];

  const ACHIEVEMENTS = [
    { id: 'ignition', icon: '🔥', n: 'Ignition', d: 'Place an execution engine.', f: (r) => !!r.engine },
    { id: 'fullstack', icon: '🏗️', n: 'Full stack', d: 'Fill every layer.', f: (r) => r.filledSlots === window.DCP.SLOTS.length },
    { id: 'native', icon: '🚀', n: 'Native speed', d: 'Run a native engine with throughput ≥ 85.', f: (r) => !!r.engine && window.DCP.NATIVE.includes(r.engine.id) && r.scores.throughput >= 85 },
    { id: 'mapside', icon: '📣', n: 'Map-side join', d: 'Plan the nightly ETL as a broadcast join.', f: (r) => !!r.plans && r.plans.etl.join === 'BHJ' },
    { id: 'noexchange', icon: '🪣', n: 'No Exchange', d: 'Plan the big-to-big join without a shuffle.', f: (r) => !!r.plans && r.plans.bigjoin.join === 'BUCKET' },
    { id: 'skewslayer', icon: '⚖️', n: 'Skew slayer', d: 'Skew resilience ≥ 80.', f: (r) => r.scores.skew >= 80 },
    { id: 'streamer', icon: '🌊', n: 'Always on', d: 'Streaming fitness ≥ 85.', f: (r) => r.scores.streaming >= 85 },
    { id: 'lakehouse', icon: '🏞️', n: 'Lakehouse architect', d: 'Table format active and I/O efficiency ≥ 85.', f: (r) => window.DCP.TABLEFMT.some((id) => r.has(id) && !r.inactive.has(id)) && r.scores.io >= 85 },
    { id: 'frugal', icon: '🪙', n: 'Frugal', d: 'Cost efficiency ≥ 85.', f: (r) => r.scores.cost >= 85 },
    { id: 'pythonista', icon: '🐍', n: 'Pythonista', d: 'Python friendliness ≥ 85.', f: (r) => r.scores.python >= 85 },
    { id: 'danger', icon: '💀', n: 'Living dangerously', d: 'Use a setting marked as dangerous.', f: (r) => r.dangers > 0 },
    { id: 'grand', icon: '🏆', n: 'Grand architect', d: 'Reach grade S.', f: (r) => r.grade === 'S' },
  ];

  const PRESETS = {
    spark: [
      { n: '🌙 Nightly ETL starter', ids: ['yarn', 'dfapi', 'sqlfuncs', 'jvm', 'aqe', 'aqecoalesce', 'aqeskew', 'broadcasthint', 'partitionfilter', 'ess', 'shufflezstd', 'execsize', 'dynalloc', 'history', 'parquet', 'partitionby', 'targetfiles'] },
      { n: '📊 Interactive SQL endpoint', ids: ['k8s', 'dfapi', 'thrift', 'jvm', 'aqe', 'aqebroadcast', 'cbo', 'celeborn', 'cachemem', 'fair', 'localitywait', 'delta', 'zorder', 'compaction', 'listingcache'] },
      { n: '🐍 PySpark ML features', ids: ['k8s', 'dfapi', 'pandasudf', 'mapinpandas', 'jvm', 'aqe', 'aqecoalesce', 'shuffletracking', 'overhead', 'arrow', 'execsize', 'dynalloc', 'stagelevel', 'parquet', 'partitionby', 'partitionfilter'] },
      { n: '🌊 Streaming Kafka → Delta', ids: ['k8s', 'dfapi', 'streaming', 'rocksdb', 'watermark', 'foreachbatch', 'jvm', 'aqe', 'execsize', 'overhead', 'maxfailures', 'history', 'delta', 'optimizewrite'] },
      { n: '🎟️ Cost-optimised spot batch', ids: ['k8s', 'dfapi', 'sqlfuncs', 'jvm', 'aqe', 'aqecoalesce', 'aqeskew', 'celeborn', 'shufflezstd', 'execsize', 'dynalloc', 'spot', 'decommission', 'maxfailures', 'parquet', 'partitionby', 'partitionfilter', 'zstd', 'targetfiles'] },
      { n: '🚀 Native engine ETL (Gluten)', ids: ['yarn', 'dfapi', 'sqlfuncs', 'gluten', 'aqe', 'aqecoalesce', 'broadcasthint', 'partitionfilter', 'ess', 'offheap', 'execsize', 'dynalloc', 'parquet', 'partitionby', 'compaction'] },
    ],
  };

  const PLATFORMS = ['OSS', 'Dataproc', 'EMR', 'Databricks'];
  const PLATFORM_NAMES = { OSS: 'Open-source Spark', Dataproc: 'Google Dataproc', EMR: 'Amazon EMR', Databricks: 'Databricks' };

  Object.assign(window.DCP, { WORKLOADS, ACHIEVEMENTS, PRESETS, PLATFORMS, PLATFORM_NAMES });
})();
