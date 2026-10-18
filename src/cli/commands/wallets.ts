// `contract-dev watch wallet <address>` and the `wallets` noun (2026-10-18): a watched WALLET is an
// address with no code — a treasury, a deployer, a market maker — watched on one chain like a
// contract, through the same watchlist API (accountType 'wallet'). Its page is /wallets/<chain>/<address>;
// its activity (the transactions it sent and received, its transfers in and out) answers to
// `query transactions|transfers|wallets --contract <name>` like a contract's. A group holds contracts
// or wallets, never both.
import { parseFlags, flag, requirePositional } from './_args';
import { apiRequest, requireAuth } from '../credentials';
import { runTool } from '../tools';
import { formatUsd } from '../format';
import { describeAccount, findWatchedAccount, parseChainId, renameCommand, unwatchCommand, type WatchedAccount } from './watch';

const HELP = `contract-dev wallets — watch wallets (addresses with no code) beside your contracts

Usage:
  contract-dev watch wallet <address> [--chain <id|name>] [--name <label>] [--group <name>]
                                                       Watch a wallet on one chain; --group puts it in a group of wallets
  contract-dev wallets list [--chain <id>]             List watched wallets
  contract-dev wallets add <address> [flags]           The same as watch wallet
  contract-dev wallets rename <address> <name> [--chain <id>]   Rename a watched wallet (clears with "")
  contract-dev wallets remove <address> [--chain <id>] Stop watching it (its monitors and tracked values go with it)

A wallet is watched per (chain, address): watch it on another chain with a second call. Its dashboard is
/wallets/<chain>/<address>. Its activity reads like a contract's: \`contract-dev query transactions --contract <name>\`
(sent and received), \`query transfers --contract <name> --out\` (what left it). A balance alert is a tracked
balance(self) with \`contract-dev monitor add\`. A group holds contracts or wallets, never both.
A contract (an address with code) is refused here: watch it with \`contract-dev watch <address>\`.
`;

interface Detection {
  accountType: 'contract' | 'wallet';
  detectedName: string | null;
  labelName?: string | null;
}

async function addWallet(args: string[]): Promise<WatchedAccount> {
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const address = requirePositional(positional, 0, 'address');
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an address: ${address}`);
  const chainId = parseChainId(flag(flags, 'chain') ?? '1', '--chain');
  const name = flag(flags, 'name');
  const group = flag(flags, 'group');
  if (group === 'true') throw new Error('--group needs a name');

  const auth = requireAuth();
  const detected = await apiRequest<Detection>(auth, 'POST', '/api/mainnet/accounts/detect', { chainId, address, accountType: 'wallet' });
  if (detected.accountType === 'contract') {
    throw new Error(`${address} has code on chain ${chainId} — it's a contract. Watch it with \`contract-dev watch ${address} --chain ${chainId}\`.`);
  }
  const label = (name && name !== 'true' ? name.trim() : '') || detected.labelName || detected.detectedName || undefined;
  if (group !== undefined) {
    // the tool tags it too, under the one-kind-per-group rule
    const r = await runTool<{ account?: WatchedAccount; created?: boolean }>(auth, 'watch_wallet', { chainId, address, ...(label ? { name: label } : {}), group });
    const account = r.account!;
    console.log(`${r.created ? 'Watching' : 'Updated'} ${describeAccount(account)} on chain ${account.chainId} · in ${group}`);
    return account;
  }
  const payload = await apiRequest<{ account: WatchedAccount; created: boolean }>(auth, 'POST', '/api/mainnet/accounts', {
    chainId,
    address,
    accountType: 'wallet',
    ...(label ? { name: label } : {}),
  });
  console.log(`${payload.created ? 'Watching' : 'Updated'} ${describeAccount(payload.account)} on chain ${payload.account.chainId}`);
  return payload.account;
}

async function listWallets(args: string[]): Promise<WatchedAccount[]> {
  const flags = parseFlags(args);
  const chainRaw = flag(flags, 'chain');
  const query = chainRaw ? `&chainId=${parseChainId(chainRaw, '--chain')}` : '';
  const auth = requireAuth();
  const { accounts } = await apiRequest<{ accounts: WatchedAccount[] }>(auth, 'GET', `/api/mainnet/accounts?accountType=wallet${query}`);
  const wallets = (accounts ?? []).filter((a) => a.accountType === 'wallet');
  if (!wallets.length) {
    console.log('No watched wallets.');
    return [];
  }
  for (const w of wallets) {
    const held = w.valueUsd == null && w.valueLoading ? '…' : formatUsd(w.valueUsd);
    console.log(`${String(w.chainId).padEnd(8)} ${w.address}  ${(w.name ?? '').padEnd(28)} ${held}`);
  }
  return wallets;
}

/** `contract-dev watch wallet <address> …` */
export async function watchWalletCommand(args: string[]): Promise<WatchedAccount | void> {
  if (args[0] === undefined || args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  return await addWallet(args);
}

/** `contract-dev wallets <verb>` */
export async function walletsCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list':
      return await listWallets(sub === undefined ? args : rest);
    case 'add':
    case 'watch':
      return await addWallet(rest);
    case 'rename':
      return await renameCommand(rest);
    case 'remove':
    case 'rm':
    case 'unwatch': {
      // one at a time, by address: the row is matched whatever its kind
      const flags = parseFlags(rest);
      const address = requirePositional(flags._ as string[], 0, 'address');
      const chainRaw = flag(flags, 'chain');
      const auth = requireAuth();
      const target = await findWatchedAccount(auth, address, chainRaw === undefined ? undefined : parseChainId(chainRaw, '--chain'), 'wallet');
      return await unwatchCommand([target.address, ...(chainRaw ? ['--chain', chainRaw] : [])]);
    }
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      if (sub.startsWith('--')) return await listWallets(args);
      if (/^0x[0-9a-fA-F]{40}$/.test(sub)) return await addWallet(args);
      console.error(`Unknown wallets subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}
