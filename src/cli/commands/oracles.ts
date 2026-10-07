// The Chainlink feeds a contract reads (the Dependencies tab's Oracles block) and one feed on
// its own (the address page's feed panel): the shapes the app answers with (the frontend's
// lib/mainnet/oracleFeedTypes) and the lines the CLI prints for them. The formatting mirrors
// the app's cells, so a feed reads the same here as on either page.
//
// Only a crypto price or exchange-rate feed with a published heartbeat gets a verdict: fresh
// when its last update is within the heartbeat (plus two minutes for it to land), late when
// it is not. A sequencer flag, a proof of reserve or a stock that sleeps at the weekend is
// listed with its reading and "Not assessed".
import { apiRequest, ResolvedAuth } from '../credentials';
import { DASH, fmtInt, fmtTime, table } from '../view';

export type FeedVerdict = 'fresh' | 'late';
export type FeedRole = 'proxy' | 'svrProxy' | 'aggregator';

interface FeedFacts {
  address: string;
  role: FeedRole;
  /** As Chainlink names it, with " · SVR" when the contract reads the SVR proxy. */
  name: string;
  path: string | null;
  /** price · rate · reserve · nav · sequencer · macro · funding · volatility · bundle · other */
  kind: string;
  base: string | null;
  quote: string | null;
  decimals: number | null;
  /** Seconds between forced updates, as published. */
  heartbeat: number | null;
  /** Deviation threshold in percent, as published. */
  deviation: number | null;
  tier: string | null;
  marketHours: string | null;
  /** Announced shutdown date (ISO), when Chainlink has published one. */
  shutdown: string | null;
  judged: boolean;
  value: number | null;
  updatedAt: number | null;
  ageSec: number | null;
  verdict: FeedVerdict | null;
}

/** One feed the contract called directly in the window — a row of Dependencies › Oracles. */
export interface OracleFeedRow extends FeedFacts {
  reads: number;
  reverted: number;
  lastReadAt: number | null;
  selector: string;
  /** The oldest the price was at any successful read in the window, in seconds. */
  stalestReadSec: number | null;
  /** Some reads had no update on record before them, so the figure is a floor. */
  stalestIsFloor: boolean;
}

export interface ConsoleOracles {
  feeds: OracleFeedRow[];
  readAt: number;
  /** A half that did not answer: the chain (no values, no verdicts) or the store (no read figures). */
  partial: 'rpc' | 'store' | null;
}

/** One feed on its own page: the book's facts and a live reading. */
export interface ChainlinkFeedFacts extends FeedFacts {
  proxy: string;
  svrProxy: string | null;
  svrLabel: string | null;
  aggregator: string | null;
  readAt: number;
}

export const ROLE_WORD: Record<FeedRole, string> = { proxy: 'proxy', svrProxy: 'SVR proxy', aggregator: 'aggregator' };

const KIND_WORD: Record<string, string> = {
  price: 'price',
  rate: 'exchange rate',
  reserve: 'proof of reserve',
  nav: 'net asset value',
  sequencer: 'sequencer status',
  macro: 'macroeconomic data',
  funding: 'funding rate',
  volatility: 'volatility',
  bundle: 'multi-value feed',
  other: 'data feed',
};

export const kindWord = (kind: string): string => KIND_WORD[kind] ?? 'data feed';

/** A span of seconds as the app prints it: 12s · 39m · 24h 31m · 3d 2h. Hours run to two days, so a 24h 31m-old price next to a 25h limit reads in hours. */
export function fmtSpan(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return DASH;
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 2 * 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** A heartbeat as Chainlink states it: 1h · 24h · 27h · 5m. */
export function fmtHeartbeat(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return DASH;
  if (sec % 86400 === 0 && sec >= 86400 * 2) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/** The reading in the feed's own terms: a USD price with its sign, another quote after the number, a rate as a bare ratio. */
export function fmtFeedValue(value: number | null | undefined, f: { kind: string; quote: string | null }): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  const num = value.toLocaleString('en-US', { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits });
  if (f.quote === 'USD' && f.kind === 'price') return `$${num}`;
  if (f.quote && f.kind === 'price') return `${num} ${f.quote}`;
  return num;
}

export function whyNotAssessed(f: { kind: string; marketHours: string | null }): string {
  if (f.kind !== 'price' && f.kind !== 'rate') return `a ${kindWord(f.kind)} feed is not judged for freshness`;
  if (f.marketHours && f.marketHours !== 'Crypto') return `follows ${f.marketHours} hours, quiet when the market is closed`;
  return 'no published heartbeat to judge against';
}

/** Fresh · Late · Not assessed — or the dash when a judged feed gave no reading. */
export function feedStatus(f: { judged: boolean; verdict: FeedVerdict | null }): string {
  if (!f.judged) return 'Not assessed';
  if (!f.verdict) return DASH;
  return f.verdict === 'late' ? 'Late' : 'Fresh';
}

/** Shutdown as the panel says it: announced and ahead, or already past. */
export function shutdownText(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(`${iso}T23:59:59Z`);
  if (Number.isNaN(t)) return `shutdown announced for ${iso}`;
  return t >= now ? `shutdown announced for ${iso}` : `shut down ${iso}`;
}

/**
 * The Oracles block above a contract's call list: a summary line, then one row per feed —
 * feed · value · updated · heartbeat · status · stalest read · reads · address.
 */
export function oracleLines(o: ConsoleOracles | null | undefined, now = Date.now()): string[] {
  const feeds = o?.feeds ?? [];
  if (!feeds.length) return [];
  const late = feeds.filter((f) => f.verdict === 'late').length;
  const fresh = feeds.filter((f) => f.verdict === 'fresh').length;
  const judged = feeds.filter((f) => f.judged).length;
  // "all fresh" only when every judged feed answered fresh; with readings missing it says nothing
  const summary = [`Price feeds it reads: ${fmtInt(feeds.length)}`, late ? `${fmtInt(late)} late` : judged > 0 && fresh === judged ? 'all fresh' : null, o?.readAt ? `read ${fmtSpan((now - o.readAt) / 1000)} ago` : null]
    .filter(Boolean)
    .join(' · ');
  const lines = [summary];
  if (o?.partial === 'rpc') lines.push('Readings unavailable: the values and verdicts could not be read right now.');
  if (o?.partial === 'store') lines.push('Read figures unavailable: the reads and stalest reads could not be counted right now.');
  lines.push(
    ...table(
      feeds,
      [
        { header: 'Feed', value: (f) => `${f.name}${f.role === 'proxy' ? '' : ` (${ROLE_WORD[f.role]})`}`, max: 36 },
        { header: 'Value', value: (f) => fmtFeedValue(f.value, f), align: 'right' },
        { header: 'Updated', value: (f) => (f.ageSec == null ? DASH : `${fmtSpan(f.ageSec)} ago`), align: 'right' },
        { header: 'Heartbeat', value: (f) => (f.judged ? fmtHeartbeat(f.heartbeat) : DASH), align: 'right' },
        { header: 'Status', value: feedStatus },
        { header: 'Stalest read', value: (f) => (f.stalestReadSec == null ? DASH : `${fmtSpan(f.stalestReadSec)}${f.stalestIsFloor ? '+' : ''}`), align: 'right' },
        { header: 'Reads', value: (f) => `${fmtInt(f.reads)}${f.reverted > 0 ? ` · ${fmtInt(f.reverted)} reverted` : ''}`, align: 'right' },
        { header: 'Address', value: (f) => f.address },
      ],
      '  ',
    ),
  );
  return lines;
}

/** The address page's panel as key · value rows: what the feed is, what it says now, its published terms, its addresses. */
export function feedPanelRows(f: ChainlinkFeedFacts, now = Date.now()): Array<[string, string]> {
  const what = [f.name, kindWord(f.kind), ROLE_WORD[f.role]].join(' · ');
  const reading: string[] = [fmtFeedValue(f.value, f)];
  if (f.ageSec != null) reading.push(`updated ${fmtSpan(f.ageSec)} ago (${fmtTime(f.updatedAt)})`);
  if (f.judged) {
    reading.push(`heartbeat ${fmtHeartbeat(f.heartbeat)}`);
    reading.push(f.verdict ? (f.verdict === 'late' ? 'Late' : 'Fresh') : 'no reading');
  } else {
    reading.push(`Not assessed: ${whyNotAssessed(f)}`);
  }
  const terms = [
    f.deviation != null && f.deviation >= 0.01 ? `deviation ${f.deviation}%` : null,
    f.tier ? `tier ${f.tier}` : null,
    f.marketHours ? `${f.marketHours} hours` : null,
    shutdownText(f.shutdown, now),
  ].filter(Boolean);
  const addresses = [`proxy ${f.proxy}`, f.svrProxy ? `${f.svrLabel ?? 'SVR proxy'} ${f.svrProxy}` : null, f.aggregator ? `aggregator ${f.aggregator}` : null].filter(Boolean);
  const rows: Array<[string, string]> = [
    ['Chainlink feed', what],
    ['Reading', reading.join(' · ')],
  ];
  if (terms.length) rows.push(['Terms', terms.join(' · ')]);
  rows.push(['Addresses', addresses.join(' · ')]);
  return rows;
}

/** The feed at an address, when it is one (its proxy, SVR proxy or aggregator); null for any other address. */
export async function loadFeed(auth: ResolvedAuth, chainId: number, address: string): Promise<ChainlinkFeedFacts | null> {
  const res = await apiRequest<{ feed: ChainlinkFeedFacts | null }>(auth, 'GET', `/api/mainnet/oracles/feed?chainId=${chainId}&address=${address.toLowerCase()}`, undefined, {
    timeoutMs: 30_000,
  });
  return res.feed ?? null;
}
