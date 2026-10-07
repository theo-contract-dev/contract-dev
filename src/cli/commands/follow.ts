import { resolveStagenetRpcUrl } from '../target';
import { callRpc } from '../rpc';
import { parseFlags, requirePositional, flag } from './_args';

const HELP = `contract-dev follow — pin contract state to LIVE mainnet (mainnet follow)

A followed account or slot always READS the live value from the chain your
Stagenet forks — even after transactions on the Stagenet have written to it.
Writes still work normally within a transaction, but are discarded at the end
of the block ("each block resets to mainnet"). Use it to stop market state
(DEX pool prices, market-maker inventory, oracles) from freezing and drifting
on a long-lived Stagenet, while your own wallets/contracts keep persisting.

Usage:
  contract-dev follow <address>                          Follow a whole contract — all storage plus balance/nonce/code
                                                         (pools, settlements, oracles)
  contract-dev follow <token> --balance-of <holder>      Follow one holder's balance on a token (slot auto-discovered)
  contract-dev follow <address> --slots <s1,s2,…>        Follow specific storage slots: 0x hex keys or decimal
                                                         slot numbers ("1,2,5" — note "10" is slot ten, not 0x10)
  contract-dev unfollow <address> [same flags]           Stop following (mirrors the flags above)
  contract-dev follow list                               Print everything currently followed

Notes:
  Follow whole accounts only for contracts holding pure market state. For shared
  contracts like tokens — where balanceOf holds user balances too — follow specific
  state with --balance-of / --slots so user balances keep persisting.
  Docs: https://docs.contract.dev/stagenets/mainnet-replay/mainnet-follow
`;

export interface FollowedState {
  accounts: string[];
  slots: Record<string, string[]>;
}

// Decimal --slots entries ("1,2,5") are declared-slot numbers — convert to the
// canonical 32-byte hex key client-side, so they work against Stagenets that
// predate server-side decimal support. Hex keys keep their 0x prefix and pass
// through untouched ("10" is slot ten, not 0x10).
function normalizeSlotArg(s: string): string {
  if (!/^\d+$/.test(s)) return s;
  const hex = BigInt(s).toString(16);
  if (hex.length > 64) throw new Error(`slot number out of range (must fit in 32 bytes): ${s}`);
  return '0x' + hex.padStart(64, '0');
}

export async function followCommand(args: string[]): Promise<unknown> {
  const [first] = args;

  switch (first) {
    case 'stop':
      // The old spelling — point at the top-level command instead of guessing.
      throw new Error('`follow stop` has been renamed — use: contract-dev unfollow <address> [same flags]');
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
      // Bare form: `follow <address> [...flags]` — the common case.
      return await followOrStop(args, false);
  }
}

const UNFOLLOW_HELP = `contract-dev unfollow — stop following mainnet state

Stops the live read-through for state previously pinned with \`contract-dev follow\`.
Local history is cleared, so the state behaves as never-touched: it keeps
tracking live mainnet until your next local write.

Usage:
  contract-dev unfollow <address>                        Stop following a whole contract
  contract-dev unfollow <token> --balance-of <holder>    Stop following one holder's balance on a token
  contract-dev unfollow <address> --slots <s1,s2,…>      Stop following specific slots (0x hex or decimal)

See what is currently followed: contract-dev follow list
`;

export async function unfollowCommand(args: string[]): Promise<unknown> {
  const [first] = args;

  switch (first) {
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(UNFOLLOW_HELP);
      return;
    default:
      return await followOrStop(args, true);
  }
}

async function followOrStop(args: string[], stop: boolean): Promise<unknown> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'address');
  const balanceOf = flag(flags, 'balance-of');
  const slotsRaw = flag(flags, 'slots');
  if (balanceOf && slotsRaw) {
    throw new Error('pass either --balance-of or --slots, not both');
  }

  const rpcUrl = await resolveStagenetRpcUrl();

  if (balanceOf) {
    const method = stop ? 'dev_unfollowTokenBalance' : 'dev_followTokenBalance';
    const res = await callRpc<{ token: string; holder: string; slot: string }>(rpcUrl, method, [address, balanceOf]);
    console.log(
      stop
        ? `Stopped following balanceOf(${res.holder}) on ${res.token}`
        : `Following balanceOf(${res.holder}) on ${res.token} — reads live mainnet from now on`,
    );
    console.log(`  slot: ${res.slot}`);
    return res;
  }

  if (slotsRaw) {
    const slots = slotsRaw.split(',').map((s) => s.trim()).filter(Boolean).map(normalizeSlotArg);
    if (slots.length === 0) throw new Error('--slots needs at least one slot key (0x hex or decimal)');
    const method = stop ? 'dev_unfollowSlots' : 'dev_followSlots';
    const res = await callRpc<{ address: string }>(rpcUrl, method, [address, slots]);
    console.log(
      stop
        ? `Stopped following ${slots.length} slot(s) on ${address}`
        : `Following ${slots.length} slot(s) on ${address} — they read live mainnet from now on`,
    );
    return res;
  }

  const method = stop ? 'dev_unfollowAccount' : 'dev_followAccount';
  const res = await callRpc<{ address: string; residueCleared?: number }>(rpcUrl, method, [address]);
  if (stop) {
    console.log(`Stopped following ${address}`);
  } else {
    console.log(`Following ${address} — its entire state (storage, balance, nonce, code) reads live mainnet from now on`);
    if (res.residueCleared) console.log(`  cleared ${res.residueCleared} locally-persisted slot(s)`);
  }
  return res;
}

async function listSubcommand(): Promise<FollowedState> {
  const rpcUrl = await resolveStagenetRpcUrl();
  const followed = await callRpc<FollowedState>(rpcUrl, 'dev_getFollowed', []);

  const slotAddrs = Object.keys(followed.slots ?? {});
  if (followed.accounts.length === 0 && slotAddrs.length === 0) {
    console.log('Nothing is followed.');
    return followed;
  }

  if (followed.accounts.length > 0) {
    console.log('Followed accounts (entire state live — storage, balance, nonce, code):');
    for (const a of followed.accounts) console.log(`  ${a}`);
  }
  if (slotAddrs.length > 0) {
    console.log('Followed slots:');
    for (const addr of slotAddrs) {
      console.log(`  ${addr}`);
      for (const s of followed.slots[addr]) console.log(`    ${s}`);
    }
  }
  return followed;
}
