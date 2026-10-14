// Every firing of some events over a contract's whole life, through the platform's event_history
// tool: how many and when (by day, week or month), how big (per token), who (top wallets, repeat
// wallets), the weekday and hour shape, and examples. A read too long for one answer comes back
// with `resume`; the command asks again (up to two more times) so the terminal gets the whole story.
import { parseFlags, flag, flagAll, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { printResult } from './_print';

const HELP = `contract-dev history — every firing of some events since launch: when, how big, who

Usage:
  contract-dev history [<contract>] --event <Name> [--event <Name>]… [--group <group>] [--chain <id|name>]
                              [--window all|24h|7d|30d|90d|1y | --since <date>] [--until <date>]
                              [--by auto|day|week|month] [--tz <zone>] [--who <field>|signer] [--field <amount field>]
                              [--wallet 0x…] [--limit <n>] [--once]

Counts by event and contract, a timeline (zero-filled), sizes per token (total, quartiles, USD buckets at today's
prices), top and repeat wallets, the weekday and hour shape, the first, last, newest and largest firings.
--who counts by an address field of the event (account, owner) or the transaction's signer; by default the event's
own account-like field, else the signer. A long history is read over up to three calls (--once stops after one).
Free workspaces read the last 24 hours.

Examples:
  contract-dev history --group "Wildcat markets" --event WithdrawalQueued --by week
  contract-dev history 0x5ab22e9c360807f16dfa34ad5c589055d2871a5b --event WithdrawalQueued --event WithdrawalExecuted --tz Australia/Sydney
  contract-dev history --group pools --event Swap --window 30d --who signer
`;

const HELP_WORDS = ['help', '-h', '--help'];

/** The tool's input from the command line. */
export function historyInput(flags: ParsedFlags): Record<string, unknown> {
  const events = flagAll(flags, 'event').flatMap((e) => e.split(',')).map((e) => e.trim()).filter(Boolean);
  if (events.length === 0) throw new Error('Name the events: --event WithdrawalQueued (contract-dev events <contract> lists them).');
  const contract = (flags._ as string[]).join(' ').trim();
  const group = flag(flags, 'group');
  const chainId = chainFlag(flags);
  const scope = contract ? { kind: 'contract', contract, ...(chainId != null ? { chainId } : {}) } : group ? { kind: 'group', group, ...(chainId != null ? { chainId } : {}) } : chainId != null ? { kind: 'workspace', chainId } : null;
  const input: Record<string, unknown> = { events, ...(scope ? { scope } : {}) };
  for (const [from, to] of [
    ['window', 'window'],
    ['since', 'since'],
    ['until', 'until'],
    ['by', 'by'],
    ['tz', 'timezone'],
    ['who', 'who'],
    ['field', 'field'],
    ['wallet', 'wallet'],
  ] as const) {
    const v = flag(flags, from);
    if (v !== undefined) input[to] = v;
  }
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 10, 25);
  return input;
}

export async function historyCommand(args: string[]): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const input = historyInput(flags);
  const auth = requireAuth();
  let result = await runTool<Record<string, unknown>>(auth, 'event_history', input);
  // a read that stopped short and can go further: ask again, it continues where it stopped
  for (let i = 0; i < 2 && flag(flags, 'once') === undefined && result.complete === false && result.resume === true; i++) {
    console.error(`Read back to ${String(result.from)}; reading further…`);
    result = await runTool<Record<string, unknown>>(auth, 'event_history', input);
  }
  for (const line of printResult(result, { omit: ['definition'] })) console.log(line);
  return result;
}
