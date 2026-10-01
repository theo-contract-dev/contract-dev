import { parseFlags } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, parseRange, RANGES, resolveContract, servedRangeNote } from '../data';
import { DASH, chainLabel, fmtAge, fmtChange, fmtCompact, fmtInt, fmtPct, fmtUsd, fmtUsdSigned, nameOr, shortAddr, sparkline, table } from '../view';

const HELP = `contract.dev tvl — the value your contracts hold

Usage:
  contract.dev tvl [<contract>] [flags]     Value now, its change over the window, by chain and by token
  contract.dev positions <contract>         The contract's positions in lending markets and vaults
  contract.dev holders <contract>           A token's holders: how many, the largest, how concentrated

Flags:
  --range 24h|7d|30d|90d   Window for the change (default 24h; Free workspaces keep 24h)
  --chain <id|name>        One chain
  --limit <n>              Token rows to print (default 15)

<contract> is an address or a watched contract's name. Add --json for everything, the
15-minute series included.
`;

interface TvlPayload {
  range: string;
  slots: number[];
  stepSec: number;
  chains: Array<{ chainId: number; contracts: number; values: Array<number | null>; liveUsd: number | null }>;
  holdings: Array<{ chainId: number; token: string | null; symbol: string | null; usd: number; amount: number | null; priceUsd: number | null; holders: Array<{ address: string; usd: number }> }>;
  totalUsd: number | null;
  otherUsd: number;
  unattributedUsd: number;
  holdingsSampledAt: number | null;
}

interface PositionRow {
  name: string;
  side: 'supplied' | 'borrowed';
  symbol: string;
  amount: number;
  usd: number | null;
  rateNow: number | null;
  realized7d: number | null;
}

interface PositionsPayload {
  chainId: number;
  address: string;
  groups: Array<{ title: string; kind: 'lending' | 'vault'; chainId: number; health: number | null; rows: PositionRow[] }>;
  readAt: number | null;
}

interface HoldersPayload {
  covered: boolean;
  isToken: boolean;
  totalHolders: number | null;
  change: Partial<Record<'1h' | '24h' | '3d' | '7d' | '30d', { change: number | null; pct: number | null }>>;
  supplyPct: Partial<Record<'top10' | 'top25' | 'top50' | 'top100', number>>;
  acquisition: { swap: number; transfer: number; airdrop: number } | null;
  distribution: Array<{ bucket: string; count: number }>;
  topHolders: Array<{ address: string; label: string | null; isContract: boolean; balanceFormatted: string | null; usd: number | null; pctOfSupply: number | null }>;
}

const help = (args: string[]) => !args.length || ['help', '-h', '--help'].includes(args[0]);

/** The series summed across chains, slot by slot; a slot with no chain reading stays empty. */
export function totalSeries(chains: TvlPayload['chains']): Array<number | null> {
  const n = Math.max(0, ...chains.map((c) => c.values.length));
  return Array.from({ length: n }, (_, i) => {
    let any = false;
    let sum = 0;
    for (const c of chains) {
      const v = c.values[i];
      if (v != null) {
        any = true;
        sum += v;
      }
    }
    return any ? sum : null;
  });
}

const firstValue = (values: Array<number | null>): number | null => values.find((v) => v != null) ?? null;

export async function tvlCommand(args: string[]): Promise<TvlPayload | void> {
  if (['help', '-h', '--help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const range = parseRange(flags, RANGES, '24h');
  const chainId = chainFlag(flags);
  const limit = limitFlag(flags, 15, 200);
  const auth = requireAuth();
  const ref = flags._[0];
  const contract = ref ? await resolveContract(auth, ref, chainId) : null;
  const q = new URLSearchParams({ range });
  const chain = contract?.chainId ?? chainId;
  if (chain !== undefined) q.set('chainId', String(chain));
  if (contract) q.set('address', contract.address.toLowerCase());
  const tvl = await apiRequest<TvlPayload>(auth, 'GET', `/api/mainnet/console/tvl?${q.toString()}`, undefined, { timeoutMs: 60_000 });

  const scope = contract ? `${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)}` : chain !== undefined ? `All contracts on ${chainLabel(chain)}` : 'All contracts';
  console.log(`${scope} · value held · last ${tvl.range ?? range}`);
  const clamped = servedRangeNote(range, tvl.range);
  if (clamped) console.log(clamped);
  const series = totalSeries(tvl.chains ?? []);
  const start = firstValue(series);
  const now = tvl.totalUsd;
  const change = now != null && start != null ? now - start : null;
  console.log(`${fmtUsd(now)} now · ${fmtUsdSigned(change)} (${fmtChange(now, start)}) over ${tvl.range ?? range}${tvl.holdingsSampledAt ? ` · read ${fmtAge(tvl.holdingsSampledAt)} ago` : ''}`);
  if (series.some((v) => v != null)) console.log(`${sparkline(series, { floor: 'min' })}  low ${fmtUsd(Math.min(...series.filter((v): v is number => v != null)))} · high ${fmtUsd(Math.max(...series.filter((v): v is number => v != null)))}`);

  if (!contract && (tvl.chains ?? []).length > 1) {
    console.log('\nBy chain');
    for (const line of table(tvl.chains, [
      { header: 'Chain', value: (c) => chainLabel(c.chainId) },
      { header: 'Contracts', value: (c) => fmtInt(c.contracts), align: 'right' },
      { header: 'Value', value: (c) => fmtUsd(c.liveUsd), align: 'right' },
      { header: 'Change', value: (c) => fmtChange(c.liveUsd, firstValue(c.values)), align: 'right' },
    ], '  ')) {
      console.log(line);
    }
  }

  const holdings = (tvl.holdings ?? []).slice().sort((a, b) => b.usd - a.usd);
  if (holdings.length) {
    const total = holdings.reduce((s, h) => s + h.usd, 0) + (tvl.otherUsd ?? 0) + (tvl.unattributedUsd ?? 0);
    console.log('\nWhat it holds');
    for (const line of table(holdings.slice(0, limit), [
      { header: 'Token', value: (h) => h.symbol ?? shortAddr(h.token), max: 16 },
      ...(contract ? [] : [{ header: 'Chain', value: (h: TvlPayload['holdings'][number]) => chainLabel(h.chainId) }]),
      { header: 'Amount', value: (h) => fmtCompact(h.amount), align: 'right' },
      { header: 'Price', value: (h) => (h.priceUsd == null ? DASH : h.priceUsd >= 1 ? `$${h.priceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${h.priceUsd.toPrecision(3)}`), align: 'right' },
      { header: 'Value', value: (h) => fmtUsd(h.usd), align: 'right' },
      { header: 'Share', value: (h) => (total > 0 ? fmtPct(h.usd / total) : DASH), align: 'right' },
      ...(contract ? [] : [{ header: 'Held by', value: (h: TvlPayload['holdings'][number]) => (h.holders.length === 1 ? shortAddr(h.holders[0].address) : `${h.holders.length} contracts`) }]),
    ], '  ')) {
      console.log(line);
    }
    if (holdings.length > limit) console.log(`  … ${fmtInt(holdings.length - limit)} more tokens (--limit)`);
  } else {
    console.log('\nNothing priced is held.');
  }
  return tvl;
}

export async function positionsCommand(args: string[]): Promise<PositionsPayload | void> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const auth = requireAuth();
  const contract = await resolveContract(auth, flags._[0], chainFlag(flags));
  const p = await apiRequest<PositionsPayload>(auth, 'GET', `/api/mainnet/console/positions?chainId=${contract.chainId}&address=${contract.address.toLowerCase()}`, undefined, {
    timeoutMs: 60_000,
  });
  console.log(`${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)} · positions${p.readAt ? ` · read ${fmtAge(p.readAt)} ago` : ''}`);
  if (!p.groups?.length) {
    console.log(p.readAt == null ? 'Not read yet. Positions are read every few minutes after a contract is watched.' : 'No positions found. Positions are read for Aave v3 markets.');
    return p;
  }
  for (const g of p.groups) {
    const net = g.rows.reduce((s, r) => s + (r.side === 'borrowed' ? -(r.usd ?? 0) : r.usd ?? 0), 0);
    console.log(`\n${g.title} · ${chainLabel(g.chainId)} · net ${fmtUsd(net)}${g.kind === 'lending' && g.health != null ? ` · health ${g.health.toFixed(2)}` : ''}`);
    for (const line of table(g.rows, [
      { header: g.kind === 'vault' ? 'Vault' : 'Market', value: (r) => r.name, max: 32 },
      ...(g.kind === 'lending' ? [{ header: 'Side', value: (r: PositionRow) => r.side }] : []),
      { header: 'Amount', value: (r) => `${fmtCompact(r.amount)} ${r.symbol}`, align: 'right' },
      { header: 'Value', value: (r) => fmtUsd(r.usd), align: 'right' },
      ...(g.kind === 'lending' ? [{ header: 'Rate now', value: (r: PositionRow) => fmtPct(r.rateNow, 2), align: 'right' as const }] : []),
      { header: '7d realised', value: (r) => fmtPct(r.realized7d, 2), align: 'right' },
    ], '  ')) {
      console.log(line);
    }
  }
  return p;
}

export async function holdersCommand(args: string[]): Promise<HoldersPayload | void> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const limit = limitFlag(flags, 15, 25);
  const auth = requireAuth();
  const contract = await resolveContract(auth, flags._[0], chainFlag(flags));
  const h = await apiRequest<HoldersPayload>(auth, 'GET', `/api/mainnet/contracts/${contract.address.toLowerCase()}/holders?chainId=${contract.chainId}`, undefined, {
    timeoutMs: 60_000,
  });
  console.log(`${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)} · holders`);
  if (!h.covered) {
    console.log(`Holder data is not available on ${chainLabel(contract.chainId)}.`);
    return h;
  }
  if (!h.isToken || h.totalHolders == null) {
    console.log('No holder data for this contract.');
    return h;
  }
  const changes = (['24h', '7d', '30d'] as const)
    .map((w) => (h.change[w]?.change != null ? `${h.change[w]!.change! > 0 ? '+' : ''}${fmtInt(h.change[w]!.change)} in ${w}` : null))
    .filter(Boolean);
  console.log(`${fmtInt(h.totalHolders)} holders${changes.length ? ` · ${changes.join(' · ')}` : ''}`);
  const conc = (['top10', 'top25', 'top100'] as const).filter((k) => h.supplyPct[k] != null).map((k) => `${k.replace('top', 'top ')} hold ${h.supplyPct[k]!.toFixed(1)}%`);
  if (conc.length) console.log(`Concentration: ${conc.join(' · ')}`);
  if (h.topHolders?.length) {
    console.log('\nLargest holders');
    for (const line of table(h.topHolders.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 })), [
      { header: '#', value: (r) => String(r.rank), align: 'right' },
      { header: 'Holder', value: (r) => `${nameOr(r.label, r.address)}${r.isContract ? ' (contract)' : ''}`, max: 32 },
      { header: 'Balance', value: (r) => (r.balanceFormatted == null ? DASH : fmtCompact(Number(r.balanceFormatted))), align: 'right' },
      { header: 'Value', value: (r) => fmtUsd(r.usd), align: 'right' },
      { header: 'Of supply', value: (r) => (r.pctOfSupply == null ? DASH : `${r.pctOfSupply.toFixed(2)}%`), align: 'right' },
      { header: 'Address', value: (r) => r.address },
    ], '  ')) {
      console.log(line);
    }
  }
  if (h.distribution?.length) console.log(`\nBy size: ${h.distribution.map((d) => `${d.bucket} ${fmtInt(d.count)}`).join(' · ')}`);
  return h;
}
