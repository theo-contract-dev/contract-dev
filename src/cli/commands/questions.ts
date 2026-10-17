// Questions the platform's tools answer that have no dashboard command of their own: who an
// address is and a read of any function (a contract's whole history is `history`). Each is one tool, called with its input built from
// flags; the answer prints as tables (./_print), and --json hands back the tool's own result.
import { parseFlags, flag, flagAll, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { printResult } from './_print';

const HELP = `contract-dev who / read — answers the dashboard has no page for

Usage:
  contract-dev who <address|ENS|name> [--chain <id>] [--limit <n>]
                                       Who it is: its name, kind, the contracts it touches here
  contract-dev who <address|ENS|name> --activity      What it did in this workspace's contracts
  contract-dev who <address|ENS|name> --holdings      What it holds
  contract-dev read <contract> <function> [<arg>…] [--chain <id>] [--decimals <n>] [--at <date|time> | --block <n>]
                                       Call a view function, now or at a past block: getUtilization, balanceOf 0x…

The biggest single events (deposits, swaps, liquidations) and who made them: \`contract-dev events <contract>
--event <Name> --sort "<formula>"\` (try: contract-dev events help). A lending market's rates or utilisation:
\`contract-dev source <contract>\` for how it computes them, then \`contract-dev read\`.
A contract's whole history (every firing since launch) is \`contract-dev history\`.

Examples:
  contract-dev who Wintermute --activity
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
