/**
 * useDashboardData — the entire pond-ts pipeline behind the dashboard
 * lives here. Sections downstream are pure renderers of this hook's
 * return value.
 *
 * Reading order, top to bottom, mirrors the data flow:
 *
 *   1. LiveSeries (the only mutable buffer)
 *   2. eviction listener
 *   3. windowed snapshot         ← every chart reads from this
 *   4. host model + colour map
 *   5. CPU section derivations   (partitionBy → baseline → toMap)
 *   6. EMA trend (whole-series smooth)
 *   7. static threshold line     (useTimeSeries)
 *   8. high-CPU filter           (TimeSeries.filter)
 *   9. bar chart buckets         (aggregate either anomalies or alerts)
 *  10. Requests section          (partitionBy → smooth → toMap)
 *  11. roll-up scalars
 */
import { useEffect, useMemo, useState } from 'react';
import {
  useCurrent,
  useLiveSeries,
  useTimeSeries,
  useWindow,
} from '@pond-ts/react';
import {
  Sequence,
  TimeSeries,
  type LiveSeries,
  type SeriesSchema,
} from 'pond-ts';
import {
  type ChartBand,
  type ChartDots,
  type ChartPoint,
  type ChartSeries,
} from './Chart';
import { type Bar } from './BarChart';
import {
  HIGH_CPU_THRESHOLD,
  HOSTS,
  PALETTE,
  WINDOW_MS,
  baselineSchema,
  schema,
} from './dashboardSchema';

export type ChartOpts = {
  /** Toggle between threshold mode (off) and anomaly mode (on). */
  showBands: boolean;
  /** Overlay the unsmoothed per-host samples behind the smoothed line. */
  showRaw: boolean;
  /** Band width in standard deviations. */
  sigma: number;
  /** Tick rate of the simulator — used to convert per-event request counts to req/sec. */
  eventsPerSec: number;
};

export type DashboardArgs = {
  hostCount: number;
  disabledHosts: Set<string>;
  chartOpts: ChartOpts;
};

export type DashboardData = {
  liveSeries: LiveSeries<typeof schema>;

  // basic counters
  totalEvents: number;
  totalRequests: number | undefined;
  evictedTotal: number;

  // host model
  hosts: readonly string[];
  enabledHosts: Set<string>;
  hostColors: Record<string, string>;

  // CPU section
  rollingCpu: number | undefined;
  trendCpu: number | undefined;
  cpuChartSeries: ChartSeries[];
  cpuBands: ChartBand[];
  cpuDots: ChartDots[];
  cpuAnomalyCount: number;
  cpuAlertCount: number;
  bars: Bar[];

  // Requests section
  reqSeries: ChartSeries[];
  totalReqPerSec: number;

  // Logs section — raw windowed snapshot.
  timeSeries: TimeSeries<typeof schema> | null;

  // Shared time axis for both the CPU and Requests charts.
  tStart: number | undefined;
  tEnd: number | undefined;
};

export function useDashboardData(args: DashboardArgs): DashboardData {
  const { hostCount, disabledHosts, chartOpts } = args;
  const { showBands, showRaw, sigma, eventsPerSec } = chartOpts;

  // 1. LiveSeries — the single mutable buffer for ingest.
  //    Retention by time so the windowed snapshot below has at least
  //    its full window of data after a fresh page load.
  const [liveSeries, snapshot] = useLiveSeries(
    {
      name: 'metrics',
      schema,
      retention: { maxAge: '6m' },
    },
    { throttle: 200 },
  );

  // 2. Eviction counter — demonstrates `liveSeries.on('evict', cb)`.
  const [evictedTotal, setEvictedTotal] = useState(0);
  useEffect(() => {
    return liveSeries.on('evict', (events) => {
      setEvictedTotal((n) => n + events.length);
    });
  }, [liveSeries]);

  // 3. Throttled 5-min windowed snapshot. `useWindow` owns the live
  //    view subscription; what we get back is an immutable TimeSeries
  //    we can chain transforms on without worrying about live mutation.
  const timeSeries = useWindow(liveSeries, '5m', { throttle: 200 });

  // 4. Host model: active slice (from the simulator's hostCount) and
  //    the user-toggled enabled set.
  const hosts = useMemo(
    () => HOSTS.slice(0, hostCount) as readonly string[],
    [hostCount],
  );
  const enabledHosts = useMemo(() => {
    const set = new Set<string>();
    for (const h of hosts) if (!disabledHosts.has(h)) set.add(h);
    return set;
  }, [hosts, disabledHosts]);
  const hostColors = useMemo(() => {
    const map: Record<string, string> = {};
    hosts.forEach((h, i) => (map[h] = PALETTE[i % PALETTE.length]));
    return map;
  }, [hosts]);

  // 5. Whole-source rollups (computed live, not from the window).
  //    `useCurrent` is sugar for `useSnapshot(src).tail(t).reduce(map)`.
  const { requests: totalRequests } = useCurrent(
    liveSeries,
    { requests: 'sum' },
    { throttle: 500 },
  );
  const { cpu: rollingCpu } = useCurrent(
    liveSeries,
    { cpu: 'avg' },
    { tail: '1m', throttle: 200 },
  );

  // 6. Time axis pinned to the latest event with a fixed back-window.
  const tEnd = timeSeries?.last()?.key().timestampMs();
  const tStart = tEnd != null ? tEnd - WINDOW_MS : undefined;

  // 7. CPU section — per-host bands, smoothed lines, anomaly dots.
  //    The pond pipeline:
  //      partitionBy('host')                       ← scope per-host
  //        .baseline('cpu', { window, sigma })     ← single rolling pass,
  //                                                  appends avg/sd/upper/lower
  //        .toMap(g => g.toPoints())               ← Map<host, wide rows>
  //
  //    `toMap(fn)` runs `fn` per partition and returns the result map
  //    directly — no `.collect()` round-trip, no extra `groupBy` pass.
  //    Each host's rows already have every column we need; the local
  //    loop just splits them into the chart's per-purpose arrays.
  const cpu = useMemo(() => {
    const series: ChartSeries[] = [];
    const bands: ChartBand[] = [];
    const dots: ChartDots[] = [];
    const allAnomalies: ChartPoint[] = [];
    if (!timeSeries) return { series, bands, dots, allAnomalies };

    // Pipeline notes:
    //   - `materialize(every 500ms)` regularises each host's events onto a
    //     fixed grid. Empty buckets get `cpu: undefined`, which propagates
    //     through `baseline` so its avg/sd/upper/lower are also undefined
    //     wherever there's no source data. Combined with
    //     `connectNulls={false}` on the chart, that renders as a visible
    //     break instead of a line drawn across the gap.
    //   - `partitionBy('host').materialize(...)` is the partition-aware
    //     overload — it auto-populates the `host` column on the empty rows
    //     it inserts, which the bare `TimeSeries.materialize` would leave
    //     undefined.
    const perHostRows = timeSeries
      .partitionBy('host')
      .materialize(Sequence.every('500ms'))
      .baseline('cpu', { window: '1m', sigma })
      .toMap((g) => g.toPoints());

    // Stand-in for `minSamples` until pond-ts gates rolling output on
    // defined-sample count. Without it, baseline keeps emitting an avg
    // computed from very few materialized cells in the trailing 1-min
    // window — producing the long flat "staircase" sections that show
    // up after the simulator is throttled (background tab) and resumes
    // sparse data. With it, sparse regions emit undefined avg/sd/upper/
    // lower, the chart's `connectNulls={false}` shows breaks there, and
    // the paired Scatter renders any isolated defined cells.
    const MIN_SAMPLES = 30;
    const ROLLING_MS = 60_000;

    for (const host of hosts) {
      if (!enabledHosts.has(host)) continue;
      const rows = perHostRows.get(host);
      if (!rows) continue;
      const color = hostColors[host];

      const upper: ChartPoint[] = [];
      const lower: ChartPoint[] = [];
      const anomalies: ChartPoint[] = [];
      const rawPoints: ChartPoint[] = [];
      const smoothPoints: ChartPoint[] = [];
      let lastAvg: number | undefined;

      // Two-pointer sliding window: at each row `i`, `definedCount` is
      // the number of rows in (rows[i].ts - 60s .. rows[i].ts] whose
      // `cpu` value is defined.
      let left = 0;
      let definedCount = 0;

      // Push a point at every materialized timestamp — including the
      // ones where `cpu` / `avg` / etc. are undefined (gap cells), so
      // the chart's `connectNulls={false}` renders the gap as a break.
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.cpu != null) definedCount++;
        while (left < i && rows[left].ts < r.ts - ROLLING_MS) {
          if (rows[left].cpu != null) definedCount--;
          left++;
        }
        // Below threshold → mask the rolling outputs. Raw `cpu` is
        // unaffected so the optional raw-samples overlay still shows
        // the underlying points.
        const reliable = definedCount >= MIN_SAMPLES;
        const avg = reliable ? r.avg : undefined;
        const hi = reliable ? r.upper : undefined;
        const lo = reliable ? r.lower : undefined;

        rawPoints.push({ ts: r.ts, value: r.cpu });
        smoothPoints.push({ ts: r.ts, value: avg });
        if (avg != null) lastAvg = avg;
        upper.push({ ts: r.ts, value: hi });
        lower.push({ ts: r.ts, value: lo });
        if (
          r.cpu != null &&
          hi != null &&
          lo != null &&
          (r.cpu > hi || r.cpu < lo)
        ) {
          anomalies.push({ ts: r.ts, value: r.cpu });
        }
      }

      if (showRaw) {
        series.push({
          name: `${host} raw`,
          color,
          width: 0.75,
          opacity: 0.35,
          hideFromLegend: true,
          points: rawPoints,
        });
      }
      series.push({
        name: host,
        color,
        stat:
          lastAvg != null ? `${(lastAvg * 100).toFixed(0)}%` : undefined,
        points: smoothPoints,
      });
      if (showBands && upper.length >= 2) {
        bands.push({ name: host, color, upper, lower });
        if (anomalies.length > 0) {
          dots.push({ name: host, color: '#e23b3b', points: anomalies });
          allAnomalies.push(...anomalies);
        }
      }
    }

    return { series, bands, dots, allAnomalies };
  }, [timeSeries, hosts, enabledHosts, hostColors, showBands, showRaw, sigma]);

  // 8. EMA-smoothed trend across all hosts (summary stat only).
  const trendCpu = useMemo(() => {
    if (!timeSeries || timeSeries.length === 0) return undefined;
    return timeSeries
      .smooth('cpu', 'ema', { alpha: 0.3, output: 'cpuTrend' })
      .last()
      ?.get('cpuTrend');
  }, [timeSeries]);

  // 9. Static 70%-threshold line, mounted via `useTimeSeries`. Two rows
  //    spanning ±1h around mount; the chart clips it to the visible
  //    window. Demonstrates the static-data path.
  const baselineInput = useMemo(() => {
    const now = Date.now();
    const rows: [number, number][] = [
      [now - 3_600_000, HIGH_CPU_THRESHOLD],
      [now + 3_600_000, HIGH_CPU_THRESHOLD],
    ];
    return { name: 'threshold', schema: baselineSchema, rows };
  }, []);
  const baselineTs = useTimeSeries(baselineInput);
  const thresholdValue = baselineTs?.first()?.get('cpu') as
    | number
    | undefined;
  const thresholdPoints =
    thresholdValue != null && tStart != null && tEnd != null
      ? [
          { ts: tStart, value: thresholdValue },
          { ts: tEnd, value: thresholdValue },
        ]
      : [];

  // 10. Final chart series. In threshold mode we append the dashed red
  //     reference line; in anomaly mode the bands + dots speak for it.
  const cpuChartSeries: ChartSeries[] = showBands
    ? cpu.series
    : [
        ...cpu.series,
        {
          name: 'threshold',
          color: '#e23b3b',
          points: thresholdPoints,
          dashed: true,
        },
      ];

  // 11. High-CPU filter: events from enabled hosts where cpu > threshold.
  //     Used for the "Alerts" stat AND as the source for the threshold-mode
  //     bar chart bucketing. Filtering on `timeSeries` (a snapshot) so the
  //     enabledHosts set can change without rebuilding a LiveView.
  const highCpuFiltered = useMemo(() => {
    if (!timeSeries) return null;
    return timeSeries.filter(
      (e) =>
        enabledHosts.has(e.get('host')) && e.get('cpu') > HIGH_CPU_THRESHOLD,
    );
  }, [timeSeries, enabledHosts]);

  // 12. Bar chart buckets: 15-second bins of either anomalies (band mode)
  //     or alerts (threshold mode). Both paths end in `aggregate(...)
  //     → iterate buckets → push Bar`.
  const bars: Bar[] = useMemo(() => {
    if (tStart == null || tEnd == null) return [];

    if (showBands) {
      // Band mode: round-trip the flat anomaly points back into a tiny
      // TimeSeries via `fromPoints` so we can use pond's bucketing.
      if (cpu.allAnomalies.length === 0) return [];
      const anomalyTs = TimeSeries.fromPoints(cpu.allAnomalies, {
        name: 'anomalies',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number' },
        ] as const,
      });
      return aggregateToBars(
        anomalyTs.aggregate(Sequence.every('15s'), { value: 'count' }),
        'value',
        tStart,
        tEnd,
      );
    }

    // Threshold mode: aggregate the live filter directly.
    if (!highCpuFiltered || highCpuFiltered.length === 0) return [];
    return aggregateToBars(
      highCpuFiltered.aggregate(Sequence.every('15s'), { cpu: 'count' }),
      'cpu',
      tStart,
      tEnd,
    );
  }, [showBands, cpu.allAnomalies, highCpuFiltered, tStart, tEnd]);

  // 13. Requests: per-host smoothed lines + 1-min rolling avg as legend stat.
  //     Same partition pattern as CPU; two `partitionBy.toMap(...)` calls
  //     produce the per-host smoothed points and the per-host scalar avg.
  const reqSeries = useMemo<ChartSeries[]>(() => {
    if (!timeSeries) return [];
    const eps = eventsPerSec;
    const perHostSmooth = timeSeries
      .partitionBy('host')
      .smooth('requests', 'ema', { alpha: 0.25 })
      .toMap((g) => g.slice(12).toPoints());
    const perHostAvg = timeSeries
      .partitionBy('host')
      .toMap((g) => g.tail('1m').reduce({ requests: 'avg' }).requests);

    const out: ChartSeries[] = [];
    for (const host of hosts) {
      if (!enabledHosts.has(host)) continue;
      const rows = perHostSmooth.get(host) ?? [];
      const rollingAvg = perHostAvg.get(host);
      out.push({
        name: host,
        color: hostColors[host],
        stat:
          rollingAvg != null
            ? `${(rollingAvg * eps).toFixed(0)}/s`
            : undefined,
        points: rows.flatMap((r) =>
          r.requests == null
            ? []
            : [{ ts: r.ts, value: r.requests * eps }],
        ),
      });
    }
    return out;
  }, [timeSeries, hosts, enabledHosts, hostColors, eventsPerSec]);

  // 14. Total req/sec across visible hosts — sum of the latest point per series.
  const totalReqPerSec = reqSeries.reduce((sum, s) => {
    const last = s.points[s.points.length - 1];
    return sum + (last?.value ?? 0);
  }, 0);

  return {
    liveSeries,
    totalEvents: snapshot?.length ?? 0,
    totalRequests,
    evictedTotal,
    hosts,
    enabledHosts,
    hostColors,
    rollingCpu,
    trendCpu,
    cpuChartSeries,
    cpuBands: cpu.bands,
    cpuDots: cpu.dots,
    cpuAnomalyCount: cpu.allAnomalies.length,
    cpuAlertCount: highCpuFiltered?.length ?? 0,
    bars,
    reqSeries,
    totalReqPerSec,
    timeSeries,
    tStart,
    tEnd,
  };
}

/**
 * Helper: turn a bucketed TimeSeries (output of `aggregate(seq,
 * { col: 'count' })`) into the bar chart's flat `Bar[]` shape, clipped
 * to the visible time axis.
 */
function aggregateToBars(
  buckets: TimeSeries<SeriesSchema>,
  col: string,
  tStart: number,
  tEnd: number,
): Bar[] {
  const out: Bar[] = [];
  for (const e of buckets) {
    const start = e.key().begin();
    const end = e.key().end();
    if (end < tStart || start > tEnd) continue;
    // Bucket events are dynamically typed (`SeriesSchema`); the count
    // reducer always emits `number | undefined`.
    out.push({
      start,
      end,
      count: ((e.data() as Record<string, unknown>)[col] as number | undefined) ?? 0,
    });
  }
  return out;
}
