// Item tables, through the platform's tools: the things inside contracts (withdrawal rounds, loans,
// requests), one row per id an event or a list view announces, over their whole life, with status
// columns chosen by rules, formula columns, and a rule that finishes a row. list, show (counts,
// findings and endings by period, rows per status, how long rows take, the biggest and newest rows,
// one row by id), create (from event names in the contracts' ABIs; --hidden keeps it off the Tables
// page), update (rename, set when rows finish, put on or take off the page) and delete (the table
// with its rows, their tracked values and its monitors). --json hands back the tool's own result.
import { parseFlags, flag, flagAll, requirePositional, type ParsedFlags } from './_args';
import { parseFormulaCall } from './eventMetric';
import { apiRequest, requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { printResult } from './_print';

const HELP = `contract-dev table — item tables: withdrawal rounds, loans, requests… one row per id, over their whole life

Usage:
  contract-dev table list [--group <group>] [--contract <ref>]
                                                      Every table, hidden ones too: what finds a row, the events it
                                                      watches, when a row finishes, rows active and finished
  contract-dev table show <table> [--by day|week|month] [--since YYYY-MM-DD] [--among active|done|all]
                              [--column <key|label>] [--contract <ref>] [--limit <n>]
                                                      Findings and endings per period, rows per status, how long rows
                                                      take, column totals, the biggest and newest rows, the busiest contracts
  contract-dev table show <table> --row <id>          One row: its values, its statuses, its watched events and its own
                                                      events since it was found
  contract-dev table delete <table>                   Remove it: its rows, their tracked values and its monitors go with it
  contract-dev table create "<name>" --opens <Event> [--status "<Label>: <Opt>=<rule>; <Opt>=<rule>; <Opt>"]…
                              [--formula "<Label>=<expr>[; call <name>=<call>]…[; token <token>][; show usd]"]… [--finished "<rule>"] [--closes <Event>|list] [--id <field>]
                              [--group <group> | --contract <ref>] [--count "<Event>[:label] [on <field>]"]…
                              [--sum "<Event>.<field>[:label] [on <field>] [token <token> [show usd] | decimals <n>]"]…
                              [--event "<Event>.<field>"]… [--closes-on <field>] [--id-shown date|number] [--hidden]
                                                      A table from the contracts' events; its history is read now and
                                                      kept up to date
  contract-dev table update <table> [--name "<name>"] [--status "<Label>: …"]… [--formula "<Label>=<expr>"]…
                              [--token "<Label>=<token> [show usd]"]… [--event "<Event>.<field>"]… [--finished "<rule>" | --never-finishes]
                              [--show | --hide]
                                                      Rename it, add status or formula columns or replace their rules (by
                                                      label), set when its rows finish, put a hidden table on the Tables
                                                      page, or take one off

Rules are expressions over the row: columns as {Label}, events by name with seen(E), at(E), latest(E), inList(),
now(), found(), timeIn({Status}), and / or / not, comparisons, arithmetic, durations like 24h or 7d; price(T),
usd(raw, T) and amount(raw, T) for dollars at the current price. A --status
column tries its options in order and the first whose rule holds wins; an option with no rule is Otherwise, last.
--closes is the shorthand for a pinned Stage column with one option Closed on that event, finished once it is.
--id-shown date shows a number id as a date (an expiry, a deadline); it is a number unless you say so.
--hidden makes a table to answer a question: it stays off the Tables page and is removed 7 days after it was last
read. --count and --sum add columns: how many of an event each row got, or the sum of one of its fields, matched on
the row's id. When the event has more than one field that could hold the id, say which with "on <field>"; an event a
rule names is stated the same way with --event "<Event>.<field>", and --closes-on <field> does it for --closes. Nothing
is matched by name. Nothing is assumed about what a number is: an amount is a token amount only when you say which token,
by ending it with "token <token>": its 0x address, self (the contract itself), or a view each contract answers with the
token's address, like asset(). Its decimals then scale it, and "show usd" puts it in dollars at the current price. A
formula already in token units takes the same: --formula "Outstanding={Requested} - {Paid}; token asset(); show usd";
its own calls then count in that token too (a balanceOf scaled by the asset's decimals) unless one states "decimals <n>".
A formula folds an event's field by name over the row's events: sum(Event.field), count(Event), min, max, first,
last. --formula "Still owed=sum(WithdrawalQueued.normalizedAmount) - sum(WithdrawalExecuted.normalizedAmount); token
asset()" with --event WithdrawalQueued.expiry --event WithdrawalExecuted.expiry to say which field holds the row id.
Without a token a number is shown as the chain holds it; "decimals <n>" scales a plain number. --token on update
sets, changes or (with nothing after =) clears a column's token.

Examples:
  contract-dev table list
  contract-dev table create "Withdrawal rounds" --group "Wildcat markets" --opens WithdrawalBatchCreated --closes WithdrawalBatchClosed --count "WithdrawalQueued:Queued on expiry" --hidden
  contract-dev table create "Withdrawal rounds" --group "Wildcat markets" --opens WithdrawalBatchCreated --id-shown date \\
    --sum "WithdrawalQueued.normalizedAmount:Requested on expiry token asset()" \\
    --sum "WithdrawalBatchPayment.normalizedAmountPaid:Paid on expiry token asset()" \\
    --event WithdrawalBatchExpired.expiry \\
    --formula "Outstanding=max({Requested} - {Paid}, 0); token asset(); show usd" \\
    --status "Stage: Expired=latest(WithdrawalBatchExpired); Paying=seen(WithdrawalBatchPayment); Queued" \\
    --status "Health: Overdue={Stage} == \\"Expired\\" and timeIn({Stage}) > 24h; At risk={Outstanding} > 100000; Healthy" \\
    --finished "{Stage} == \\"Expired\\" and {Outstanding} == 0"
  contract-dev table show "Withdrawal rounds" --by week --among done
  contract-dev table show "Withdrawal rounds" --row 2026-10-13
`;

const HELP_WORDS = ['help', '-h', '--help'];

export async function tableCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
    case 'ls':
      return await listTables(rest);
    case 'show':
    case 'describe':
      return await showTable(rest);
    case 'create':
    case 'add':
      return await createTable(rest);
    case 'update':
    case 'rename':
      return await updateTable(rest, sub === 'rename');
    case 'delete':
    case 'remove':
    case 'rm':
      return await deleteTable(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    case undefined:
      return await listTables([]);
    default:
      // `table "Withdrawal rounds"` reads as `table show "Withdrawal rounds"`
      return await showTable(args);
  }
}

const scopeInput = (flags: ParsedFlags): Record<string, unknown> => {
  const group = flag(flags, 'group');
  const contract = flag(flags, 'contract');
  const chainId = chainFlag(flags);
  return { ...(group ? { group } : {}), ...(contract ? { contract } : {}), ...(chainId != null && contract ? { chainId } : {}) };
};

async function listTables(args: string[]): Promise<unknown> {
  if (HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const result = await runTool<Record<string, unknown>>(requireAuth(), 'list_tables', scopeInput(flags));
  for (const line of printResult(result)) console.log(line);
  return result;
}

async function showTable(args: string[]): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const table = (flags._ as string[]).join(' ').trim();
  if (!table) throw new Error('Name the table (contract-dev table list shows them).');
  const input: Record<string, unknown> = { table };
  for (const key of ['row', 'contract', 'by', 'since', 'column', 'among'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  // the old words for the rows still read: open → active, closed → done
  if (input.among === 'open') input.among = 'active';
  if (input.among === 'closed') input.among = 'done';
  const chainId = chainFlag(flags);
  if (chainId != null && input.contract) input.chainId = chainId;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 5, 25);
  const result = await runTool<Record<string, unknown>>(requireAuth(), 'describe_table', input);
  for (const line of printResult(result)) console.log(line);
  return result;
}

/** `table delete <table>`: the table by id or name (hidden ones too), then the server's DELETE, which takes its rows, their tracked values and its monitors with it. */
async function deleteTable(args: string[]): Promise<{ ok: true; id: string }> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP) as never;
  const flags = parseFlags(args);
  const ref = (flags._ as string[]).join(' ').trim();
  if (!ref) throw new Error('Name the table to delete (contract-dev table list shows them).');
  const auth = requireAuth();
  const listed = await runTool<{ rows?: Array<{ id: string; name: string }> }>(auth, 'list_tables', {});
  const rows = listed.rows ?? [];
  const byId = rows.find((t) => t.id === ref);
  const byName = rows.filter((t) => t.name.trim().toLowerCase() === ref.toLowerCase());
  const table = byId ?? (byName.length === 1 ? byName[0] : undefined);
  if (!table) {
    if (byName.length > 1) throw new Error(`"${ref}" names ${byName.length} tables (${byName.map((t) => t.id).join(', ')}); pass the id.`);
    throw new Error(`No table matches "${ref}" (contract-dev table list shows them).`);
  }
  await apiRequest(auth, 'DELETE', `/api/console/tables/${table.id}`);
  console.log(`Deleted table "${table.name}" (${table.id}): its rows, their tracked values and its monitors.`);
  return { ok: true, id: table.id };
}

const STATUS_HELP = '--status takes "Label: Option=rule; Option=rule; Option" (the last without a rule is Otherwise): --status "Stage: Closed=latest(WithdrawalBatchClosed); Open".';

/** `--status "Stage: Expired=latest(WithdrawalBatchExpired); Paying=seen(WithdrawalBatchPayment); Queued"` as the tool's status columns. */
export function statusesFrom(flags: ParsedFlags): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of flagAll(flags, 'status')) {
    const colon = raw.indexOf(':');
    if (colon <= 0) throw new Error(STATUS_HELP);
    const label = raw.slice(0, colon).trim();
    const options = raw
      .slice(colon + 1)
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf('=');
        return eq > 0 ? { name: p.slice(0, eq).trim(), when: p.slice(eq + 1).trim() } : { name: p };
      });
    if (!label || options.length === 0 || options.some((o) => !o.name)) throw new Error(STATUS_HELP);
    out.push({ label, options });
  }
  return out;
}

/** `--formula "Outstanding={Requested} - {Paid}"` as the tool's formula columns. */
export function formulasFrom(flags: ParsedFlags): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of flagAll(flags, 'formula')) {
    const eq = raw.indexOf('=');
    const label = eq > 0 ? raw.slice(0, eq).trim() : '';
    const [expr = '', ...more] = (eq > 0 ? raw.slice(eq + 1) : '').split(';').map((x) => x.trim());
    if (!label || !expr) throw new Error('--formula takes Label=expression: --formula "Outstanding={Requested} - {Paid}".');
    const formula: Record<string, unknown> = { label, expr };
    const calls: Record<string, unknown>[] = [];
    for (const part of more.filter(Boolean)) {
      // the formula's own reads: "; call held=totalAssets() on asset() decimals 18", "; call eth=balance(self)", "; call owed=slot(self, keccak(id(), 3))"
      const call = /^call\s+(.+)$/s.exec(part);
      if (call) {
        calls.push(parseFormulaCall(call[1]));
        continue;
      }
      const m = /^(token|show|unit)\s+(\S+)$/.exec(part);
      if (!m) throw new Error(`--formula: after the expression come "; call <name>=<call>", "; token <token>", "; show usd" or "; unit <unit>" (got: ${part})`);
      if (m[1] === 'token') formula.token = tokenRef(m[2], '--formula');
      else if (m[1] === 'show') formula.show = showOf(m[2], '--formula');
      else formula.unit = m[2];
    }
    if (formula.show && !formula.token) throw new Error('--formula: show needs a token.');
    if (calls.length > 0) formula.calls = calls;
    out.push(formula);
  }
  return out;
}

/** A stated token as the server takes it: a 0x address, self, or a view with no arguments, like asset(). */
const TOKEN_REF = /^(0x[0-9a-fA-F]{40}|self|[A-Za-z_][A-Za-z0-9_]*\(\))$/;

function tokenRef(value: string, what: string): string {
  if (!TOKEN_REF.test(value)) throw new Error(`${what}: a token is its 0x address, self (the contract itself), or a view with no arguments that returns its address, like asset() (got: ${value})`);
  return value;
}

function showOf(value: string, what: string): 'token' | 'usd' {
  if (value !== 'usd' && value !== 'token') throw new Error(`${what}: show is usd or token (got: ${value})`);
  return value;
}

/** `… token asset() show usd`, `… decimals 18` at the end of a --sum: what the amount is, each said once. */
export function amountSuffix(whole: string, what: string): { rest: string; token?: string; show?: 'token' | 'usd'; decimals?: number } {
  let rest = whole.trim();
  const out: { token?: string; show?: 'token' | 'usd'; decimals?: number } = {};
  for (;;) {
    const m = /^(.*?)\s+(token|show|decimals)\s+(\S+)$/.exec(rest);
    if (!m) break;
    if (m[2] === 'token') out.token = tokenRef(m[3], what);
    else if (m[2] === 'show') out.show = showOf(m[3], what);
    else {
      const d = Number(m[3]);
      if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error(`${what}: decimals is 0 to 36 (got: ${m[3]})`);
      out.decimals = d;
    }
    rest = m[1];
  }
  if (out.token && out.decimals !== undefined) throw new Error(`${what}: a token brings its own decimals; give one or the other.`);
  if (out.show && !out.token) throw new Error(`${what}: show needs a token.`);
  return { rest, ...out };
}

/** `--count WithdrawalQueued:Queued` and `--sum WithdrawalQueued.normalizedAmount:Queued amount` as the tool's columns. */
/** A trailing `on <field>`: the event's field that holds the row id, stated when more than one could. */
function takeOn(raw: string): { rest: string; on?: string } {
  const m = /\s+on\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(raw);
  return m ? { rest: raw.slice(0, m.index), on: m[1] } : { rest: raw };
}

export function columnsFrom(flags: ParsedFlags): Record<string, unknown>[] {
  const split = (raw: string): [string, string | null] => {
    const at = raw.indexOf(':');
    return at > 0 ? [raw.slice(0, at).trim(), raw.slice(at + 1).trim() || null] : [raw.trim(), null];
  };
  const out: Record<string, unknown>[] = [];
  for (const whole of flagAll(flags, 'count')) {
    const { rest: raw, on } = takeOn(whole);
    const [event, label] = split(raw);
    if (!event) throw new Error('--count takes an event name, like --count WithdrawalQueued.');
    out.push({ label: label ?? `${event} count`, event, fold: 'count', ...(on ? { on } : {}) });
  }
  for (const whole of flagAll(flags, 'sum')) {
    // `… token asset() show usd` or `… decimals 18`: what the amount is, only as stated; left out, the plain number
    const { rest: beforeAmount, ...amount } = amountSuffix(whole, '--sum');
    const { rest, on } = takeOn(beforeAmount);
    const [ref, label] = split(rest);
    const dot = ref.lastIndexOf('.');
    if (dot <= 0 || dot === ref.length - 1) throw new Error('--sum takes Event.field, like --sum WithdrawalQueued.normalizedAmount.');
    out.push({ label: label ?? `${ref.slice(dot + 1)}`, event: ref.slice(0, dot), field: ref.slice(dot + 1), fold: 'sum', ...(on ? { on } : {}), ...amount });
  }
  return out;
}

/** --event "<Event>.<field>": an event the rules name, with the field that holds the row id (stated when more than one could). */
function eventsFrom(flags: ParsedFlags): string[] {
  return flagAll(flags, 'event')
    .filter((v) => v !== 'true')
    .map((v) => v.trim())
    .filter(Boolean);
}

async function createTable(args: string[]): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'name');
  const opens = flag(flags, 'opens');
  if (!opens) throw new Error('--opens names what makes a row: an event (WithdrawalBatchCreated) or a list view (getUnpaidBatchExpiries()).');
  const input: Record<string, unknown> = { name, opens, ...scopeInput(flags) };
  for (const key of ['closes', 'id', 'closesOn', 'finished'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  const closesOn = flag(flags, 'closes-on');
  if (closesOn !== undefined) input.closesOn = closesOn;
  const events = eventsFrom(flags);
  if (events.length > 0) input.events = events;
  const statuses = statusesFrom(flags);
  if (statuses.length > 0) input.statuses = statuses;
  const formulas = formulasFrom(flags);
  if (formulas.length > 0) input.formulas = formulas;
  const columns = columnsFrom(flags);
  if (columns.length > 0) input.columns = columns;
  if (flag(flags, 'hidden') !== undefined) input.listed = false;
  // a number id is a number unless you say it is a date (an expiry, a deadline): nothing is read from its name
  const idShown = flag(flags, 'id-shown');
  if (idShown !== undefined) {
    if (idShown !== 'date' && idShown !== 'number') throw new Error(`--id-shown takes date or number (got: ${idShown})`);
    input.idShown = idShown;
  }
  const result = await runTool<Record<string, unknown>>(requireAuth(), 'create_table', input);
  for (const line of printResult(result)) console.log(line);
  return result;
}

async function updateTable(args: string[], renaming: boolean): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const table = requirePositional(positional, 0, 'table');
  const name = flag(flags, 'name') ?? (renaming ? positional[1] : undefined);
  const show = flag(flags, 'show') !== undefined;
  const hide = flag(flags, 'hide') !== undefined;
  const finished = flag(flags, 'finished');
  const never = flag(flags, 'never-finishes') !== undefined;
  const statuses = statusesFrom(flags);
  const formulas = formulasFrom(flags);
  const events = eventsFrom(flags);
  const tokens = flagAll(flags, 'token').map((raw) => {
    const eq = raw.indexOf('=');
    const column = eq > 0 ? raw.slice(0, eq).trim() : '';
    if (!column) throw new Error('--token takes Label=<token>: --token "Requested=asset()", or --token "Requested=" to clear it.');
    const [token = '', ...more] = raw.slice(eq + 1).trim().split(/\s+/).filter(Boolean);
    const shown = more.length === 2 && more[0] === 'show' ? showOf(more[1], '--token') : undefined;
    if (more.length > 0 && !shown) throw new Error(`--token: after the token comes "show usd" or "show token" (got: ${more.join(' ')})`);
    return { column, token: token ? tokenRef(token, '--token') : '', ...(shown ? { show: shown } : {}) };
  });
  if (show && hide) throw new Error('Pick one: --show or --hide.');
  if (!name && !show && !hide && finished === undefined && !never && statuses.length === 0 && formulas.length === 0 && tokens.length === 0 && events.length === 0)
    throw new Error('Nothing to change: pass --name "<name>", --status …, --formula …, --token …, --finished "<rule>", --never-finishes, --show or --hide.');
  const input: Record<string, unknown> = {
    table,
    ...(name ? { name } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(formulas.length > 0 ? { formulas } : {}),
    ...(tokens.length > 0 ? { tokens } : {}),
    ...(events.length > 0 ? { events } : {}),
    ...(finished !== undefined ? { finished } : never ? { finished: '' } : {}),
    ...(show ? { listed: true } : hide ? { listed: false } : {}),
  };
  const result = await runTool<Record<string, unknown>>(requireAuth(), 'update_table', input);
  for (const line of printResult(result)) console.log(line);
  return result;
}
