import { relative } from 'node:path';

export function relPath(p: string): string {
  const r = relative(process.cwd(), p);
  if (r === '') return '.';
  if (r.startsWith('..')) return r;
  return `./${r}`;
}

// A measured zero is a value ("$0"); the dash means unknown (nothing priced, lookup failed).
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(abs >= 1 ? 0 : 2)}`;
}

export function formatInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}
