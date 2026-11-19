import { refuseGoneFlags, METRIC_GONE } from './gone';
import { lastFlag, lastWindow } from '../last';
import { Interface, isAddress } from 'ethers';
import { parseFlags, flag, requirePositional, requireFlag, type ParsedFlags } from './_args';
import { apiRequest, requireAuth, ResolvedAuth } from '../credentials';
import { parseChainId, WatchedAccount } from './watch';
import { chainFlag, chainOf, resolveContract } from '../data';
import { runTool } from '../tools';
import { defineMetricCommand, listMetricsCommand, resolveAnyMetric } from './_define';
import { EVENT_METRIC_HELP, defineGroupMetric, defineItemMetric, deleteEventMetric, isEventMetric, listEventMetrics, monitorEventMetric, showEventMetric, trackFormula, updateEventMetric } from './eventMetric';

const TRACK_HELP = `contract-dev track — track an on-chain value as a metric (charted on /metrics, usable by monitors)

Usage:
  contract-dev track <address|name> <kind> [--chain <id>] [--label "<name>"] [--hidden] [kind flags]
                                                 --hidden keeps it off the Metrics page: a value made only for a
                                                 report or a monitor, gone with the report when nothing else reads it
  contract-dev untrack <id|label> [...]          Stop tracking (also removes monitors that read it)

Kinds:
  native-balance                                 The address's native balance
  erc20-balance   --token <addr>                 The address's balance of an ERC20
  function        --function "<sig>" [--args a,b] The result of any view call, e.g.
                  [--word <n>] [--signed]          --function "convertToAssets(uint256) returns (uint256)" --args 1e18
                  [--decimals <n>]                 (--calldata 0x… instead of --function/--args; --word picks
                                                    one return value; --decimals sets the display scale)
  (formula)                                      contract-dev track formula <contract> --label … --call … --value …:
                                                 several views at one block and an expression (try: track formula help)

Examples:
  contract-dev track 0xA0b8… function --function "totalSupply() returns (uint256)" --label "USDC supply"
  contract-dev track 0xVault… function --function "totalAssets() returns (uint256)" --decimals 18
`;

const METRICS_HELP = `contract-dev metrics — the workspace's metrics, of two kinds

A STATE metric says how things stand (a balance, a supply, a view's result, a column added up): read every
block, drawn as a level. An ACTIVITY metric says what happened over a window (swaps, fees, deposits): added
up from events, drawn as bars. One command defines either, on a contract, a wallet, a group or a table.

  contract-dev metrics [--kind state|activity] [--hidden] [--on <what>]   Every metric: kind, name, on, reads, unit, id
  contract-dev metric define "<name>" --on <what> --call "<read>"… | --each <Event>…   (try: metric define help)
  contract-dev metric show <id|name> [--last 24h|7d|30d|90d | --since launch | --since <date> [--until <date>]] [--limit <n>]
                            (a state metric reads those windows; an activity metric any whole days, 1d to 365d)
  contract-dev metric delete <id|name>…
  contract-dev metric rename <id|name> "<new name>"
  contract-dev metric pause <id|name> / resume <id|name>     A state metric on one contract or wallet: stop reading (history kept) / go on
  contract-dev metric decimals <id|name> <n|clear>          Its display scale (one contract or wallet)
  contract-dev metric export <id|name> [--last 24h|7d|30d|90d | --since launch] [--format csv|json]
  contract-dev metric monitor <metric> --name "…" --when "<formula>"   An alert on it (or: notify add alert)

A metric is named by its id or, when one has it, its name. The older spellings still work and say so:
track <address> <kind> · track formula · metric events · metric table · metric group · group column add.
`;

// The serialized TrackedOnchainValue row the app's API returns (lastValueRaw decoded to lastValue).
export interface TrackedMetric {
  id: string;
  chainId: number;
  address: string;
  kind: string;
  label: string | null;
  params: Record<string, unknown> | null;
  enabled: boolean;
  cadence: string;
  intervalSec: number;
  lastValue: number | null;
  lastValueAt: string | null;
  lastSampledAt: string | null;
  createdAt: string;
  liveTracking?: boolean;
  liveValue?: number | null;
  liveBlockNumber?: number | null;
}

// CLI kind → the kind the API stores. Names follow the app's Track Metric picker.
const KINDS: Record<string, { api: string; label: string }> = {
  'native-balance': { api: 'nativeBalance', label: 'Native balance' },
  'erc20-balance': { api: 'tokenBalance', label: 'ERC20 balance' },
  // total-supply and balance-of left with the app's picker 2026-10-14: both are `function`
  // on the token (totalSupply(); balanceOf(address) --args <holder>). Existing rows keep sampling.
  function: { api: 'functionResult', label: 'Function call' },
  calls: { api: 'callCount', label: 'Method calls' },
  reverts: { api: 'revertCount', label: 'Method reverts' },
  'revert-rate': { api: 'revertRate', label: 'Method revert rate' },
  callers: { api: 'callerCount', label: 'Method callers' },
  // gas-p95 (gasP95) left the picker 2026-10-14; the API refuses new rows of it, existing ones keep sampling.
};
const TRACE_KINDS = new Set(['calls', 'reverts', 'revert-rate', 'callers']);
// The kinds help and errors name: call-level data is not collected for now (2026-10-22), so the method kinds go
// unlisted; they are still accepted and the server answers for them.
const LISTED_KINDS = Object.keys(KINDS).filter((k) => !TRACE_KINDS.has(k));
// The windows the app's picker offers (TRACE_WINDOW_OPTIONS_SEC in @mockchain/config).
const TRACE_WINDOWS: Record<string, number> = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };

export const shortHex = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** An address, or the name of a contract this workspace watches. */
async function addressOrName(raw: string, label: string, chainId: number): Promise<string> {
  const ref = raw.trim();
  if (isAddress(ref)) return ref;
  if (/^0x/i.test(ref)) throw new Error(`${label} must be a 0x address or a watched contract's name (got: ${raw})`);
  return (await resolveContract(requireAuth(), ref, chainId)).address;
}

function requireAddress(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) throw new Error(`${label} must be a 0x address (got: ${raw})`);
  return trimmed;
}

// "1e18" / "2.5e6" → the integer digits, so a uint argument can be typed the way people
// say it. Anything else is passed through for ethers to judge.
export function expandScientific(raw: string): string {
  const m = /^(\d+)(?:\.(\d+))?e(\d+)$/i.exec(raw.trim());
  if (!m) return raw;
  const [, whole, frac = '', exp] = m;
  const shift = Number(exp) - frac.length;
  if (shift < 0) throw new Error(`${raw} is not an integer`);
  return `${whole}${frac}${'0'.repeat(shift)}`.replace(/^0+(?=\d)/, '');
}

function parseArgs(raw: string | undefined): unknown[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to the comma form */
    }
    throw new Error(`--args must be a JSON array or comma-separated values (got: ${raw})`);
  }
  return trimmed.split(',').map((v) => {
    const t = v.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    return expandScientific(t);
  });
}

// Build the params for a `function` read from a human-readable signature — the same
// calldata / signature / wordIndex / signed the app's composer stores, so the sampler and
// the chart treat it identically.
function buildFunctionParams(flags: ReturnType<typeof parseFlags>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const calldata = flag(flags, 'calldata');
  const signature = flag(flags, 'function');
  if (calldata && signature) throw new Error('Pass either --calldata or --function, not both');
  if (!calldata && !signature) throw new Error('A function read needs --function "<sig>" (or --calldata 0x…)');

  if (calldata) {
    if (!/^0x[0-9a-fA-F]{8}([0-9a-fA-F]{2})*$/.test(calldata)) throw new Error(`--calldata must be 0x-hex with a 4-byte selector (got: ${calldata})`);
    params.calldata = calldata.toLowerCase();
  } else {
    const fragmentText = /^\s*function\s/.test(signature!) ? signature! : `function ${signature}`;
    let iface: Interface;
    try {
      iface = new Interface([fragmentText]);
    } catch (err) {
      throw new Error(`Could not parse --function "${signature}": ${err instanceof Error ? err.message : err}`);
    }
    const fn = iface.fragments.find((f) => f.type === 'function') as any;
    if (!fn) throw new Error(`--function "${signature}" is not a function signature`);
    const args = parseArgs(flag(flags, 'args'));
    if (args.length !== fn.inputs.length) {
      throw new Error(`${fn.name} takes ${fn.inputs.length} argument${fn.inputs.length === 1 ? '' : 's'}, got ${args.length} (pass --args a,b,…)`);
    }
    try {
      params.calldata = iface.encodeFunctionData(fn, args);
    } catch (err) {
      throw new Error(`Could not encode arguments for ${fn.name}: ${err instanceof Error ? err.message : err}`);
    }
    const outs = (fn.outputs ?? []).map((o: any) => o.type).join(',');
    params.signature = `${fn.format('sighash')}${outs ? ` → ${outs}` : ''}`;
    // A multi-value return must pin a word, else the whole blob is stored and compared.
    const wordRaw = flag(flags, 'word');
    const multi = (fn.outputs?.length ?? 0) > 1;
    if (multi && wordRaw === undefined) {
      throw new Error(`${fn.name} returns ${fn.outputs.length} values — pick one with --word <0..${fn.outputs.length - 1}>`);
    }
    if (wordRaw !== undefined) {
      const word = Number(wordRaw);
      if (!Number.isInteger(word) || word < 0) throw new Error(`--word must be a non-negative integer (got: ${wordRaw})`);
      params.wordIndex = word;
    }
    const tracked = fn.outputs?.[typeof params.wordIndex === 'number' ? params.wordIndex : 0];
    if (tracked && /^int\d*$/.test(tracked.type)) params.signed = true;
  }

  if (flag(flags, 'word') !== undefined && calldata) {
    const word = Number(flag(flags, 'word'));
    if (!Number.isInteger(word) || word < 0) throw new Error(`--word must be a non-negative integer`);
    params.wordIndex = word;
  }
  if (flag(flags, 'signed') === 'true') params.signed = true;
  const decimalsRaw = flag(flags, 'decimals');
  if (decimalsRaw !== undefined) {
    const decimals = Number(decimalsRaw);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('--decimals must be a whole number between 0 and 36');
    params.decimals = decimals;
  }
  return params;
}

function parseAddressList(raw: string, label: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[\s,]+/)) {
    if (!part) continue;
    out.add(requireAddress(part, `${label} entry`).toLowerCase());
  }
  if (out.size === 0) throw new Error(`${label} needs at least one address`);
  return Array.from(out);
}

function buildTraceParams(flags: ReturnType<typeof parseFlags>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const method = flag(flags, 'method');
  if (method) {
    if (/^0x[0-9a-fA-F]{8}$/.test(method)) {
      params.selector = method.toLowerCase();
    } else {
      // "swap(address,bool,int256)" → its selector, with the signature kept for display.
      let iface: Interface;
      try {
        iface = new Interface([/^\s*function\s/.test(method) ? method : `function ${method}`]);
      } catch {
        throw new Error(`--method must be a 4-byte selector (0x12345678) or a signature like "transfer(address,uint256)" (got: ${method})`);
      }
      const fn = iface.fragments.find((f) => f.type === 'function') as any;
      if (!fn) throw new Error(`--method "${method}" is not a function signature`);
      params.selector = fn.selector.toLowerCase();
      params.signature = fn.format('sighash');
    }
  }
  const windowRaw = flag(flags, 'window') ?? '1h';
  const windowSec = TRACE_WINDOWS[windowRaw] ?? (Object.values(TRACE_WINDOWS).includes(Number(windowRaw)) ? Number(windowRaw) : undefined);
  if (windowSec === undefined) throw new Error(`--window must be one of ${Object.keys(TRACE_WINDOWS).join(', ')} (got: ${windowRaw})`);
  params.windowSec = windowSec;
  const only = flag(flags, 'only');
  const except = flag(flags, 'except');
  if (only && except) throw new Error('Pass either --only or --except, not both');
  if (only) params.callers = { mode: 'only', addresses: parseAddressList(only, '--only') };
  if (except) params.callers = { mode: 'except', addresses: parseAddressList(except, '--except') };
  return params;
}

// The subject's watched name, for the generated label — the app names metrics
// "<account> · <kind>" and the CLI should read the same on /metrics.
async function subjectName(auth: ResolvedAuth, chainId: number, address: string): Promise<string> {
  const lower = address.toLowerCase();
  try {
    const { accounts } = await apiRequest<{ accounts: WatchedAccount[] }>(auth, 'GET', '/api/mainnet/accounts?accountType=contract');
    const hit = (accounts ?? []).find((a) => a.accountType === 'contract' && a.address.toLowerCase() === lower && a.chainId === chainId);
    if (hit?.name) return hit.name;
  } catch {
    /* the label is cosmetic — never fail a track over it */
  }
  return shortHex(address);
}

export async function trackCommand(args: string[]): Promise<TrackedMetric | void> {
  if (args.length > 0 && !['help', '-h', '--help'].includes(args[0]) && args[1] !== 'formula' && args[0] !== 'formula') console.error('`track` is the older spelling: contract-dev metric define "<name>" --on <contract> --call "<read>" (try: metric define help).');
  // a calculated value: several calls and an expression (src/cli/commands/eventMetric)
  if (args[0] === 'formula') return (await trackFormula(args.slice(1))) as void;
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help' || args[0] === undefined) {
    console.log(TRACK_HELP);
    return;
  }
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const kindName = requirePositional(positional, 1, `kind (one of: ${LISTED_KINDS.join(', ')})`);
  const kind = KINDS[kindName];
  if (!kind) throw new Error(`Unknown kind "${kindName}". One of: ${LISTED_KINDS.join(', ')}`);
  // the chain is said, or is the watched contract's own; never assumed (2026-10-23: four values went on Ethereum for Arbitrum contracts)
  const subject = requirePositional(positional, 0, 'address').trim();
  if (/^0x/i.test(subject) && !isAddress(subject)) throw new Error(`address must be a 0x address or a watched contract's name (got: ${subject})`);
  const stated = chainFlag(flags);
  const chainId = isAddress(subject) ? await chainOf(requireAuth(), subject, stated) : (stated ?? (await resolveContract(requireAuth(), subject)).chainId);
  // a watched contract's name works as well as its address (track stETH totalSupply)
  const address = await addressOrName(subject, 'address', chainId);

  let params: Record<string, unknown> | undefined;
  let labelSuffix = kind.label;
  switch (kindName) {
    case 'erc20-balance':
      params = { token: await addressOrName(requireFlag(flags, 'token'), '--token', chainId) };
      break;
    case 'function': {
      params = buildFunctionParams(flags);
      const sig = typeof params.signature === 'string' ? params.signature : null;
      const fnName = sig ? sig.replace(/\(.*$/, '') : null;
      labelSuffix = fnName ? `${fnName}${typeof params.wordIndex === 'number' ? ` #${params.wordIndex}` : ''}` : kind.label;
      break;
    }
    default:
      if (TRACE_KINDS.has(kindName)) params = buildTraceParams(flags);
  }

  const auth = requireAuth();
  // The trace kinds name themselves server-side from the watched label; the on-chain kinds
  // don't, so generate the app's "<account> · <kind>" form for them.
  let label = flag(flags, 'label');
  if (!label && !TRACE_KINDS.has(kindName)) {
    const subject = await subjectName(auth, chainId, address);
    label = kindName === 'function' && typeof params?.signature === 'string' ? `${subject}.${labelSuffix}` : `${subject} · ${labelSuffix}`;
  }

  const payload = await apiRequest<{ trackedMetric: TrackedMetric; created?: boolean }>(auth, 'POST', '/api/mainnet/tracked-metrics', {
    chainId,
    address,
    kind: kind.api,
    ...(params && Object.keys(params).length ? { params } : {}),
    ...(label ? { label } : {}),
    // --hidden: off the Metrics page, a value made only for a report or a monitor (2026-11-06)
    ...(flag(flags, 'hidden') !== undefined ? { listed: false } : {}),
  });
  const metric = payload.trackedMetric;
  const verb = payload.created === false ? 'Already tracking' : 'Tracking';
  console.log(`${verb} ${metric.label ?? kind.label} on chain ${metric.chainId} (id: ${metric.id})`);
  return metric;
}

// A metric by id, or by label when exactly one matches (case-insensitive).
export async function resolveMetric(auth: ResolvedAuth, ref: string): Promise<TrackedMetric> {
  // By id or label, over EVERY value the workspace has — the method values (`track calls`…)
  // and the values the app's monitor composer made are not listed by `metrics`, but a
  // monitor can still be added on them.
  const { trackedMetrics } = await apiRequest<{ trackedMetrics: TrackedMetric[] }>(auth, 'GET', '/api/mainnet/tracked-metrics?include=unlisted');
  const all = trackedMetrics ?? [];
  const byId = all.find((m) => m.id === ref);
  if (byId) return byId;
  const lower = ref.trim().toLowerCase();
  const byLabel = all.filter((m) => (m.label ?? '').toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) {
    throw new Error(`${byLabel.length} metrics are labelled "${ref}" — use an id: ${byLabel.map((m) => m.id).join(', ')}`);
  }
  throw new Error(`No tracked metric matches "${ref}" (run \`contract-dev metrics\` to list them).`);
}

export function formatValue(value: number | null | undefined): string {
  // A measured zero is a value; the dash means unknown (no reading yet / chain unreachable).
  if (value == null || !Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return Number(value.toPrecision(8)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

const currentValue = (m: TrackedMetric) => (m.liveValue != null ? m.liveValue : m.lastValue);

export async function metricsCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list': {
      // one list of both kinds (2026-11-07); the old filters by address or chain still list tracked values alone
      const a = sub === undefined ? args : rest;
      return a.some((x) => x === '--address' || x === '--chain') ? await listMetrics(a) : await listMetricsCommand(a);
    }
    case 'events':
      console.log('`metric events` is now `metrics --kind activity`.');
      return await listMetricsCommand(['--kind', 'activity']);
    case 'show': {
      // by id or name, whichever kind: a state metric's readings, an activity metric's records
      refuseGoneFlags(rest, METRIC_GONE, 'metric');
      const flags = parseFlags(rest);
      const ref = (flags._ as string[]).join(' ').trim();
      if (!ref) throw new Error('Missing required metric: contract-dev metric show <id|name>');
      const found = await resolveAnyMetric(ref);
      const after = rest.filter((x) => !(flags._ as string[]).includes(x));
      return found.source === 'tracked' ? await showMetric([found.id, ...after]) : await showEventMetric([found.id, ...after]);
    }
    case 'define':
      return await defineMetricCommand(rest);
    case 'update':
      return await updateEventMetric(rest);
    case 'delete':
      return await deleteEventMetric(rest);
    case 'monitor':
      return await monitorEventMetric(rest);
    case 'table':
    case 'item': // the old name, kept quiet
      return await defineItemMetric(rest);
    case 'group':
      return await defineGroupMetric(rest);
    case 'rename':
      return await patchMetric(rest, 'rename');
    case 'pause':
      return await patchMetric(rest, 'pause');
    case 'resume':
      return await patchMetric(rest, 'resume');
    case 'decimals':
      return await patchMetric(rest, 'decimals');
    case 'export':
      refuseGoneFlags(rest, METRIC_GONE, 'metric');
      return await exportMetric(rest);
    case 'track':
      return await trackCommand(rest);
    case 'untrack':
    case 'remove':
    case 'rm':
      return await untrackCommand(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(METRICS_HELP);
      console.log(EVENT_METRIC_HELP);
      return;
    default:
      // `metrics --kind …` — flags only, no subcommand.
      if (sub.startsWith('--')) return args.some((x) => x === '--address' || x === '--chain') ? await listMetrics(args) : await listMetricsCommand(args);
      console.error(`Unknown metrics subcommand: ${sub}\n`);
      console.error(METRICS_HELP);
      process.exit(1);
  }
}

async function listMetrics(args: string[]): Promise<Array<TrackedMetric | ListedMetric>> {
  const flags = parseFlags(args);
  const query: string[] = [];
  const address = flag(flags, 'address');
  if (address) query.push(`address=${requireAddress(address, '--address').toLowerCase()}`);
  const chainRaw = flag(flags, 'chain');
  if (chainRaw) query.push(`chainId=${parseChainId(chainRaw, '--chain')}`);

  const auth = requireAuth();
  const { trackedMetrics } = await apiRequest<{ trackedMetrics: TrackedMetric[] }>(
    auth,
    'GET',
    `/api/mainnet/tracked-metrics${query.length ? `?${query.join('&')}` : ''}`,
  );
  const tracked = trackedMetrics ?? [];
  // event, table and group metrics have no one address or chain: listed when nothing narrows the list
  let others: ListedMetric[] = [];
  let othersFailed = false;
  if (query.length === 0) {
    try {
      others = (await runTool<{ metrics?: ListedMetric[] }>(auth, 'describe_metric', {})).metrics ?? [];
    } catch {
      othersFailed = true;
    }
  }
  if (!tracked.length && !others.length) {
    console.log(othersFailed ? 'No tracked metrics. Event metrics could not be listed just now: contract-dev metric events.' : 'No metrics. Track a value with `contract-dev track <address> <kind>`, or add one up from events with `contract-dev metric define`.');
    return [];
  }
  for (const m of tracked) {
    const state = m.enabled ? '' : '  (paused)';
    console.log(
      `${m.id}  ${m.kind.padEnd(14)} ${String(m.chainId).padEnd(6)} ${shortHex(m.address)}  ${(m.label ?? '').padEnd(36)} ${formatValue(currentValue(m))}${state}`,
    );
  }
  if (others.length) {
    if (tracked.length) console.log('');
    console.log('Event, table and group metrics');
    for (const m of others) console.log(`${m.id}  ${(METRIC_KIND_WORDS[m.kind] ?? m.kind).padEnd(14)} ${m.name.padEnd(36)} ${(m.scope ?? '').padEnd(28)} ${listedStatus(m)}`);
  } else if (othersFailed) console.log('\nEvent metrics could not be listed just now: contract-dev metric events.');
  return [...tracked, ...others];
}

/** An event, table or group metric as describe_metric lists it. */
interface ListedMetric {
  id: string;
  name: string;
  kind: string;
  scope?: string;
  status?: string;
  records?: number;
  error?: string;
  /** On the overview's header strip. */
  pinned?: boolean;
}

/** The CLI's word for each kind: an item metric is made with `metric table`. */
const METRIC_KIND_WORDS: Record<string, string> = { event: 'event', item: 'table', group: 'group' };

/** Where a listed metric stands: its records once it reads new events, or what it is still doing. */
const listedStatus = (m: ListedMetric): string =>
  m.error ? `error: ${m.error}` : m.status === 'ready' && m.kind === 'event' && m.records != null ? `${m.records.toLocaleString('en-US')} records` : (m.status ?? '—');

interface SeriesPayload {
  trackedMetric: TrackedMetric;
  points: Array<{ at: string; value: number | null; blockNumber?: number; txHash?: string }>;
  prev: { at: string; value: number | null } | null;
  /** the window the server actually served — narrower than asked when the plan clamps it */
  range?: string;
}

/** The windows a state metric's readings are served over (the series route's range), by their length in hours. */
const SERIES_WINDOWS: Record<number, string> = { 24: '24h', 168: '7d', 720: '30d', 2160: '90d' };

/** A state metric's window from --last (one the series serves, never rounded) or --since launch (all of it). */
function seriesRange(flags: ParsedFlags, fallback: string): string {
  const last = lastFlag(flags);
  const since = flag(flags, 'since');
  if (last !== undefined && since !== undefined) throw new Error('Say one of --last <window> or --since launch.');
  if (since !== undefined) {
    if (since.trim().toLowerCase() !== 'launch') throw new Error(`A state metric takes --since launch, for all of it (got: ${since}); a window is --last 24h, 7d, 30d or 90d.`);
    return 'all';
  }
  return last === undefined ? fallback : lastWindow(last, SERIES_WINDOWS, "a state metric's readings", { since: true });
}

async function showMetric(args: string[]): Promise<SeriesPayload> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'metric id or label');
  const range = seriesRange(flags, '30d');
  const limitRaw = flag(flags, 'limit');
  const limit = limitRaw === undefined ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');

  const auth = requireAuth();
  const metric = await resolveMetric(auth, ref);
  const payload = await apiRequest<SeriesPayload>(auth, 'GET', `/api/mainnet/tracked-metrics/${metric.id}/series?range=${range}`);
  const m = payload.trackedMetric;
  console.log(`${m.label ?? m.kind}  (${m.id})`);
  console.log(`  kind: ${m.kind}   chain: ${m.chainId}   address: ${m.address}`);
  if (m.params && Object.keys(m.params).length) console.log(`  params: ${JSON.stringify(m.params)}`);
  console.log(`  value: ${formatValue(currentValue(m))}${m.lastValueAt ? `   last change: ${m.lastValueAt}` : ''}${m.enabled ? '' : '   (paused)'}`);
  const shown = payload.points.slice(-limit);
  const served = payload.range ?? range;
  console.log(`  history (${served}${served !== range ? `, the widest window on this plan` : ''}): ${payload.points.length} point${payload.points.length === 1 ? '' : 's'}${shown.length < payload.points.length ? `, showing the last ${shown.length}` : ''}`);
  if (payload.prev && shown.length === 0) console.log(`  carried in from ${payload.prev.at}: ${formatValue(payload.prev.value)}`);
  for (const p of shown) {
    console.log(`  ${p.at}  ${formatValue(p.value).padStart(20)}${p.blockNumber != null ? `  block ${p.blockNumber}` : ''}${p.txHash ? `  ${p.txHash}` : ''}`);
  }
  return payload;
}

// `metrics export`: every point of the window, one row per reading — for a spreadsheet or a
// script. CSV by default; --format json prints the series payload. Newest 2,000 readings.
async function exportMetric(args: string[]): Promise<SeriesPayload> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'metric id or label');
  const range = seriesRange(flags, 'all');
  const format = flag(flags, 'format') ?? 'csv';
  if (format !== 'csv' && format !== 'json') throw new Error('--format must be csv or json');

  const auth = requireAuth();
  let metric: TrackedMetric;
  try {
    metric = await resolveMetric(auth, ref);
  } catch (e) {
    // a group or table total, or an activity metric: added up, with no readings to export (2026-11-09)
    if (!(e instanceof Error && /No tracked metric matches/.test(e.message))) throw e;
    const other = await resolveAnyMetric(ref).catch(() => null);
    if (!other || other.source === 'tracked') throw e;
    throw new Error(`${other.name} is added up from ${other.reads}, so it has no readings to export. Export is for a state metric on one contract or wallet; metric show "${other.name}" --json prints its series.`);
  }
  const payload = await apiRequest<SeriesPayload>(auth, 'GET', `/api/mainnet/tracked-metrics/${metric.id}/series?range=${range}`);
  if (payload.range && payload.range !== range) console.error(`Note: ${payload.range} is the widest window on this plan; exporting that.`);
  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  const csv = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  console.log('at,value,block,tx');
  for (const p of payload.points) console.log([p.at, p.value, p.blockNumber, p.txHash].map(csv).join(','));
  return payload;
}

async function patchMetric(args: string[], action: 'rename' | 'pause' | 'resume' | 'decimals'): Promise<TrackedMetric> {
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const ref = requirePositional(positional, 0, 'metric id or label');
  const auth = requireAuth();
  let metric: TrackedMetric;
  try {
    metric = await resolveMetric(auth, ref);
  } catch (e) {
    if (!(e instanceof Error && /No tracked metric matches/.test(e.message))) throw e;
    const other = await resolveAnyMetric(ref);
    if (other.source === 'tracked') throw e;
    if (action === 'rename') {
      const name = positional.slice(1).join(' ').trim();
      if (!name) throw new Error('Missing required name');
      const { metric: renamed } = await apiRequest<{ metric: { id: string; name: string } }>(auth, 'PATCH', `/api/mainnet/custom-metrics/${other.id}`, { name });
      console.log(`Renamed ${other.id} to "${renamed.name}".`);
      return renamed as unknown as TrackedMetric;
    }
    // pause, resume and decimals are for a state metric on one contract or wallet; a group or table total
    // and an activity metric are added up, not read (2026-11-09: was "is an state metric … it is not sampled")
    throw new Error(`${other.name} is added up from ${other.reads}, so it can't be ${action === 'decimals' ? 'given a display scale' : 'paused or resumed'}. Pause, resume and decimals are for a state metric on one contract or wallet. Delete it (metric delete) or define it again.`);
  }

  let body: Record<string, unknown>;
  switch (action) {
    case 'rename': {
      const label = positional.slice(1).join(' ').trim();
      if (!label) throw new Error('Missing required label');
      body = { label };
      break;
    }
    case 'pause':
      body = { enabled: false };
      break;
    case 'resume':
      body = { enabled: true };
      break;
    case 'decimals': {
      const raw = requirePositional(positional, 1, 'decimals (a number, or "clear")');
      if (raw === 'clear') body = { decimals: null };
      else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error('decimals must be a whole number between 0 and 36, or "clear"');
        body = { decimals: n };
      }
      break;
    }
  }

  const { trackedMetric } = await apiRequest<{ trackedMetric: TrackedMetric }>(auth, 'PATCH', `/api/mainnet/tracked-metrics/${metric.id}`, body);
  const name = trackedMetric.label ?? trackedMetric.kind;
  switch (action) {
    case 'rename':
      console.log(`Renamed ${metric.id} to "${trackedMetric.label}".`);
      break;
    case 'pause':
      console.log(`Paused ${name} — sampling stops, history is kept.`);
      break;
    case 'resume':
      console.log(`Resumed ${name}.`);
      break;
    case 'decimals': {
      const d = (trackedMetric.params as any)?.decimals;
      console.log(d == null ? `Cleared the display scale on ${name}: a supply, an ERC-20 balance or a share price takes its token's decimals again; any other value shows as the chain holds it.` : `${name} now displays with ${d} decimals.`);
      console.log('Monitors reading this metric compare against the new scale — check their thresholds.');
    }
  }
  return trackedMetric;
}

export async function untrackCommand(args: string[]): Promise<Array<{ id: string; label: string | null }> | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help' || args[0] === undefined) {
    console.log(METRICS_HELP);
    return;
  }
  const flags = parseFlags(args);
  const refs = flags._ as string[];
  if (refs.length === 0) throw new Error('Missing required metric id or label');
  const auth = requireAuth();
  const removed: Array<{ id: string; label: string | null }> = [];
  for (const ref of refs) {
    const metric = await resolveMetric(auth, ref);
    await apiRequest(auth, 'DELETE', `/api/mainnet/tracked-metrics/${metric.id}`);
    console.log(`Untracked ${metric.label ?? metric.kind} (${metric.id}) — its history and any monitors reading it are gone.`);
    removed.push({ id: metric.id, label: metric.label });
  }
  return removed;
}
