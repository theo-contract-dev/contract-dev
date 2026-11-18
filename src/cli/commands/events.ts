import { parseFlags, flag, flagAll, type ParsedFlags } from './_args';
import { parseRead } from './eventMetric';
import { printResult } from './_print';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, lookupNames, nameKey, RANGES, resolveContract, servedRangeNote } from '../data';
import { EVENT_WINDOWS, lastFlag, lastWindow, SUMMARY_WINDOWS } from '../last';
import { chainLabel, DASH, fmtAge, fmtChange, fmtInt, nameOr, plural, shortAddr, sparkline, table, type Column } from '../view';


const AGGS = ['sum', 'avg', 'min', 'max'] as const;

/** The query_events input from the flags: what to read, keep, show, rank or group. */
interface QueryRow {
  time: string;
  contract: string;
  tx?: string;
  /** Who made it: the smart account when there is one, else the signer; the signer when it differs; a searcher bot. */
  wallet?: { address: string; name: string | null };
  signer?: { address: string; name: string | null };
  searcher?: boolean;
  event: string;
  params?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  value?: string | null;
}

interface QueryResult extends Record<string, unknown> {
  rows?: QueryRow[];
  groups?: Array<Record<string, unknown> & { value: string | null; events: number }>;
  /** The figures that are dollars, by name ('value' for the ranking or the measure). */
  dollars?: string[];
}

/** A figure as the query prints it: dollars grouped with cents under $1,000, other numbers grouped; text as it is. */
export function queryFigure(v: unknown, usd: boolean): string {
  if (v == null) return DASH;
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  const n = Number(s);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const body =
    abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs === 0 ? '0' : usd ? abs.toFixed(2) : abs >= 1 ? abs.toFixed(4).replace(/\.?0+$/, '') : Number(abs.toPrecision(4)).toString();
  return usd ? `${sign}$${body}` : `${sign}${body}`;
}

/** A query's answer: what was read, then one table of the events (or of the groups), its columns the shown fields. */
/** Who made an event, for its row: the wallet's name or short address, the signer when it differs, and a searcher bot. */
function whoText(x: QueryRow): string {
  if (!x.wallet) return DASH;
  const wallet = x.wallet.name ?? shortAddr(x.wallet.address);
  const via = x.signer ? ` via ${x.signer.name ?? shortAddr(x.signer.address)}` : '';
  return `${wallet}${via}${x.searcher ? ' · searcher' : ''}`;
}

export function queryLines(r: QueryResult): string[] {
  const out = printResult(r, { omit: ['definition', 'rows', 'groups', 'dollars', 'more'] });
  const dollars = new Set(r.dollars ?? []);
  if (r.rows) {
    out.push('');
    if (r.rows.length === 0) return [...out, 'No events'];
    const shown = Array.from(new Set(r.rows.flatMap((x) => Object.keys(x.fields ?? {}))));
    const params = shown.length > 0 ? [] : Array.from(new Set(r.rows.flatMap((x) => Object.keys(x.params ?? {}))));
    const ranked = r.rows.some((x) => 'value' in x);
    const columns: Column<QueryRow>[] = [
      { header: 'Time', value: (x) => x.time.slice(0, 16).replace('T', ' ') },
      { header: 'Contract', value: (x) => x.contract, max: 40 },
      ...(new Set(r.rows.map((x) => x.event)).size > 1 ? [{ header: 'Event', value: (x: QueryRow) => x.event }] : []),
      ...shown.map((k) => ({ header: k, value: (x: QueryRow) => queryFigure(x.fields?.[k], dollars.has(k)), max: 44 })),
      ...params.map((k) => ({ header: k, value: (x: QueryRow) => queryFigure(x.params?.[k], false), max: 44 })),
      ...(ranked ? [{ header: 'Value', value: (x: QueryRow) => queryFigure(x.value, dollars.has('value')) }] : []),
      ...(r.rows.some((x) => x.wallet) ? [{ header: 'Who', value: (x: QueryRow) => whoText(x), max: 40 }] : []),
      { header: 'Tx', value: (x) => (x.tx ? `${(x.tx.split('/').pop() ?? x.tx).slice(0, 10)}…` : DASH) },
    ];
    out.push(...table(r.rows, columns));
  }
  if (r.groups) {
    out.push('');
    if (r.groups.length === 0) return [...out, 'No events'];
    // every group's keys, a name beside its address (senderName after sender)
    const keys = Array.from(new Set(r.groups.flatMap((g) => Object.keys(g)))).filter((k) => !['value', 'events', 'unvalued'].includes(k));
    const columns: Column<Record<string, unknown> & { value: string | null; events: number }>[] = [
      ...keys.map((k) => ({ header: k.charAt(0).toUpperCase() + k.slice(1), value: (g: Record<string, unknown>) => String(g[k] ?? DASH), max: 44 })),
      { header: 'Value', value: (g) => queryFigure(g.value, dollars.has('value')) },
      { header: 'Events', value: (g) => g.events.toLocaleString('en-US') },
    ];
    out.push(...table(r.groups, columns));
  }
  if (typeof r.more === 'number' && r.more > 0) out.push('', `${r.more.toLocaleString('en-US')} more; raise --limit to see them.`);
  return out;
}

/** Where `query events` looks: a watched contract or wallet, a group, the whole workspace, or a contract nobody watches by address. */
export interface EventScope {
  contract?: string;
  group?: string;
  address?: string;
  chainId?: number;
}

/** `query events --each <Event> --last <duration>`: the query_events input from the flags: what to read, keep, show, rank or group. */
export function eventsQueryInput(flags: ParsedFlags, events: string[], scope: EventScope): Record<string, unknown> {
  const input: Record<string, unknown> = { events, ...scope };
  const fixed = new Set(flagAll(flags, 'fixed').map((f) => f.trim()));
  const reads = flagAll(flags, 'read').map((r) => parseRead(r, fixed));
  if (reads.length > 0) input.reads = reads;
  const show = flagAll(flags, 'show').map((raw) => {
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(0, eq).trim() : '';
    const expr = eq > 0 ? raw.slice(eq + 1).trim() : '';
    if (!name || !expr) throw new Error('--show takes name=expression: --show "usd=usd(assetAmount, a)".');
    return { name, expr };
  });
  if (show.length > 0) input.show = show;
  for (const key of ['where', 'sort'] as const) {
    const v = flag(flags, key);
    if (v !== undefined && v !== 'true') input[key] = v;
  }
  if (flag(flags, 'asc') === 'true') input.asc = true;
  const by = flagAll(flags, 'by').flatMap((b) => b.split(',')).map((b) => b.trim()).filter((b) => b && b !== 'true');
  if (by.length > 0) input.by = by;
  if (flagAll(flags, 'measure').length > 0) throw new Error('query events adds up with one measure: --sum, --avg, --min or --max "<expr>", or --count.');
  const measures = [...AGGS.flatMap((fn) => flagAll(flags, fn).map((expr) => ({ fn, expr }))), ...(flag(flags, 'count') === 'true' ? [{ fn: 'count' as const }] : [])];
  if (measures.length > 1) throw new Error('One measure per query: --sum, --avg, --min, --max or --count.');
  if (measures.length === 1) input.measure = measures[0];
  // the events tool's own windows, never rounded: 1h, 24h, 7d, 30d, 90d, 365d
  const last = lastFlag(flags);
  if (last !== undefined) input.window = lastWindow(last, EVENT_WINDOWS, 'events', { since: true });
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 20, 100);
  return input;
}

interface EventRow {
  topic0: string;
  name: string | null;
  signature: string | null;
  dormant: boolean;
  fired: number;
  txs: number;
  firstAt: number | null;
  lastAt: number | null;
  spark: number[];
  prev: { fired: number } | null;
  contracts: Array<{ chainId: number; address: string }>;
  contractCount: number;
}

/** The Events tab's answer: names and counts from the activity ledger; the fuller figures (transactions, the previous period, a shape) only when the server has them. */
export interface EventsPayload {
  range: string;
  rows: Partial<EventRow>[];
  totals?: { fired: number; events: number; txs?: number; contracts?: number };
  buckets?: number[];
  prevTotals?: { fired: number } | null;
  abiResolved?: boolean;
  unavailable?: 'store' | 'chain' | null;
}

/** `query events --on <contract>` with no --each: every event the contract (or every watched one) fired in the window, and the ones it declares that never fired. */
export async function eventsSummary(flags: ParsedFlags, contractRef: string | null): Promise<EventsPayload> {
  const last = lastFlag(flags);
  const range = last === undefined ? '24h' : lastWindow(last, SUMMARY_WINDOWS, 'the events summary');
  if (!(RANGES as readonly string[]).includes(range)) throw new Error(`--last on the events summary takes 24h, 7d, 30d or 90d (got: ${last}).`);
  const chainId = chainFlag(flags);
  const limit = limitFlag(flags, 25);
  const auth = requireAuth();
  const contract = contractRef ? await resolveContract(auth, contractRef, chainId) : null;
  const q = new URLSearchParams({ range });
  const chain = contract?.chainId ?? chainId;
  if (chain !== undefined) q.set('chainId', String(chain));
  if (contract) q.set('address', contract.address.toLowerCase());
  const payload = await apiRequest<EventsPayload>(auth, 'GET', `/api/mainnet/console/events?${q.toString()}`, undefined, { timeoutMs: 60_000 });

  const scope = contract ? `${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)}` : chain !== undefined ? `All contracts on ${chainLabel(chain)}` : 'All contracts';
  console.log(`${scope} · events · last ${payload.range ?? range}`);
  const clamped = servedRangeNote(range, payload.range);
  if (clamped) console.log(clamped);
  if (payload.unavailable) {
    console.log(payload.unavailable === 'chain' ? 'Chain not collected: events are recorded for Ethereum, Arbitrum, Avalanche and Sepolia.' : 'Data unavailable. Retry in a moment.');
    return payload;
  }
  // the totals as given, else from the rows (2026-10-27: the route answers names and counts, nothing else, and the
  // summary read a field that was not there)
  const all = payload.rows ?? [];
  const t = payload.totals ?? { fired: all.reduce((n, r) => n + (r.fired ?? 0), 0), events: all.filter((r) => (r.fired ?? 0) > 0).length };
  const change = payload.prevTotals ? ` (${fmtChange(t.fired, payload.prevTotals.fired)} on the previous ${payload.range ?? range})` : '';
  const txs = t.txs != null ? ` · in ${plural(t.txs, 'transaction')}` : '';
  const contracts = !contract && t.contracts != null ? ` · ${plural(t.contracts, 'contract')}` : '';
  console.log(`${plural(t.fired, 'event')} fired${change} · ${plural(t.events, 'kind')}${txs}${contracts}`);
  if (payload.buckets?.length) console.log(`Fired  ${sparkline(payload.buckets)}`);
  if (payload.abiResolved === false) console.log('No ABI for this contract: events are named by their topic.');

  const fired = all.filter((r) => !r.dormant && (r.fired ?? 0) > 0);
  const dormant = all.filter((r) => r.dormant);
  // the columns the rows carry: a ledger answer has a name and a count; the Events tab's fuller rows the rest
  const rich = fired.some((r) => r.txs != null || r.prev != null || r.spark != null || r.lastAt != null);
  console.log('');
  if (!fired.length) console.log('Nothing fired in the window.');
  else {
    const rows = fired.slice(0, limit);
    const names = contract || !rich ? new Map<string, string>() : await lookupNames(auth, rows.flatMap((r) => (r.contracts ?? []).slice(0, 1)));
    const owner = (r: Partial<EventRow>) =>
      r.contractCount === 1 && r.contracts?.[0] ? nameOr(names.get(nameKey(r.contracts[0].chainId, r.contracts[0].address)), r.contracts[0].address) : plural(r.contractCount ?? 0, 'contract');
    const columns: Column<Partial<EventRow>>[] = [
      { header: 'Event', value: (r) => r.signature ?? r.name ?? (r.topic0 ? shortAddr(r.topic0) : DASH), max: 48 },
      ...(contract || !rich ? [] : [{ header: 'Contract', value: owner, max: 28 } as Column<Partial<EventRow>>]),
      { header: 'Fired', value: (r) => fmtInt(r.fired), align: 'right' },
    ];
    if (rich)
      columns.push(
        { header: 'Change', value: (r) => fmtChange(r.fired ?? 0, r.prev?.fired), align: 'right' },
        { header: 'Transactions', value: (r) => fmtInt(r.txs), align: 'right' },
        { header: 'Last', value: (r) => fmtAge(r.lastAt), align: 'right' },
        { header: 'Shape', value: (r) => sparkline(r.spark ?? [], { width: 24 }) },
      );
    for (const line of table(rows, columns)) {
      console.log(line);
    }
    if (fired.length > rows.length) console.log(`… ${fmtInt(fired.length - rows.length)} more (--limit, or --json for all)`);
  }
  if (dormant.length) {
    const shown = dormant.slice(0, 12).map((r) => r.name ?? (r.topic0 ? shortAddr(r.topic0) : DASH));
    console.log(`\nDeclared but not fired: ${shown.join(', ')}${dormant.length > shown.length ? `, … ${fmtInt(dormant.length - shown.length)} more` : ''}`);
  }
  return payload;
}
