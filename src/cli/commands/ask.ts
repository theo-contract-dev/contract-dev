// Questions over the platform's tools: find, describe, compare, activity query. Each sends the
// tool its input, prints the answer as tables, and hands --json the tool's own result, so a
// person at the terminal and an agent read the same figures.
import { parseFlags, flag, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag, lookupNames, nameKey, RANGES, servedRangeNote, type Range } from '../data';
import { DASH, chainLabel, fmtAge, fmtInt, fmtPct, fmtUsd, nameOr, plural, shortAddr, table, type Column } from '../view';
import { oracleLines, type ConsoleOracles } from './oracles';
import { STANDARD_LABEL } from './inspect';
import { parseTimeZone } from './report';

const HELP = `contract-dev find / describe — ask the workspace a question

Usage:
  contract-dev find <query>                         What a name points at: contracts (by name, address or a kind word:
                                                    pools, vaults, tokens, nfts, proxies), groups, metrics, monitors,
                                                    reports, destinations
  contract-dev describe <contract> [--chain <id>]   What a watched contract is: kinds, standards, groups, TVL, owner,
                                                    implementation, token; its events and write functions

Examples:
  contract-dev find pools
  contract-dev describe steth
`;

const HELP_WORDS = ['help', '-h', '--help'];

const scopeWords = (label: string | null | undefined): string => (!label || label === 'workspace' ? 'Workspace' : label);

/** --group / --contract / --chain → the tools' scope argument; nothing → the whole workspace. */
export function scopeFromFlags(flags: ParsedFlags): Record<string, unknown> | undefined {
  const group = flag(flags, 'group');
  const contract = flag(flags, 'contract');
  const chainId = chainFlag(flags);
  if (group !== undefined && contract !== undefined) throw new Error('Pick one of --group or --contract.');
  if (group === 'true') throw new Error('--group needs a name');
  if (contract === 'true') throw new Error('--contract needs an address or a watched name');
  const chain = chainId !== undefined ? { chainId } : {};
  if (group !== undefined) return { kind: 'group', group, ...chain };
  if (contract !== undefined) return { kind: 'contract', contract, ...chain };
  if (chainId !== undefined) return { kind: 'workspace', ...chain };
  return undefined;
}

/** --window (or --range), one of the dashboard's windows. */
/** The windows the question tools read: the dashboard's, plus the past hour. */
export const ASK_WINDOWS = ['1h', ...RANGES] as const;
export type AskWindow = (typeof ASK_WINDOWS)[number];

export function windowFlag(flags: ParsedFlags, fallback: Range = '7d'): Range {
  const raw = flag(flags, 'window') ?? flag(flags, 'range');
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (!(ASK_WINDOWS as readonly string[]).includes(v)) throw new Error(`--window must be one of ${ASK_WINDOWS.join(', ')} (got: ${raw})`);
  return v as Range;
}

// ── find ──

export interface FindResult {
  contracts: Array<{ chainId: number; address: string; name: string; groups: string[]; kinds: string[]; standards: string[]; tvlUsd: number | null }>;
  groups: Array<{ group: string; contracts: number }>;
  metrics: Array<{ id: string; label: string | null; kind: string; chainId: number; address: string }>;
  monitors: Array<{ id: string; name: string; kind: string | null; status: string }>;
  reports: Array<{ id: string; name: string; cadence: string }>;
  destinations: Array<{ id: string; kind: string; label: string | null; target: string }>;
}

/** One block per non-empty section: a title with the count, then the table. */
export function findSections(r: FindResult): string[][] {
  const out: string[][] = [];
  const section = <T>(title: string, rows: T[] | undefined, columns: Column<T>[]) => {
    if (!rows?.length) return;
    out.push([`${title} (${fmtInt(rows.length)})`, ...table(rows, columns, '  ')]);
  };
  section('Contracts', r.contracts, [
    { header: 'Chain', value: (c) => chainLabel(c.chainId) },
    { header: 'Name', value: (c) => c.name, max: 32 },
    { header: 'Address', value: (c) => c.address },
    { header: 'Kinds', value: (c) => (c.kinds ?? []).join(', ') },
    { header: 'Groups', value: (c) => (c.groups ?? []).join(', '), max: 32 },
    { header: 'TVL', value: (c) => fmtUsd(c.tvlUsd), align: 'right' },
  ]);
  section('Groups', r.groups, [
    { header: 'Group', value: (g) => g.group },
    { header: 'Contracts', value: (g) => fmtInt(g.contracts), align: 'right' },
  ]);
  section('Metrics', r.metrics, [
    { header: 'Id', value: (m) => m.id },
    { header: 'Label', value: (m) => m.label ?? DASH, max: 40 },
    { header: 'Kind', value: (m) => m.kind },
    { header: 'Chain', value: (m) => chainLabel(m.chainId) },
    { header: 'Address', value: (m) => m.address },
  ]);
  section('Monitors', r.monitors, [
    { header: 'Id', value: (m) => m.id },
    { header: 'Name', value: (m) => m.name, max: 48 },
    { header: 'Kind', value: (m) => m.kind ?? 'custom' },
    { header: 'Status', value: (m) => m.status },
  ]);
  section('Reports', r.reports, [
    { header: 'Id', value: (x) => x.id },
    { header: 'Name', value: (x) => x.name, max: 48 },
    { header: 'Cadence', value: (x) => x.cadence },
  ]);
  section('Destinations', r.destinations, [
    { header: 'Id', value: (d) => d.id },
    { header: 'Kind', value: (d) => d.kind },
    { header: 'Label', value: (d) => d.label ?? DASH, max: 32 },
    { header: 'Target', value: (d) => d.target, max: 40 },
  ]);
  return out;
}

export async function findCommand(args: string[]): Promise<FindResult | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const query = (flags._ as string[]).join(' ').trim();
  if (!query) throw new Error('Say what to find: a name, an address, or a kind word (pools, vaults, tokens).');
  const input: Record<string, unknown> = { query };
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 10, 50);
  const r = await runTool<FindResult>(requireAuth(), 'find', input);
  const sections = findSections(r);
  if (!sections.length) {
    console.log(`Nothing in this workspace matches "${query}".`);
    return r;
  }
  sections.forEach((lines, i) => {
    if (i) console.log('');
    for (const line of lines) console.log(line);
  });
  return r;
}

// ── describe ──

interface DependencyRow {
  to: string;
  selector: string | null;
  name: string | null;
  callType: string;
  calls: number;
  reverts: number;
  lastAt: number | null;
}

export interface Described {
  chainId: number;
  address: string;
  name: string;
  kinds: string[];
  standards: string[];
  groups: string[];
  tvlUsd: number | null;
  owner: string | null;
  implementation: string | null;
  token: { symbol: string; decimals: number | null } | null;
  /** null when no ABI is known */
  events: Array<{ name: string; signature: string; fields: string[] }> | null;
  functions: string[] | null;
  calls: { rows: DependencyRow[]; totals: { calls: number; reverts: number } | null; oracles: ConsoleOracles | null } | null;
}

const FUNCTIONS_SHOWN = 20;

/** The key/value block, then the events, the write functions, and what it calls. */
export function describeLines(d: Described, calleeNames = new Map<string, string>()): string[] {
  const facts: Array<[string, string]> = [
    ['Chain', chainLabel(d.chainId)],
    ['Address', d.address],
    ['Kinds', (d.kinds ?? []).join(', ') || DASH],
    ['Standards', (d.standards ?? []).map((s) => STANDARD_LABEL[s] ?? s).join(', ') || 'none detected'],
    ['Groups', (d.groups ?? []).join(', ') || 'none'],
    ['TVL', fmtUsd(d.tvlUsd)],
    ['Owner', d.owner ?? DASH],
  ];
  if (d.implementation) facts.push(['Implementation', d.implementation]);
  if (d.token) facts.push(['Token', `${d.token.symbol}${d.token.decimals != null ? ` · ${d.token.decimals} decimals` : ''}`]);
  if (d.events === null) facts.push(['ABI', `none known (add one with contract-dev contracts set-abi ${d.address} --abi <file>)`]);
  const width = Math.max(...facts.map(([k]) => k.length));
  const lines = [d.name, ...facts.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`)];

  if (d.events) {
    lines.push('', `Events (${fmtInt(d.events.length)})`);
    if (!d.events.length) lines.push('  The ABI declares no events.');
    else lines.push(...table(d.events, [{ header: 'Name', value: (e) => e.name }, { header: 'Fields', value: (e) => e.fields.join(', ') || DASH }], '  '));
  }
  if (d.functions) {
    const shown = d.functions.slice(0, FUNCTIONS_SHOWN);
    lines.push('', `Write functions (${shown.length < d.functions.length ? `${fmtInt(shown.length)} of ${fmtInt(d.functions.length)}` : fmtInt(d.functions.length)})`);
    if (!shown.length) lines.push('  The ABI declares no write functions.');
    for (const f of shown) lines.push(`  ${f}`);
  }
  if (d.calls) {
    const rows = d.calls.rows ?? [];
    const callees = new Set(rows.map((r) => r.to.toLowerCase()));
    const totals = d.calls.totals;
    const head = totals ? `${plural(callees.size, 'contract')} · ${plural(totals.calls, 'call')} · ${plural(totals.reverts, 'revert')}` : plural(callees.size, 'contract');
    lines.push('', `Calls (last 7d): ${rows.length ? head : 'none out to other contracts'}`);
    if (rows.length) {
      lines.push(
        ...table(
          rows,
          [
            { header: 'Calls into', value: (r) => nameOr(calleeNames.get(nameKey(d.chainId, r.to)), r.to), max: 36 },
            { header: 'Method', value: (r) => r.name ?? r.selector ?? DASH, max: 28 },
            { header: 'Type', value: (r) => (r.callType ?? '').toLowerCase() },
            { header: 'Calls', value: (r) => fmtInt(r.calls), align: 'right' },
            { header: 'Reverts', value: (r) => fmtInt(r.reverts), align: 'right' },
            { header: 'Last', value: (r) => fmtAge(r.lastAt), align: 'right' },
            { header: 'Address', value: (r) => r.to },
          ],
          '  ',
        ),
      );
    }
    const oracles = oracleLines(d.calls.oracles);
    if (oracles.length) lines.push('', ...oracles.map((l) => `  ${l}`));
  }
  return lines;
}

export async function describeCommand(args: string[]): Promise<Described | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const ref = (flags._ as string[]).join(' ').trim();
  if (!ref) throw new Error('Name a contract: its address or its name in the workspace.');
  const chainId = chainFlag(flags);
  const auth = requireAuth();
  const d = await runTool<Described>(auth, 'describe_contract', { contract: ref, ...(chainId !== undefined ? { chainId } : {}) });
  const callees = d.calls?.rows ?? [];
  const names = callees.length ? await lookupNames(auth, callees.map((r) => ({ chainId: d.chainId, address: r.to }))) : new Map<string, string>();
  for (const line of describeLines(d, names)) console.log(line);
  return d;
}

// ── compare ──

const MEASURES = ['transactions', 'activeWallets', 'volumeInUsd', 'volumeOutUsd', 'tvlUsd', 'revertedShare'] as const;
type Measure = (typeof MEASURES)[number];

export interface CompareResult {
  scope: string;
  window: string;
  by: Measure;
  unit: 'count' | 'usd' | 'share';
  rows: Array<{ chainId: number; address: string; name: string; value: number | null; prev: number | null; changePct: number | null }>;
}

/** A figure in the measure's unit: dollars, a share of transactions, or a count. */
export const fmtByUnit = (v: number | null | undefined, unit: string | undefined): string => (unit === 'usd' ? fmtUsd(v) : unit === 'share' ? fmtPct(v) : fmtInt(v));

/** +12% / -3.4% from a percentage the server computed; a dash when there was no base. */
export function fmtChangePct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return DASH;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function measureFlag(flags: ParsedFlags): Measure {
  const raw = flag(flags, 'by');
  if (raw === undefined) return 'transactions';
  const hit = MEASURES.find((m) => m.toLowerCase() === raw.trim().toLowerCase());
  if (!hit) throw new Error(`--by must be one of ${MEASURES.join(', ')} (got: ${raw})`);
  return hit;
}


// ── activity query ──

const QUERY_MEASURES = ['transactions', 'wallets'] as const;
type QueryMeasure = (typeof QUERY_MEASURES)[number];
const DIMENSIONS = ['contract', 'day'] as const;
type Dimension = (typeof DIMENSIONS)[number];

export interface ActivityQueryRow {
  chainId?: number;
  address?: string;
  name?: string;
  day?: string;
  value: number;
}

export interface ActivityQueryResult {
  scope: string;
  window: string;
  measure: QueryMeasure;
  groupBy: Dimension[];
  unavailable: 'store' | null;
  rows: ActivityQueryRow[];
}

const MEASURE_HEADER: Record<QueryMeasure, string> = { transactions: 'Transactions', wallets: 'Wallets' };

const rowLabel = (r: ActivityQueryRow): string => nameOr(r.name, r.address);

/**
 * Grouped by contract and day: one row per contract, one column per day, oldest first, and the window's total. A day with nothing counted prints 0:
 * the store answered, and it counted nothing. Distinct wallets do not add up across days, so
 * the wallets measure gets no total column.
 */
export function pivotLines(rows: ActivityQueryRow[], measure: QueryMeasure): string[] {
  const days = Array.from(new Set(rows.map((r) => r.day ?? ''))).sort();
  const groups = new Map<string, { label: string; byDay: Map<string, number>; total: number }>();
  for (const r of rows) {
    const key = `${r.chainId}:${(r.address ?? '').toLowerCase()}`;
    const g = groups.get(key) ?? { label: rowLabel(r), byDay: new Map<string, number>(), total: 0 };
    const day = r.day ?? '';
    g.byDay.set(day, (g.byDay.get(day) ?? 0) + r.value);
    g.total += r.value;
    groups.set(key, g);
  }
  const list = Array.from(groups.values()).sort((a, b) => b.total - a.total);
  type Group = (typeof list)[number];
  const columns: Column<Group>[] = [
    { header: 'Contract', value: (g) => g.label, max: 40 },
    ...days.map((d): Column<Group> => ({ header: d, value: (g) => fmtInt(g.byDay.get(d) ?? 0), align: 'right' })),
    ...(measure === 'wallets' ? [] : [{ header: 'Total', value: (g: Group) => fmtInt(g.total), align: 'right' as const }]),
  ];
  return table(list, columns);
}

/** Any other grouping: one column per dimension present, then the count. */
export function plainLines(rows: ActivityQueryRow[], groupBy: Dimension[], measure: QueryMeasure): string[] {
  const columns: Column<ActivityQueryRow>[] = [];
  if (groupBy.includes('contract')) columns.push({ header: 'Contract', value: rowLabel, max: 40 });
  if (groupBy.includes('day')) columns.push({ header: 'Day', value: (r) => r.day ?? DASH });
  columns.push({ header: MEASURE_HEADER[measure] ?? 'Value', value: (r) => fmtInt(r.value), align: 'right' });
  return table(rows, columns);
}

