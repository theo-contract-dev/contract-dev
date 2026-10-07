import { readFileSync } from 'node:fs';
import { contractStats, showContract } from './inspect';
import { parseFlags, flag, requirePositional } from './_args';
import { apiRequest, requireAuth, ResolvedAuth } from '../credentials';
import { formatUsd } from '../format';

const HELP = `contract-dev watch — watch mainnet contracts on your workspace's dashboard

Usage:
  contract-dev watch <address> [flags]                 Watch a contract
  contract-dev watch list [--chain <id>]               List watched contracts
  contract-dev rename <address> <name> [--chain <id>]  Rename a watched contract (clears with "")
  contract-dev contracts set-abi <address> --abi <file> Set the ABI on a contract already watched (--clear removes it)
  contract-dev unwatch <address> [--chain <id>]        Stop watching a contract
  contract-dev contracts show <address|name>          One contract at a glance: what it is, what it holds, its last 24h
  contract-dev contracts stats [--range]               Every watched contract side by side: value, transactions, volume

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

Contracts are watched per (chain, address) — \`--chain\` disambiguates one watched
on several chains. Watched contracts appear on the home map and /contracts.
The same commands read as nouns: contracts list · contracts add <address> ·
contracts rename <address> <name> · contracts remove <address>.
Requires \`contract-dev login\`.
`;

// The unified shape returned by the app's watchlist API. The API also holds watched
// wallets in this shape; the CLI is contracts-only and filters them out everywhere.
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

// Resolve one watched contract from an address (+ optional chain). Contracts are
// per-(chain, address), so --chain disambiguates. Shared by unwatch / rename and by the
// metric commands that name a subject.
export async function findWatchedAccount(
  auth: ResolvedAuth,
  address: string,
  chainId: number | undefined,
): Promise<WatchedAccount> {
  const lower = address.toLowerCase();
  const { accounts } = await apiRequest<{ accounts: WatchedAccount[] }>(auth, 'GET', '/api/mainnet/accounts?accountType=contract');
  const matches = (accounts ?? []).filter(
    (a) => a.accountType === 'contract' && a.address.toLowerCase() === lower && (chainId === undefined || a.chainId === chainId),
  );
  if (matches.length === 0) {
    throw new Error(`No watched contract found for ${address}${chainId !== undefined ? ` on chain ${chainId}` : ''}`);
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

// The modal's flow: detect first (type + name), then add with the result as hints so the
// server classifies once. A wallet is refused here, before any row exists.
async function addSubcommand(args: string[]): Promise<WatchedAccount> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._ as string[], 0, 'address');
  const chainId = parseChainId(flag(flags, 'chain') ?? '1', '--chain');
  const name = flag(flags, 'name');
  const abiFile = flag(flags, 'abi');
  const abi = abiFile ? readAbiFile(abiFile) : undefined;

  const auth = requireAuth();
  const detected = await apiRequest<Detection>(auth, 'POST', '/api/mainnet/accounts/detect', { chainId, address });
  if (detected.accountType !== 'contract') {
    throw new Error(`${address} has no code on chain ${chainId} — it's a wallet. The CLI watches contracts; add wallets in the app.`);
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
    case 'stats':
      return await contractStats(rest);
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
  const target = await findWatchedAccount(auth, address, chainId);
  await apiRequest(auth, 'DELETE', `/api/mainnet/accounts/${target.id}`);
  console.log(`Stopped watching ${describeAccount(target)}.`);
  return { ok: true, id: target.id, address: target.address, chainId: target.chainId };
}
