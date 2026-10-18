import { readFileSync } from 'node:fs';
import { showContract } from './inspect';
import { parseFlags, flag, requirePositional, type ParsedFlags } from './_args';
import { apiRequest, requireAuth, ResolvedAuth } from '../credentials';
import { runTool } from '../tools';
import { formatUsd } from '../format';
import { fmtInt, plural } from '../view';
import { watchWalletCommand } from './wallets';

const HELP = `contract-dev watch — watch mainnet contracts (and wallets) on your workspace's dashboard

Usage:
  contract-dev watch <address> [flags]                 Watch a contract
  contract-dev watch wallet <address> [--chain <id>] [--name <label>] [--group <name>]
                                                       Watch a wallet — an address with no code (try: wallets help)
  contract-dev watch <address>[=<name>]… [--chain <id>] [--group <name>]
                                                       Watch several at once, each named, tagged into a group when one is named
  contract-dev watch list [--chain <id>]               List watched contracts
  contract-dev rename <address> <name> [--chain <id>]  Rename a watched contract (clears with "")
  contract-dev contracts set-abi <address> --abi <file> Set the ABI on a contract already watched (--clear removes it)
  contract-dev unwatch <address> [<address>…] [--chain <id>]   Stop watching one or several contracts (name or address)
  contract-dev contracts show <address|name>          One contract at a glance: what it is, what it holds, its last 24h

Flags (watch <address>):
  --chain <id>     Chain the contract lives on (default: 1). Names work: ethereum, arbitrum,
                   avalanche, sepolia.
  --name <label>   Display name. Omit to use the app's name for the address, else the
                   token's name(), else its verified name; change it later with rename.
  --abi <file>     ABI for a contract the explorer holds no verified source for: a JSON
                   array, or a Foundry / Hardhat artifact (out/X.sol/X.json), or \`-\` to read
                   stdin. Names its methods, events and reverts across the app. Ignored once
                   the contract is verified — the explorer's ABI wins. Change it later with
                   \`contracts set-abi\`, or in the app.

Flags (contracts set-abi <address>):
  --abi <file>     The ABI to store, same two shapes as above; \`-\` reads stdin.
  --clear          Remove the stored ABI instead, so the explorer is read again.
  --chain <id>     Disambiguate a contract watched on several chains.

Several addresses (or one with --group) go through the watch_contracts tool in one call: each is
detected, a wallet is skipped, and the rest are tagged into --group when one is named. Name each
one where it stands: 0xae7a…fE84=stETH, or "0x889e…F9B1=Withdrawal Queue" in quotes when the name
has spaces; an address with no name takes the explorer's. --abi goes with one address only.

  contract-dev watch 0xae7ab96520de3a18e5e111b5eaab095312d7fe84=stETH "0x889edc2edab5f40e902b864ad4d7ade8e412f9b1=Withdrawal Queue" --group Lido
\`contract-dev factory <address> --watch --group <name>\` does the same for everything a factory deployed.

Contracts are watched per (chain, address) — \`--chain\` disambiguates one watched
on several chains. Watched contracts appear on the home map and /contracts.
The same commands read as nouns: contracts list · contracts add <address> ·
contracts rename <address> <name> · contracts remove <address>.
Requires \`contract-dev login\`.
`;

// The unified shape returned by the app's watchlist API: a contract or a wallet (accountType),
// each watched per (chain, address). The contract commands filter to contracts; `wallets`
// (./wallets) is the wallet side; rename and unwatch take either.
export interface WatchedAccount {
  id: string;
  chainId: number;
  chainIds: number[];
  address: string;
  accountType: 'contract' | 'wallet';
  name: string | null;
  contractType?: string | null;
  /** What the app detected it to be: erc20, erc4626, erc721, a proxy standard… */
  standards?: string[] | null;
  valueUsd?: number | null;
  /** the first value read has not landed yet (a just-watched contract) */
  valueLoading?: boolean;
}

interface Detection {
  accountType: 'contract' | 'wallet';
  detectedName: string | null;
  /** the app's own name for the address, offered ahead of the detected one (as the modal does) */
  labelName?: string | null;
  /** contracts: the explorer holds a verified ABI */
  hasAbi?: boolean;
  contractType: string | null;
}

// Chains by name as well as by id — the names the app uses, plus the usual short forms.
export const CHAIN_NAMES: Record<string, number> = {
  ethereum: 1, eth: 1, mainnet: 1,
  arbitrum: 42161, arb: 42161,
  avalanche: 43114, avax: 43114,
  sepolia: 11155111,
  base: 8453,
  optimism: 10, op: 10,
  polygon: 137, matic: 137,
  bnb: 56, bsc: 56,
  monad: 143,
};

export function parseChainId(raw: string, label: string): number {
  const byName = CHAIN_NAMES[raw.trim().toLowerCase()];
  if (byName) return byName;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a chain id or a chain name (ethereum, arbitrum, avalanche, sepolia, …) — got: ${raw}`);
  }
  return value;
}

export function describeAccount(account: WatchedAccount): string {
  return account.name ? `${account.name} (${account.address})` : account.address;
}

// Resolve one watched account (a contract or a wallet) from an address (+ optional chain).
// Accounts are per-(chain, address), so --chain disambiguates. Shared by unwatch / rename and
// by the metric commands that name a subject; `kind` narrows to one side.
export async function findWatchedAccount(
  auth: ResolvedAuth,
  address: string,
  chainId: number | undefined,
  kind?: 'contract' | 'wallet',
): Promise<WatchedAccount> {
  const lower = address.toLowerCase();
  const { accounts } = await apiRequest<{ accounts: WatchedAccount[] }>(auth, 'GET', `/api/mainnet/accounts${kind ? `?accountType=${kind}` : ''}`);
  const matches = (accounts ?? []).filter(
    (a) => (kind === undefined || a.accountType === kind) && a.address.toLowerCase() === lower && (chainId === undefined || a.chainId === chainId),
  );
  if (matches.length === 0) {
    throw new Error(`No watched ${kind ?? 'contract or wallet'} found for ${address}${chainId !== undefined ? ` on chain ${chainId}` : ''}`);
  }
  if (matches.length > 1) {
    const chains = matches.map((m) => m.chainId).join(', ');
    throw new Error(`${address} is watched on chains ${chains}. Disambiguate with --chain.`);
  }
  return matches[0];
}

export async function watchCommand(args: string[]): Promise<unknown> {
  const [sub] = args;
  switch (sub) {
    case 'wallet':
    case 'wallets':
      return await watchWalletCommand(args.slice(1));
    case 'list':
      return await listSubcommand(args.slice(1));
    case 'add':
      return await addSubcommand(args.slice(1));
    case 'rename':
      return await renameCommand(args.slice(1));
    case 'set-abi':
    case 'abi':
      return await setAbiCommand(args.slice(1));
    case 'remove':
    case 'rm':
      return await unwatchCommand(args.slice(1));
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      return await addSubcommand(args);
  }
}

// --abi: a JSON array, or a Foundry / Hardhat artifact object carrying `abi`. Sent as compact
// array JSON; the API validates the fragments and stores it for the org.
//
// `-` reads stdin, so an artifact can be piped or narrowed on the way in:
//   contract-dev contracts set-abi 0x… --abi -        < out/Thing.sol/Thing.json
//   jq '.abi' out/Thing.sol/Thing.json | contract-dev contracts set-abi 0x… --abi -
// A file is the normal case. There is no flag that takes the ABI inline: a real one runs to
// tens of KB of braces and quotes, which no shell should be asked to carry.
function readAbiFile(file: string): string {
  let text: string;
  if (file === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch (err) {
      throw new Error(`Could not read the ABI from stdin: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!text.trim()) throw new Error('No ABI on stdin. Pipe an artifact in, or pass --abi <file>.');
  } else {
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`Could not read --abi file ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const where = file === '-' ? 'The ABI on stdin' : `--abi file ${file}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { abi?: unknown }).abi)
      ? (parsed as { abi: unknown[] }).abi
      : null;
  if (!arr || arr.length === 0) throw new Error(`${where} must be a JSON array, or an artifact with a non-empty "abi" array`);
  return JSON.stringify(arr);
}

/**
 * `contract-dev contracts set-abi <address> --abi <file|-> [--chain <id>] [--clear]`
 *
 * The gap `watch --abi` left: that flag only ever applied to the call that STARTED the watch,
 * so a contract already being watched could only get an ABI through the app. This is the same
 * PATCH the app's settings panel sends.
 *
 * The explorer always wins, so this is for a contract it holds no verified source for. Setting
 * one on a verified contract is accepted and simply never read.
 */
export async function setAbiCommand(args: string[]): Promise<WatchedAccount | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help' || args[0] === undefined) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const address = requirePositional(positional, 0, 'address');
  const chainRaw = flag(flags, 'chain');
  const chainId = chainRaw === undefined ? undefined : parseChainId(chainRaw, '--chain');
  // A bare --flag comes back as the string 'true' from parseFlags, the way every other
  // boolean flag in the CLI reads it.
  const clear = flag(flags, 'clear') === 'true';
  const abiFile = flag(flags, 'abi');
  if (clear && abiFile) throw new Error('Pass --abi <file> or --clear, not both');
  if (!clear && !abiFile) throw new Error('Missing --abi <file> (or - for stdin). Pass --clear to remove the ABI instead.');
  // null clears the paste; the API then reads the explorer again for this contract.
  const abi = clear ? null : readAbiFile(abiFile as string);

  const auth = requireAuth();
  const target = await findWatchedAccount(auth, address, chainId);
  const { account } = await apiRequest<{ account: WatchedAccount }>(auth, 'PATCH', `/api/mainnet/accounts/${target.id}`, { abi });
  if (clear) console.log(`Removed the ABI on ${account.address}.`);
  else console.log(`ABI saved for ${account.address}. Its methods, events and reverts are named across the app.`);
  return account;
}

/** What the watch_contracts tool answers: a tally, with each address it skipped or could not watch. */
export interface WatchContractsResult {
  added: number;
  alreadyWatched: number;
  skipped: Array<{ address: string; reason: string }>;
  failed: Array<{ address: string; error: string }>;
  group: string | null;
  chainId: number;
}

// Past this many addresses in one go, the tool wants it said twice.
const MANY = 25;

/** The tally on one line, then each skipped and failed address on its own. */
export function watchSummaryLines(r: WatchContractsResult): string[] {
  const skipped = r.skipped ?? [];
  const failed = r.failed ?? [];
  const lines = [`Watched ${fmtInt(r.added)} · already watched ${fmtInt(r.alreadyWatched)} · skipped ${fmtInt(skipped.length)} (not a contract) · failed ${fmtInt(failed.length)}`];
  for (const s of skipped) lines.push(`  skipped ${s.address} — ${s.reason}`);
  for (const f of failed) lines.push(`  failed ${f.address} — ${f.error}`);
  return lines;
}

// Several addresses, or one going into a group: one call to the watch_contracts tool, which
// detects each, skips wallets, tags the rest and answers with a tally.
/** `0xabc…=stETH` → the address and the name given with it; a bare address has none. */
export function splitNamed(arg: string): { address: string; name: string } {
  const m = /^(0x[0-9a-fA-F]{40})=([\s\S]*)$/.exec(arg.trim());
  return m ? { address: m[1], name: m[2].trim() } : { address: arg.trim(), name: '' };
}

async function watchMany(flags: ParsedFlags, args: string[], group: string | undefined): Promise<WatchContractsResult> {
  const chainId = parseChainId(flag(flags, 'chain') ?? '1', '--chain');
  const name = flag(flags, 'name');
  const named = args.map(splitNamed);
  const addresses = named.map((n) => n.address);
  if (addresses.length > 1 && name !== undefined) throw new Error('--name names one contract; name several where they stand: 0xabc…=Name.');
  if (name !== undefined && name !== 'true' && !named[0].name) named[0].name = name;
  const names = named.map((n) => n.name);
  if (flag(flags, 'abi') !== undefined) throw new Error('--abi goes with one address; set it afterwards with `contract-dev contracts set-abi`.');
  // the CLI is a person (or their agent) acting on purpose: the server's many-at-once check is for chat
  const r = await runTool<WatchContractsResult>(requireAuth(), 'watch_contracts', {
    chainId,
    addresses,
    ...(names.some(Boolean) ? { names } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(addresses.length > MANY ? { confirmMany: true } : {}),
  });
  for (const line of watchSummaryLines(r)) console.log(line);
  return r;
}

// The modal's flow: detect first (type + name), then add with the result as hints so the
// server classifies once. A wallet is refused here, before any row exists.
async function addSubcommand(args: string[]): Promise<WatchedAccount | WatchContractsResult> {
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  requirePositional(positional, 0, 'address');
  const group = flag(flags, 'group');
  if (group === 'true') throw new Error('--group needs a name');
  if (positional.length > 1 || group !== undefined) return await watchMany(flags, positional, group);
  const { address, name: inline } = splitNamed(positional[0]);
  const chainId = parseChainId(flag(flags, 'chain') ?? '1', '--chain');
  const name = flag(flags, 'name') ?? (inline || undefined);
  const abiFile = flag(flags, 'abi');
  const abi = abiFile ? readAbiFile(abiFile) : undefined;

  const auth = requireAuth();
  const detected = await apiRequest<Detection>(auth, 'POST', '/api/mainnet/accounts/detect', { chainId, address });
  if (detected.accountType !== 'contract') {
    throw new Error(`${address} has no code on chain ${chainId} — it's a wallet. Watch it with \`contract-dev watch wallet ${address} --chain ${chainId}\`.`);
  }
  if (detected.hasAbi === false && !abi) {
    console.log(
      `No verified ABI on the explorer for ${address}. Pass --abi <artifact.json> to name its methods, events and reverts, or add it later with \`contract-dev contracts set-abi ${address} --abi <artifact.json>\`.`,
    );
  }

  const label = name?.trim() || detected.labelName || detected.detectedName || undefined;
  const payload = await apiRequest<{ account: WatchedAccount; created: boolean }>(auth, 'POST', '/api/mainnet/accounts', {
    chainId,
    address,
    accountType: 'contract',
    ...(detected.contractType ? { contractType: detected.contractType } : {}),
    ...(label ? { name: label } : {}),
    ...(abi ? { abi } : {}),
  });

  const account = payload.account;
  console.log(`${payload.created ? 'Watching' : 'Updated'} ${describeAccount(account)} on chain ${account.chainId}`);
  return account;
}

async function listSubcommand(args: string[]): Promise<WatchedAccount[]> {
  const flags = parseFlags(args);
  const chainRaw = flag(flags, 'chain');
  const query = chainRaw ? `&chainId=${parseChainId(chainRaw, '--chain')}` : '';

  const auth = requireAuth();
  const { accounts } = await apiRequest<{ accounts: WatchedAccount[] }>(auth, 'GET', `/api/mainnet/accounts?accountType=contract${query}`);
  const contracts = (accounts ?? []).filter((a) => a.accountType === 'contract');
  if (!contracts.length) {
    console.log('No watched contracts.');
    return [];
  }
  for (const account of contracts) {
    const tvl = account.valueUsd == null && account.valueLoading ? '…' : formatUsd(account.valueUsd);
    console.log(`${String(account.chainId).padEnd(8)} ${account.address}  ${(account.name ?? '').padEnd(28)} ${tvl}`);
  }
  return contracts;
}

// `contract-dev contracts <verb>` — the noun form of watch / rename / unwatch.
export async function contractsCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list':
      return await listSubcommand(sub === undefined ? args : rest);
    case 'add':
    case 'watch':
      return await addSubcommand(rest);
    case 'rename':
      return await renameCommand(rest);
    case 'set-abi':
    case 'abi':
      return await setAbiCommand(rest);
    case 'remove':
    case 'rm':
    case 'unwatch':
      return await unwatchCommand(rest);
    case 'show':
    case 'info':
      return await showContract(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      if (sub.startsWith('--')) return await listSubcommand(args);
      if (/^0x[0-9a-fA-F]{40}$/.test(sub)) return await addSubcommand(args);
      console.error(`Unknown contracts subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

// `contract-dev rename <address> <name>` — the same PATCH the register's rename uses, so
// the name lands in the org address book too (every AccountCell in the app agrees).
export async function renameCommand(args: string[]): Promise<WatchedAccount | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help' || args[0] === undefined) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const address = requirePositional(positional, 0, 'address');
  // "" is a legitimate value here (clear the name), so don't go through requirePositional.
  if (positional.length < 2) throw new Error('Missing required name (pass "" to clear it)');
  const name = positional.slice(1).join(' ').trim();
  const chainRaw = flag(flags, 'chain');
  const chainId = chainRaw === undefined ? undefined : parseChainId(chainRaw, '--chain');

  const auth = requireAuth();
  const target = await findWatchedAccount(auth, address, chainId);
  const { account } = await apiRequest<{ account: WatchedAccount }>(auth, 'PATCH', `/api/mainnet/accounts/${target.id}`, {
    name,
  });
  if (account.name) console.log(`Renamed ${account.address} to "${account.name}".`);
  else console.log(`Cleared the name on ${account.address}.`);
  return account;
}

export async function unwatchCommand(args: string[]): Promise<{ ok: true; id: string; address: string; chainId: number } | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help' || args[0] === undefined) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const address = requirePositional(flags._ as string[], 0, 'address');
  const chainRaw = flag(flags, 'chain');
  const chainId = chainRaw === undefined ? undefined : parseChainId(chainRaw, '--chain');

  const auth = requireAuth();
  const refs = flags._ as string[];
  if (refs.length > 1) {
    // several at once: every name is matched before anything is removed, and their monitors and tracked values go with them
    const r = await runTool<{ unwatched: { name: string; chainId: number; address: string; monitors: number; trackedValues: number }[]; failed: { contract: string; error: string }[] }>(auth, 'unwatch_contracts', {
      contracts: refs,
      ...(chainId !== undefined ? { chainId } : {}),
    });
    for (const u of r.unwatched) console.log(`Stopped watching ${u.name} (${u.address} on chain ${u.chainId})${u.monitors || u.trackedValues ? ` · removed ${plural(u.monitors, 'monitor')} and ${plural(u.trackedValues, 'tracked value')}` : ''}.`);
    for (const f of r.failed) console.log(`${f.contract}: ${f.error}`);
    return { ok: true, id: '', address: refs.join(','), chainId: chainId ?? 0 };
  }
  const target = await findWatchedAccount(auth, address, chainId);
  await apiRequest(auth, 'DELETE', `/api/mainnet/accounts/${target.id}`);
  console.log(`Stopped watching ${describeAccount(target)}.`);
  return { ok: true, id: target.id, address: target.address, chainId: target.chainId };
}
