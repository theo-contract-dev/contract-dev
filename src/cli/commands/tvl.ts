import { parseFlags } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, parseRange, RANGES, resolveContract, servedRangeNote } from '../data';
import { DASH, chainLabel, fmtAge, fmtChange, fmtCompact, fmtInt, fmtPct, fmtTime, fmtUsd, fmtUsdSigned, nameOr, shortAddr, sparkline, table } from '../view';

const HELP = `contract-dev tvl — the value your contracts hold

Usage:
  contract-dev tvl [<contract>] [flags]     Value now, its change over the window, by chain and by token
  contract-dev positions <contract>         The contract's positions in lending markets and vaults
  contract-dev positions <contract> <position> [--range]
                                            One position in full: its facts, the series behind them over the
                                            window, and its timeline (deposits, withdrawals, supplies, borrows,
                                            repays, liquidations). <position> is a vault's name or address, or a
                                            lending market's name (\`aave v3 · core\`, \`core\`)
  contract-dev holders <contract>           A token's holders: how many, the largest, how concentrated

Flags:
  --range 24h|7d|30d|90d   Window for the change (default 24h; Free workspaces keep 24h)
  --chain <id|name>        One chain
  --limit <n>              Token rows to print (default 15); timeline rows on a position (default 20)

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
  /** The position the row opens: `vault:<address>` or `aave:<market>`. Absent = no detail. */
  detail?: string;
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

// ── one position in full (the Positions tab's drill-down, `?position=`) ──

const POSITION_RANGES = ['24h', '7d', '30d', '90d'] as const;

interface DetailPoint {
  at: string;
  value: number;
}

type TimelineKind = 'deposit' | 'withdraw' | 'transfer-in' | 'transfer-out' | 'supply' | 'borrow' | 'repay' | 'liquidation';

const TIMELINE_LABEL: Record<TimelineKind, string> = {
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  'transfer-in': 'Received',
  'transfer-out': 'Sent',
  supply: 'Supply',
  borrow: 'Borrow',
  repay: 'Repay',
  liquidation: 'Liquidation',
};

interface TimelineEntry {
  at: string;
  blockNumber: number;
  /** null when the row came from the app's own change record, with no transaction known. */
  txHash: string | null;
  kind: TimelineKind;
  amount: number | null;
  symbol: string;
}

interface DetailHistory {
  fromMs: number;
  /** Where the chain's record begins; null when the chain is not collected. */
  storeFromMs: number | null;
  /** When the app first recorded this position. */
  recordedFromMs: number | null;
}

interface VaultPositionDetail {
  kind: 'vault';
  chainId: number;
  address: string;
  position: string;
  vault: { address: string; name: string; symbol: string | null; decimals: number; asset: string; assetSymbol: string; assetDecimals: number; curator: string | null; verified: boolean };
  holding: {
    shares: number;
    assets: number;
    usd: number | null;
    shareOfVault: number | null;
    withdrawable: number | null;
    vaultSize: number | null;
    sharePrice: number | null;
    realized7d: number | null;
    readAt: number | null;
  };
  series: { sharePrice: DetailPoint[]; value: DetailPoint[]; valueUsd: DetailPoint[] | null; vaultSize: DetailPoint[] };
  usdPricing: 'daily' | 'current' | null;
  timeline: TimelineEntry[];
  history: DetailHistory;
}

interface LendingPositionDetail {
  kind: 'lending';
  chainId: number;
  address: string;
  position: string;
  market: { key: string; title: string; pool: string };
  account: { healthFactor: number | null; collateralUsd: number | null; debtUsd: number | null; readAt: number | null };
  series: { health: DetailPoint[]; collateralUsd: DetailPoint[]; debtUsd: DetailPoint[]; borrowRates: Array<{ asset: string; symbol: string; points: DetailPoint[] }> };
  timeline: TimelineEntry[];
  history: DetailHistory;
}

export type PositionDetail = VaultPositionDetail | LendingPositionDetail;

interface PositionDetailPayload {
  range: string;
  detail: PositionDetail;
}

/**
 * The position a person named, among the rows that open one: the `vault:…` / `aave:…` key
 * itself, a vault's address, a market's key (`core`), a row's name or symbol, or a group's
 * title — exact first, then a whole word, then any part. Two matches is an error that lists them.
 */
export function matchPosition(groups: PositionsPayload['groups'], ref: string): { key: string; title: string } {
  const q = ref.trim().toLowerCase();
  if (!q) throw new Error('Name a position: a vault (name or address) or a lending market.');
  const options: Array<{ key: string; title: string; names: string[] }> = [];
  for (const g of groups) {
    for (const r of g.rows) {
      if (!r.detail) continue;
      const key = r.detail.toLowerCase();
      let o = options.find((x) => x.key === key);
      if (!o) {
        o = { key, title: g.kind === 'vault' ? `${g.title} · ${r.name}` : g.title, names: [g.title.toLowerCase(), key.slice(key.indexOf(':') + 1)] };
        options.push(o);
      }
      o.names.push(r.name.toLowerCase(), r.symbol.toLowerCase());
    }
  }
  if (!options.length) throw new Error('No position here opens in full.');
  const pick = (found: typeof options, how: string) => {
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error(`${how} matches ${found.length} positions: ${found.map((o) => `${o.title} (${o.key})`).join('; ')}. Name one by its key.`);
    return null;
  };
  const word = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
  const hit =
    pick(options.filter((o) => o.key === q), `"${ref}"`) ??
    pick(options.filter((o) => o.names.includes(q)), `"${ref}"`) ??
    pick(options.filter((o) => o.names.some((n) => word.test(n))), `"${ref}"`) ??
    pick(options.filter((o) => o.names.some((n) => n.includes(q))), `"${ref}"`);
  if (hit) return { key: hit.key, title: hit.title };
  throw new Error(`No position matches "${ref}". Here: ${options.map((o) => `${o.title} (${o.key})`).join('; ')}.`);
}

/** An amount in a token's own units: whole tokens grouped, small ones to four places. */
const fmtAmount = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? DASH : Math.abs(n) >= 1000 ? fmtInt(n) : String(Math.round(n * 10_000) / 10_000));

/** A share price or a health factor: four places, as the page prints them. */
const fmtRatio = (n: number | null | undefined, digits = 4): string => (n == null || !Number.isFinite(n) ? DASH : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits }));

const dateOf = (ms: number | null | undefined): string => (ms == null ? DASH : new Date(ms).toISOString().slice(0, 10));

type SeriesSpec = [label: string, points: DetailPoint[] | null | undefined, fmt: (v: number) => string];

/** Each series as a line: its sparkline and first → last, labels aligned; a level that never moved is a word, not a line; one point is nothing. */
function seriesLines(specs: SeriesSpec[]): string[] {
  const drawn = specs
    .map(([label, points, fmt]) => ({ label, fmt, values: (points ?? []).map((p) => p.value).filter((v) => Number.isFinite(v)) }))
    .filter((x) => x.values.length >= 2);
  const width = Math.max(0, ...drawn.map((x) => x.label.length));
  return drawn.map(({ label, fmt, values }) => {
    const moved = Math.max(...values) !== Math.min(...values);
    return `  ${label.padEnd(width)}  ${moved ? `${sparkline(values, { floor: 'min', width: 32 })}  ${fmt(values[0])} → ${fmt(values[values.length - 1])}` : `unchanged at ${fmt(values[0])}`}`;
  });
}

function printTimeline(entries: TimelineEntry[], limit: number): void {
  const newestFirst = entries.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  console.log('\nTimeline');
  if (!newestFirst.length) {
    console.log('  Nothing moved in the window.');
    return;
  }
  for (const line of table(newestFirst.slice(0, limit), [
    { header: 'Time', value: (e) => fmtTime(Date.parse(e.at)) },
    { header: 'Age', value: (e) => fmtAge(Date.parse(e.at)), align: 'right' },
    { header: 'Action', value: (e) => TIMELINE_LABEL[e.kind] ?? e.kind },
    { header: 'Amount', value: (e) => (e.amount == null ? DASH : `${fmtAmount(e.amount)} ${e.symbol}`), align: 'right' },
    { header: 'Block', value: (e) => fmtInt(e.blockNumber), align: 'right' },
    { header: 'Tx', value: (e) => e.txHash ?? DASH },
  ], '  ')) {
    console.log(line);
  }
  if (newestFirst.length > limit) console.log(`  … ${fmtInt(newestFirst.length - limit)} more (--limit, or --json for all)`);
}

/** Where the history begins, and why, when it is later than the window asked for. */
function historyLine(h: DetailHistory): string {
  const bounds = [h.recordedFromMs != null && h.recordedFromMs > h.fromMs ? `recorded from ${dateOf(h.recordedFromMs)}` : null, h.storeFromMs != null && h.storeFromMs > h.fromMs ? `the chain's record from ${dateOf(h.storeFromMs)}` : null].filter(Boolean);
  return `History from ${dateOf(h.fromMs)}${bounds.length ? ` (${bounds.join(', ')})` : ''}${h.storeFromMs == null ? ' · chain not collected' : ''}`;
}

async function showPosition(auth: Parameters<typeof apiRequest>[0], contract: { chainId: number; address: string; name: string | null }, ref: string, range: (typeof POSITION_RANGES)[number], limit: number): Promise<PositionDetailPayload> {
  const addr = contract.address.toLowerCase();
  const list = await apiRequest<PositionsPayload>(auth, 'GET', `/api/mainnet/console/positions?chainId=${contract.chainId}&address=${addr}`, undefined, { timeoutMs: 60_000 });
  const picked = matchPosition(list.groups ?? [], ref);
  const res = await apiRequest<PositionDetailPayload>(
    auth,
    'GET',
    `/api/mainnet/console/positions/detail?chainId=${contract.chainId}&address=${addr}&position=${encodeURIComponent(picked.key)}&range=${range}`,
    undefined,
    { timeoutMs: 90_000 },
  );
  const d = res.detail;
  console.log(`${picked.title} · ${contract.name ?? shortAddr(contract.address)} · ${chainLabel(d.chainId)} · last ${res.range ?? range}`);
  const clamped = servedRangeNote(range, res.range);
  if (clamped) console.log(clamped);

  const rows: Array<[string, string]> = [];
  const specs: SeriesSpec[] = [];
  if (d.kind === 'vault') {
    const v = d.vault;
    const h = d.holding;
    const inAsset = (n: number | null | undefined) => (n == null ? DASH : `${fmtAmount(n)} ${v.assetSymbol}`);
    rows.push(['Value', `${inAsset(h.assets)}${h.usd != null ? ` (${fmtUsd(h.usd)})` : ''} · ${fmtAmount(h.shares)} ${v.symbol ?? 'shares'}${h.shareOfVault != null ? ` · ${fmtPct(h.shareOfVault, 2)} of the vault` : ''}`]);
    rows.push(['Withdrawable now', inAsset(h.withdrawable)]);
    rows.push(['Share price', `${h.sharePrice == null ? DASH : `${fmtRatio(h.sharePrice)} ${v.assetSymbol}`}${h.realized7d != null ? ` · realised 7d ${fmtPct(h.realized7d, 2)}` : ''}`]);
    rows.push(['Vault size', inAsset(h.vaultSize)]);
    rows.push(['Vault', [v.name, v.address, v.curator ? `curator ${v.curator}` : null, v.verified ? null : 'unverified: its figures are its own claims'].filter(Boolean).join(' · ')]);
    rows.push(['Read', h.readAt ? `${fmtAge(h.readAt)} ago` : DASH]);
    specs.push(['Value', d.series.value, inAsset]);
    specs.push([d.usdPricing === 'current' ? 'Value (USD, today\'s price)' : 'Value (USD)', d.series.valueUsd, fmtUsd]);
    specs.push(['Share price', d.series.sharePrice, (x) => fmtRatio(x)]);
    specs.push(['Vault size', d.series.vaultSize, inAsset]);
  } else {
    const a = d.account;
    rows.push(['Health factor', a.healthFactor == null ? DASH : fmtRatio(a.healthFactor, 2)]);
    rows.push(['Collateral', fmtUsd(a.collateralUsd)]);
    rows.push(['Debt', fmtUsd(a.debtUsd)]);
    rows.push(['Net', a.collateralUsd != null && a.debtUsd != null ? fmtUsd(a.collateralUsd - a.debtUsd) : DASH]);
    rows.push(['Market', `${d.market.title} · pool ${d.market.pool}`]);
    rows.push(['Read', a.readAt ? `${fmtAge(a.readAt)} ago` : DASH]);
    specs.push(['Health factor', d.series.health, (x) => fmtRatio(x, 2)]);
    specs.push(['Collateral', d.series.collateralUsd, fmtUsd]);
    specs.push(['Debt', d.series.debtUsd, fmtUsd]);
    for (const r of d.series.borrowRates ?? []) specs.push([`Borrow rate ${r.symbol}`, r.points, (x) => fmtPct(x, 2)]);
  }
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v}`);
  const drawn = seriesLines(specs);
  if (drawn.length) {
    console.log('');
    for (const l of drawn) console.log(l);
  }
  printTimeline(d.timeline ?? [], limit);
  console.log(`\n${historyLine(d.history)}`);
  return res;
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
  // A level that never moved is a number, not a line.
  const known = series.filter((v): v is number => v != null);
  const moved = known.length > 1 && Math.max(...known) !== Math.min(...known);
  const read = tvl.holdingsSampledAt ? ` · read ${fmtAge(tvl.holdingsSampledAt)} ago` : '';
  if (moved) {
    console.log(`${fmtUsd(now)} now · ${fmtUsdSigned(change)} (${fmtChange(now, start)}) over ${tvl.range ?? range}${read}`);
    console.log(`${sparkline(series, { floor: 'min' })}  low ${fmtUsd(Math.min(...known))} · high ${fmtUsd(Math.max(...known))}`);
  } else {
    console.log(`${fmtUsd(now)} now${known.length ? ` · unchanged over ${tvl.range ?? range}` : ''}${read}`);
  }

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

export async function positionsCommand(args: string[]): Promise<PositionsPayload | PositionDetailPayload | void> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const auth = requireAuth();
  const contract = await resolveContract(auth, flags._[0], chainFlag(flags));
  if (flags._[1]) return showPosition(auth, contract, flags._.slice(1).join(' '), parseRange(flags, POSITION_RANGES, '24h'), limitFlag(flags, 20, 500));
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
  if (p.groups.some((g) => g.rows.some((r) => r.detail))) console.log(`\nOne in full: contract-dev positions ${contract.name ? `"${contract.name}"` : contract.address} <vault or market> [--range 7d]`);
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
