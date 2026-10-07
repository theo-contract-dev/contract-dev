import { parseFlags, flag } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, isAddress, limitFlag, lookupNames, nameKey, parseRange, RANGES, resolveContract, servedRangeNote } from '../data';
import { chainLabel, fmtAge, fmtInt, fmtUsd, fmtUsdSigned, nameOr, plural, shortAddr, sparkline, table } from '../view';

const HELP = `contract-dev flows — value moving in and out of your contracts

Usage:
  contract-dev flows [<contract>] [flags]          Totals, by token, and the biggest counterparties
  contract-dev flows [<contract>] --in | --out     Every counterparty on one side, largest first
  contract-dev flows <token>                       A token's page adds the token's own movements: its top senders
                                                   and receivers over the last 24h, holder to holder
  contract-dev counterparty <address> [--range]    One counterparty's dealings with your contracts

Flags:
  --range 24h|7d|30d|90d   Window (default 24h; Free workspaces keep 24h)
  --chain <id|name>        One chain
  --token <address>        One token (native for the chain's coin)
  --limit <n>              Rows to print (default 15; with --in or --out up to 100)
  --offset <n>             With --in or --out: start further down the list

<contract> is an address or a watched contract's name. In and out are from your contracts'
side. Add --json for everything the Flows tab has, the hourly series included.

An ERC-20's own transfers never touch its own balance, so for a token the in-and-out view is
near-empty and the senders and receivers of the token itself are the figure that matters —
the home map shows the same swap. Mints, burns and self-transfers are left out.
`;

interface FlowBucket {
  t: number;
  inUsd: number;
  outUsd: number;
  inN: number;
  outN: number;
}

interface CounterpartyRow {
  address: string;
  label: string | null;
  role: string;
  inUsd: number;
  outUsd: number;
  transfers: number;
  lastAt: number | null;
  isNew?: boolean;
  topContract?: { chainId: number; address: string } | null;
}

export interface FlowsPayload {
  range: string;
  totals: { inUsd: number; outUsd: number; transfers: number; counterparties: number };
  external?: { inUsd: number; outUsd: number; transfers: number; counterparties: number };
  tokens: Array<{ token: string | null; symbol: string | null; chainId: number; inUsd: number; outUsd: number; transfers: number }>;
  rows: CounterpartyRow[];
  buckets: FlowBucket[];
}

/** A wallet that sent or received the token: a peer of the home map's value row. */
interface TokenPeer {
  address: string;
  label: string | null;
  role: string;
  usd: number;
  n: number;
  /** Transfers counted without a price. */
  unpriced: number;
  lastTs: number;
}

/** An ERC-20's top senders and receivers of the token itself over the map's 24h window. */
export interface TokenParties {
  flow: {
    /** The sent side's whole window, in USD at the current price. */
    inUsd: number;
    outUsd: number;
    inN: number;
    outN: number;
    unpricedN: number;
    top: { in: TokenPeer[]; out: TokenPeer[] };
  } | null;
  unavailable: 'store' | 'chain' | null;
}

interface CounterpartiesPage {
  direction: 'in' | 'out';
  rows: CounterpartyRow[];
  total: number;
  sumUsd: number;
  nextOffset: number | null;
}

interface CounterpartyPayload {
  address: string;
  range: string;
  label: { name: string | null; category: string | null } | null;
  totals: { inUsd: number; outUsd: number; transfersIn: number; transfersOut: number; lastSeenAt: number | null };
  perContract: Array<{ chainId: number; address: string; inUsd: number; outUsd: number; transfers: number; lastSeenAt: number | null }>;
  recent: Array<{ chainId: number; contract: string; direction: 'in' | 'out'; symbol: string | null; amount: number; usd: number | null; at: number; hash: string }>;
}

export async function flowsCommand(args: string[]): Promise<unknown> {
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
  const direction = flag(flags, 'in') === 'true' ? 'in' : flag(flags, 'out') === 'true' ? 'out' : null;
  const token = flag(flags, 'token');
  if (token !== undefined && token !== 'native' && !isAddress(token)) throw new Error('--token takes a token address, or native for the chain\'s coin.');

  const q = new URLSearchParams({ range });
  const chain = contract?.chainId ?? chainId;
  if (chain !== undefined) q.set('chainId', String(chain));
  if (contract) q.set('address', contract.address.toLowerCase());
  if (token) q.set('token', token.toLowerCase());
  const scope = contract ? `${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)}` : chain !== undefined ? `All contracts on ${chainLabel(chain)}` : 'All contracts';

  if (direction) {
    const limit = limitFlag(flags, 50, 100);
    const offsetRaw = flag(flags, 'offset');
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('--offset must be a whole number.');
    q.set('direction', direction);
    q.set('offset', String(offset));
    q.set('limit', String(limit));
    const page = await apiRequest<CounterpartiesPage>(auth, 'GET', `/api/mainnet/console/flows/counterparties?${q.toString()}`, undefined, { timeoutMs: 60_000 });
    console.log(`${scope} · ${direction === 'in' ? 'into' : 'out of'} your contracts · last ${range}`);
    console.log(`${fmtUsd(page.sumUsd)} ${direction === 'in' ? 'from' : 'to'} ${plural(page.total, 'counterparty', 'counterparties')}\n`);
    if (!page.rows?.length) {
      console.log('No transfers on that side in the window.');
      return page;
    }
    printCounterparties(page.rows, offset);
    if (page.nextOffset != null) console.log(`… more from --offset ${page.nextOffset}`);
    return page;
  }

  const limit = limitFlag(flags, 15, 100);
  const flows = await apiRequest<FlowsPayload>(auth, 'GET', `/api/mainnet/console/flows?${q.toString()}`, undefined, { timeoutMs: 60_000 });
  console.log(`${scope} · last ${flows.range ?? range}${token ? ` · token ${token === 'native' ? 'native' : shortAddr(token)}` : ''}`);
  const clamped = servedRangeNote(range, flows.range);
  if (clamped) console.log(clamped);
  const t = flows.totals;
  console.log(
    `In ${fmtUsd(t.inUsd)} · Out ${fmtUsd(t.outUsd)} · Net ${fmtUsdSigned(t.inUsd - t.outUsd)} · ${plural(t.transfers, 'transfer')} · ${plural(t.counterparties, 'counterparty', 'counterparties')}`,
  );
  if (flows.external && (flows.external.inUsd !== t.inUsd || flows.external.outUsd !== t.outUsd)) {
    console.log(`Leaving out transfers between your own contracts: in ${fmtUsd(flows.external.inUsd)} · out ${fmtUsd(flows.external.outUsd)}`);
  }
  if (flows.buckets?.length) {
    console.log(`In   ${sparkline(flows.buckets.map((b) => b.inUsd))}`);
    console.log(`Out  ${sparkline(flows.buckets.map((b) => b.outUsd))}`);
  }

  const tokens = (flows.tokens ?? []).slice().sort((a, b) => b.inUsd + b.outUsd - (a.inUsd + a.outUsd)).slice(0, limit);
  if (tokens.length) {
    console.log('\nBy token');
    for (const line of table(tokens, [
      { header: 'Token', value: (r) => r.symbol ?? shortAddr(r.token), max: 16 },
      ...(contract ? [] : [{ header: 'Chain', value: (r: FlowsPayload['tokens'][number]) => chainLabel(r.chainId) }]),
      { header: 'In', value: (r) => fmtUsd(r.inUsd), align: 'right' },
      { header: 'Out', value: (r) => fmtUsd(r.outUsd), align: 'right' },
      { header: 'Net', value: (r) => fmtUsdSigned(r.inUsd - r.outUsd), align: 'right' },
      { header: 'Transfers', value: (r) => fmtInt(r.transfers), align: 'right' },
    ], '  ')) {
      console.log(line);
    }
  }
  const rows = (flows.rows ?? []).slice(0, limit);
  console.log('\nTop counterparties');
  if (!rows.length) console.log('  No transfers in the window.');
  else printCounterparties(rows, 0, '  ');

  // A token's own movements, holder to holder: the home map's value row for a token node.
  if (!contract?.standards?.includes('erc20')) return flows;
  const parties = await apiRequest<TokenParties>(auth, 'GET', `/api/mainnet/contract/token-parties?chainId=${contract.chainId}&address=${contract.address.toLowerCase()}`, undefined, {
    timeoutMs: 60_000,
  }).catch(() => null);
  console.log('\nThe token itself, holder to holder · last 24h');
  if (!parties) console.log('  Transfers unavailable. Retry in a moment.');
  else if (parties.unavailable === 'chain') console.log('  Chain not collected');
  else if (parties.unavailable || !parties.flow) console.log('  Transfers unavailable. Retry in a moment.');
  else {
    const f = parties.flow;
    const priced = f.unpricedN === 0;
    console.log(`  ${priced ? `${fmtUsd(f.inUsd)} moved in ` : ''}${plural(f.inN, 'transfer')}${priced ? '' : ' (unpriced)'}`);
    for (const [title, peers] of [['Top senders', f.top.in], ['Top receivers', f.top.out]] as const) {
      console.log(`\n  ${title}`);
      if (!peers.length) {
        console.log('    No transfers in the window.');
        continue;
      }
      for (const line of table(
        peers.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 })),
        [
          { header: '#', value: (r) => String(r.rank), align: 'right' },
          { header: 'Wallet', value: (r) => nameOr(r.label, r.address), max: 36 },
          { header: 'Kind', value: (r) => r.role },
          ...(priced ? [{ header: 'Value', value: (r: TokenPeer) => fmtUsd(r.usd), align: 'right' as const }] : []),
          { header: 'Transfers', value: (r) => fmtInt(r.n), align: 'right' },
          { header: 'Last', value: (r) => fmtAge(r.lastTs), align: 'right' },
          { header: 'Address', value: (r) => r.address },
        ],
        '    ',
      )) {
        console.log(line);
      }
    }
  }
  return { ...flows, tokenTransfers: parties };
}

function printCounterparties(rows: CounterpartyRow[], offset: number, indent = ''): void {
  for (const line of table(
    rows.map((r, i) => ({ ...r, rank: offset + i + 1 })),
    [
      { header: '#', value: (r) => String(r.rank), align: 'right' },
      { header: 'Counterparty', value: (r) => `${nameOr(r.label, r.address)}${r.isNew ? ' (new)' : ''}`, max: 36 },
      { header: 'Kind', value: (r) => r.role },
      { header: 'In', value: (r) => fmtUsd(r.inUsd), align: 'right' },
      { header: 'Out', value: (r) => fmtUsd(r.outUsd), align: 'right' },
      { header: 'Transfers', value: (r) => fmtInt(r.transfers), align: 'right' },
      { header: 'Last', value: (r) => fmtAge(r.lastAt), align: 'right' },
      { header: 'Address', value: (r) => r.address },
    ],
    indent,
  )) {
    console.log(line);
  }
}

export async function counterpartyCommand(args: string[]): Promise<CounterpartyPayload | void> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const address = flags._[0];
  if (!isAddress(address)) throw new Error('counterparty takes an address (0x…).');
  const range = parseRange(flags, RANGES, '24h');
  const limit = limitFlag(flags, 15, 100);
  const auth = requireAuth();
  const c = await apiRequest<CounterpartyPayload>(auth, 'GET', `/api/mainnet/console/counterparty?address=${address.toLowerCase()}&range=${range}`, undefined, {
    timeoutMs: 60_000,
  });
  console.log(`${nameOr(c.label?.name, c.address)}${c.label?.category ? ` (${c.label.category})` : ''} · ${c.address} · last ${c.range ?? range}`);
  const t = c.totals;
  console.log(
    `Into your contracts ${fmtUsd(t.inUsd)} (${plural(t.transfersIn, 'transfer')}) · out of them ${fmtUsd(t.outUsd)} (${plural(t.transfersOut, 'transfer')}) · last seen ${fmtAge(t.lastSeenAt)} ago`,
  );
  const names = await lookupNames(auth, [...(c.perContract ?? []), ...(c.recent ?? []).map((r) => ({ chainId: r.chainId, address: r.contract }))]);
  const contractName = (chainId: number, a: string) => nameOr(names.get(nameKey(chainId, a)), a);
  if (c.perContract?.length) {
    console.log('\nWith each contract');
    for (const line of table(c.perContract, [
      { header: 'Contract', value: (r) => contractName(r.chainId, r.address), max: 28 },
      { header: 'Chain', value: (r) => chainLabel(r.chainId) },
      { header: 'In', value: (r) => fmtUsd(r.inUsd), align: 'right' },
      { header: 'Out', value: (r) => fmtUsd(r.outUsd), align: 'right' },
      { header: 'Transfers', value: (r) => fmtInt(r.transfers), align: 'right' },
      { header: 'Last', value: (r) => fmtAge(r.lastSeenAt), align: 'right' },
      { header: 'Address', value: (r) => r.address },
    ], '  ')) {
      console.log(line);
    }
  }
  if (c.recent?.length) {
    console.log('\nRecent transfers');
    for (const line of table(c.recent.slice(0, limit), [
      { header: 'Age', value: (r) => fmtAge(r.at), align: 'right' },
      { header: 'Dir', value: (r) => r.direction },
      { header: 'Amount', value: (r) => `${fmtAmount(r.amount)} ${r.symbol ?? ''}`.trim(), align: 'right' },
      { header: 'Value', value: (r) => fmtUsd(r.usd), align: 'right' },
      { header: 'Contract', value: (r) => contractName(r.chainId, r.contract), max: 28 },
      { header: 'Tx', value: (r) => r.hash },
    ], '  ')) {
      console.log(line);
    }
  }
  return c;
}

const fmtAmount = (n: number): string => (Math.abs(n) >= 1000 ? fmtInt(n) : String(Math.round(n * 10_000) / 10_000));
