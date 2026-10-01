import { parseFlags, flag } from './_args';
import { requireAuth, apiRequest, ResolvedAuth } from '../credentials';
import { chainFlag, limitFlag, lookupNames, nameKey, parseRange, RANGES, resolveContract, servedRangeNote } from '../data';
import type { WatchedAccount } from './watch';
import { DASH, chainLabel, fmtAge, fmtChange, fmtInt, fmtPct, nameOr, plural, shortAddr, sparkline, table } from '../view';

const HELP = `contract.dev methods — what is being called on your contracts, method by method

Usage:
  contract.dev methods [<contract>] [flags]           Every method called in the window: calls, reverts, callers, gas
  contract.dev methods <contract> <method>            One method in full: callers, revert reasons, arguments, recent calls
  contract.dev methods <contract> <method> --paths    How calls reach it: the contracts in front of it

Flags:
  --range 24h|7d|30d|90d   Window (default 24h; Free workspaces keep 24h)
  --chain <id|name>        One chain
  --reads | --all          Read-only methods, or reads and writes (default: state-changing)
  --direct | --routed      Called straight from a wallet, or from another contract
  --limit <n>              Rows to print (default 25)

<contract> is an address or a watched contract's name. <method> is a name (transfer), a
signature (transfer(address,uint256)) or a selector (0xa9059cbb). Add --json for everything.
`;

interface MethodRow {
  methodId: string;
  name: string | null;
  signature: string | null;
  kind: 'write' | 'read' | string;
  calls: number;
  direct: number;
  routed: number;
  reverts: number;
  callers: number;
  gasP50: number | null;
  gasP95: number | null;
  lastAt: number | null;
  contractCount: number;
  contracts: Array<{ chainId: number; address: string }>;
  dormant: boolean;
  prev?: { calls: number; reverts: number } | null;
  topRevert?: { reason: string; n: number } | null;
  spark?: number[];
}

export interface MethodsPayload {
  range: string;
  rows: MethodRow[];
  totals: { calls: number; direct: number; routed: number; methods: number; reverts: number; contracts: number };
  prevTotals?: { calls: number; reverts: number } | null;
  buckets?: number[];
  bucketSec?: number;
  abiResolved?: boolean;
}

interface MethodDetail {
  name: string | null;
  signature: string | null;
  selector: string;
  kind: string;
  range: string;
  stats: {
    calls: number;
    direct: number;
    routed: number;
    reverts: number;
    callers: number;
    txs: number;
    gasP50: number | null;
    gasP95: number | null;
    gasMax: number | null;
    depthAvg: number | null;
    firstAt: number | null;
    lastAt: number | null;
  };
  buckets?: { calls: number[]; reverts: number[] };
  callers: Array<{ address: string; calls: number; reverts: number; viaContract: boolean; lastAt: number | null }>;
  reverts: { total: number; sampled: number; reasons: Array<{ reason: string; n: number; where: string; example?: { txHash: string } | null }> };
  args: Array<{ index: number; name: string; type: string; distinct: number; top: Array<{ value: string; n: number }> }>;
  effects?: { events: Array<{ name: string | null; topic0: string; emissions: number }> };
  recent: Array<{ txHash: string; at: number; from: string; depth: number; gasUsed: number; reason: string | null; error: string; txFailed: boolean }>;
}

interface PathsPayload {
  total: number;
  sampled: number;
  unit: string;
  paths: Array<{ hops: Array<{ address: string; name: string | null; label: string | null; selector: string | null; ours: boolean }>; count: number; share: number; lastAt: number | null }>;
}

export async function methodsCommand(args: string[]): Promise<unknown> {
  if (['help', '-h', '--help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const [ref, methodRef] = flags._;
  const range = parseRange(flags, RANGES, '24h');
  const chainId = chainFlag(flags);
  const auth = requireAuth();
  const contract = ref ? await resolveContract(auth, ref, chainId) : null;
  if (methodRef) {
    if (!contract) throw new Error('Name the contract the method belongs to.');
    return flag(flags, 'paths') === 'true' ? await showPaths(auth, contract, methodRef, range) : await showMethod(auth, contract, methodRef, range, limitFlag(flags, 10, 100));
  }
  return await listMethods(auth, contract, chainId, range, flags);
}

async function listMethods(
  auth: ResolvedAuth,
  contract: WatchedAccount | null,
  chainId: number | undefined,
  range: string,
  flags: ReturnType<typeof parseFlags>,
): Promise<MethodsPayload> {
  const lens = flag(flags, 'all') === 'true' ? 'all' : flag(flags, 'reads') === 'true' ? 'reads' : 'writes';
  const route = flag(flags, 'direct') === 'true' ? 'direct' : flag(flags, 'routed') === 'true' ? 'routed' : 'any';
  const limit = limitFlag(flags, 25);
  const q = new URLSearchParams({ range });
  const chain = contract?.chainId ?? chainId;
  if (chain !== undefined) q.set('chainId', String(chain));
  if (contract) q.set('address', contract.address.toLowerCase());
  if (lens !== 'writes') q.set('lens', lens);
  if (route !== 'any') q.set('route', route);
  const payload = await apiRequest<MethodsPayload>(auth, 'GET', `/api/mainnet/console/methods?${q.toString()}`, undefined, { timeoutMs: 60_000 });

  const scope = contract ? `${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)}` : chain !== undefined ? `All contracts on ${chainLabel(chain)}` : 'All contracts';
  const reading = lens === 'all' ? 'reads and writes' : lens === 'reads' ? 'reads' : 'state-changing';
  console.log(`${scope} · last ${payload.range ?? range} · ${reading}${route !== 'any' ? ` · ${route}` : ''}`);
  const clamped = servedRangeNote(range, payload.range);
  if (clamped) console.log(clamped);
  const t = payload.totals;
  if (t) {
    console.log(
      `${plural(t.calls, 'call')} (${fmtChange(t.calls, payload.prevTotals?.calls)} on the previous ${payload.range ?? range}) · ${plural(t.reverts, 'revert')} · ${plural(t.methods, 'method')} on ${plural(t.contracts, 'contract')}`,
    );
  }
  if (payload.buckets?.length) console.log(`Calls  ${sparkline(payload.buckets)}`);
  const rows = (payload.rows ?? []).filter((r) => !r.dormant).slice(0, limit);
  console.log('');
  if (rows.length === 0) {
    console.log('No calls in the window.');
    return payload;
  }
  const many = !contract;
  // Across the workspace, say whose method it is: the contract's name, or how many share it.
  const names = many ? await lookupNames(auth, rows.flatMap((r) => (r.contracts ?? []).slice(0, 1))) : new Map<string, string>();
  const owner = (r: MethodRow) =>
    r.contractCount === 1 && r.contracts?.[0] ? nameOr(names.get(nameKey(r.contracts[0].chainId, r.contracts[0].address)), r.contracts[0].address) : plural(r.contractCount, 'contract');
  for (const line of table(rows, [
    { header: 'Method', value: (r) => r.signature ?? r.name ?? r.methodId, max: 40 },
    ...(many ? [{ header: 'Contract', value: owner, max: 28 }] : []),
    { header: 'Calls', value: (r) => fmtInt(r.calls), align: 'right' },
    { header: 'Change', value: (r) => fmtChange(r.calls, r.prev?.calls), align: 'right' },
    { header: 'Reverts', value: (r) => fmtInt(r.reverts), align: 'right' },
    { header: 'Revert rate', value: (r) => (r.calls ? fmtPct(r.reverts / r.calls) : DASH), align: 'right' },
    { header: 'Callers', value: (r) => fmtInt(r.callers), align: 'right' },
    { header: 'Gas p50', value: (r) => fmtInt(r.gasP50), align: 'right' },
    { header: 'Gas p95', value: (r) => fmtInt(r.gasP95), align: 'right' },
    { header: 'Last', value: (r) => fmtAge(r.lastAt), align: 'right' },
    { header: 'Top revert', value: (r) => (r.topRevert ? `${r.topRevert.reason} ×${fmtInt(r.topRevert.n)}` : ''), max: 36 },
  ])) {
    console.log(line);
  }
  const hidden = (payload.rows ?? []).filter((r) => !r.dormant).length - rows.length;
  if (hidden > 0) console.log(`… ${fmtInt(hidden)} more methods (--limit, or --json for all)`);
  return payload;
}

/** A method named by selector, signature or name, against the contract's verified functions. */
async function resolveSelector(auth: ResolvedAuth, contract: WatchedAccount, ref: string): Promise<{ selector: string; label: string }> {
  if (/^0x[0-9a-fA-F]{8}$/.test(ref)) return { selector: ref.toLowerCase(), label: ref.toLowerCase() };
  const surface = await apiRequest<{ functions?: Array<{ selector: string; name: string; signature: string }> }>(
    auth,
    'GET',
    `/api/mainnet/contract/facts?chainId=${contract.chainId}&address=${contract.address.toLowerCase()}&part=surface`,
    undefined,
    { timeoutMs: 60_000 },
  ).catch(() => ({ functions: [] }));
  const fns = surface.functions ?? [];
  const wanted = ref.replace(/\s+/g, '');
  const bySig = fns.filter((f) => f.signature === wanted);
  const byName = bySig.length ? bySig : fns.filter((f) => f.name.toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return { selector: byName[0].selector.toLowerCase(), label: byName[0].signature };
  if (byName.length > 1) throw new Error(`"${ref}" is overloaded: ${byName.map((f) => `${f.signature} (${f.selector})`).join(', ')}. Name one by signature or selector.`);
  if (fns.length === 0) throw new Error(`No verified functions for ${contract.name ?? contract.address}. Name the method by its selector (0x…).`);
  throw new Error(`${contract.name ?? contract.address} has no method "${ref}". \`contract.dev methods ${contract.address}\` lists what is called.`);
}

async function showMethod(auth: ResolvedAuth, contract: WatchedAccount, ref: string, range: string, limit: number): Promise<MethodDetail> {
  const { selector } = await resolveSelector(auth, contract, ref);
  const d = await apiRequest<MethodDetail>(
    auth,
    'GET',
    `/api/mainnet/console/method?chainId=${contract.chainId}&address=${contract.address.toLowerCase()}&selector=${selector}&range=${range}`,
    undefined,
    { timeoutMs: 60_000 },
  );
  const s = d.stats;
  console.log(`${contract.name ?? shortAddr(contract.address)} · ${d.signature ?? d.name ?? selector} · ${selector} · last ${d.range ?? range}`);
  const clamped = servedRangeNote(range, d.range);
  if (clamped) console.log(clamped);
  console.log(`${plural(s.calls, 'call')} (${fmtInt(s.direct)} direct · ${fmtInt(s.routed)} routed) · ${plural(s.reverts, 'revert')} · ${plural(s.callers, 'caller')} · ${plural(s.txs, 'transaction')}`);
  console.log(`Gas p50 ${fmtInt(s.gasP50)} · p95 ${fmtInt(s.gasP95)} · max ${fmtInt(s.gasMax)}${s.depthAvg != null ? ` · average call depth ${s.depthAvg}` : ''} · last call ${fmtAge(s.lastAt)} ago`);
  if (d.buckets?.calls?.length) console.log(`Calls    ${sparkline(d.buckets.calls)}`);
  if (d.buckets?.reverts?.some((n) => n > 0)) console.log(`Reverts  ${sparkline(d.buckets.reverts)}`);

  const names = await lookupNames(auth, [
    ...d.callers.map((c) => ({ chainId: contract.chainId, address: c.address })),
    ...d.recent.slice(0, limit).map((r) => ({ chainId: contract.chainId, address: r.from })),
  ]);
  const name = (a: string) => nameOr(names.get(nameKey(contract.chainId, a)), a);

  if (d.callers.length) {
    console.log('\nCallers');
    for (const line of table(d.callers.slice(0, limit), [
      { header: 'Caller', value: (c) => name(c.address), max: 32 },
      { header: 'Kind', value: (c) => (c.viaContract ? 'contract' : 'wallet') },
      { header: 'Calls', value: (c) => fmtInt(c.calls), align: 'right' },
      { header: 'Reverts', value: (c) => fmtInt(c.reverts), align: 'right' },
      { header: 'Last', value: (c) => fmtAge(c.lastAt), align: 'right' },
      { header: 'Address', value: (c) => c.address },
    ], '  ')) {
      console.log(line);
    }
  }
  if (d.reverts?.reasons?.length) {
    console.log(`\nRevert reasons${d.reverts.sampled < d.reverts.total ? ` (from ${fmtInt(d.reverts.sampled)} of ${fmtInt(d.reverts.total)})` : ''}`);
    for (const line of table(d.reverts.reasons, [
      { header: 'Reason', value: (r) => r.reason, max: 48 },
      { header: 'Count', value: (r) => fmtInt(r.n), align: 'right' },
      { header: 'Where', value: (r) => (r.where === 'this' ? 'in this method' : 'further down') },
      { header: 'Example', value: (r) => r.example?.txHash ?? '' },
    ], '  ')) {
      console.log(line);
    }
  }
  if (d.args?.length) {
    console.log('\nArguments');
    for (const a of d.args) {
      const top = a.top.slice(0, 3).map((t) => `${a.type === 'address' ? shortAddr(t.value) : t.value} ×${fmtInt(t.n)}`).join(', ');
      console.log(`  ${a.name || `arg${a.index}`} (${a.type}): ${plural(a.distinct, 'distinct value')}${top ? ` · most common ${top}` : ''}`);
    }
  }
  if (d.effects?.events?.length) {
    console.log(`\nEvents it emits: ${d.effects.events.map((e) => `${e.name ?? shortAddr(e.topic0)} ×${fmtInt(e.emissions)}`).join(' · ')}`);
  }
  if (d.recent?.length) {
    console.log('\nRecent calls');
    for (const line of table(d.recent.slice(0, limit), [
      { header: 'Age', value: (r) => fmtAge(r.at), align: 'right' },
      { header: 'From', value: (r) => name(r.from), max: 28 },
      { header: 'Depth', value: (r) => String(r.depth), align: 'right' },
      { header: 'Gas', value: (r) => fmtInt(r.gasUsed), align: 'right' },
      { header: 'Result', value: (r) => (r.error ? `reverted${r.reason ? `: ${r.reason}` : ''}` : r.txFailed ? 'ok, transaction failed' : 'ok'), max: 32 },
      { header: 'Tx', value: (r) => r.txHash },
    ], '  ')) {
      console.log(line);
    }
  }
  return d;
}

async function showPaths(auth: ResolvedAuth, contract: WatchedAccount, ref: string, range: string): Promise<PathsPayload> {
  const { selector, label } = await resolveSelector(auth, contract, ref);
  const p = await apiRequest<PathsPayload>(
    auth,
    'GET',
    `/api/mainnet/console/paths?chainId=${contract.chainId}&range=${range}&method=${contract.address.toLowerCase()}:${selector}`,
    undefined,
    { timeoutMs: 60_000 },
  );
  console.log(`How calls reach ${contract.name ?? shortAddr(contract.address)} · ${label} · last ${range}`);
  console.log(`${plural(p.total, p.unit === 'calls' ? 'call' : 'transaction')}${p.sampled < p.total ? ` · paths from a sample of ${fmtInt(p.sampled)}` : ''}\n`);
  if (!p.paths?.length) {
    console.log('No calls in the window.');
    return p;
  }
  for (const line of table(p.paths, [
    { header: 'Share', value: (x) => fmtPct(x.share), align: 'right' },
    { header: 'Calls', value: (x) => fmtInt(x.count), align: 'right' },
    { header: 'Path', value: (x) => x.hops.map((h) => `${h.label ?? shortAddr(h.address)}.${h.name ?? h.selector ?? '?'}`).join(' → '), max: 120 },
  ])) {
    console.log(line);
  }
  return p;
}
