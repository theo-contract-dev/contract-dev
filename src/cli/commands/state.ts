import { resolveStagenetRpcUrl } from '../target';
import { callRpc } from '../rpc';
import { parseFlags, requirePositional, requireFlag, parseAmount } from './_args';

interface CodeResult { address: string; }
interface NonceResult { address: string; nonce: string; }
interface StorageResult { address: string; slot: string; }
interface ResyncResult { address: string; slotsCleared: number; }

const HELP = `contract.dev state — override on-chain state on your Stagenet

Usage:
  contract.dev state set-code <address> <bytecode>
  contract.dev state set-nonce <address> <nonce>
  contract.dev state set-storage <address> --slot <0x..> --value <0x..>
  contract.dev state resync <address>          Drop every local override on a mainnet contract so it reads live again

Notes:
  set-code accepts 0x-prefixed bytecode. Pass "0x" to wipe the code.
  set-nonce accepts a decimal or 0x-hex non-negative integer.
  set-storage --slot accepts a decimal slot number ("5") or 0x hex (≤32 bytes,
    left-padded). Note "10" is slot ten, not 0x10. --value must be a full
    32-byte hex word (0x + 64 hex chars) — encode explicitly.
  resync is the inverse of set-code / set-storage for a contract that exists on the
    replicated chain: its code, account record and written storage go back to live.
`;

export async function stateCommand(
  args: string[],
): Promise<CodeResult | NonceResult | StorageResult | ResyncResult | void> {
  const [sub, ...rest] = args;

  switch (sub) {
    case 'set-code':
      return await setCodeSubcommand(rest);
    case 'resync':
      return await resyncSubcommand(rest);
    case 'set-nonce':
      return await setNonceSubcommand(rest);
    case 'set-storage':
      return await setStorageSubcommand(rest);
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown state subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function resyncSubcommand(args: string[]): Promise<ResyncResult> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');
  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<ResyncResult>(rpcUrl, 'dev_resyncAccount', [address]);
  console.log(`Resynced ${result.address} to the live chain (${result.slotsCleared} written slot${result.slotsCleared === 1 ? '' : 's'} cleared).`);
  return result;
}

async function setCodeSubcommand(args: string[]): Promise<CodeResult> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');
  const bytecode = requirePositional(flags._, 1, 'bytecode');
  if (!/^0x[0-9a-fA-F]*$/.test(bytecode)) {
    throw new Error('bytecode must be 0x-prefixed hex (use "0x" to wipe)');
  }

  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<CodeResult>(rpcUrl, 'dev_setCode', [address, bytecode]);

  const len = (bytecode.length - 2) / 2;
  console.log(`Set code at ${result.address} (${len} byte${len === 1 ? '' : 's'})`);
  return result;
}

async function setNonceSubcommand(args: string[]): Promise<NonceResult> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');
  const nonce = parseAmount(requirePositional(flags._, 1, 'nonce'), 'nonce');

  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<NonceResult>(rpcUrl, 'dev_setNonce', [address, nonce]);

  console.log(`Set nonce for ${result.address} = ${result.nonce}`);
  return result;
}

async function setStorageSubcommand(args: string[]): Promise<StorageResult> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');
  const slotRaw = requireFlag(flags, 'slot');
  const value = requireFlag(flags, 'value');

  // Slot keys are uint256, so decimal and short hex are unambiguous (left-pad).
  // Normalized client-side to the canonical 32-byte key, so older Stagenets
  // accept them too. Note "10" is slot ten, not 0x10.
  let slot: string;
  if (/^\d+$/.test(slotRaw)) {
    const hex = BigInt(slotRaw).toString(16);
    if (hex.length > 64) throw new Error(`--slot number out of range (must fit in 32 bytes): ${slotRaw}`);
    slot = '0x' + hex.padStart(64, '0');
  } else if (/^0x[0-9a-fA-F]{1,64}$/.test(slotRaw)) {
    slot = '0x' + slotRaw.slice(2).toLowerCase().padStart(64, '0');
  } else {
    throw new Error(`--slot must be a decimal slot number or 0x hex (≤32 bytes). Got: ${slotRaw}`);
  }

  // VALUES keep the strict rule — uint-style vs bytes-style padding is
  // ambiguous, so callers encode explicitly. Friendlier error than the server's.
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      `--value must be a 32-byte hex word (0x + 64 hex chars). Got: ${value}\n` +
        `  Pad short hex explicitly: "0x" + n.toString(16).padStart(64, "0")`,
    );
  }

  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<StorageResult>(rpcUrl, 'dev_setStorageAt', [address, slot, value]);

  console.log(`Set storage at ${result.address}`);
  console.log(`  slot:  ${result.slot}`);
  console.log(`  value: ${value}`);
  return result;
}
