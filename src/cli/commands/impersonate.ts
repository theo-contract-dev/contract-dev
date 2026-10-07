import { resolveStagenetRpcUrl } from '../target';
import { callRpc } from '../rpc';
import { parseFlags, requirePositional, flag, parseAmount } from './_args';

interface BalanceResult { address: string; balance: string; }

const HELP = `contract-dev impersonate — send transactions from any address without its private key

Usage:
  contract-dev impersonate <address> [--fund <amount>]   Add address to impersonation allowlist
  contract-dev impersonate stop <address>                Remove address from allowlist
  contract-dev impersonate list                          Print all currently-impersonated addresses

Options:
  --fund <amount>   Top up the impersonated address with native tokens (e.g. for gas).
                    Accepts decimal, 0x-hex, or "1 ether" / "1000000 wei".

Notes:
  Impersonation only applies to eth_sendTransaction (unsigned). If your client
  signs locally and uses eth_sendRawTransaction, the signer wins and impersonation
  has no effect. Use a JSON-RPC signer (e.g. provider.getSigner(address) in ethers).
`;

export interface ImpersonateResult {
  address: string;
  funded?: BalanceResult;
}

export interface StopImpersonatingResult {
  address: string;
}

export async function impersonateCommand(
  args: string[],
): Promise<ImpersonateResult | StopImpersonatingResult | string[] | void> {
  const [first, ...rest] = args;

  switch (first) {
    case 'stop':
      return await stopSubcommand(rest);
    case 'list':
    case 'ls':
      return await listSubcommand();
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      // Default = start impersonating <first>. We put the address-as-first-arg
      // path on the bare form (no subcommand) since "start impersonating X" is
      // the common case and reads more naturally as `impersonate <addr>`.
      return await startSubcommand(args);
  }
}

async function startSubcommand(args: string[]): Promise<ImpersonateResult> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');
  const fundRaw = flag(flags, 'fund');

  const rpcUrl = await resolveStagenetRpcUrl();
  await callRpc<boolean>(rpcUrl, 'dev_impersonateAccount', [address]);
  console.log(`Impersonating ${address}`);

  let funded: BalanceResult | undefined;
  if (fundRaw) {
    const amount = parseAmount(fundRaw, '--fund');
    funded = await callRpc<BalanceResult>(rpcUrl, 'dev_addBalance', [address, amount]);
    console.log(`  funded with +${amount} wei (new balance: ${funded.balance})`);
  }

  return { address, funded };
}

async function stopSubcommand(args: string[]): Promise<StopImpersonatingResult> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');

  const rpcUrl = await resolveStagenetRpcUrl();
  await callRpc<boolean>(rpcUrl, 'dev_stopImpersonatingAccount', [address]);
  console.log(`Stopped impersonating ${address}`);
  return { address };
}

async function listSubcommand(): Promise<string[]> {
  const rpcUrl = await resolveStagenetRpcUrl();
  const accounts = await callRpc<string[]>(rpcUrl, 'dev_getImpersonatedAccounts', []);

  if (accounts.length === 0) {
    console.log('No impersonated accounts.');
  } else {
    for (const a of accounts) console.log(a);
  }
  return accounts;
}
