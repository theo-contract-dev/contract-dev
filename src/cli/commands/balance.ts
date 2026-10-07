import { formatUnits } from 'ethers';
import { resolveStagenetRpcUrl } from '../target';
import { callRpc } from '../rpc';
import { fetchStagenetInfo } from '../stagenet-info';
import { parseFlags, requirePositional, parseAmount } from './_args';

interface BalanceResult {
  address: string;
  balance: string;
}

interface ERC20BalanceResult {
  tokenAddress: string;
  address: string;
  balance: string;
}

const HELP = `contract-dev balance — change native token balances on your Stagenet

Usage:
  contract-dev balance add <address> <amount>     Add amount (wei) to an account
  contract-dev balance set <address> <amount>     Overwrite an account's balance

Amount accepts decimal ("1000000000000000000"), 0x-hex ("0xde0b6b3a7640000"),
or a unit suffix ("1 ether", "1000000 wei").
`;

const ERC20_HELP = `contract-dev erc20-balance — change ERC20 balances on your Stagenet

Usage:
  contract-dev erc20-balance add <holder> <token> <amount>   Add amount to holder
  contract-dev erc20-balance set <holder> <token> <amount>   Overwrite holder's balance

Amount is in the token's smallest unit (decimal or 0x-hex).
Writes the balanceOf storage slot. The token's totalSupply is NOT adjusted.
`;

export async function balanceCommand(args: string[]): Promise<BalanceResult | void> {
  const [sub, ...rest] = args;

  switch (sub) {
    case 'add':
      return await nativeSubcommand(rest, 'add');
    case 'set':
      return await nativeSubcommand(rest, 'set');
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown balance subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

export async function erc20BalanceCommand(args: string[]): Promise<ERC20BalanceResult | void> {
  const [sub, ...rest] = args;

  switch (sub) {
    case 'add':
      return await erc20Subcommand(rest, 'add');
    case 'set':
      return await erc20Subcommand(rest, 'set');
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(ERC20_HELP);
      return;
    default:
      console.error(`Unknown erc20-balance subcommand: ${sub}\n`);
      console.error(ERC20_HELP);
      process.exit(1);
  }
}

async function nativeSubcommand(args: string[], action: 'add' | 'set'): Promise<BalanceResult> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');
  const amount = parseAmount(requirePositional(flags._, 1, 'amount'), 'amount');

  const method = action === 'add' ? 'dev_addBalance' : 'dev_setBalance';
  const rpcUrl = await resolveStagenetRpcUrl();
  const [info, result] = await Promise.all([
    fetchStagenetInfo(rpcUrl),
    callRpc<BalanceResult>(rpcUrl, method, [address, amount]),
  ]);

  const sym = info.nativeCurrency.symbol;
  const fmt = (wei: string) => `${formatUnits(wei, info.nativeCurrency.decimals)} ${sym}`;
  const verb = action === 'add' ? 'Added' : 'Set';
  const change = action === 'add' ? `+${fmt(amount)}` : `= ${fmt(amount)}`;
  console.log(`${verb} ${sym} balance for ${result.address} (${change})`);
  console.log(`  new balance: ${fmt(result.balance)}`);
  return result;
}

async function erc20Subcommand(args: string[], action: 'add' | 'set'): Promise<ERC20BalanceResult> {
  const flags = parseFlags(args);
  const holder = requirePositional(flags._, 0, 'holder address');
  const token = requirePositional(flags._, 1, 'token address');
  const amount = parseAmount(requirePositional(flags._, 2, 'amount'), 'amount');

  const method = action === 'add' ? 'dev_addERC20Balance' : 'dev_setERC20Balance';
  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<ERC20BalanceResult>(rpcUrl, method, [holder, token, amount]);

  const verb = action === 'add' ? 'Added' : 'Set';
  const change = action === 'add' ? `+${amount}` : `= ${amount}`;
  console.log(`${verb} ERC20 balance for ${result.address} on ${result.tokenAddress} (${change})`);
  console.log(`  new balance: ${result.balance}`);
  return result;
}
