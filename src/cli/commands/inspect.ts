import { parseFlags } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, lookupNames, nameKey, parseRange, RANGES, resolveContract, servedRangeNote, workspaceContracts } from '../data';
import { DASH, chainLabel, fmtAge, fmtChange, fmtCompact, fmtInt, fmtUsd, fmtUsdSigned, nameOr, plural, shortAddr, sparkline, table } from '../view';
import { isBuiltinMonitor, monitorState, type Invariant } from './monitor';
import { formatValue, type TrackedMetric } from './metrics';
import { totalSeries } from './tvl';
import { oracleLines, type ConsoleOracles } from './oracles';

const SHOW_HELP = `contract-dev contracts show — one watched contract at a glance (the Overview tab)

Usage:
  contract-dev contracts show <contract>       What it is (proxy, token, owner, deployer, ABI), what it holds and
                                               how that moved, its last 24 hours (transactions, wallets, value
                                               moved, a token's own volume), its monitors and tracked metrics
  contract-dev contracts stats [--range]       Every watched contract side by side: value, change, transactions, volume

<contract> is an address or a watched contract's name. Add --json for the full answers.
`;

interface Party {
  address: string;
  label: string | null;
}

interface ChainFacts {
  standards: string[];
  proxy: { implementation: Party; admin: Party | null; beacon: Party | null } | null;
  owner: Party | 'renounced' | null;
  token: { name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null } | null;
  codeSize: number | null;
}

interface Identity {
  name: string | null;
  verified: boolean;
  proxy: boolean;
  implementation: string | null;
  deployer: string | null;
  factory: string | null;
  deployedAt: number | null;
}

interface FeedCounts {
  counts: { transactions: number; transactionsFailed: number; calls: number; callsReverted: number; events: number; transfers: number };
  buckets?: Array<{ t: number; total: number; failed: number }>;
  unavailable: string | null;
}

export const STANDARD_LABEL: Record<string, string> = {
  eip1967: 'EIP-1967 proxy',
  eip1167: 'EIP-1167 clone',
  eip2535: 'EIP-2535 diamond',
  proxy: 'Proxy',
  erc20: 'ERC-20',
  erc4626: 'ERC-4626 vault',
  erc721: 'ERC-721',
  erc1155: 'ERC-1155',
};

const settle = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

interface TokenVolume {
  values: number[];
  transfers: number[];
  priced: boolean;
  symbol: string | null;
  coverageIdx: number;
  unavailable: boolean;
}

/** One contract's monitors and their states: its custom rules, and each default monitor's reading of it. */
export function contractHealth(invariants: Invariant[], chainId: number, address: string): Array<{ name: string; state: string; sentence: string | null }> {
  const a = address.toLowerCase();
  const out: Array<{ name: string; state: string; sentence: string | null }> = [];
  for (const inv of invariants) {
    if (isBuiltinMonitor(inv)) {
      const subject = (inv.subjects ?? []).find((s) => s.chainId === chainId && s.address.toLowerCase() === a);
      if (!subject) continue;
      const state = !inv.enabled ? 'disabled' : subject.state === 'nodata' ? 'no data yet' : subject.state;
      out.push({ name: inv.name, state, sentence: subject.sentence ?? null });
    } else if ((inv.inputs ?? []).some((i) => i.trackedOnchainValue && i.trackedOnchainValue.chainId === chainId && i.trackedOnchainValue.address.toLowerCase() === a)) {
      out.push({ name: inv.name, state: monitorState(inv), sentence: null });
    }
  }
  return out;
}

export async function showContract(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) {
    console.log(SHOW_HELP);
    return;
  }
  const flags = parseFlags(args);
  const auth = requireAuth();
  const c = await resolveContract(auth, flags._[0], chainFlag(flags));
  const addr = c.address.toLowerCase();
  const at = `chainId=${c.chainId}&address=${addr}`;
  const opts = { timeoutMs: 60_000 };
  const [facts, identity, feed, flows, users, tvl, settings, metricsRes, invariantsRes] = await Promise.all([
    settle(apiRequest<ChainFacts>(auth, 'GET', `/api/mainnet/contract/facts?${at}&part=chain`, undefined, opts)),
    settle(apiRequest<Identity>(auth, 'GET', `/api/mainnet/contracts/${addr}/identity?chainId=${c.chainId}`, undefined, opts)),
    settle(apiRequest<FeedCounts>(auth, 'GET', `/api/mainnet/activity/feed?range=24h&chain=${c.chainId}&contract=${addr}`, undefined, opts)),
    settle(apiRequest<{ totals: { inUsd: number; outUsd: number; transfers: number; counterparties: number } }>(auth, 'GET', `/api/mainnet/console/flows?range=24h&${at}`, undefined, opts)),
    settle(apiRequest<{ totals: { active: number; txs: number; prevActive: number | null } }>(auth, 'GET', `/api/mainnet/console/users?range=24h&${at}`, undefined, opts)),
    settle(apiRequest<{ chains: Array<{ values: Array<number | null>; liveUsd: number | null }>; totalUsd: number | null }>(auth, 'GET', `/api/mainnet/console/tvl?range=24h&${at}`, undefined, opts)),
    settle(apiRequest<{ manualAbi: string | null; hasPublicAbi: boolean }>(auth, 'GET', `/api/mainnet/accounts/${c.id}`, undefined, opts)),
    settle(apiRequest<{ trackedMetrics: TrackedMetric[] }>(auth, 'GET', `/api/mainnet/tracked-metrics?${at}`, undefined, opts)),
    settle(apiRequest<{ invariants: Invariant[] }>(auth, 'GET', '/api/mainnet/invariants', undefined, opts)),
  ]);
  // An ERC-20's Overview band is its own transfer volume: 24 hourly buckets ending with this hour.
  const isToken = !!facts?.standards?.includes('erc20');
  const hour = 3_600_000;
  const clockFrom = Math.floor(Date.now() / hour) * hour - 23 * hour;
  const volume = isToken
    ? await settle(apiRequest<TokenVolume>(auth, 'GET', `/api/mainnet/contract/transfer-volume?${at}&from=${clockFrom}&step=${hour}&n=24`, undefined, opts))
    : null;

  const party = (p: Party | null | undefined) => (p ? `${p.label ? `${p.label} ` : ''}${p.address}` : DASH);
  const rows: Array<[string, string]> = [['Address', `${c.address} · ${chainLabel(c.chainId)}`]];
  if (identity) {
    const what = [identity.name ?? 'Unnamed contract', identity.verified ? 'verified' : 'not verified'];
    if (identity.proxy || facts?.proxy) what.push(`proxy → ${facts?.proxy ? party(facts.proxy.implementation) : identity.implementation ?? DASH}`);
    rows.push(['Contract', what.join(' · ')]);
  } else if (facts?.proxy) {
    rows.push(['Contract', `proxy → ${party(facts.proxy.implementation)}`]);
  }
  if (facts?.proxy?.admin) rows.push(['Proxy admin', party(facts.proxy.admin)]);
  if (facts) rows.push(['Owner', facts.owner === 'renounced' ? 'renounced' : party(facts.owner)]);
  if (facts?.token) {
    const tk = facts.token;
    rows.push(['Token', [`${tk.name ?? 'Unnamed'}${tk.symbol ? ` (${tk.symbol})` : ''}`, tk.decimals != null ? `${tk.decimals} decimals` : null, tk.totalSupply ? `supply ${tk.totalSupply}` : null].filter(Boolean).join(' · ')]);
  }
  if (facts?.standards?.length) rows.push(['Standards', facts.standards.map((s) => STANDARD_LABEL[s] ?? s).join(' · ')]);
  if (identity?.deployedAt || identity?.deployer) {
    const when = identity.deployedAt ? new Date(identity.deployedAt).toISOString().slice(0, 10) : null;
    rows.push(['Deployed', [when, identity.deployer ? `by ${identity.deployer}` : null, identity.factory ? `through ${identity.factory}` : null].filter(Boolean).join(' ')]);
  }
  if (settings) rows.push(['ABI', settings.hasPublicAbi ? 'verified on the explorer' : settings.manualAbi ? 'added by hand' : `none (add one with contract-dev watch ${c.address} --abi <file>)`]);

  // Value held, and how it moved over the day.
  const series = tvl ? totalSeries(tvl.chains as Parameters<typeof totalSeries>[0]) : [];
  const first = series.find((v) => v != null) ?? null;
  const valueNow = tvl?.totalUsd ?? c.valueUsd ?? null;
  // A level that never moved is a number, not a line.
  const known = series.filter((v): v is number => v != null);
  const moved = known.length > 1 && Math.max(...known) !== Math.min(...known);
  rows.push(['Value held', `${fmtUsd(valueNow)}${moved && valueNow != null && first != null ? ` · ${fmtUsdSigned(valueNow - first)} (${fmtChange(valueNow, first)}) over 24h` : known.length ? ' · unchanged over 24h' : ''}`]);
  if (moved) rows.push(['', sparkline(series, { floor: 'min' })]);

  if (feed && !feed.unavailable) {
    const n = feed.counts;
    rows.push(['Last 24h', `${plural(n.transactions, 'transaction')} (${fmtInt(n.transactionsFailed)} failed) · ${plural(n.calls, 'call')} · ${plural(n.events, 'event')}`]);
    if (feed.buckets?.length) rows.push(['', sparkline(feed.buckets.map((b) => b.total))]);
  } else {
    rows.push(['Last 24h', 'Activity unavailable']);
  }
  if (users) rows.push(['', `${plural(users.totals.active, 'active wallet')} (${fmtChange(users.totals.active, users.totals.prevActive)} on the day before)`]);
  if (flows) rows.push(['', `In ${fmtUsd(flows.totals.inUsd)} · out ${fmtUsd(flows.totals.outUsd)} · ${plural(flows.totals.transfers, 'transfer')} with ${plural(flows.totals.counterparties, 'counterparty', 'counterparties')}`]);
  if (volume && !volume.unavailable) {
    const known = (xs: number[]) => xs.slice(Math.max(0, volume.coverageIdx)).reduce((s, v) => s + (v ?? 0), 0);
    const moved = known(volume.values);
    rows.push(['Token volume', `${volume.priced ? fmtUsd(moved) : `${fmtCompact(moved)} ${volume.symbol ?? 'tokens'}`} in ${plural(known(volume.transfers), 'transfer')} over 24h`]);
  }

  const health = invariantsRes ? contractHealth(invariantsRes.invariants ?? [], c.chainId, c.address) : [];
  if (health.length) {
    const bad = health.filter((h) => h.state === 'alerting' || h.state === 'warning');
    rows.push(['Health', bad.length ? bad.map((h) => `${h.name}: ${h.state}${h.sentence ? ` (${h.sentence})` : ''}`).join(' · ') : `All ${plural(health.length, 'monitor')} healthy`]);
    rows.push(['Monitors', health.map((h) => `${h.name} ${h.state}`).join(' · ')]);
  }
  const metrics = metricsRes?.trackedMetrics ?? [];
  if (metricsRes) {
    const listed = metrics.slice(0, 4).map((m) => `${m.label ?? m.kind} ${formatValue(m.liveValue != null ? m.liveValue : m.lastValue)}`);
    rows.push(['Metrics', metrics.length ? `${fmtInt(metrics.length)} tracked: ${listed.join(' · ')}${metrics.length > 4 ? ' · …' : ''}` : 'none tracked']);
  }

  console.log(c.name ?? c.address);
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v}`);
  console.log(`\nMore: contract-dev events|tvl ${c.address} · contract-dev query transactions|transfers|wallets --contract ${c.address}`);
  return { contract: c, facts, identity, activity: feed, flows, users, tvl, tokenVolume: volume, abi: settings, health, metrics };
}

interface ConsoleBundle {
  range: string;
  contracts: Array<{ id: string; label: string | null; tvlUsd: number | null; address: string; chainId: number; contractType: string | null }>;
  byAccount: Record<
    string,
    {
      tx?: Array<{ n: number; failed: number }>;
      vol?: Array<{ usd: number }>;
      tvlPrev?: { nowUsd: number | null; thenUsd: number | null } | null;
    }
  >;
}


interface DependenciesPayload {
  chainId: number;
  address: string;
  range: string;
  rows: Array<{ to: string; selector: string | null; name: string | null; callType: string; calls: number; reverts: number; lastAt: number | null }>;
  totals?: { calls: number; reverts: number } | null;
  /** The callees that are Chainlink feeds, read live and measured over the window. */
  oracles?: ConsoleOracles | null;
}

