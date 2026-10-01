import { parseFlags, flag } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, lookupNames, nameKey, parseRange, resolveContract, servedRangeNote } from '../data';
import { DASH, chainLabel, fmtAge, fmtInt, fmtUsd, nameOr, plural, shortAddr, sparkline, table, Column } from '../view';

const HELP = `contract.dev activity — what reached your watched contracts, newest first

Usage:
  contract.dev activity [<contract>] [flags]       Transactions that reached the workspace's contracts
  contract.dev activity <contract> --calls         Every call into the contract, internal calls included
  contract.dev activity <contract> --events        Logs the contract emitted
  contract.dev activity <contract> --transfers     Tokens and coin moving in and out of it

Flags:
  --range 24h|7d          Window (default 24h)
  --chain <id|name>       One chain
  --failed                Only rows whose call into the contract reverted
  --reads | --all         Read-only calls, or reads and writes (default: state-changing only)
  --direct | --routed     Sent straight to the contract, or reaching it through another one
  --in | --out            Transfers: one direction
  --limit <n>             Rows to print (default 25, up to 500)

<contract> is an address or a watched contract's name. Add --json for everything the
dashboard's Activity tab has: the counts, the hourly series and up to 500 rows.
`;

interface Bucket {
  t: number;
  total: number;
  failed: number;
}

interface FeedRowBase {
  kind: 'tx' | 'call' | 'event' | 'transfer' | 'notable';
  chainId: number;
  txHash: string;
  blockNumber: number;
  tsMs: number;
  contract: string;
}

interface TxRow extends FeedRowBase {
  kind: 'tx';
  from: string;
  to: string | null;
  method: string | null;
  selector: string | null;
  status: 'success' | 'failed' | null;
  via: boolean;
  callReverted: boolean;
}

interface CallRow extends FeedRowBase {
  kind: 'call';
  caller: string;
  method: string | null;
  selector: string | null;
  callType: string;
  tracePath: number[];
  gasUsed: number;
  reverted: boolean;
  reason: string | null;
  caught: boolean;
}

interface EventRow extends FeedRowBase {
  kind: 'event';
  name: string | null;
  topic0: string;
  args: Array<{ name: string; type: string; value: string }> | null;
}

interface TransferRow extends FeedRowBase {
  kind: 'transfer';
  direction: 'in' | 'out';
  counterparty: string;
  symbol: string | null;
  token: string;
  amount: string;
  usd: number | null;
  decimalsKnown: boolean;
}

type FeedRow = TxRow | CallRow | EventRow | TransferRow;

export interface ActivityFeed {
  params: { tab: string; range: string; lens: string; route: string; status: string; chainId: number | null; contract: string | null };
  buckets: Bucket[];
  stepMs: number;
  total: number;
  failed: number;
  counts: {
    transactions: number;
    transactionsFailed: number;
    calls: number;
    callsReverted: number;
    events: number;
    transfers: number;
    transfersIn: number;
    transfersOut: number;
  };
  rows: FeedRow[];
  scope: { watched: number; inScope: number; collected: number; notCollected: number; coverageStartMs: number | null };
  unavailable: 'store' | 'chain' | 'none' | null;
}

const VIEW_FLAGS: Record<string, string> = { calls: 'calls', events: 'events', transfers: 'flows', flows: 'flows', transactions: 'transactions' };

const UNAVAILABLE: Record<string, string> = {
  store: 'Data unavailable. Retry in a moment.',
  chain: 'Chain not collected: activity is recorded for Ethereum, Arbitrum, Avalanche and Sepolia.',
  none: 'No watched contracts in scope. Watch one with `contract.dev watch <address>`.',
};

export async function activityCommand(args: string[]): Promise<ActivityFeed | void> {
  if (['help', '-h', '--help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const views = Object.keys(VIEW_FLAGS).filter((k) => flag(flags, k) === 'true');
  if (new Set(views.map((v) => VIEW_FLAGS[v])).size > 1) throw new Error('Pick one of --calls, --events or --transfers.');
  const view = views.length ? VIEW_FLAGS[views[0]] : 'transactions';
  const range = parseRange(flags, ['24h', '7d'] as const, '24h');
  const chainId = chainFlag(flags);
  const limit = limitFlag(flags, 25);
  const lens = flag(flags, 'all') === 'true' ? 'all' : flag(flags, 'reads') === 'true' ? 'reads' : 'writes';
  const route = flag(flags, 'direct') === 'true' ? 'direct' : flag(flags, 'routed') === 'true' ? 'routed' : 'any';
  const dir = flag(flags, 'in') === 'true' ? 'in' : flag(flags, 'out') === 'true' ? 'out' : 'all';

  const auth = requireAuth();
  const ref = flags._[0];
  const contract = ref ? await resolveContract(auth, ref, chainId) : null;

  const q = new URLSearchParams();
  if (view !== 'transactions') q.set('view', view);
  q.set('range', range);
  if (lens !== 'writes') q.set('reading', lens);
  if (route !== 'any') q.set('route', route);
  if (flag(flags, 'failed') === 'true') q.set('status', 'failed');
  const chain = contract?.chainId ?? chainId;
  if (chain !== undefined) q.set('chain', String(chain));
  if (contract) q.set('contract', contract.address.toLowerCase());
  if (dir !== 'all') q.set('dir', dir);

  const feed = await apiRequest<ActivityFeed>(auth, 'GET', `/api/mainnet/activity/feed?${q.toString()}`, undefined, { timeoutMs: 60_000 });

  const scope = contract ? `${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)}` : chain !== undefined ? `All contracts on ${chainLabel(chain)}` : 'All contracts';
  const reading = lens === 'all' ? 'reads and writes' : lens === 'reads' ? 'reads' : 'state-changing';
  console.log(`${scope} · last ${feed.params?.range ?? range} · ${reading}${route !== 'any' ? ` · ${route}` : ''}${flag(flags, 'failed') === 'true' ? ' · failed only' : ''}`);
  const clamped = servedRangeNote(range, feed.params?.range);
  if (clamped) console.log(clamped);
  if (feed.unavailable) {
    console.log(UNAVAILABLE[feed.unavailable] ?? 'Data unavailable.');
    return feed;
  }

  const c = feed.counts;
  console.log(
    [
      `${plural(c.transactions, 'transaction')} (${fmtInt(c.transactionsFailed)} failed)`,
      `${plural(c.calls, 'call')} (${fmtInt(c.callsReverted)} reverted)`,
      plural(c.events, 'event'),
      `${plural(c.transfers, 'transfer')} (${fmtInt(c.transfersIn)} in · ${fmtInt(c.transfersOut)} out)`,
    ].join(' · '),
  );
  if (feed.buckets?.length) {
    const peak = feed.buckets.reduce((m, b) => (b.total > m.total ? b : m), feed.buckets[0]);
    const step = feed.stepMs >= 86_400_000 ? 'Daily' : 'Hourly';
    console.log(`${step}  ${sparkline(feed.buckets.map((b) => b.total))}  peak ${fmtInt(peak.total)}`);
  }
  if (feed.scope?.notCollected) {
    console.log(`${plural(feed.scope.notCollected, 'contract')} in scope ${feed.scope.notCollected === 1 ? 'is' : 'are'} on a chain not collected.`);
  }

  const rows = (feed.rows ?? []).slice(0, limit);
  console.log('');
  if (rows.length === 0) {
    console.log('No activity in the window.');
    return feed;
  }

  const names = await lookupNames(auth, rows.flatMap(rowAddresses));
  const name = (chainId: number, address: string | null | undefined) => nameOr(names.get(nameKey(chainId, address)), address);
  const many = !contract;
  const where: Column<FeedRow>[] = many
    ? [
        { header: 'Chain', value: (r) => chainLabel(r.chainId) },
        { header: 'Contract', value: (r) => name(r.chainId, r.contract), max: 28 },
      ]
    : [];
  const age: Column<FeedRow> = { header: 'Age', value: (r) => fmtAge(r.tsMs), align: 'right' };
  const tx: Column<FeedRow> = { header: 'Tx', value: (r) => r.txHash };

  let columns: Column<FeedRow>[];
  if (view === 'calls') {
    columns = [
      age,
      ...where,
      { header: 'Method', value: (r) => method(r as CallRow), max: 28 },
      { header: 'Caller', value: (r) => name(r.chainId, (r as CallRow).caller), max: 28 },
      { header: 'Depth', value: (r) => String((r as CallRow).tracePath?.length ?? 0), align: 'right' },
      { header: 'Gas', value: (r) => fmtInt((r as CallRow).gasUsed), align: 'right' },
      { header: 'Result', value: (r) => callResult(r as CallRow), max: 32 },
      tx,
    ];
  } else if (view === 'events') {
    columns = [
      age,
      ...where,
      { header: 'Event', value: (r) => (r as EventRow).name ?? shortAddr((r as EventRow).topic0), max: 28 },
      { header: 'Arguments', value: (r) => eventArgs(r as EventRow), max: 72 },
      tx,
    ];
  } else if (view === 'flows') {
    columns = [
      age,
      ...where,
      { header: 'Dir', value: (r) => (r as TransferRow).direction },
      { header: 'Amount', value: (r) => `${(r as TransferRow).amount} ${(r as TransferRow).symbol ?? shortAddr((r as TransferRow).token)}`, align: 'right', max: 28 },
      { header: 'Value', value: (r) => fmtUsd((r as TransferRow).usd), align: 'right' },
      { header: 'Counterparty', value: (r) => name(r.chainId, (r as TransferRow).counterparty), max: 28 },
      tx,
    ];
  } else {
    columns = [
      age,
      ...where,
      { header: 'Method', value: (r) => method(r as TxRow), max: 28 },
      { header: 'From', value: (r) => name(r.chainId, (r as TxRow).from), max: 28 },
      { header: 'Route', value: (r) => ((r as TxRow).via ? `via ${name(r.chainId, (r as TxRow).to)}` : 'direct'), max: 32 },
      { header: 'Status', value: (r) => txStatus(r as TxRow) },
      tx,
    ];
  }
  for (const line of table(rows, columns)) console.log(line);
  if ((feed.rows ?? []).length > rows.length) console.log(`… ${fmtInt(feed.rows.length - rows.length)} more rows (--limit, or --json for all)`);
  return feed;
}

function rowAddresses(r: FeedRow): Array<{ chainId: number; address: string | null }> {
  const out: Array<{ chainId: number; address: string | null }> = [{ chainId: r.chainId, address: r.contract }];
  if (r.kind === 'tx') out.push({ chainId: r.chainId, address: r.from }, { chainId: r.chainId, address: r.via ? r.to : null });
  if (r.kind === 'call') out.push({ chainId: r.chainId, address: r.caller });
  if (r.kind === 'transfer') out.push({ chainId: r.chainId, address: r.counterparty });
  return out;
}

const method = (r: { method: string | null; selector: string | null }) => r.method ?? r.selector ?? DASH;

function txStatus(r: TxRow): string {
  if (r.status === 'failed') return 'failed';
  if (r.callReverted) return 'caught revert';
  return r.status ?? DASH;
}

function callResult(r: CallRow): string {
  if (!r.reverted) return 'ok';
  const why = r.reason ? `: ${r.reason}` : '';
  return r.caught ? `reverted, caught${why}` : `reverted${why}`;
}

function eventArgs(r: EventRow): string {
  if (!r.args) return 'not decoded';
  return r.args.map((a) => `${a.name || a.type}=${a.value}`).join(' ');
}
