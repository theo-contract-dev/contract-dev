// `--last <duration>` (5.0.0): how far back a question or a table reaches, in one word for every command, in place of
// --days. A duration is a whole number and a unit, h, d or w: 1h, 24h, 7d, 30d, 2w, 365d. Events are read over the
// events tool's own windows; every other set of rows counts in whole days.
import { flag, type ParsedFlags } from './commands/_args';

/** The windows the events tool reads (the server's AGENT_WINDOWS), by their length in hours. */
export const EVENT_WINDOWS: Record<number, string> = { 1: '1h', 24: '24h', 168: '7d', 720: '30d', 2160: '90d', 8760: '365d' };
/** The windows the which-events-fired summary reads (RANGES), by their length in hours. */
export const SUMMARY_WINDOWS: Record<number, string> = { 24: '24h', 168: '7d', 720: '30d', 2160: '90d' };

const HOURS: Record<string, number> = { h: 1, d: 24, w: 168 };

/** A duration as hours: `1h` 1, `7d` 168, `2w` 336. Anything else is refused with an example. */
export function parseLast(raw: string): number {
  const m = /^(\d+)\s*([hdw])$/i.exec(raw.trim());
  const n = m ? Number(m[1]) : 0;
  if (!m || !Number.isSafeInteger(n) || n < 1)
    throw new Error(`--last takes a number and h, d or w: --last 1h, --last 7d, --last 30d, --last 2w (got: ${raw.trim() || 'nothing'}).`);
  return n * HOURS[m[2].toLowerCase()];
}

/** The --last a command was given, as typed; undefined when it was not. A bare --last is refused. */
export function lastFlag(flags: ParsedFlags): string | undefined {
  const raw = flag(flags, 'last');
  if (raw === undefined) return undefined;
  if (raw === 'true') throw new Error('--last takes a duration: --last 1h, --last 7d, --last 30d.');
  // --last was a measure until 5.0.0 (the last value of each group): an expression here is that, said where it went
  if (!/^\s*\d+\s*[hdw]\s*$/i.test(raw) && /[^0-9a-z\s]|^[a-z_]/i.test(raw.trim()))
    throw new Error(`--last is how far back now: --last 1h, --last 7d, --last 30d (got: ${raw.trim()}). The last value of each group is --measure <name>="last(${raw.trim()})".`);
  return raw;
}

/** One of `windows` for a duration, never rounded: a length it does not have is refused with the ones it has. */
export function lastWindow(raw: string, windows: Record<number, string>, what: string, opts: { since?: boolean } = {}): string {
  const w = windows[parseLast(raw)];
  if (!w) {
    const said = Object.values(windows).map((x) => (x === '24h' ? '24h (1d)' : x === '7d' ? '7d (1w)' : x));
    throw new Error(`--last on ${what} takes ${said.join(', ')} (got: ${raw.trim()})${opts.since ? '; for the whole history, --since launch' : ''}.`);
  }
  return w;
}

/** A duration in whole days, for rows that count in days; an hour that is no whole day is refused, naming them. */
export function lastDays(raw: string, what: string): number {
  const h = parseLast(raw);
  if (h % 24 !== 0) throw new Error(`${what} count in whole days: --last 1d and up (got: ${raw.trim()}).`);
  return h / 24;
}

/** --days, gone in 5.0.0: refused with the word that replaces it. */
export function refuseDays(flags: ParsedFlags, help: string): void {
  if (flag(flags, 'days') !== undefined) throw new Error(`--days is gone: say --last <n>d (contract-dev ${help} help).`);
}
