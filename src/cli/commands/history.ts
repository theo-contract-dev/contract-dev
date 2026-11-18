// `query events --since launch|<date>` (5.0.0; the `history` command before): every firing of some events over a
// contract's whole life, through the platform's event_history tool: how many and when (by day, week or month), how big
// (a formula's value), who (top wallets, repeat wallets), the weekday and hour shape, and examples. A read too long for
// one answer comes back with `resume`; it is asked again (up to two more times) so the terminal gets the whole story.
import { flag, flagAll, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { limitFlag } from '../data';
import { printResult } from './_print';
import { parseRead } from './eventMetric';

/** The periods a history counts by. */
const PERIODS = ['auto', 'day', 'week', 'month'];

/**
 * `query events --each <Event> --since launch|<date>`: the event_history input. `--by` is the period (day, week, month)
 * or wallet, whose top and repeat wallets every history answer carries anyway; `--who` counts by an address field.
 */
export function historyInputFrom(flags: ParsedFlags, events: string[], scope: { kind: 'contract' | 'group' | 'workspace'; contract?: string; group?: string; chainId?: number } | null, address?: string, chainId?: number): Record<string, unknown> {
  const input: Record<string, unknown> = { events, ...(scope ? { scope } : {}), ...(address ? { address, ...(chainId != null ? { chainId } : {}) } : {}) };
  const since = String(flag(flags, 'since') ?? '').trim();
  if (since === 'launch' || since === 'all') input.window = 'all';
  else if (/^\d{4}-\d{2}-\d{2}/.test(since)) input.since = since;
  else throw new Error(`--since takes launch or a UTC date (2026-10-01) (got: ${since || 'nothing'}).`);
  const by = flagAll(flags, 'by').flatMap((b) => b.split(',')).map((b) => b.trim()).filter((b) => b && b !== 'true');
  if (by.length > 1) throw new Error('With --since, --by takes one of day, week, month or wallet.');
  if (by[0] && by[0] !== 'wallet') {
    if (!PERIODS.includes(by[0])) throw new Error(`With --since, --by takes day, week, month or wallet (got: ${by[0]}); to group by anything else, use a --last window.`);
    input.by = by[0];
  }
  for (const [from, to] of [
    ['until', 'until'],
    ['tz', 'timezone'],
    ['who', 'who'],
    ['wallet', 'wallet'],
  ] as const) {
    const v = flag(flags, from);
    if (v !== undefined && v !== 'true') input[to] = v;
  }
  // every read here is read once per contract: the server takes them as fixed
  const reads = flagAll(flags, 'read').map((r) => {
    const { fixed: _fixed, ...rest } = parseRead(r, new Set());
    return rest;
  });
  if (reads.length > 0) input.reads = reads;
  const value = flag(flags, 'value');
  if (value !== undefined && value !== 'true') input.value = value;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 10, 25);
  return input;
}

/** The history read through: a read too long for one answer comes back with `resume`, asked again up to twice unless --once. */
export async function runHistory(flags: ParsedFlags, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const auth = requireAuth();
  let result = await runTool<Record<string, unknown>>(auth, 'event_history', input);
  for (let i = 0; i < 2 && flag(flags, 'once') === undefined && result.complete === false && result.resume === true; i++) {
    console.error(`Read back to ${String(result.from)}; reading further…`);
    result = await runTool<Record<string, unknown>>(auth, 'event_history', input);
  }
  for (const line of printResult(result, { omit: ['definition', 'saved'] })) console.log(line);
  return result;
}
