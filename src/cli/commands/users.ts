import { parseFlags, flag } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, lookupNames, nameKey, parseRange, RANGES, resolveContract, servedRangeNote } from '../data';
import type { ResolvedAuth } from '../credentials';
import { chainLabel, fmtAge, fmtChange, fmtInt, fmtPct, nameOr, plural, shortAddr, sparkline, table } from '../view';

const HELP = `contract-dev users — the wallets using your contracts

Usage:
  contract-dev users [<contract>] [flags]       Active wallets and their transactions, against the previous window,
                                                how they reach your contracts, and the busiest of them
  contract-dev users [<contract>] --routes      Every route in: called directly, or through which contracts
  contract-dev users [<contract>] --wallets     The wallets themselves, busiest first

Flags:
  --range 24h|7d|30d|90d   Window (default 24h; Free workspaces keep 24h)
  --chain <id|name>        One chain
  --limit <n>              Rows to print (default 10; with --routes or --wallets 50, up to 100)
  --offset <n>             With --wallets: start further down the list

<contract> is an address or a watched contract's name. Add --json for everything the Users tab has.
`;

interface UsersPayload {
  range: string;
  buckets: Array<{ t: number; active: number; txs: number }>;
  totals: { active: number; txs: number; prevActive: number | null };
}

interface ArrivalRoute {
  address: string;
  chainId: number;
  label: string | null;
  role: string;
  kind: string;
  txs: number;
  wallets: number;
  isWatched?: boolean;
}

interface ArrivalPayload {
  range: string;
  walletTxs: number;
  walletCount: number;
  totals: { txs: number; directTxs: number; routedTxs: number; doors: number };
  routes: ArrivalRoute[];
}

interface WalletsPage {
  rows: Array<{ address: string; chainId: number; label: string | null; role: string; txs: number; contracts: number; firstSeenAt: number | null; lastSeenAt: number | null }>;
  total: number;
  nextOffset: number | null;
}

export async function usersCommand(args: string[]): Promise<unknown> {
  if (['help', '-h', '--help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const range = parseRange(flags, RANGES, '24h');
  const chainId = chainFlag(flags);
  const auth = requireAuth();
  const ref = flags._[0];
  const contract = ref ? await resolveContract(auth, ref, chainId) : null;
  const q = new URLSearchParams({ range });
  const chain = contract?.chainId ?? chainId;
  if (chain !== undefined) q.set('chainId', String(chain));
  if (contract) q.set('address', contract.address.toLowerCase());
  const scope = contract ? `${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)}` : chain !== undefined ? `All contracts on ${chainLabel(chain)}` : 'All contracts';
  const opts = { timeoutMs: 60_000 };

  if (flag(flags, 'wallets') === 'true') {
    const limit = limitFlag(flags, 50, 100);
    const offset = Number(flag(flags, 'offset') ?? 0);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('--offset must be a whole number.');
    q.set('offset', String(offset));
    q.set('limit', String(limit));
    const page = await apiRequest<WalletsPage>(auth, 'GET', `/api/mainnet/console/users/arrival/wallets?${q.toString()}`, undefined, opts);
    console.log(`${scope} · wallets · last ${range}`);
    console.log(`${plural(page.total, 'wallet')}\n`);
    printWallets(page, offset, '', await namesFor(auth, page.rows));
    if (page.nextOffset != null) console.log(`… more from --offset ${page.nextOffset}`);
    return page;
  }

  if (flag(flags, 'routes') === 'true') {
    const limit = limitFlag(flags, 50, 500);
    const arrival = await apiRequest<ArrivalPayload>(auth, 'GET', `/api/mainnet/console/users/arrival?${q.toString()}`, undefined, opts);
    console.log(`${scope} · how wallets arrive · last ${arrival.range ?? range}`);
    printArrival(arrival, limit, await namesFor(auth, (arrival.routes ?? []).slice(0, limit)));
    return arrival;
  }

  const limit = limitFlag(flags, 10, 100);
  const walletsQ = new URLSearchParams(q);
  walletsQ.set('limit', String(limit));
  const [users, arrival, wallets] = await Promise.all([
    apiRequest<UsersPayload>(auth, 'GET', `/api/mainnet/console/users?${q.toString()}`, undefined, opts),
    apiRequest<ArrivalPayload>(auth, 'GET', `/api/mainnet/console/users/arrival?${q.toString()}`, undefined, opts).catch(() => null),
    apiRequest<WalletsPage>(auth, 'GET', `/api/mainnet/console/users/arrival/wallets?${walletsQ.toString()}`, undefined, opts).catch(() => null),
  ]);
  console.log(`${scope} · last ${users.range ?? range}`);
  const clamped = servedRangeNote(range, users.range);
  if (clamped) console.log(clamped);
  const t = users.totals;
  console.log(
    `${plural(t.active, 'active wallet')} (${fmtChange(t.active, t.prevActive)} on the previous ${users.range ?? range}) · ${plural(t.txs, 'transaction')}`,
  );
  if (users.buckets?.length) {
    console.log(`Wallets       ${sparkline(users.buckets.map((b) => b.active))}`);
    console.log(`Transactions  ${sparkline(users.buckets.map((b) => b.txs))}`);
  }
  const names = await namesFor(auth, [...(arrival?.routes ?? []).slice(0, 5), ...(wallets?.rows ?? [])]);
  if (arrival) printArrival(arrival, 5, names);
  if (wallets?.rows?.length) {
    console.log('\nBusiest wallets');
    printWallets(wallets, 0, '  ', names);
  }
  return { users, arrival, wallets };
}

/** Book names for the rows the payload left unlabelled. */
async function namesFor(auth: ResolvedAuth, rows: Array<{ chainId: number; address: string; label: string | null }>): Promise<Map<string, string>> {
  return lookupNames(auth, rows.filter((r) => !r.label));
}

function printArrival(a: ArrivalPayload, limit: number, names: Map<string, string>): void {
  const t = a.totals;
  if (!t || !t.txs) {
    console.log('\nNo wallet transactions in the window.');
    return;
  }
  console.log(
    `\nHow they arrive: ${fmtPct(t.directTxs / t.txs)} direct (${fmtInt(t.directTxs)}) · ${fmtPct(t.routedTxs / t.txs)} through another contract (${fmtInt(t.routedTxs)}, ${plural(t.doors, 'route')})`,
  );
  const routes = (a.routes ?? []).slice(0, limit);
  if (!routes.length) return;
  for (const line of table(routes, [
    { header: 'Through', value: (r) => `${nameOr(r.label ?? names.get(nameKey(r.chainId, r.address)), r.address)}${r.isWatched ? ' (watched)' : ''}`, max: 36 },
    { header: 'Kind', value: (r) => r.kind },
    { header: 'Transactions', value: (r) => fmtInt(r.txs), align: 'right' },
    { header: 'Share', value: (r) => fmtPct(r.txs / t.txs), align: 'right' },
    { header: 'Wallets', value: (r) => fmtInt(r.wallets), align: 'right' },
    { header: 'Address', value: (r) => r.address },
  ], '  ')) {
    console.log(line);
  }
  if ((a.routes ?? []).length > routes.length) console.log(`  … ${fmtInt(a.routes.length - routes.length)} more (--routes)`);
}

function printWallets(page: WalletsPage, offset: number, indent: string, names: Map<string, string>): void {
  if (!page.rows?.length) {
    console.log(`${indent}No wallets in the window.`);
    return;
  }
  for (const line of table(
    page.rows.map((r, i) => ({ ...r, rank: offset + i + 1 })),
    [
      { header: '#', value: (r) => String(r.rank), align: 'right' },
      { header: 'Wallet', value: (r) => nameOr(r.label ?? names.get(nameKey(r.chainId, r.address)), r.address), max: 32 },
      { header: 'Kind', value: (r) => r.role },
      { header: 'Transactions', value: (r) => fmtInt(r.txs), align: 'right' },
      { header: 'Contracts', value: (r) => fmtInt(r.contracts), align: 'right' },
      { header: 'Last', value: (r) => fmtAge(r.lastSeenAt), align: 'right' },
      { header: 'Address', value: (r) => r.address },
    ],
    indent,
  )) {
    console.log(line);
  }
}
