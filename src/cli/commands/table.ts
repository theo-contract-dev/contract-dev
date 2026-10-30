// Everything on the Tables page, through the platform's tools. Two kinds, one command (2026-10-26):
//   - a live table: a question over data the workspace keeps, asked again while it is open
//     (`create "<name>" --from <data>` with the query's own flags; it was `query … --keep`). One
//     straight from events is one step (2026-10-27, `--from events --event <E> --field …`): the
//     events are kept as data of the table's own, off the lists and gone with it, then asked;
//   - an item table: the things inside contracts (withdrawal rounds, loans, requests), one row per id
//     an event or a list view announces, over their whole life, with status columns chosen by rules,
//     formula columns, and a rule that finishes a row (`create "<name>" --opens <Event>`).
// list (both), show (an item table's counts, findings and endings by period, rows per status, how
// long rows take, the biggest and newest rows, one row by id; a live table's rows, asked now),
// update (either kind: rename or describe it; an item table also: set when rows finish, put on or take off the page) and delete.
// Every table takes a description (2026-10-27): a sentence or two saying what it shows, on create or update.
// --json hands back the tool's own result.
import { statusesFrom } from './_status';
import { parseFlags, flag, flagAll, requirePositional, type ParsedFlags } from './_args';
import { definitionFrom, parseFormulaCall } from './eventMetric';
import { apiRequest, requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { printResult, columnsTable, type BreakdownColumn } from './_print';
import { clausesFromFlags, printRows, queryCommand, savedLine } from './query';

const HELP = `contract-dev table — everything on the Tables page: live tables over rows the workspace keeps, and item tables
(withdrawal rounds, loans, requests… one row per id, over their whole life)

Usage:
  contract-dev table create "<name>" --from events --group <group> | --contract <ref> --event <Event> [--event …]
                              [--field "<name>=<expr>[ on <Event>]"]… [--read "<name>=<call>"]… [--pair "<Event> [on <field>]"]…
                              [--keep <param>[,<param>…] | --keep all] [--days <n>] [--column <name>]… [--detail <name>]…
                              [--status "<Label>: <Opt>=<rule>; <Opt>"]… [--description "<sentence>"] [the query's flags]
                                                      A live table straight from events, one step: the events are kept as
                                                      rows underneath (off the Metrics page, gone with the table), each with
                                                      its --field figures (usd(amount, token) on the event's day,
                                                      amount(raw, token) in whole tokens, a read as of its transaction, a
                                                      paired event's field as Event.field), and the question is asked of them
                                                      with the query's flags (--where, --by, --measure, --having, --breakdown,
                                                      --sort, --limit), asked again while the table is open. --days: how far
                                                      back the rows reach (the plan's history unless said).
                                                      A table that lists its rows shows only the columns it names with
                                                      --column, in that order: a --field, or the row's own time, day, tx,
                                                      chain, contract, event or wallet (the wallet that signed it). Named
                                                      none, it shows its --field columns alone. Name what the table is for;
                                                      an amount() column prints its token's symbol. --detail names the
                                                      columns a row opens onto, one line per item of a list field (a
                                                      batch swap's swaps; a single swap is one line). --status sets a
                                                      category drawn as a pill on each row (Type: Batch=…; Single), only
                                                      when wanted: a table has no pills otherwise
  contract-dev table create "<name>" --from <rows> [--description "<sentence>"] [the query's flags]
                                                      A live table over rows the workspace already keeps: --from "<table>"
                                                      for another table's rows (its own --where carried in: an Integrators
                                                      table built on the swaps-and-bridges table; a table that folds its
                                                      rows cannot be built on), an item table's rows or a metric's records
                                                      (contract-dev table list names them); --from transactions, transfers,
                                                      wallets, contracts, metrics, monitors, alerts or reports. The flags are
                                                      contract-dev query's (--where, --by, --measure, --having, --breakdown,
                                                      --sort, --days, --group…)
  contract-dev table list [--group <group>] [--contract <ref>]
                                                      Every table, hidden ones too: the live tables, then each item table's
                                                      rule for a row, the events it watches, when a row finishes, rows
                                                      active and finished
  contract-dev table show <table> [--limit <n>]       A live table's rows, asked now (25 unless said; --json for every one)
  contract-dev table show <table> [--by day|week|month] [--since YYYY-MM-DD] [--among active|done|all]
                              [--column <key|label>] [--contract <ref>] [--limit <n>]
                                                      Findings and endings per period, rows per status, how long rows
                                                      take, column totals, the biggest and newest rows, the busiest contracts
  contract-dev table show <table> --row <id>          One row: its values, its statuses, its watched events and its own
                                                      events since it was found
  contract-dev table show <live table>                 A live table's rows, asked now
  contract-dev table delete <table>                   Remove it (an item table's rows, their tracked values and its monitors go with it)
  contract-dev table create "<name>" --opens <Event> [--status "<Label>: <Opt>=<rule>; <Opt>=<rule>; <Opt>"]…
                              [--formula "<Label>=<expr>[; call <name>=<call>]…[; token <token>][; show usd]"]… [--finished "<rule>"] [--closes <Event>|list] [--id <field>]
                              [--group <group> | --contract <ref>] [--count "<Event>[:label] [on <field>]"]…
                              [--sum "<Event>.<field>[:label] [on <field>] [token <token> [show usd] | decimals <n>]"]…
                              [--event "<Event>.<field>"]… [--closes-on <field>] [--id-shown date|number] [--hidden] [--description "<sentence>"]
                                                      A table from the contracts' events; its history is read now and
                                                      kept up to date
  contract-dev table update <table> [--name "<name>"] [--description "<sentence>"] [--status "<Label>: …"]… [--formula "<Label>=<expr>"]…
                              [--token "<Label>=<token> [show usd]"]… [--event "<Event>.<field>"]… [--finished "<rule>" | --never-finishes]
                              [--show | --hide]
                                                      Rename or describe it (--description "" removes it), add status or
                                                      formula columns or replace their rules (by label), set when its rows
                                                      finish, put a hidden table on the Tables page, or take one off. A live
                                                      table takes --name and --description

--description "<sentence>" on any table: a sentence or two saying what it shows, beside it on the Tables page and at the
top of its page.

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
first or last of an address or a fixed bytes field keeps it as it was emitted: --formula "Trader=first(Opened.trader)".
A call's arguments may name the row's own cells, {Label}, and the formula's other calls by name, as many as the view
takes: a position kept under its trader, market and index is read with all three (the Open positions example).

A snapshot (the answer as it was, under Queries) is contract-dev query … --save, not a table.

Examples:
  contract-dev table create "Top integrators" --from events --group "DZap Routers" \\
    --event DZapTokenSwapped --event DZapBatchTokenSwapped --event BridgeStarted --event CctpBridgeTransferStarted \\
    --pair "DZapBridgeStarted on transactionId" \\
    --field "vol=usd(swapInfo.fromAmount, swapInfo.fromToken) on DZapTokenSwapped" \\
    --field "vol=sum(usd(swapInfo.fromAmount, swapInfo.fromToken)) on DZapBatchTokenSwapped" \\
    --field "vol=usd(amount, from) on BridgeStarted" --field "vol=usd(amountIn, from) on CctpBridgeTransferStarted" \\
    --field "integrator=integrator on DZapTokenSwapped" --field "integrator=integrator on DZapBatchTokenSwapped" \\
    --field "integrator=DZapBridgeStarted.integrator on BridgeStarted" --field "integrator=DZapBridgeStarted.integrator on CctpBridgeTransferStarted" \\
    --by integrator --measure swaps='count where {Event} == "DZapTokenSwapped" or {Event} == "DZapBatchTokenSwapped"' \\
    --measure bridges='count where {Event} == "BridgeStarted" or {Event} == "CctpBridgeTransferStarted"' --measure volume="sum(vol)" \\
    --sort volume --breakdown chain
  contract-dev table create "Swaps, 30 days" --from events --group "DZap Routers" --event DZapTokenSwapped --event DZapBatchTokenSwapped --days 30 \\
    --description "Every swap through the DZap routers over 30 days, newest first; a batch opens onto its swaps" \\
    --field "fromToken=swapInfo.fromToken" --field "toToken=swapInfo.toToken" \\
    --field "amountIn=amount(swapInfo.fromAmount, swapInfo.fromToken)" --field "amountOut=amount(swapInfo.returnToAmount, swapInfo.toToken)" \\
    --field "swapDollars=first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken))" \\
    --field "dollars=first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken)) on DZapTokenSwapped" \\
    --field "dollars=sum(first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken))) on DZapBatchTokenSwapped" \\
    --status 'Type: Batch={Event} == "DZapBatchTokenSwapped"; Single' \\
    --column time --column chain --column tx --column Type --column dollars \\
    --detail fromToken --detail amountIn --detail toToken --detail amountOut --detail swapDollars --sort time
  contract-dev table create "Swaps over $10k" --from "Swaps, 30 days" --where "dollars > 10000"
  contract-dev table create "Top wallets, 24h" --from transfers --group "DZap Routers" --days 1 --by wallet --sum "{USD}"
  contract-dev table update "Top integrators" --description "Volume, swaps, bridges and wallets per integrator over 90 days"
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
  contract-dev table create "Open positions" --contract PairInfos --opens TradeInitialAccFeesStoredV2 --id tradeId \\
    --event TradeInitialAccFeesStoredV2.tradeId --finished "{Collateral} == 0" \\
    --formula "Trader=first(TradeInitialAccFeesStoredV2.trader)" --formula "Pair=first(TradeInitialAccFeesStoredV2.pairIndex)" \\
    --formula "Index=first(TradeInitialAccFeesStoredV2.index)" \\
    --formula "Collateral=c; call c=getOpenTrade(address,uint16,uint8).collateral on 0xccd5…66e7 with {Trader}, {Pair}, {Index} decimals 6"
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

/** A live table as the saved-queries routes answer it. */
interface LiveTable {
  id: string;
  title: string;
  description?: string | null;
  tool: string;
  rows: number;
  url: string;
  asOf?: string;
}
interface LiveTableView extends LiveTable {
  asOf: string;
  /** The question as it was asked (query_data's input): what to print first, and its window. */
  args?: Record<string, unknown>;
  snapshot: {
    columns: { key: string; label: string; unit?: string; symbolKey?: string }[];
    rows: Record<string, unknown>[];
    matched: number;
    notes?: string[];
    breakdown?: BreakdownColumn;
    /** Each row opens onto lines with these columns (a batch swap's swaps), held in the row's `lines`. */
    detail?: { columns: { key: string; label: string; unit?: string; symbolKey?: string }[] };
    grouped?: { by: string[]; measure: string };
    /** `filling`: the data under it is still reading its history, so the rows are partial. */
    meta?: { filling?: boolean };
  };
}

const liveTables = async (auth: ReturnType<typeof requireAuth>): Promise<LiveTable[]> =>
  (await apiRequest<{ queries: LiveTable[] }>(auth, 'GET', '/api/mainnet/queries?kept=1')).queries ?? [];

/** The live table a name means: its id, or its whole title (case-insensitive); null when none is called that. */
async function findLive(auth: ReturnType<typeof requireAuth>, ref: string): Promise<LiveTable | null> {
  const all = await liveTables(auth);
  const byId = all.find((t) => t.id === ref);
  if (byId) return byId;
  const byTitle = all.filter((t) => t.title.trim().toLowerCase() === ref.toLowerCase());
  if (byTitle.length > 1) throw new Error(`"${ref}" names ${byTitle.length} live tables (${byTitle.map((t) => t.id).join(', ')}); pass the id.`);
  return byTitle[0] ?? null;
}

/** What --from names: a dataset's own word, or a name query table resolves (another table's rows, an item table's rows, a metric's records). */
const FROM_DATASETS = ['contracts', 'metrics', 'monitors', 'alerts', 'reports', 'transactions', 'transfers', 'wallets'];

/** `table create "<name>" --from <data> …`: the question asked through `query` and kept as a live table. */
async function createLiveTable(args: string[]): Promise<unknown> {
  const name = args[0];
  if (!name || name.startsWith('--')) throw new Error('Name the table first: contract-dev table create "<name>" --from <data> ….');
  const rest = args.slice(1);
  const at = rest.findIndex((a) => a === '--from' || a.startsWith('--from='));
  const from = (rest[at].startsWith('--from=') ? rest[at].slice('--from='.length) : rest[at + 1] ?? '').trim();
  if (!from || from.startsWith('--')) throw new Error('--from names the rows: events (--event <Event>…, the events kept underneath), "<table>" (another table\'s rows, an item table\'s rows or a metric\'s records: contract-dev table list), transactions, transfers, wallets, contracts, metrics, monitors, alerts or reports.');
  const remaining = rest.filter((_, i) => i !== at && !(i === at + 1 && !rest[at].startsWith('--from=')));
  // the table's own words, not the question's: taken out before the rest is asked
  const description = descriptionFlag(parseFlags(remaining));
  const others = withoutFlags(remaining, ['description']);
  const events = from.toLowerCase() === 'events';
  // --keep is an item table's old flag, and a table from events' parameters to keep; --status is both tables' category
  // (an item table's over its rows' facts, a live table's a pill over its columns, 2026-10-27)
  for (const f of ['--opens', '--closes', '--formula', '--finished', '--hidden', ...(events ? [] : ['--keep'])])
    if (others.some((a) => a === f || a.startsWith(`${f}=`))) throw new Error(`${f} is for a table that opens rows on an event (--opens); a live table takes the query's flags (contract-dev query help).`);
  if (events) return createEventsTable(name, others, description);
  const query = FROM_DATASETS.includes(from.toLowerCase()) ? [from.toLowerCase()] : ['data', from];
  return queryCommand([...query, ...others], { live: name, ...(description ? { description } : {}) });
}

/** The flags that say what the rows are (the data kept underneath); every other flag is the question asked of them. */
const EVENTS_DATA_FLAGS = ['event', 'field', 'read', 'fixed', 'pair', 'keep', 'history', 'group', 'contract', 'chain'];

/** The arguments without the named flags, `--flag value` and `--flag=value` alike (a flag's value is the next word, as parseFlags reads it). */
function withoutFlags(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith('--') ? a.slice(2).split('=')[0] : null;
    if (name && names.includes(name)) {
      if (!a.includes('=') && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * `table create "<name>" --from events --group <g> --event <E> [--field …] [the query's flags]` (2026-10-27): one step.
 * The events are kept as rows of the table's own (define_data: off the Metrics page, named after the
 * table, deleted with it), then the question is asked of them by id and kept as the live table. --where, --by, --measure
 * and the rest are the question, in the table language over the fields; the per-event figures are --field.
 */
async function createEventsTable(name: string, args: string[], description?: string): Promise<unknown> {
  const flags = parseFlags(args);
  for (const k of ['value', 'aggregate', 'unit', 'split', 'line'])
    if (flag(flags, k) !== undefined) throw new Error(`--${k} makes a metric (contract-dev metric define); a table keeps the events as rows and adds them up with --by and --measure.`);
  const definition = definitionFrom(flags);
  // the question's --where is over the rows (the table language); nothing here filters the events as they are kept
  for (const k of ['where', 'split', 'line', 'value', 'aggregate', 'unit']) delete definition[k];
  if (!definition.events) throw new Error('--event names what each row is: contract-dev table create "<name>" --from events --group <group> --event <Event> [--field "vol=usd(amount, token)"] [--by … --measure …].');
  const scope = scopeInput(flags);
  if (!scope.group && !scope.contract) throw new Error('Say whose events: --group <group> or --contract <ref>.');
  // --days reaches back over the rows kept and is the question's window too
  const days = flag(flags, 'days');
  if (days !== undefined) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) throw new Error('--days takes a whole number of days');
    if (definition.history === undefined) definition.history = n;
  }
  // one call (2026-10-30): the rows and the table together, the server keeping nothing when the question is refused
  // (until then this chained define_data and a query, and a failed column check left the rows behind under the name)
  const question = parseFlags(withoutFlags(args, EVENTS_DATA_FLAGS));
  const table: Record<string, unknown> = { title: name, ...(description ? { description } : {}), ...clausesFromFlags(question) };
  // the columns a listing shows, in order, and the lines a row opens onto (as contract-dev query takes them)
  const columns = flagAll(question, 'column').flatMap((c) => String(c).split(',')).map((c) => c.trim()).filter(Boolean);
  if (columns.length > 0) table.columns = columns;
  const detail = flagAll(question, 'detail').flatMap((c) => String(c).split(',')).map((c) => c.trim()).filter(Boolean);
  if (detail.length > 0) table.detail = detail;
  if (days !== undefined) table.days = Number(days);
  const r = (await runTool<Record<string, unknown>>(requireAuth(), 'define_data', { name, ...scope, ...definition, table })) as Record<string, unknown> | undefined;
  // never the rows so far (Theo, 2026-10-27): the table is indexing until every row is in
  if (r?.filling) console.log(`Indexing the events in the background; its rows show once every one is in (contract-dev table show "${name}").`);
  const kept = savedLine(r);
  if (kept) console.log(kept);
  return r;
}

async function listTables(args: string[]): Promise<unknown> {
  if (HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const auth = requireAuth();
  const scoped = Object.keys(scopeInput(flags)).length > 0;
  // the live tables are the workspace's, not a group's: a scoped list is the item tables alone
  const [result, live] = await Promise.all([runTool<Record<string, unknown>>(auth, 'list_tables', scopeInput(flags)), scoped ? Promise.resolve([]) : liveTables(auth)]);
  if (live.length > 0) {
    console.log(`Live tables (${live.length})`);
    for (const line of columnsTable(['Id', 'Name', 'Rows', 'Link', 'Description'], live.map((t) => [t.id, t.title, String(t.rows), t.url, t.description ?? '—']))) console.log(line);
    console.log('');
    // the item tables' own counts follow: said so, since "Tables: 0" under a list of live tables read as a contradiction (2026-10-27)
    console.log('Item tables (things that open and close inside contracts)');
  }
  for (const line of printResult(result)) console.log(line);
  return live.length > 0 ? { ...result, live } : result;
}

/** A live table's rows, asked now: the question's own columns first, its window said, and whether it is still filling (2026-10-27); `limit` rows printed (every one with --json). */
async function showLive(auth: ReturnType<typeof requireAuth>, found: LiveTable, limit = 25): Promise<LiveTableView> {
  const { query } = await apiRequest<{ query: LiveTableView }>(auth, 'POST', `/api/mainnet/queries/${found.id}/refresh`, undefined, { timeoutMs: 90_000 });
  const snap = query.snapshot;
  const args = query.args ?? {};
  const days = typeof args.days === 'number' ? args.days : undefined;
  // a table still indexing shows no rows, never the ones so far (Theo, 2026-10-27): its count would read as the answer
  const filling = snap.meta?.filling === true;
  const count = filling ? 'indexing' : `${snap.rows.length} row${snap.rows.length === 1 ? '' : 's'}${snap.matched > snap.rows.length ? ` of ${snap.matched}` : ''}`;
  console.log(`${query.title} · live table · ${count}${days ? ` · last ${days} day${days === 1 ? '' : 's'}` : ''} · ${query.url}`);
  if (query.description) console.log(query.description);
  if (filling) {
    console.log('Indexing: its rows show once every one is in.');
    return query;
  }
  // the columns the question names come first, as a query prints them (the dollar column a where is on, not the ninth column)
  const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const named = [
    ...strings(args.sort),
    ...strings(args.where),
    ...strings(args.by),
    ...strings(args.total),
    ...strings(args.breakdown),
    ...((args.show as { name?: string }[] | undefined)?.map((s) => s.name ?? '') ?? []),
    ...((args.measures as { name?: string }[] | undefined)?.map((m) => m.name ?? '') ?? []),
  ].filter(Boolean);
  printRows(snap.rows.slice(0, limit), snap.columns, named, snap.grouped?.by ?? [], snap.breakdown, Array.isArray(args.columns) && !snap.grouped, snap.detail?.columns);
  if (snap.rows.length > limit) console.log(`… ${(snap.rows.length - limit).toLocaleString('en-US')} more row${snap.rows.length - limit === 1 ? '' : 's'} (--limit, or --json for all)`);
  for (const n of snap.notes ?? []) console.log(n);
  return query;
}

async function showTable(args: string[]): Promise<unknown> {
  if (!args.length || HELP_WORDS.includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const table = (flags._ as string[]).join(' ').trim();
  if (!table) throw new Error('Name the table (contract-dev table list shows them).');
  const auth = requireAuth();
  const live = await findLive(auth, table);
  if (live) return showLive(auth, live, flag(flags, 'limit') !== undefined ? limitFlag(flags, 1, 5_000) : 25);
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
  const result = await runTool<Record<string, unknown>>(auth, 'describe_table', input);
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
    const live = await findLive(auth, ref);
    if (!live) throw new Error(`No table matches "${ref}" (contract-dev table list shows them).`);
    await apiRequest(auth, 'DELETE', `/api/mainnet/queries/${live.id}`);
    console.log(`Deleted live table "${live.title}" (${live.id}); rows it kept for itself went with it.`);
    return { ok: true, id: live.id };
  }
  await apiRequest(auth, 'DELETE', `/api/console/tables/${table.id}`);
  console.log(`Deleted table "${table.name}" (${table.id}): its rows, their tracked values and its monitors.`);
  return { ok: true, id: table.id };
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
  if (args.some((a) => a === '--from' || a.startsWith('--from='))) return createLiveTable(args);
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'name');
  const opens = flag(flags, 'opens');
  if (!opens) throw new Error('Say what the table holds: --from events --event <Event> for a live table straight from events (top wallets, integrators, swaps over a line), --from <data> for one over rows the workspace keeps, or --opens <Event> for things that open and close inside contracts (contract-dev table help).');
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
  const description = descriptionFlag(flags);
  if (description) input.description = description;
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
  // '' removes it
  const description = descriptionFlag(flags, true);
  const auth = requireAuth();
  // a live table is renamed or described through its own route; every other flag is an item table's
  const itemOnly = Object.keys(flags).some((k) => k !== '_' && k !== 'name' && k !== 'description');
  const live = !itemOnly && (name || description !== undefined) ? await liveFor(auth, table) : null;
  if (live) return updateLive(auth, live, name, description);
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
  if (!name && description === undefined && !show && !hide && finished === undefined && !never && statuses.length === 0 && formulas.length === 0 && tokens.length === 0 && events.length === 0)
    throw new Error('Nothing to change: pass --name "<name>", --description "<sentence>", --status …, --formula …, --token …, --finished "<rule>", --never-finishes, --show or --hide.');
  const input: Record<string, unknown> = {
    table,
    ...(name ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(formulas.length > 0 ? { formulas } : {}),
    ...(tokens.length > 0 ? { tokens } : {}),
    ...(events.length > 0 ? { events } : {}),
    ...(finished !== undefined ? { finished } : never ? { finished: '' } : {}),
    ...(show ? { listed: true } : hide ? { listed: false } : {}),
  };
  const result = await runTool<Record<string, unknown>>(auth, 'update_table', input);
  for (const line of printResult(result)) console.log(line);
  return result;
}

/** --description "<sentence>": trimmed; on update an empty one is kept (it removes the description), elsewhere it is an error. */
function descriptionFlag(flags: ParsedFlags, emptyClears = false): string | undefined {
  const raw = flag(flags, 'description');
  if (raw === undefined) return undefined;
  // a bare --description reads as "true": the sentence is missing
  if (raw === 'true') throw new Error('--description takes a sentence: --description "Every swap over $10k through the routers, newest first"' + (emptyClears ? ', or --description "" to remove it.' : '.'));
  const text = raw.trim();
  if (!text && !emptyClears) throw new Error('--description takes a sentence saying what the table shows.');
  if (text.length > 280) throw new Error(`--description holds 280 characters (got ${text.length}).`);
  return text;
}

/** The live table `ref` names, unless an item table answers to it first (as table delete reads a name). */
async function liveFor(auth: ReturnType<typeof requireAuth>, ref: string): Promise<LiveTable | null> {
  const listed = await runTool<{ rows?: Array<{ id: string; name: string }> }>(auth, 'list_tables', {});
  const rows = listed.rows ?? [];
  if (rows.some((t) => t.id === ref || t.name.trim().toLowerCase() === ref.toLowerCase())) return null;
  return findLive(auth, ref);
}

/** `table update <live table> [--name …] [--description …]`: the two things a live table's own route changes. */
async function updateLive(auth: ReturnType<typeof requireAuth>, live: LiveTable, name: string | undefined, description: string | undefined): Promise<unknown> {
  const { query } = await apiRequest<{ query: LiveTable }>(auth, 'PATCH', `/api/mainnet/queries/${live.id}`, { ...(name ? { title: name } : {}), ...(description !== undefined ? { description } : {}) });
  console.log(`Updated live table "${query.title}" (${query.id})${query.description ? `: ${query.description}` : description === '' ? ': description removed' : ''}`);
  return query;
}
