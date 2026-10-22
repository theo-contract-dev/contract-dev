import { parseFlags, flag, flagAll, type ParsedFlags } from './_args';
import { saveFromFlags, savedLine } from './_save';
import { parseRead } from './eventMetric';
import { runTool } from '../tools';
import { printResult } from './_print';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, lookupNames, nameKey, parseRange, RANGES, resolveContract, servedRangeNote } from '../data';
import { chainLabel, DASH, fmtAge, fmtChange, fmtInt, nameOr, plural, shortAddr, sparkline, table, type Column } from '../view';

const HELP = `contract-dev events — what your contracts emitted, event by event

Usage:
  contract-dev events [<contract>] [flags]     Every event fired in the window: how often, in how many
                                               transactions, against the previous window; with a contract,
                                               the events its ABI declares that never fired too

Flags:
  --range 24h|7d|30d|90d   Window (default 24h; Free workspaces keep 24h)
  --chain <id|name>        One chain
  --limit <n>              Rows to print (default 25)

<contract> is an address or a watched contract's name. For the logs themselves, newest
first, use \`contract-dev activity <contract> --events\`. Add --json for everything.

Query (with --event): the events themselves, worked through formulas, in the language of metric define
  contract-dev events [<contract> | --group <group> | --address 0x… --chain <id>] --event <Name> [--event …] [--chain <id|name>]
                      [--read "<name>=<call> [on <target>] [with <arg>, …]"]… [--fixed <read>]…
                      [--show "<name>=<expr>"]… [--where "<expr>"] [--sort "<expr>" [--asc]]
                      [--by contract|day|week|sender|<name>]… [--sum|--avg|--min|--max "<expr>" | --count]
                      [--window 1h|24h|7d|30d|90d] [--limit <n>]
  --sort ranks the events, largest first (newest first without it); --by groups them and --sum, --avg,
  --min, --max or --count adds each group up. Tokens are named in the formula: usd(raw, token),
  amount(raw, token), the token an address, a read or a parameter (\`contract-dev describe <contract>\` shows each
  field's token as checked against the contract's transactions). Each event is priced on its own day. Each listed
  event says who made it: the wallet (a smart account when there is one), the signer it came via, a searcher bot.
  A --sort on a field, abs(), usd()/amount() of one or max() of those (no --where) ranks the whole window; any
  other reads the newest 10,000 events (1,000 with a read per transaction) and says where it started.
  --address reads a contract nobody watches (a position manager, a factory, a pool) straight from the chain's
  log history, narrowed: a --where equality on an indexed field (to == 0x…) is applied by the log index itself,
  or --window is 7d at most. With no verified ABI, write the event as its full signature.

  --save [bars|stacked|diverging|line|table]  Keep the answer at a page in the app (a chart or a table) and print its link; --title names the page

Examples:
  contract-dev events 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640 --event Swap --read "t0=token0()" --fixed t0 \\
    --sort "usd(abs(amount0), t0)" --limit 10
  contract-dev events --group "Wildcat markets" --event Deposit --read "a=asset()" --fixed a \\
    --where "usd(assetAmount, a) > 100000" --show "usd=usd(assetAmount, a)"
  contract-dev events --group "Uniswap v3" --event Swap --read "t0=token0()" --fixed t0 \\
    --by contract --by day --sum "usd(abs(amount0), t0)" --window 7d
  contract-dev events --address 0xC36442b4a4522E871399CD717aBDD847Ab11FE88 --chain 1 --event Transfer \\
    --where "to == 0xMYWALLET" --window 90d
`;

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

export function queryInput(flags: ParsedFlags): Record<string, unknown> {
  const events = flagAll(flags, 'event').flatMap((e) => e.split(',')).map((e) => e.trim()).filter((e) => e && e !== 'true');
  if (events.length === 0) throw new Error('Name the events: --event Swap (contract-dev events <contract> lists them).');
  const input: Record<string, unknown> = { events };
  const ref = (flags._ as string[]).join(' ').trim();
  const group = flag(flags, 'group');
  const address = flag(flags, 'address');
  const chain = chainFlag(flags);
  if (address === 'true') throw new Error('--address needs a 0x address (and --chain).');
  if (address && (ref || (group && group !== 'true'))) throw new Error('Give --address, or a contract or --group, not both.');
  if (address) input.address = address;
  else if (ref) input.contract = ref;
  else if (group && group !== 'true') input.group = group;
  if (chain !== undefined) input.chainId = chain;
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
  const measures = [...AGGS.flatMap((fn) => flagAll(flags, fn).map((expr) => ({ fn, expr }))), ...(flag(flags, 'count') === 'true' ? [{ fn: 'count' as const }] : [])];
  if (measures.length > 1) throw new Error('One measure per query: --sum, --avg, --min, --max or --count.');
  if (measures.length === 1) input.measure = measures[0];
  const window = flag(flags, 'window');
  if (window !== undefined) input.window = window;
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

export interface EventsPayload {
  range: string;
  rows: EventRow[];
  totals: { fired: number; events: number; txs: number; contracts: number };
  buckets: number[];
  prevTotals: { fired: number } | null;
  abiResolved: boolean;
  unavailable?: 'store' | 'chain';
}

export async function eventsCommand(args: string[]): Promise<EventsPayload | void> {
  if (['help', '-h', '--help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  // with --event: the events themselves, through formulas (query_events)
  if (flagAll(flags, 'event').some((e) => e !== 'true')) {
    const save = saveFromFlags(flags);
    const r = await runTool<QueryResult>(requireAuth(), 'query_events', { ...queryInput(flags), ...(save ? { save } : {}) });
    for (const line of queryLines(r)) console.log(line);
    const saved = savedLine(r as unknown as Record<string, unknown>);
    if (saved) console.log(saved);
    return r as unknown as EventsPayload;
  }
  const range = parseRange(flags, RANGES, '24h');
  const chainId = chainFlag(flags);
  const limit = limitFlag(flags, 25);
  const auth = requireAuth();
  const ref = flags._[0];
  const contract = ref ? await resolveContract(auth, ref, chainId) : null;
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
  const t = payload.totals;
  console.log(
    `${plural(t.fired, 'event')} fired (${fmtChange(t.fired, payload.prevTotals?.fired)} on the previous ${payload.range ?? range}) · ${plural(t.events, 'kind')} · in ${plural(t.txs, 'transaction')}${contract ? '' : ` · ${plural(t.contracts, 'contract')}`}`,
  );
  if (payload.buckets?.length) console.log(`Fired  ${sparkline(payload.buckets)}`);
  if (!payload.abiResolved) console.log('No ABI for this contract: events are named by their topic.');

  const fired = (payload.rows ?? []).filter((r) => !r.dormant);
  const dormant = (payload.rows ?? []).filter((r) => r.dormant);
  console.log('');
  if (!fired.length) console.log('Nothing fired in the window.');
  else {
    const rows = fired.slice(0, limit);
    const names = contract ? new Map<string, string>() : await lookupNames(auth, rows.flatMap((r) => (r.contracts ?? []).slice(0, 1)));
    const owner = (r: EventRow) =>
      r.contractCount === 1 && r.contracts?.[0] ? nameOr(names.get(nameKey(r.contracts[0].chainId, r.contracts[0].address)), r.contracts[0].address) : plural(r.contractCount, 'contract');
    for (const line of table(rows, [
      { header: 'Event', value: (r) => r.signature ?? r.name ?? shortAddr(r.topic0), max: 48 },
      ...(contract ? [] : [{ header: 'Contract', value: owner, max: 28 }]),
      { header: 'Fired', value: (r) => fmtInt(r.fired), align: 'right' },
      { header: 'Change', value: (r) => fmtChange(r.fired, r.prev?.fired), align: 'right' },
      { header: 'Transactions', value: (r) => fmtInt(r.txs), align: 'right' },
      { header: 'Last', value: (r) => fmtAge(r.lastAt), align: 'right' },
      { header: 'Shape', value: (r) => sparkline(r.spark ?? [], { width: 24 }) },
    ])) {
      console.log(line);
    }
    if (fired.length > rows.length) console.log(`… ${fmtInt(fired.length - rows.length)} more (--limit, or --json for all)`);
  }
  if (dormant.length) {
    const shown = dormant.slice(0, 12).map((r) => r.name ?? shortAddr(r.topic0));
    console.log(`\nDeclared but not fired: ${shown.join(', ')}${dormant.length > shown.length ? `, … ${fmtInt(dormant.length - shown.length)} more` : ''}`);
  }
  return payload;
}
