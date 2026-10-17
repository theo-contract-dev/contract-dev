// Event metrics, through the platform's tools (2026-10-14): a number added up from events, each
// event a record with the views it needs read as of its own transaction. define (always tried on
// the newest events first; --preview stops there), show (the total, the largest contracts, a
// series, and the records behind it), update (rename, or replace parts of the definition: the
// history is read again) and delete. They live under `contract-dev metric`, beside tracked values.
// --json hands back the tool's own result.
import { parseFlags, flag, flagAll, onlyFlags, requirePositional, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag } from '../data';
import { printResult } from './_print';

export const EVENT_METRIC_HELP = `Event metrics — a number added up from events, each read exactly at its own transaction:
  contract-dev metric define "<name>" --event <Event> [--event …] [--group <group> | --contract <ref>]
                              [--read "<name>=<call>[.<output>] [on <target>] [with <arg>, …]"]… [--fixed <read>]…
                              [--field "<name>=<expr>"]… [--value "<expr>"] [--where "<rule>"]
                              [--aggregate sum|count|avg|min|max] [--split contract|none|<name>] [--unit usd|count|number]
                              [--history <days>] [--preview]
                                                      Saved at once; its history is read back in the background and
                                                      kept up to date. --preview tries the newest 24 hours and saves nothing
  contract-dev metric events                          The event metrics: scope, events, unit, status, records
  contract-dev metric show <name> [--days <n>] [--by hour|day] [--split <contract|key>] [--records <n>] [--newest]
                                                      Its total, the largest contracts, a series, and the records behind
                                                      it with their parameters, reads and fields
  contract-dev metric update <name> [--name "<new>"] [any define flag]   Replace those parts; the history is read again
  contract-dev metric delete <name>
  contract-dev metric item "<name>" --table "<table>" [--column "<label>"] [--among active|done|all]
                              [--aggregate sum|count|avg|min|max] [--split contract|none] [--unit usd|count|number] [--preview]
                                                      A number over an item table's rows, recorded each minute from now
                                                      (in dollars only when its column states a token)
  contract-dev metric group "<name>" --group "<group>" --column <key|label> [--aggregate sum|avg|min|max|count]
                              [--split contract|none] [--unit usd|number] [--token <token>] [--preview]
                                                      A group's column rolled up into one number across its contracts,
                                                      recorded each minute from now: the plain sum, or in dollars when
                                                      the column states its token (or --token: an address, self, or a
                                                      view each contract answers, like asset()), each priced in its own
  contract-dev metric monitor <metric> --name "<name>" --when "<formula>" [--per total|each] [--level critical|warning]
                              [--to <destination>…] [--preview]
                                                      An alert on a metric, one formula:
                                                        value > 1000              each new record that meets it pages,
                                                                                  with its transaction (an event metric)
                                                        total(1h) > 5000000       the metric over a moving window, against
                                                                                  a line (< for below)
                                                        total(1h) > before(1h) * 1.1    up more than 10% on the hour before
                                                        total(24h) < before(24h) * 0.5  down more than half on the day before
                                                        total(1h) > 3 * usual(1h, 7d)   over three times its usual hour,
                                                                                  averaged over 7 days
                                                        value > 50000             an item or group metric's level now
                                                      A window is 5 minutes to 7 days, and alerts while it holds. --per
                                                      is required on a split metric: total (as a whole) or each (every
                                                      contract on its own)

A read calls a view as of the start of the event's transaction: on the emitting contract unless "on" names another
(a parameter, an earlier read, or 0x…); "with" passes arguments. A view that reads no storage is read once.
Expressions use the event's parameters by name, the reads, earlier fields, emitter(), sender(), time(), block(),
tx(), amount(raw, token), usd(raw, token) at the event's day's price (native ETH is token 0x0000…0000, written out in
full), price(token), if(), min(), max(), abs(),
round(). Arithmetic is exact. Ethereum, Avalanche and Sepolia; up to 89 days of history.

Example (Uniswap v3 swap fees in dollars, per pool):
  contract-dev metric define "Swap fees" --group "Uniswap v3" --event Swap \\
    --read "fee=fee()" --read "t0=token0()" --read "t1=token1()" \\
    --field "in0=if(amount0 > 0, amount0, 0)" --field "in1=if(amount1 > 0, amount1, 0)" \\
    --value "usd(in0 * fee / 1000000, t0) + usd(in1 * fee / 1000000, t1)"
  contract-dev metric show "Swap fees" --days 7
`;

/** Split on commas outside brackets and quotes: `a, if(b, c), "x,y"` is three. */
function topLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out;
}

const READ_HELP = '--read takes name=call, then optionally ".output", "on <target>" and "with <args>": --read "price=slot0().sqrtPriceX96", --read "dec=decimals() returns (uint8) on t0", --read "f=getFee(address) on 0xReg… with emitter()"; a coin balance --read "eth=balance(emitter())"; a storage word --read "cap=slot(emitter(), 7)" or --read "owed=slot(emitter(), keccak(sender(), 3))"; each read exactly as of the event\'s transaction.';

/** `--read "f=getFee(address) returns (uint24) on 0xReg… with emitter()"` as the tool's read. */
export function parseRead(raw: string, fixed: Set<string>): Record<string, unknown> {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new Error(READ_HELP);
  const name = raw.slice(0, eq).trim();
  let rest = raw.slice(eq + 1).trim();
  let args: string[] | undefined;
  const withAt = rest.search(/\swith\s/);
  if (withAt > 0) {
    args = topLevel(rest.slice(withAt + 6));
    rest = rest.slice(0, withAt).trim();
  }
  let on: string | undefined;
  const onAt = rest.search(/\son\s/);
  if (onAt > 0) {
    on = rest.slice(onAt + 4).trim();
    rest = rest.slice(0, onAt).trim();
  }
  // a trailing ".output" after the call's closing bracket names one of several outputs
  let output: string | undefined;
  const dot = /\)\.([A-Za-z_][A-Za-z0-9_.]*)$/.exec(rest);
  if (dot) {
    output = dot[1];
    rest = rest.slice(0, dot.index + 1);
  }
  if (!name || !rest) throw new Error(READ_HELP);
  return { name, call: rest, ...(on ? { on } : {}), ...(args ? { args } : {}), ...(output ? { output } : {}), ...(fixed.has(name) ? { fixed: true } : {}) };
}

/** The definition flags as the tool's input; only the parts given. */
export function definitionFrom(flags: ParsedFlags): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const events = flagAll(flags, 'event');
  if (events.length > 0) input.events = events;
  const fixed = new Set(flagAll(flags, 'fixed').map((f) => f.trim()));
  const reads = flagAll(flags, 'read').map((r) => parseRead(r, fixed));
  if (reads.length > 0) input.reads = reads;
  const fields = flagAll(flags, 'field').map((raw) => {
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(0, eq).trim() : '';
    const expr = eq > 0 ? raw.slice(eq + 1).trim() : '';
    if (!name || !expr) throw new Error('--field takes name=expression: --field "in0=if(amount0 > 0, amount0, 0)".');
    return { name, expr };
  });
  if (fields.length > 0) input.fields = fields;
  for (const key of ['value', 'where', 'aggregate', 'split', 'unit'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  const history = flag(flags, 'history');
  if (history !== undefined) {
    const n = Number(String(history).replace(/d$/, ''));
    if (!Number.isInteger(n) || n < 1 || n > 89) throw new Error('--history takes a number of days from 1 to 89.');
    input.history = n;
  }
  return input;
}

const scopeInput = (flags: ParsedFlags): Record<string, unknown> => {
  const group = flag(flags, 'group');
  const contract = flag(flags, 'contract');
  const chainId = chainFlag(flags);
  return { ...(group ? { group } : {}), ...(contract ? { contract } : {}), ...(chainId != null && contract ? { chainId } : {}) };
};

async function print(tool: string, input: Record<string, unknown>): Promise<unknown> {
  const result = await runTool<Record<string, unknown>>(requireAuth(), tool, input);
  for (const line of printResult(result)) console.log(line);
  return result;
}

export async function defineEventMetric(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(EVENT_METRIC_HELP);
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'name');
  const definition = definitionFrom(flags);
  if (!definition.events) throw new Error('--event names what is counted: --event Swap.');
  return print('define_metric', { name, ...scopeInput(flags), ...definition, ...(flag(flags, 'preview') !== undefined ? { preview: true } : {}) });
}

/** `metric show <name>` for an event metric; null when no event metric has that name. */
export async function showEventMetric(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  const metric = (flags._ as string[]).join(' ').trim();
  const input: Record<string, unknown> = { metric };
  const days = flag(flags, 'days') ?? flag(flags, 'range');
  if (days !== undefined) {
    const n = Number(String(days).replace(/d$/, ''));
    if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('--days takes a number of days from 1 to 90.');
    input.days = n;
  }
  for (const key of ['by', 'split'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  const records = flag(flags, 'records') ?? flag(flags, 'limit');
  if (records !== undefined) input.records = Math.max(0, Math.min(50, Number(records) || 0));
  if (flag(flags, 'newest') !== undefined) input.order = 'time';
  return print('describe_metric', input);
}

/** Whether a name is an event metric's (for `metric show`, which also reads tracked values). */
export async function isEventMetric(ref: string): Promise<boolean> {
  const list = await runTool<{ metrics?: { id: string; name: string }[] }>(requireAuth(), 'describe_metric', {});
  const r = ref.trim().toLowerCase();
  return (list.metrics ?? []).some((m) => m.id === ref.trim() || m.name.trim().toLowerCase() === r);
}

/** The event metrics, for `metric events`. */
export async function listEventMetrics(): Promise<{ id: string; name: string }[]> {
  const list = await runTool<{ metrics?: Record<string, unknown>[] }>(requireAuth(), 'describe_metric', {});
  const rows = list.metrics ?? [];
  if (rows.length === 0) console.log('No event metrics. Define one with `contract-dev metric define`.');
  else for (const line of printResult({ metrics: rows.map((m) => ({ name: m.name, scope: m.scope, events: m.events, unit: m.unit, status: m.status, records: m.records })) })) console.log(line);
  return rows as { id: string; name: string }[];
}

export async function updateEventMetric(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(EVENT_METRIC_HELP);
  const flags = parseFlags(args);
  const metric = requirePositional(flags._ as string[], 0, 'metric');
  const name = flag(flags, 'name');
  const definition = definitionFrom(flags);
  if (!name && Object.keys(definition).length === 0) throw new Error('Nothing to change: pass --name "<name>" or the parts of the definition to replace (--event, --read, --field, --value, --where, …).');
  return print('update_metric', { metric, ...(name ? { name } : {}), ...definition, ...(flag(flags, 'preview') !== undefined ? { preview: true } : {}) });
}

export async function deleteEventMetric(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  const metric = requirePositional(flags._ as string[], 0, 'metric');
  return print('delete_metric', { metric });
}

/** `metric monitor <metric> …`: an alert on an event metric, every part named. */
export async function monitorEventMetric(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(EVENT_METRIC_HELP);
  const flags = parseFlags(args);
  onlyFlags(flags, 'metric monitor', ['name', 'when', 'per', 'level', 'to', 'preview']);
  const metric = requirePositional(flags._ as string[], 0, 'metric');
  const name = flag(flags, 'name');
  if (!name) throw new Error('--name says what it watches for: --name "Large swap fee".');
  // without --to the monitor records its alerts on its page until a destination is linked, like every monitor
  const to = flagAll(flags, 'to').filter((t) => t !== 'true');
  const when = flag(flags, 'when');
  if (when === undefined || when === 'true' || !when.trim()) throw new Error('--when says when it alerts: --when "value > 1000" (each record), "total(1h) > before(1h) * 1.1" (a window), "value > 50000" (an item or group metric).');
  const input: Record<string, unknown> = { metric, name, when, ...(to.length ? { to } : {}) };
  for (const key of ['per', 'level'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  if (flag(flags, 'preview') !== undefined) input.preview = true;
  return print('add_metric_monitor', input);
}

const CALL_HELP = '--call takes name=call, then optionally ".output", "on <target>", "with <args>" and "decimals <n>": --call "pooled=getTotalPooledEther() decimals 18"; a coin balance is --call "eth=balance(self)"; a storage word --call "cap=slot(self, 7)" or --call "owed=slot(self, keccak(0xLender…, 3))".';

/** `--call "debt=totalDebt() on 0x… with 0xabc…, 5 decimals 18"` as the tool's call. */
export function parseFormulaCall(raw: string): Record<string, unknown> {
  let rest = raw.trim();
  let decimals: number | undefined;
  const dec = /\sdecimals\s+(\d+)\s*$/.exec(rest);
  if (dec) {
    decimals = Number(dec[1]);
    rest = rest.slice(0, dec.index).trim();
  }
  const read = parseRead(rest, new Set());
  if (!read.name || !read.call) throw new Error(CALL_HELP);
  const args = (read.args as string[] | undefined)?.map((a) => (/^-?\d+$/.test(a) ? a : a === 'true' ? true : a === 'false' ? false : a));
  return { name: read.name, call: read.call, ...(read.on ? { on: read.on } : {}), ...(args ? { args } : {}), ...(read.output ? { output: read.output } : {}), ...(decimals != null ? { decimals } : {}) };
}

/** `track formula <contract> --label … --call … --value …`: a value worked out from several views at one block. */
export async function trackFormula(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) {
    console.log(`contract-dev track formula <contract> --label "<name>" --call "<name>=<call> [on <target>] [with <args>] [decimals <n>]"… --value "<expression>" [--chain <id>] [--preview]

A value worked out from several reads at the same block, sampled every block, charted, reported and monitored
like any tracked value. A call is a view (getBuffer(), getFee(address) with 0x…; on <contract> unless "on"
names another: a 0x address, or a view the contract answers with one, like asset()), a coin balance
(balance(self), balance(0x…)), or a storage word (slot(self, 7); slot(self, keccak(0xLender…, 3)) for a
mapping's key). A view that returns an array answers a list: owners[1], len(owners), indexOf(owners, 0x…),
sum(amounts). The value is an expression over the calls' names (buffer - debt, assets / supply, max(a - b, 0)),
worked out exactly; dollars only through a stated token: usd(held, 0xa0b8…) at the current price, amount(raw, 0x…)
by the token's decimals, where the token is its 0x address or a call that answers one (t0 = token0()).

Examples:
  contract-dev track formula 0xae7ab96520de3a18e5e111b5eaab095312d7fe84 --label "stETH share rate" \\
    --call "pooled=getTotalPooledEther() decimals 18" --call "shares=getTotalShares() decimals 18" --value "pooled / shares"
  contract-dev track formula 0xVault… --label "Headroom" --call "held=totalAssets()" --call "debt=totalDebt() on 0xRisk…" \\
    --call "eth=balance(self)" --value "usd(held, 0xa0b8…) - usd(debt, 0xa0b8…) + usd(eth, 0x0000000000000000000000000000000000000000)"
`);
    return;
  }
  const flags = parseFlags(args);
  const contract = requirePositional(flags._ as string[], 0, 'contract');
  const label = flag(flags, 'label');
  if (!label) throw new Error('--label names the value: --label "Free buffer".');
  const calls = flagAll(flags, 'call').map(parseFormulaCall);
  if (calls.length === 0) throw new Error(CALL_HELP);
  const value = flag(flags, 'value');
  if (!value) throw new Error('--value is the expression over the calls\' names: --value "pooled / shares".');
  const chainId = chainFlag(flags);
  return print('track_formula', { contract, label, calls, value, ...(chainId != null ? { chainId } : {}), ...(flag(flags, 'preview') !== undefined ? { preview: true } : {}) });
}

/** `metric group "<name>" --group … --column …`: a group's column rolled up into one metric, recorded forward. */
export async function defineGroupMetric(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(EVENT_METRIC_HELP);
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'name');
  const group = flag(flags, 'group');
  if (!group) throw new Error('--group names the group (contract-dev group show lists its columns).');
  const column = flag(flags, 'column');
  if (!column) throw new Error('--column names the column to roll up, by key or label.');
  const input: Record<string, unknown> = { name, group, column };
  for (const key of ['aggregate', 'split', 'unit', 'token'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  if (flag(flags, 'preview') !== undefined) input.preview = true;
  return print('define_group_metric', input);
}

/** `metric item "<name>" --table …`: a number over a table's rows, recorded forward. */
export async function defineItemMetric(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(EVENT_METRIC_HELP);
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'name');
  const table = flag(flags, 'table');
  if (!table) throw new Error('--table names the item table (contract-dev table list shows them).');
  const input: Record<string, unknown> = { name, table };
  for (const key of ['column', 'among', 'aggregate', 'split', 'unit'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  if (flag(flags, 'preview') !== undefined) input.preview = true;
  return print('define_item_metric', input);
}

