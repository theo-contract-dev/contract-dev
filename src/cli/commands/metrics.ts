import { Interface, isAddress } from 'ethers';
import { parseFlags, flag, requirePositional, requireFlag } from './_args';
import { apiRequest, requireAuth, ResolvedAuth } from '../credentials';
import { parseChainId, WatchedAccount } from './watch';

const TRACK_HELP = `contract.dev track — track an on-chain value as a metric (charted on /metrics, usable by monitors)

Usage:
  contract.dev track <address> <kind> [--chain <id>] [--label "<name>"] [kind flags]
  contract.dev untrack <id|label> [...]          Stop tracking (also removes monitors that read it)

Kinds:
  native-balance                                 The address's native balance
  erc20-balance   --token <addr>                 The address's balance of an ERC20
  total-supply                                   An ERC20's totalSupply()
  balance-of      --holder <addr>                An ERC20's balanceOf(holder)
  function        --function "<sig>" [--args a,b] The result of any view call, e.g.
                  [--word <n>] [--signed]          --function "convertToAssets(uint256) returns (uint256)" --args 1e18
                  [--decimals <n>]                 (--calldata 0x… instead of --function/--args; --word picks
                                                    one return value; --decimals sets the display scale)
  tvl                                            The contract's TVL in USD (provider-backed)
  calls | reverts | revert-rate | callers | gas-p95
                  [--method <selector|"sig">]    Method telemetry from the trace store, over a window
                  [--window 5m|15m|1h|6h|24h]      (default: any method, 1h). --only / --except <addrs>
                  [--only a,b | --except a,b]      filter by caller.

Examples:
  contract.dev track 0xA0b8… total-supply --label "USDC supply"
  contract.dev track 0xVault… function --function "totalAssets() returns (uint256)" --decimals 18
  contract.dev track 0xPool… calls --method "swap(address,bool,int256,uint160,bytes)" --window 15m
`;

const METRICS_HELP = `contract.dev metrics — the workspace's tracked metrics

Usage:
  contract.dev metrics [--address <addr>] [--chain <id>]    List metrics (id, kind, chain, address, label, value)
  contract.dev metrics show <id|label> [--range 24h|7d|30d|90d|all] [--limit <n>]
                                                            The metric and its recent history
  contract.dev metrics rename <id|label> "<label>"
  contract.dev metrics pause <id|label>                     Stop sampling (keeps history)
  contract.dev metrics resume <id|label>
  contract.dev metrics decimals <id|label> <n|clear>        Display scale — re-interprets the stored history
                                                            (monitor thresholds on it were typed against the old scale)
  contract.dev metrics export <id|label> [--range 24h|7d|30d|90d|all] [--format csv|json]
                                                            The metric's history: at, value, block, tx (default: csv)
  contract.dev track …                                      Start tracking (try: track help; also: metrics track …)
  contract.dev untrack <id|label>                           Stop tracking (also: metrics untrack …)

A metric may be referred to by its id or, when unambiguous, its label. \`--chain\` takes a
chain id or name (ethereum, arbitrum, avalanche, sepolia). Tracking a value that is already
tracked returns the existing metric.
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
  'total-supply': { api: 'totalSupply', label: 'Total supply' },
  'balance-of': { api: 'functionResult', label: 'Balance of' },
  function: { api: 'functionResult', label: 'Function call' },
  tvl: { api: 'tvlUsd', label: 'TVL' },
  calls: { api: 'callCount', label: 'Method calls' },
  reverts: { api: 'revertCount', label: 'Method reverts' },
  'revert-rate': { api: 'revertRate', label: 'Method revert rate' },
  callers: { api: 'callerCount', label: 'Method callers' },
  'gas-p95': { api: 'gasP95', label: 'Method gas p95' },
};
const TRACE_KINDS = new Set(['calls', 'reverts', 'revert-rate', 'callers', 'gas-p95']);
// The windows the app's picker offers (TRACE_WINDOW_OPTIONS_SEC in @mockchain/config).
const TRACE_WINDOWS: Record<string, number> = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };
const BALANCE_OF_SIGNATURE = 'balanceOf(address) → uint256';

export const shortHex = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export function encodeBalanceOf(holder: string): string {
  return '0x70a08231' + holder.slice(2).toLowerCase().padStart(64, '0');
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
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help' || args[0] === undefined) {
    console.log(TRACK_HELP);
    return;
  }
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const address = requireAddress(requirePositional(positional, 0, 'address'), 'address');
  const kindName = requirePositional(positional, 1, `kind (one of: ${Object.keys(KINDS).join(', ')})`);
  const kind = KINDS[kindName];
  if (!kind) throw new Error(`Unknown kind "${kindName}". One of: ${Object.keys(KINDS).join(', ')}`);
  const chainId = parseChainId(flag(flags, 'chain') ?? '1', '--chain');

  let params: Record<string, unknown> | undefined;
  let labelSuffix = kind.label;
  switch (kindName) {
    case 'erc20-balance':
      params = { token: requireAddress(requireFlag(flags, 'token'), '--token') };
      break;
    case 'balance-of': {
      const holder = requireAddress(requireFlag(flags, 'holder'), '--holder');
      params = { calldata: encodeBalanceOf(holder), signature: BALANCE_OF_SIGNATURE };
      labelSuffix = `Balance of ${shortHex(holder)}`;
      break;
    }
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
  // The provider / trace kinds name themselves server-side from the watched label; the
  // on-chain kinds don't, so generate the app's "<account> · <kind>" form for them.
  let label = flag(flags, 'label');
  if (!label && kindName !== 'tvl' && !TRACE_KINDS.has(kindName)) {
    const subject = await subjectName(auth, chainId, address);
    label = kindName === 'function' && typeof params?.signature === 'string' ? `${subject}.${labelSuffix}` : `${subject} · ${labelSuffix}`;
  }

  const payload = await apiRequest<{ trackedMetric: TrackedMetric; created?: boolean }>(auth, 'POST', '/api/mainnet/tracked-metrics', {
    chainId,
    address,
    kind: kind.api,
    ...(params && Object.keys(params).length ? { params } : {}),
    ...(label ? { label } : {}),
  });
  const metric = payload.trackedMetric;
  const verb = payload.created === false ? 'Already tracking' : 'Tracking';
  console.log(`${verb} ${metric.label ?? kind.label} on chain ${metric.chainId} (id: ${metric.id})`);
  return metric;
}

// A metric by id, or by label when exactly one matches (case-insensitive).
export async function resolveMetric(auth: ResolvedAuth, ref: string): Promise<TrackedMetric> {
  const { trackedMetrics } = await apiRequest<{ trackedMetrics: TrackedMetric[] }>(auth, 'GET', '/api/mainnet/tracked-metrics');
  const all = trackedMetrics ?? [];
  const byId = all.find((m) => m.id === ref);
  if (byId) return byId;
  const lower = ref.trim().toLowerCase();
  const byLabel = all.filter((m) => (m.label ?? '').toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) {
    throw new Error(`${byLabel.length} metrics are labelled "${ref}" — use an id: ${byLabel.map((m) => m.id).join(', ')}`);
  }
  throw new Error(`No tracked metric matches "${ref}" (run \`contract.dev metrics\` to list them).`);
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
    case 'list':
      return await listMetrics(sub === undefined ? args : rest);
    case 'show':
      return await showMetric(rest);
    case 'rename':
      return await patchMetric(rest, 'rename');
    case 'pause':
      return await patchMetric(rest, 'pause');
    case 'resume':
      return await patchMetric(rest, 'resume');
    case 'decimals':
      return await patchMetric(rest, 'decimals');
    case 'export':
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
      return;
    default:
      // `metrics --address …` — flags only, no subcommand.
      if (sub.startsWith('--')) return await listMetrics(args);
      console.error(`Unknown metrics subcommand: ${sub}\n`);
      console.error(METRICS_HELP);
      process.exit(1);
  }
}

async function listMetrics(args: string[]): Promise<TrackedMetric[]> {
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
  if (!trackedMetrics?.length) {
    console.log('No tracked metrics. Start one with `contract.dev track <address> <kind>`.');
    return [];
  }
  for (const m of trackedMetrics) {
    const state = m.enabled ? '' : '  (paused)';
    console.log(
      `${m.id}  ${m.kind.padEnd(14)} ${String(m.chainId).padEnd(6)} ${shortHex(m.address)}  ${(m.label ?? '').padEnd(36)} ${formatValue(currentValue(m))}${state}`,
    );
  }
  return trackedMetrics;
}

interface SeriesPayload {
  trackedMetric: TrackedMetric;
  points: Array<{ at: string; value: number | null; blockNumber?: number; txHash?: string }>;
  prev: { at: string; value: number | null } | null;
}

async function showMetric(args: string[]): Promise<SeriesPayload> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'metric id or label');
  const range = flag(flags, 'range') ?? '30d';
  if (!['24h', '7d', '30d', '90d', 'all'].includes(range)) throw new Error('--range must be one of 24h, 7d, 30d, 90d, all');
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
  console.log(`  history (${range}): ${payload.points.length} point${payload.points.length === 1 ? '' : 's'}${shown.length < payload.points.length ? `, showing the last ${shown.length}` : ''}`);
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
  const range = flag(flags, 'range') ?? 'all';
  if (!['24h', '7d', '30d', '90d', 'all'].includes(range)) throw new Error('--range must be one of 24h, 7d, 30d, 90d, all');
  const format = flag(flags, 'format') ?? 'csv';
  if (format !== 'csv' && format !== 'json') throw new Error('--format must be csv or json');

  const auth = requireAuth();
  const metric = await resolveMetric(auth, ref);
  const payload = await apiRequest<SeriesPayload>(auth, 'GET', `/api/mainnet/tracked-metrics/${metric.id}/series?range=${range}`);
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
  const metric = await resolveMetric(auth, ref);

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
      console.log(d == null ? `Cleared the display scale on ${name} (the app will re-probe it).` : `${name} now displays with ${d} decimals.`);
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
