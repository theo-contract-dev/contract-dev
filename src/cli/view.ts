// Text output for the data commands (activity, methods, flows, users, tvl, …): aligned
// tables, compact numbers, ages and sparklines. Pure functions that return strings, so the
// commands print them and the tests read them.
//
// The numbers follow the app's rules: a measured zero prints as `0`; the dash means unknown
// (the figure could not be read, or does not apply).

export const DASH = '—';

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Numbers read best right-aligned. */
  align?: 'left' | 'right';
  /** Clip longer cells with an ellipsis (labels, method signatures). */
  max?: number;
}

function clip(s: string, max: number | undefined): string {
  if (!max || s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** Rows as aligned columns under a header line, two spaces apart. */
export function table<T>(rows: T[], columns: Column<T>[], indent = ''): string[] {
  const cells = rows.map((row) => columns.map((c) => clip(c.value(row), c.max)));
  const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((r) => r[i].length)));
  const line = (values: string[]) =>
    indent +
    values
      .map((v, i) => (columns[i].align === 'right' ? v.padStart(widths[i]) : i === values.length - 1 ? v : v.padEnd(widths[i])))
      .join('  ')
      .replace(/\s+$/, '');
  return [line(columns.map((c) => c.header)), ...cells.map(line)];
}

// ── numbers ──────────────────────────────────────────────────────────────

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** 1,234 — whole numbers grouped. */
export function fmtInt(v: number | null | undefined): string {
  return finite(v) ? Math.round(v).toLocaleString('en-US') : DASH;
}

/** 950 · 12.4K · 3.21M · 1.05B — counts and amounts at a glance. */
export function fmtCompact(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const step = (x: number, unit: string) => `${sign}${x.toFixed(x < 10 ? 2 : x < 100 ? 1 : 0)}${unit}`;
  if (abs >= 1e12) return step(abs / 1e12, 'T');
  if (abs >= 1e9) return step(abs / 1e9, 'B');
  if (abs >= 1e6) return step(abs / 1e6, 'M');
  if (abs >= 1e4) return step(abs / 1e3, 'K');
  if (abs >= 100 || Number.isInteger(abs)) return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)}`;
  if (abs === 0) return '0';
  return `${sign}${abs.toPrecision(3)}`;
}

/** $12.4K · $3.21M — a dollar value; $0 is a value, the dash is unknown. */
export function fmtUsd(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(abs >= 1 || abs === 0 ? 0 : 2)}`;
}

/** +$1.2M / -$40.0K — a signed dollar change. */
export function fmtUsdSigned(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  return v > 0 ? `+${fmtUsd(v)}` : fmtUsd(v);
}

/** 12.5% from a fraction (0.125). */
export function fmtPct(fraction: number | null | undefined, digits = 1): string {
  if (!finite(fraction)) return DASH;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** The change from `prev` to `now` as +12% / -3% — a dash when there is no base to compare. */
export function fmtChange(now: number | null | undefined, prev: number | null | undefined): string {
  if (!finite(now) || !finite(prev) || prev === 0) return DASH;
  const pct = ((now - prev) / prev) * 100;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

// ── time ─────────────────────────────────────────────────────────────────

/** How long ago, compactly: 42s · 12m · 3h · 2d. */
export function fmtAge(ms: number | null | undefined, now = Date.now()): string {
  if (!finite(ms) || ms <= 0) return DASH;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** 2026-10-01 03:19 UTC — an absolute time that reads the same on every machine. */
export function fmtTime(ms: number | null | undefined): string {
  if (!finite(ms) || ms <= 0) return DASH;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// ── shapes ───────────────────────────────────────────────────────────────

const BARS = '▁▂▃▄▅▆▇█';

/**
 * A series as one line of block characters, at most `width` wide (longer series keep the last
 * value of each stretch). Counts sit on a zero floor; a level such as value held is drawn
 * between its own low and high (`floor: 'min'`), or a 0.7% move would be a flat line.
 */
export function sparkline(values: Array<number | null | undefined>, opts: { floor?: 'zero' | 'min'; width?: number } = {}): string {
  const width = opts.width ?? 48;
  let series = values;
  if (series.length > width) {
    const step = series.length / width;
    series = Array.from({ length: width }, (_, i) => {
      for (let j = Math.min(series.length, Math.round((i + 1) * step)) - 1; j >= Math.round(i * step); j--) if (finite(series[j])) return series[j];
      return null;
    });
  }
  const known = series.filter(finite);
  if (series.length === 0 || known.length === 0) return '';
  const max = Math.max(...known, opts.floor === 'min' ? -Infinity : 0);
  const min = Math.min(...known, opts.floor === 'min' ? Infinity : 0);
  return series
    .map((v) => {
      if (!finite(v)) return ' ';
      if (max === min) return opts.floor === 'min' ? BARS[3] : BARS[0];
      return BARS[Math.min(BARS.length - 1, Math.floor(((v - min) / (max - min)) * (BARS.length - 1) + 0.5))];
    })
    .join('');
}

/** 0x1234…abcd */
export const shortAddr = (address: string | null | undefined): string =>
  address ? (address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address) : DASH;

/** A name when one is known, the short address otherwise. */
export const nameOr = (name: string | null | undefined, address: string | null | undefined): string =>
  name && name.trim() ? name : shortAddr(address);

const CHAIN_LABELS: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB',
  137: 'Polygon',
  143: 'Monad',
  8453: 'Base',
  42161: 'Arbitrum',
  43114: 'Avalanche',
  11155111: 'Sepolia',
};

export const chainLabel = (chainId: number | null | undefined): string =>
  chainId == null ? DASH : CHAIN_LABELS[chainId] ?? `Chain ${chainId}`;

/** "1 transaction" / "3 transactions" */
export const plural = (n: number, one: string, many = `${one}s`): string => `${fmtInt(n)} ${n === 1 ? one : many}`;
