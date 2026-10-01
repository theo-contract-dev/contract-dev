import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { parseFlags, flag } from './_args';
import { requireAuth, apiRequest, ResolvedAuth } from '../credentials';
import { chainFlag, isAddress, limitFlag, resolveContract, workspaceContracts } from '../data';
import { DASH, chainLabel, fmtAge, fmtCompact, fmtInt, fmtUsd, nameOr, plural, shortAddr, table } from '../view';
import { relPath } from '../format';

const HELP = `contract.dev explorer lookups — any transaction, address or block on a supported chain

Usage:
  contract.dev tx <hash> [--chain] [--trace] [--state]   A transaction: outcome, decoded call, fees, transfers, logs;
                                                         --trace for its call tree, --state for what it changed
  contract.dev address <0x…> [--chain] [--limit]         An address: balance, what it is, its recent transactions
  contract.dev block <number> [--chain] [--limit]        A block and its transactions
  contract.dev wallet <0x…> [--chain] [--approvals|--txs]   A wallet's tokens, its open approvals, or its transactions
  contract.dev source <contract|0x…> [--chain] [--out <dir>]  A contract's verified source; --out writes the files

Chains: Ethereum, Arbitrum, Avalanche and Sepolia. Without --chain, tx looks on each of them,
address and source use the chain a watched contract is on (else Ethereum), and block reads
Ethereum. Add --json for the full answers.
`;

const CHAINS = [1, 42161, 43114, 11155111];
const NATIVE: Record<number, string> = { 1: 'ETH', 42161: 'ETH', 43114: 'AVAX', 11155111: 'ETH' };

/** A wei amount as the chain's coin: 1.5 ETH, 0.000123 AVAX. */
export function fmtNative(wei: string | null | undefined, chainId: number): string {
  if (wei == null) return DASH;
  let v: bigint;
  try {
    v = BigInt(wei);
  } catch {
    return DASH;
  }
  const symbol = NATIVE[chainId] ?? 'native';
  if (v === BigInt(0)) return `0 ${symbol}`;
  const neg = v < BigInt(0);
  const abs = neg ? -v : v;
  const base = BigInt(10) ** BigInt(18);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(18, '0');
  let shown: string;
  if (whole >= BigInt(1000)) shown = whole.toLocaleString('en-US');
  else if (whole > BigInt(0)) shown = `${whole}.${frac.slice(0, 4)}`.replace(/\.?0+$/, '');
  else {
    const firstSig = frac.search(/[1-9]/);
    shown = `0.${frac.slice(0, Math.min(18, firstSig + 4))}`.replace(/0+$/, '');
  }
  return `${neg ? '-' : ''}${shown} ${symbol}`;
}

const help = (args: string[]) => !args.length || ['help', '-h', '--help'].includes(args[0]);

// ── tx ───────────────────────────────────────────────────────────────────

interface TxDetail {
  hash: string;
  status: boolean | null;
  blockNumber: number;
  confirmations: number;
  timestamp: number;
  from: string;
  to: string | null;
  fromName: string | null;
  toName: string | null;
  contractCreated: string | null;
  valueWei: string;
  selector: string | null;
  methodName: string | null;
  nonce: number;
  gasUsed: number;
  gasLimit: number;
  effectiveGasPriceGwei: number | null;
  feeWei: string | null;
  call: { method: string; signature: string; args: Array<{ name: string; type: string; value: string }> } | null;
  transfers: Array<{ token: string; symbol: string; amount: string; from: string; to: string }>;
  logs: Array<{ address: string; name: string | null; args: [string, string][]; index: number }>;
}

interface TraceFrame {
  id: string;
  depth: number;
  type: string;
  from: string;
  to: string | null;
  valueWei: string;
  gasUsed: number;
  method: string | null;
  selector: string | null;
  args: Array<{ name: string; type: string; value: string }> | null;
  error: string | null;
  revertReason: string | null;
}

interface StateAccount {
  address: string;
  balance: { before: string; after: string } | null;
  nonce: { before: number; after: number } | null;
  code: { before: number; after: number } | null;
  storage: Array<{ slot: string; before: string; after: string }>;
}

async function findTx(auth: ResolvedAuth, hash: string, chainId: number | undefined): Promise<{ chainId: number; tx: TxDetail }> {
  const chains = chainId !== undefined ? [chainId] : CHAINS;
  const answers = await Promise.all(
    chains.map((c) =>
      apiRequest<TxDetail>(auth, 'GET', `/api/mainnet/explorer/tx?chainId=${c}&hash=${hash}`, undefined, { timeoutMs: 45_000 })
        .then((tx) => ({ chainId: c, tx }))
        .catch(() => null),
    ),
  );
  const hit = answers.find((a) => a && a.tx?.hash);
  if (!hit) throw new Error(`No transaction ${hash} on ${chains.map(chainLabel).join(', ')}.`);
  return hit;
}

const argList = (args: Array<{ name: string; value: string }> | null | undefined, max = 3) =>
  args ? args.slice(0, max).map((a) => `${a.name ? `${a.name}: ` : ''}${a.value.length > 24 ? `${a.value.slice(0, 22)}…` : a.value}`).join(', ') + (args.length > max ? ', …' : '') : '';

export async function txCommand(args: string[]): Promise<unknown> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const hash = flags._[0];
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) throw new Error('tx takes a transaction hash (0x + 64 hex).');
  const auth = requireAuth();
  const { chainId, tx } = await findTx(auth, hash.toLowerCase(), chainFlag(flags));
  const status = tx.status === true ? 'success' : tx.status === false ? 'failed' : 'pending';
  console.log(`${tx.hash} · ${chainLabel(chainId)} · ${status}`);
  const rows: Array<[string, string]> = [
    ['Block', `${fmtInt(tx.blockNumber)} · ${new Date(tx.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC (${fmtAge(tx.timestamp * 1000)} ago) · ${plural(tx.confirmations, 'confirmation')}`],
    ['From', `${tx.fromName ? `${tx.fromName} ` : ''}${tx.from}`],
    ['To', tx.contractCreated ? `new contract ${tx.contractCreated}` : `${tx.toName ? `${tx.toName} ` : ''}${tx.to ?? DASH}`],
    ['Call', tx.call ? `${tx.call.method}(${argList(tx.call.args, 6)})` : tx.methodName ?? tx.selector ?? 'plain transfer'],
    ['Value', fmtNative(tx.valueWei, chainId)],
    ['Fee', `${fmtNative(tx.feeWei, chainId)} · gas ${fmtInt(tx.gasUsed)} of ${fmtInt(tx.gasLimit)}${tx.effectiveGasPriceGwei != null ? ` at ${tx.effectiveGasPriceGwei.toPrecision(4)} gwei` : ''}`],
    ['Nonce', String(tx.nonce)],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v}`);
  if (tx.transfers?.length) {
    console.log(`\nTransfers (${fmtInt(tx.transfers.length)})`);
    for (const line of table(tx.transfers, [
      { header: 'Amount', value: (t) => `${t.amount} ${t.symbol}`.trim(), align: 'right', max: 32 },
      { header: 'From', value: (t) => t.from },
      { header: 'To', value: (t) => t.to },
    ], '  ')) {
      console.log(line);
    }
  }
  if (tx.logs?.length) {
    console.log(`\nLogs (${fmtInt(tx.logs.length)})`);
    for (const log of tx.logs.slice(0, 50)) {
      const args = (log.args ?? []).map(([k, v]) => `${k}=${v.length > 24 ? `${v.slice(0, 22)}…` : v}`).join(' ');
      console.log(`  ${String(log.index).padStart(3)}  ${shortAddr(log.address)}  ${log.name ?? 'undecoded'}${args ? `  ${args}` : ''}`);
    }
    if (tx.logs.length > 50) console.log(`  … ${fmtInt(tx.logs.length - 50)} more (--json)`);
  }

  const out: Record<string, unknown> = { chainId, tx };
  if (flag(flags, 'trace') === 'true') {
    const trace = await apiRequest<{ status: string; frames: TraceFrame[]; truncated: boolean }>(auth, 'GET', `/api/mainnet/explorer/tx/trace?chainId=${chainId}&hash=${tx.hash}`, undefined, {
      timeoutMs: 60_000,
    });
    out.trace = trace;
    console.log(`\nCall tree${trace.truncated ? ' (truncated)' : ''}`);
    if (trace.status !== 'ok') console.log(`  ${trace.status === 'unsupported' ? `Call traces are not available on ${chainLabel(chainId)}.` : 'Call trace unavailable. Retry in a moment.'}`);
    for (const f of trace.frames ?? []) {
      const target = f.to ? shortAddr(f.to) : 'new contract';
      const what = f.method ? `${f.method}(${argList(f.args)})` : f.selector ?? '';
      const failed = f.error ? `  ✗ ${f.revertReason ?? f.error}` : '';
      const value = f.valueWei && f.valueWei !== '0' ? `  ${fmtNative(f.valueWei, chainId)}` : '';
      console.log(`  ${'  '.repeat(f.depth)}${f.type.toLowerCase()} ${target}${what ? `.${what}` : ''}${value}  gas ${fmtInt(f.gasUsed)}${failed}`);
    }
  }
  if (flag(flags, 'state') === 'true') {
    const state = await apiRequest<{ status: string; accounts: StateAccount[] }>(auth, 'GET', `/api/mainnet/explorer/tx/state?chainId=${chainId}&hash=${tx.hash}`, undefined, {
      timeoutMs: 60_000,
    });
    out.state = state;
    console.log('\nState changes');
    if (state.status !== 'ok') console.log(`  ${state.status === 'unsupported' ? `State changes are not available on ${chainLabel(chainId)}.` : 'State changes unavailable. Retry in a moment.'}`);
    for (const a of state.accounts ?? []) {
      const parts: string[] = [];
      if (a.balance) {
        const delta = (BigInt(a.balance.after) - BigInt(a.balance.before)).toString();
        parts.push(`balance ${delta.startsWith('-') ? '' : '+'}${fmtNative(delta, chainId)}`);
      }
      if (a.nonce) parts.push(`nonce ${a.nonce.before} → ${a.nonce.after}`);
      if (a.code) parts.push(`code ${fmtInt(a.code.before)} → ${fmtInt(a.code.after)} bytes`);
      if (a.storage?.length) parts.push(plural(a.storage.length, 'slot'));
      console.log(`  ${a.address}  ${parts.join(' · ')}`);
      for (const s of (a.storage ?? []).slice(0, 8)) console.log(`      ${s.slot}: ${s.before} → ${s.after}`);
      if ((a.storage ?? []).length > 8) console.log(`      … ${fmtInt(a.storage.length - 8)} more (--json)`);
    }
  }
  return out;
}

// ── address ──────────────────────────────────────────────────────────────

interface AddressPayload {
  address: string;
  balanceWei: string;
  nonce: number;
  isContract: boolean;
  identity: { name: string | null; verified: boolean; proxy: boolean; implementation: string | null; deployer: string | null; deployedAt: number | null } | null;
  txs: Array<{ hash: string; blockNumber: number; timestamp: number; from: string; to: string | null; valueWei: string; methodName: string | null; selector: string | null; failed: boolean }>;
}

/** The chain to read an address on: --chain, else the chain it is watched on, else Ethereum. */
async function chainForAddress(auth: ResolvedAuth, address: string, chainId: number | undefined): Promise<number> {
  if (chainId !== undefined) return chainId;
  const watched = await workspaceContracts(auth).catch(() => []);
  return watched.find((w) => w.address.toLowerCase() === address.toLowerCase())?.chainId ?? 1;
}

export async function addressCommand(args: string[]): Promise<AddressPayload | void> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const address = flags._[0];
  if (!isAddress(address)) throw new Error('address takes an address (0x…).');
  const limit = limitFlag(flags, 15, 50);
  const auth = requireAuth();
  const chainId = await chainForAddress(auth, address, chainFlag(flags));
  const a = await apiRequest<AddressPayload>(auth, 'GET', `/api/mainnet/explorer/address?chainId=${chainId}&address=${address.toLowerCase()}`, undefined, { timeoutMs: 60_000 });
  const id = a.identity;
  console.log(`${a.address} · ${chainLabel(chainId)} · ${a.isContract ? 'contract' : 'wallet'}`);
  const rows: Array<[string, string]> = [['Balance', fmtNative(a.balanceWei, chainId)], ['Nonce', String(a.nonce)]];
  if (id?.name || id?.verified) rows.push(['Contract', [id.name ?? 'Unnamed', id.verified ? 'verified' : 'not verified', id.proxy ? `proxy → ${id.implementation ?? DASH}` : null].filter(Boolean).join(' · ')]);
  if (id?.deployer) rows.push(['Deployed', `${id.deployedAt ? `${new Date(id.deployedAt).toISOString().slice(0, 10)} ` : ''}by ${id.deployer}`]);
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v}`);
  const txs = (a.txs ?? []).slice(0, limit);
  if (txs.length) {
    console.log('\nRecent transactions');
    for (const line of table(txs, [
      { header: 'Age', value: (t) => fmtAge(t.timestamp * 1000), align: 'right' },
      { header: 'Method', value: (t) => t.methodName ?? t.selector ?? 'transfer', max: 24 },
      { header: 'From', value: (t) => shortAddr(t.from) },
      { header: 'To', value: (t) => shortAddr(t.to) },
      { header: 'Value', value: (t) => fmtNative(t.valueWei, chainId), align: 'right' },
      { header: 'Status', value: (t) => (t.failed ? 'failed' : 'success') },
      { header: 'Tx', value: (t) => t.hash },
    ], '  ')) {
      console.log(line);
    }
  }
  return a;
}

// ── block ────────────────────────────────────────────────────────────────

interface BlockPayload {
  number: number;
  hash: string;
  timestamp: number;
  txCount: number;
  gasUsed: number;
  gasLimit: number;
  baseFeeGwei: number | null;
  miner: string;
  head: number | null;
  txs: Array<{ hash: string; from: string; to: string | null; valueWei: string; method: string | null; selector: string | null; status: string | null; index: number }>;
}

export async function blockCommand(args: string[]): Promise<BlockPayload | void> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const n = Number(flags._[0]);
  if (!Number.isInteger(n) || n < 0) throw new Error('block takes a block number.');
  const chainId = chainFlag(flags) ?? 1;
  const limit = limitFlag(flags, 20, 1000);
  const auth = requireAuth();
  const b = await apiRequest<BlockPayload>(auth, 'GET', `/api/mainnet/explorer/block?chainId=${chainId}&number=${n}`, undefined, { timeoutMs: 60_000 });
  console.log(`Block ${fmtInt(b.number)} · ${chainLabel(chainId)} · ${new Date(b.timestamp * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC (${fmtAge(b.timestamp * 1000)} ago)`);
  console.log(
    `${plural(b.txCount, 'transaction')} · gas ${fmtInt(b.gasUsed)} of ${fmtInt(b.gasLimit)} (${b.gasLimit ? ((b.gasUsed / b.gasLimit) * 100).toFixed(1) : DASH}%)${b.baseFeeGwei != null ? ` · base fee ${b.baseFeeGwei.toPrecision(4)} gwei` : ''} · ${b.head != null ? plural(b.head - b.number, 'confirmation') : ''}`,
  );
  console.log(`  Hash   ${b.hash}\n  Miner  ${b.miner}\n`);
  for (const line of table((b.txs ?? []).slice(0, limit), [
    { header: '#', value: (t) => String(t.index), align: 'right' },
    { header: 'Method', value: (t) => t.method ?? t.selector ?? 'transfer', max: 24 },
    { header: 'From', value: (t) => shortAddr(t.from) },
    { header: 'To', value: (t) => shortAddr(t.to) },
    { header: 'Value', value: (t) => fmtNative(t.valueWei, chainId), align: 'right' },
    { header: 'Status', value: (t) => t.status ?? DASH },
    { header: 'Tx', value: (t) => t.hash },
  ])) {
    console.log(line);
  }
  if ((b.txs ?? []).length > limit) console.log(`… ${fmtInt(b.txs.length - limit)} more (--limit, or --json for all)`);
  return b;
}

// ── wallet ───────────────────────────────────────────────────────────────

interface WalletTokens {
  totalUsd: number | null;
  truncated: boolean;
  tokens: Array<{ chainId: number; tokenAddress: string | null; symbol: string; name: string; balanceFormatted: number; usdPrice: number | null; usdValue: number | null; nativeToken: boolean }>;
}

interface WalletApprovals {
  totalUsdAtRisk: number;
  totalApprovals: number;
  approvals: Array<{ chainId: number; txHash: string; approvedAt: string | null; token: { address: string; symbol: string }; spender: { address: string; label: string | null; entity: string | null }; valueFormatted: number; unlimited: boolean; atRiskAmount: number; usdAtRisk: number }>;
}

interface WalletTxs {
  transactions: Array<{ chainId: number; hash: string; blockNumber: number; direction: string; method: string | null; valueNative: number; nativeSymbol: string; counterparty: string | null; failed: boolean; timestamp: string; gasCostUsd: number | null }>;
}

export async function walletCommand(args: string[]): Promise<unknown> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const address = flags._[0];
  if (!isAddress(address)) throw new Error('wallet takes an address (0x…).');
  const chainId = chainFlag(flags);
  const limit = limitFlag(flags, 20, 200);
  const auth = requireAuth();
  const q = chainId !== undefined ? `?chainId=${chainId}` : '';
  const base = `/api/mainnet/wallets/${address.toLowerCase()}`;
  const opts = { timeoutMs: 60_000 };
  const where = chainId !== undefined ? chainLabel(chainId) : 'all chains';

  if (flag(flags, 'approvals') === 'true') {
    const a = await apiRequest<WalletApprovals>(auth, 'GET', `${base}/approvals${q}`, undefined, opts);
    console.log(`${address} · approvals · ${where}`);
    console.log(`${plural(a.totalApprovals, 'open approval')} · ${fmtUsd(a.totalUsdAtRisk)} could be pulled\n`);
    if (!a.approvals?.length) {
      console.log('No open approvals.');
      return a;
    }
    for (const line of table(a.approvals.slice(0, limit), [
      { header: 'Token', value: (r) => r.token.symbol, max: 16 },
      { header: 'Spender', value: (r) => nameOr(r.spender.label ?? r.spender.entity, r.spender.address), max: 32 },
      { header: 'Allowance', value: (r) => (r.unlimited ? 'unlimited' : fmtCompact(r.valueFormatted)), align: 'right' },
      { header: 'At risk', value: (r) => fmtUsd(r.usdAtRisk), align: 'right' },
      { header: 'Chain', value: (r) => chainLabel(r.chainId) },
      { header: 'Approved in', value: (r) => r.txHash },
    ])) {
      console.log(line);
    }
    return a;
  }

  if (flag(flags, 'txs') === 'true') {
    const t = await apiRequest<WalletTxs>(auth, 'GET', `${base}/transactions${q}`, undefined, opts);
    console.log(`${address} · transactions · ${where}\n`);
    if (!t.transactions?.length) {
      console.log('No transactions.');
      return t;
    }
    for (const line of table(t.transactions.slice(0, limit), [
      { header: 'Age', value: (r) => fmtAge(Date.parse(r.timestamp)), align: 'right' },
      { header: 'Dir', value: (r) => r.direction },
      { header: 'Method', value: (r) => r.method ?? 'transfer', max: 24 },
      { header: 'Counterparty', value: (r) => shortAddr(r.counterparty) },
      { header: 'Value', value: (r) => `${fmtCompact(r.valueNative)} ${r.nativeSymbol}`, align: 'right' },
      { header: 'Gas', value: (r) => fmtUsd(r.gasCostUsd), align: 'right' },
      { header: 'Status', value: (r) => (r.failed ? 'failed' : 'success') },
      { header: 'Tx', value: (r) => r.hash },
    ])) {
      console.log(line);
    }
    return t;
  }

  const w = await apiRequest<WalletTokens>(auth, 'GET', `${base}/tokens${q}`, undefined, opts);
  console.log(`${address} · tokens · ${where}`);
  console.log(`${fmtUsd(w.totalUsd)} across ${plural(w.tokens?.length ?? 0, 'token')}${w.truncated ? ' (the largest only)' : ''}\n`);
  const tokens = (w.tokens ?? []).slice().sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1)).slice(0, limit);
  for (const line of table(tokens, [
    { header: 'Token', value: (r) => r.symbol, max: 16 },
    { header: 'Chain', value: (r) => chainLabel(r.chainId) },
    { header: 'Balance', value: (r) => fmtCompact(r.balanceFormatted), align: 'right' },
    { header: 'Price', value: (r) => (r.usdPrice == null ? DASH : r.usdPrice >= 1 ? `$${r.usdPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${r.usdPrice.toPrecision(3)}`), align: 'right' },
    { header: 'Value', value: (r) => fmtUsd(r.usdValue), align: 'right' },
    { header: 'Address', value: (r) => (r.nativeToken ? 'native' : r.tokenAddress ?? DASH) },
  ])) {
    console.log(line);
  }
  return w;
}

// ── source ───────────────────────────────────────────────────────────────

/**
 * The files of a verified contract from the explorer's source field, which comes in three
 * shapes: one Solidity file as plain text; a JSON map of files; or a standard-JSON compiler
 * input wrapped in an extra pair of braces.
 */
export function sourceFiles(name: string, sourceCode: string): Record<string, string> {
  const text = sourceCode.trim();
  const fromSources = (sources: Record<string, { content?: string }>) =>
    Object.fromEntries(Object.entries(sources).map(([path, f]) => [path, f?.content ?? '']));
  if (text.startsWith('{{') && text.endsWith('}}')) {
    try {
      return fromSources(JSON.parse(text.slice(1, -1)).sources ?? {});
    } catch {
      // fall through: treat as one file
    }
  } else if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return fromSources(parsed.sources ?? parsed);
    } catch {
      // fall through
    }
  }
  return { [`${name || 'Contract'}.sol`]: sourceCode };
}

export async function sourceCommand(args: string[]): Promise<unknown> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const ref = flags._[0];
  const auth = requireAuth();
  let address = ref;
  let chainId = chainFlag(flags);
  if (!isAddress(ref)) {
    const c = await resolveContract(auth, ref, chainId);
    address = c.address;
    chainId = c.chainId;
  }
  chainId = await chainForAddress(auth, address, chainId);
  const s = await apiRequest<{ name: string | null; sourceCode: string | null }>(auth, 'GET', `/api/mainnet/explorer/source?chainId=${chainId}&address=${address.toLowerCase()}`, undefined, {
    timeoutMs: 60_000,
  });
  if (!s.sourceCode) {
    console.log(`No verified source for ${address} on ${chainLabel(chainId)}.`);
    return s;
  }
  const files = sourceFiles(s.name ?? 'Contract', s.sourceCode);
  const paths = Object.keys(files);
  console.log(`${s.name ?? 'Contract'} · ${address} · ${chainLabel(chainId)} · ${plural(paths.length, 'file')}`);
  const out = flag(flags, 'out');
  if (out && out !== 'true') {
    const root = resolve(out);
    for (const p of paths) {
      const rel = normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`Refusing to write outside ${relPath(root)}: ${p}`);
      const target = join(root, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, files[p]);
    }
    console.log(`Wrote ${plural(paths.length, 'file')} to ${relPath(root)}`);
  } else {
    for (const p of paths) console.log(`  ${p}  (${fmtInt(files[p].split('\n').length)} lines)`);
    console.log('\nWrite them out with --out <dir>.');
  }
  return { name: s.name, chainId, address, files };
}
