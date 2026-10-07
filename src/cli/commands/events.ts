import { parseFlags } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, lookupNames, nameKey, parseRange, RANGES, resolveContract, servedRangeNote } from '../data';
import { chainLabel, fmtAge, fmtChange, fmtInt, nameOr, plural, shortAddr, sparkline, table } from '../view';

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
`;

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
