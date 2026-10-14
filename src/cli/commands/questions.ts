// Questions the platform's tools answer that have no dashboard command of their own: the
// biggest events, who an address is, a lending market's state and a read of any function (a
// contract's whole history is `history`). Each is one tool, called with its input built from
// flags; the answer prints as tables (./_print), and --json hands back the tool's own result.
import { parseFlags, flag, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { scopeFromFlags, ASK_WINDOWS } from './ask';
import { printResult } from './_print';

const HELP = `contract-dev largest / who / market / read — answers the dashboard has no page for

Usage:
  contract-dev largest <Event>[,<Event>…] [scope] [--field <amount field>] [--window 1h|24h|7d|30d|90d] [--limit <n>]
                                       The biggest single events (deposits, swaps, withdrawals, liquidations) and who made them
  contract-dev who <address|ENS|name> [--chain <id>] [--limit <n>]
                                       Who it is: its name, kind, the contracts it touches here
  contract-dev who <address|ENS|name> --activity      What it did in this workspace's contracts
  contract-dev who <address|ENS|name> --holdings      What it holds, and its lending positions
  contract-dev market [<contract>] [--group <name>] [--asset <symbol|address>] [--market-id 0x…] [--window <w>] [--limit <n>]
                                       Lending markets and vaults now: rates, utilisation, supplied, borrowed, liquidations
  contract-dev read <contract> <function> [<arg>…] [--chain <id>] [--decimals <n>] [--at <date|time> | --block <n>]
                                       Call a view function, now or at a past block: getUtilization, balanceOf 0x…

Scope (largest): --group <name>, --contract <address|name> or --chain <id>; the whole workspace without one.
A contract's whole history (every firing since launch) is \`contract-dev history\`.

Examples:
  contract-dev largest Deposit --group Lido --window 24h
  contract-dev who Wintermute --activity
  contract-dev market --group "Wildcat markets"
  contract-dev read "Withdrawal Queue" unfinalizedStETH --decimals 18
`;

const HELP_WORDS = ['help', '-h', '--help'];

const print = (result: unknown): void => {
  for (const line of printResult(result)) console.log(line);
};

function wordFlag(flags: ParsedFlags, name: string): string | undefined {
  const v = flag(flags, name);
  if (v === 'true') throw new Error(`--${name} needs a value`);
  return v === undefined ? undefined : v.trim();
}

/** "Deposit,Withdraw" or several positional words → the event names. */
function eventsArg(positional: string[], what: string): string[] {
  const events = positional.flatMap((p) => p.split(',')).map((e) => e.trim()).filter(Boolean);
  if (!events.length) throw new Error(`Name the event: contract-dev ${what} Deposit (several: Supply,Withdraw).`);
  return events;
}

function askWindow(flags: ParsedFlags, allowed: readonly string[]): string | undefined {
  const w = wordFlag(flags, 'window');
  if (w !== undefined && !allowed.includes(w.toLowerCase())) throw new Error(`--window must be one of ${allowed.join(', ')} (got: ${w})`);
  return w?.toLowerCase();
}

export async function largestCommand(args: string[]): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const input: Record<string, unknown> = { events: eventsArg(flags._ as string[], 'largest') };
  const scope = scopeFromFlags(flags);
  if (scope) input.scope = scope;
  const field = wordFlag(flags, 'field');
  if (field) input.field = field;
  const window = askWindow(flags, ASK_WINDOWS);
  if (window) input.window = window;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 10, 25);
  const r = await runTool(requireAuth(), 'largest_events', input);
  print(r);
  return r;
}

export async function whoCommand(args: string[]): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const who = (flags._ as string[]).join(' ').trim();
  if (!who) throw new Error('Say who: an address, an ENS name or a name, like contract-dev who Wintermute.');
  const activity = flag(flags, 'activity') === 'true';
  const holdings = flag(flags, 'holdings') === 'true';
  if (activity && holdings) throw new Error('Pick one: --activity or --holdings.');
  const tool = activity ? 'address_activity' : holdings ? 'address_holdings' : 'describe_address';
  const input: Record<string, unknown> = { who };
  const chainId = chainFlag(flags);
  if (chainId !== undefined && tool === 'describe_address') input.chainId = chainId;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 10, tool === 'address_activity' ? 20 : 25);
  const r = await runTool(requireAuth(), tool, input);
  print(r);
  return r;
}

export async function marketCommand(args: string[]): Promise<unknown> {
  if (HELP_WORDS.includes(args[0] ?? '')) return void console.log(HELP);
  const flags = parseFlags(args);
  const contract = (flags._ as string[]).join(' ').trim();
  const group = wordFlag(flags, 'group');
  if (contract && group) throw new Error('Pick one: a contract or --group.');
  const input: Record<string, unknown> = {};
  const chainId = chainFlag(flags);
  if (contract) input.scope = { kind: 'contract', contract, ...(chainId !== undefined ? { chainId } : {}) };
  else if (group) input.scope = { kind: 'group', group, ...(chainId !== undefined ? { chainId } : {}) };
  else if (chainId !== undefined) input.scope = { kind: 'workspace', chainId };
  const asset = wordFlag(flags, 'asset');
  if (asset) input.asset = asset;
  const marketId = wordFlag(flags, 'market-id');
  if (marketId) input.marketId = marketId;
  const window = askWindow(flags, ASK_WINDOWS);
  if (window) input.window = window;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 10, 20);
  const r = await runTool(requireAuth(), 'market_state', input);
  print(r);
  return r;
}

export async function readCommand(args: string[]): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const [contract, fn, ...callArgs] = flags._ as string[];
  if (!contract || !fn) throw new Error('Say what to read: contract-dev read <contract> <function> [<arg>…], like contract-dev read stETH getTotalPooledEther.');
  const call: Record<string, unknown> = { function: fn };
  if (callArgs.length) call.args = callArgs;
  const decimals = wordFlag(flags, 'decimals');
  if (decimals !== undefined) {
    const n = Number(decimals);
    if (!Number.isInteger(n) || n < 0 || n > 77) throw new Error(`--decimals must be a whole number 0–77 (got: ${decimals})`);
    call.decimals = n;
  }
  const input: Record<string, unknown> = { contract, calls: [call] };
  const chainId = chainFlag(flags);
  if (chainId !== undefined) input.chainId = chainId;
  const at = wordFlag(flags, 'at');
  const block = wordFlag(flags, 'block');
  if (at && block) throw new Error('Pick one: --at <time> or --block <n>.');
  if (at) input.at = at;
  if (block) {
    const n = Number(block);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--block must be a block number (got: ${block})`);
    input.block = n;
  }
  const r = await runTool(requireAuth(), 'read_contract', input);
  print(r);
  return r;
}
