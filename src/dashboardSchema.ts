/**
 * Shared schema, constants, and types for the dashboard.
 *
 * All chart sections derive from a single LiveSeries shaped by the
 * `schema` const below. Declaring it as `as const` lets pond-ts narrow
 * the column types end-to-end — `event.get('cpu')` returns `number`,
 * `event.get('host')` returns `string`, no casts.
 */

/** The metric event schema. Each push is `[time, cpu, requests, host]`. */
export const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

/**
 * Two-column schema for the static threshold line. Used with
 * `useTimeSeries` to mount a fixed series the chart overlays in
 * threshold mode.
 */
export const baselineSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
] as const;

/** Visible time axis for every chart in the dashboard. */
export const WINDOW_MS = 5 * 60 * 1000;

/**
 * Closed host pool. Declaring as `as const` gives downstream
 * `pivotByGroup`/`partitionBy` type inference a fixed set to work with;
 * the simulator slices by `hostCount` for the active subset.
 */
export const HOSTS = [
  'api-1',
  'api-2',
  'api-3',
  'api-4',
  'api-5',
  'api-6',
  'api-7',
  'api-8',
] as const;

/**
 * Per-host CPU mean. Each host gets a distinct baseline so the chart
 * shows separable lines under bands.
 */
export const HOST_MEANS: readonly number[] = [
  0.55, 0.45, 0.65, 0.5, 0.6, 0.4, 0.7, 0.35,
];

/** Chart line/band colours. Indexed by host position in `HOSTS`. */
export const PALETTE = [
  '#4c8bf5',
  '#2ec27e',
  '#a76bf5',
  '#f59f4c',
  '#3bc3c3',
  '#e28bd8',
];

/** Threshold for "high CPU" alerts in non-anomaly mode. */
export const HIGH_CPU_THRESHOLD = 0.7;

/** Empty-state singleton so a never-discovered host list keeps a stable identity. */
export const NO_HOSTS: readonly string[] = [];
