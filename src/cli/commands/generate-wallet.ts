import { Wallet } from 'ethers';
import { resolveStagenetRpcUrl } from '../target';
import { callRpc } from '../rpc';
import { fetchStagenetInfo } from '../stagenet-info';

interface AddBalanceResult {
  address: string;
  balance: string;
}

// 1,000,000 native tokens in wei (10^6 * 10^18 = 10^24).
const FUND_AMOUNT_WEI = '1000000000000000000000000';

export interface GeneratedWallet {
  address: string;
  privateKey: string;
}

const HELP = `contract-dev generate-wallet — generate a fresh wallet and fund it on your Stagenet

Usage:
  contract-dev generate-wallet          Print a new address + private key, funded with 1,000,000 native tokens

The private key is shown once and never stored. Targets the active stagenet
(override with --stagenet <name> or --rpc-url <url>).
`;

export async function generateWalletCommand(args: string[] = []): Promise<GeneratedWallet | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const rpcUrl = await resolveStagenetRpcUrl();

  const wallet = Wallet.createRandom();

  console.log('Generated wallet');
  console.log(`  Address:     ${wallet.address}`);
  console.log(`  Private key: ${wallet.privateKey}`);

  console.log('\nSave the private key now — it is not stored.');

  console.log('\nFunding wallet...');
  const [info] = await Promise.all([
    fetchStagenetInfo(rpcUrl),
    callRpc<AddBalanceResult>(rpcUrl, 'dev_addBalance', [
      wallet.address,
      FUND_AMOUNT_WEI,
    ]),
  ]);

  console.log(`Funded with 1,000,000 ${info.nativeCurrency.symbol}.`);

  return { address: wallet.address, privateKey: wallet.privateKey };
}
