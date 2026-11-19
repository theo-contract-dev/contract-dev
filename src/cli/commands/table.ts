// Everything on the Tables page, through the platform's tools. One command, one grammar (5.0.0, 2026-11-17):
// `create "<name>" --on <what>` says what the table is on, `--each <Event>` what a row is. A table is made from
// events, or built on a table that is (--on table:"<name>"); the lists the platform keeps by itself (transactions,
// transfers, wallets…) are asked with `query`, never kept as a table (--rows removed, 2026-11-18). What the words ask
// for decides how it is kept: with `--id` (and a read column, a formula, a
// finish rule, a fold of events per row) one row per thing an event announces, over its whole life, its columns read
// live; alone, one row per event, asked again while the table is open. The flags of the two older ways (`--opens`,
// `--from`, `--group`, `--contract`) are refused with the word that replaced them; underneath, rewriteTableArgs still
// hands the two tools (create_table, define_data and the query's save) the shapes they take.
// list, show (a table's counts, findings and endings by period, rows per status, how long rows take, the biggest and
// newest rows, one row by id; or its rows, asked now), update (rename or describe it; set when rows finish, put it on
// or take it off the page) and delete. Every table takes a description: a sentence or two saying what it shows.
// --json hands back the tool's own result.
import { statusesFrom } from './_status';
import { parseFlags, flag, flagAll, requirePositional, type ParsedFlags } from './_args';
import { lastDays, lastFlag } from '../last';
import { definitionFrom, parseFormulaCall } from './eventMetric';
import { apiRequest, requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { printResult, columnsTable, type BreakdownColumn } from './_print';
import { clausesFromFlags, printRows, queryCommand, savedLine } from './query';

const HELP = `contract-dev table — everything on the Tables page

One grammar, the same words as a metric: --on says what the table is on (a contract or wallet, tag:<group>,
workspace, or table:"<other>" to build on it); --each <Event> says what a row is. A table is made from events, or
built on a table that is. What you ask for decides how it is kept. With --id (and a read --column, --formula,
--finished, --count or --sum per row) it is a STATE table: one row per thing that event announces, alive while the
thing is, its columns read live and its events added up, over its whole life. Alone it is an ACTIVITY table: one
row per event, asked again each time it is opened. You never pick a kind.

  contract-dev table create "Loans" --on tag:markets --each LoanOpened --id loanId --column "Owed=accountDebt(id())" --finished "seen(LoanClosed)"
  contract-dev table create "Big swaps" --on tag:pools --each Swap --where "usd(abs(amount0), token0()) > 10000"
  contract-dev table create "Swaps" --on 0x8366a39CC670B4001A1121B8F6A443A643e40951 --chain 4663 --each Swap --where "id in Pools"
  contract-dev table create "Whales" --on table:"Big swaps" --by wallet --top 10

Usage:
  contract-dev table create "<name>" --on <contract|tag:<group>> --each <Event> [--id <field>]
                              [--column "<Label>=<view>(<args>)[.<output>][; on 0x… | {Column} | id()][; token <token>][; show usd][; decimals <n>]"]…
                              [--count "<Event>[:<Label>] [on <field>] [from <contract>] [by <field>] [where <field> == {Column}] [last <window>]"]…
                              [--sum "<Event>.<field>[:<Label>] [on <field>] [from <contract>] [by <field>] [where <field> == {Column}] [token <token> [show usd] | decimals <n>] [last <window>]"]…
                              [--sum '<column>:<Label> from table:"<table of events>" [on <field>] last <window>']… [--count '<Label> from table:"<table>" last <window>']…
                              [--formula "<Label>=<expr>[; call <name>=<call>]…[; token <token>][; show usd]"]…
                              [--status "<Label>: <Opt>=<rule>; <Opt>=<rule>; <Opt>"]… [--finished "<rule>"] [--closes <Event>|list]
                              [--event "<Event>.<field> [from <contract>]"]… [--closes-on <field>] [--id-shown date|number]
                              [--found-label "<word>"] [--row-name "<template>"] [--detail "<Column>, <Column>…"]
                              [--hidden] [--description "<sentence>"]
                                                      One row per thing the event announces (withdrawal rounds, loans,
                                                      requests, pools a registry lists), over its whole life: its history
                                                      is read now and kept up to date. --id names the event's field that is
                                                      the row's id
  contract-dev table create "<name>" --on <contract|tag:<group>> --each <Event> [--each …]
                              [--field "<name>=<expr>[ on <Event>]"]… [--read "<name>=<call>"]… [--pair "<Event> [on <field>]"]…
                              [--keep <param>[,<param>…] | --keep all] [--last <n>d] [--column <name>]… [--detail <name>]…
                              [--status "<Label>: <Opt>=<rule>; <Opt>"]… [--description "<sentence>"] [the query's flags]
                                                      One row per event, one step: the events are kept as rows underneath
                                                      (off the Metrics page, gone with the table), each with its --field
                                                      figures (usd(amount, token) on the event's day, amount(raw, token) in
                                                      whole tokens, a read as of its transaction, a paired event's field as
                                                      Event.field), and the question is asked of them with the query's flags
                                                      (--where, --by, --measure, --having, --breakdown, --sort, --limit),
                                                      asked again while the table is open. --last: how far back the rows
                                                      reach (the plan's history unless said).
                                                      A table that lists its rows shows only the columns it names with
                                                      --column, in that order: a --field, or the row's own time, day, tx,
                                                      chain, contract, event or wallet (the wallet that signed it). Named
                                                      none, it shows its --field columns alone. Name what the table is for;
                                                      an amount() column prints its token's symbol. --detail names the
                                                      columns a row opens onto, one line per item of a list field (a
                                                      batch swap's swaps; a single swap is one line); --breakdown <column>
                                                      opens each group onto its parts. --status sets a category drawn as a
                                                      pill on each row (Type: Batch=…; Single), only when wanted
  contract-dev table create "<name>" --on table:"<table>" [--description "<sentence>"] [the query's flags]
                                                      Built on another table's rows (its own --where carried in: an
                                                      Integrators table built on the swaps-and-bridges table; a table that
                                                      folds its rows cannot be built on) or on a metric's records
                                                      (contract-dev table list names them). The flags are contract-dev
                                                      query's (--where, --by, --measure, --having, --breakdown, --sort,
                                                      --last…)
  contract-dev table list [--on tag:<group> | --on <contract>]
                                                      Every table, hidden ones too: the tables over rows the workspace
                                                      keeps, then each table of things with its rule for a row, the events
                                                      it watches, when a row finishes, rows active and finished
  contract-dev table show <table> [--limit <n>]       Its rows, asked now (25 unless said; --json for every one)
  contract-dev table show <table> [--by day|week|month] [--since YYYY-MM-DD] [--among active|done|all]
                              [--column <key|label>] [--on <contract>] [--limit <n>]
                                                      A table of things: findings and endings per period, rows per status,
                                                      how long rows take, column totals, the biggest and newest rows, the
                                                      busiest contracts
  contract-dev table show <table> --row <id|name> --last 30d [--series]
                                                      One row over time: where each number column stood at the start and
                                                      the end of the window, the change, its low and high; --series adds
                                                      every day's value. A column over a window (Fees 7d) has its whole
                                                      past; the rest have days from when the table started keeping them
  contract-dev table show <table> --row <id>          One row: its values, its statuses, its watched events and its own
                                                      events since it was found
  contract-dev table update <table> [--name "<name>"] [--description "<sentence>"] [--status "<Label>: …"]… [--formula "<Label>=<expr>"]…
                              [--column "<Label>=<view>(<args>)…"]… [--count "…"]… [--sum "…"]…
                              [--token "<Label>=<token> [show usd]"]… [--event "<Event>.<field> [from <contract>]"]…
                              [--finished "<rule>" | --never-finishes] [--found-label "<word>"] [--row-name "<template>"]
                              [--detail "<Column>, <Column>…"] [--show | --hide]
                                                      Rename or describe it (--description "" removes it), add status or
                                                      formula columns or replace their rules (by label), set when its rows
                                                      finish, put a hidden table on the Tables page, or take one off. A
                                                      table of events or of kept rows takes --name and --description
  contract-dev table delete <table>                   Remove it (its rows, their tracked values and its monitors go with it)

--opens, --from, --group and --contract are gone (5.0.0): --each <Event> --id <field>, --on table:"<name>",
--on tag:<group> and --on <contract> say the same. --rows is gone too: transactions, transfers, wallets and the other
lists the platform keeps are asked with contract-dev query, and a table is made from events.

--description "<sentence>" on any table: a sentence or two saying what it shows, beside it on the Tables page and at the
top of its page.

Rules are expressions over the row: columns as {Label}, events by name with seen(E), at(E), latest(E), inList(),
now(), found(), timeIn({Status}), and / or / not, comparisons, arithmetic, durations like 24h or 7d; price(T),
usd(raw, T) and amount(raw, T) for dollars at the current price. A --status
column tries its options in order and the first whose rule holds wins; an option with no rule is Otherwise, last.
--closes is the shorthand for a pinned Stage column with one option Closed on that event, finished once it is.
--id-shown date shows a number id as a date (an expiry, a deadline); it is a number unless you say so.
--row-name says what a row is called, as a template over the table's own columns in braces: --row-name "{Token 0} /
{Token 1}" names a pool by its pair; its id is on the row's own page. Give one whenever the id says nothing to a reader
(a hash, a number). A column holding a token prints its symbol; on update, --row-name "" goes back to the id.
--column reads a view on each row: on the row's own contract, on one contract for every row ("; on 0x…": a registry
asked about each pool by its id), on an address the row itself holds ("; on {Hook}": each pool's own hook), or on the
row's id where that is an address ("; on id()": a factory's pools). The view is found on whichever watched contract
declares it.
A count or a sum takes "last <window>" (24h, 7d, 30d) to cover a window back from now in place of the whole history;
from table:"<table of events>" adds up that table's rows per row of this one, its column for a sum:
--sum 'feeusd:Fees 7d from table:"Swaps" last 7d'. Each keeps a metric of the table's own, off the Metrics page.
Every number column keeps its value per row and day: a row's page charts them, a formula reads an earlier one with
ago({Deposits}, 7d), and table show <table> --row <id|name> --last 30d reads them back.
--detail names the columns shown on a row's own page and not in the table, by label: --detail "Hook, Token 0, Token 1,
Registered". Every column is made the same way; this only says where it shows. A row of the table opens its page: the
table's columns, these, and what each column split with "by" breaks into. Keep the table to what is compared across
rows. On update it replaces the list; --detail "" puts every column back in the table.
--found-label names the column saying when each row was found: by itself it is the opening event's past tense
(PoolRegistered: Registered, LoanOpened: Opened), else First seen. Give one only when that word is wrong.
--hidden makes a table to answer a question: it stays off the Tables page and is removed 7 days after it was last
read. --count and --sum add columns: how many of an event each row got, or the sum of one of its fields, matched on
the row's id. After Event[.field][:Label] come its clauses, each once, in any order:
  on <field>       the event's field that holds the row id, when more than one could; nothing is matched by name
  from <contract>  the contract that emits the event, when it is not the row's own: a watched contract's name or 0x
                   address (--count "Bribed:Incentives on poolId from Voter incentives"); quote a name that holds a
                   clause word (from "Fee on transfer"). The event is matched to the row with the same id
  by <field>       the event's field the column is split by (by token, by from): the row opens onto its parts;
                   several joined by commas keep one part per set of values (by tickLower,tickUpper: a price range).
                   A formula reads the parts with each({Column}, …): amount is the part's total, the fields by name
  where <field> == {Column}
                   only the events whose number field equals one of the row's own columns (where epoch == {Next epoch}:
                   what was posted for the week a Next epoch column holds); the figure follows the column when it changes
  token <token>    what the amount is an amount of: its 0x address, self (the contract itself), a view each contract
                   answers with the token's address, like asset(), or one of the event's own fields (token token): the
                   column is then split by that token, each part in its own token, and totals in dollars
  show usd         dollars at the current price (with a token)
  decimals <n>     scales a plain number
An event a rule names is stated the same way with --event "<Event>.<field>" (and "… from <contract>" when another
contract emits it), and --closes-on <field> does it for --closes. Nothing is assumed about what a number is: an amount is
a token amount only when you say which token. A
formula already in token units takes the same: --formula "Outstanding={Requested} - {Paid}; token asset(); show usd";
its own calls then count in that token too (a balanceOf scaled by the asset's decimals) unless one states "decimals <n>".
A formula folds an event's field by name over the row's events: sum(Event.field), count(Event), min, max, first,
last. --formula "Still owed=sum(WithdrawalQueued.normalizedAmount) - sum(WithdrawalExecuted.normalizedAmount); token
asset()" with --event WithdrawalQueued.expiry --event WithdrawalExecuted.expiry to say which field holds the row id.
Without a token a number is shown as the chain holds it. --token on update
sets, changes or (with nothing after =) clears a column's token.
first or last of an address or a fixed bytes field keeps it as it was emitted: --formula "Trader=first(Opened.trader)".
A call's arguments may name the row's own cells, {Label}, and the formula's other calls by name, as many as the view
takes: a position kept under its trader, market and index is read with all three (the Open positions example).

Examples:
  contract-dev table create "Top integrators" --on tag:"DZap Routers" \\
    --each DZapTokenSwapped --each DZapBatchTokenSwapped --each BridgeStarted --each CctpBridgeTransferStarted \\
    --pair "DZapBridgeStarted on transactionId" \\
    --field "vol=usd(swapInfo.fromAmount, swapInfo.fromToken) on DZapTokenSwapped" \\
    --field "vol=sum(usd(swapInfo.fromAmount, swapInfo.fromToken)) on DZapBatchTokenSwapped" \\
    --field "vol=usd(amount, from) on BridgeStarted" --field "vol=usd(amountIn, from) on CctpBridgeTransferStarted" \\
    --field "integrator=integrator on DZapTokenSwapped" --field "integrator=integrator on DZapBatchTokenSwapped" \\
    --field "integrator=DZapBridgeStarted.integrator on BridgeStarted" --field "integrator=DZapBridgeStarted.integrator on CctpBridgeTransferStarted" \\
    --by integrator --measure swaps='count where {Event} == "DZapTokenSwapped" or {Event} == "DZapBatchTokenSwapped"' \\
    --measure bridges='count where {Event} == "BridgeStarted" or {Event} == "CctpBridgeTransferStarted"' --measure volume="sum(vol)" \\
    --sort volume --breakdown chain
  contract-dev table create "Swaps, 30 days" --on tag:"DZap Routers" --each DZapTokenSwapped --each DZapBatchTokenSwapped --last 30d \\
    --description "Every swap through the DZap routers over 30 days, newest first; a batch opens onto its swaps" \\
    --field "fromToken=swapInfo.fromToken" --field "toToken=swapInfo.toToken" \\
    --field "amountIn=amount(swapInfo.fromAmount, swapInfo.fromToken)" --field "amountOut=amount(swapInfo.returnToAmount, swapInfo.toToken)" \\
    --field "swapDollars=first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken))" \\
    --field "dollars=first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken)) on DZapTokenSwapped" \\
    --field "dollars=sum(first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken))) on DZapBatchTokenSwapped" \\
    --status 'Type: Batch={Event} == "DZapBatchTokenSwapped"; Single' \\
    --column time --column chain --column tx --column Type --column dollars \\
    --detail fromToken --detail amountIn --detail toToken --detail amountOut --detail swapDollars --sort time
  contract-dev table create "Swaps over $10k" --on table:"Swaps, 30 days" --where "dollars > 10000"
  contract-dev table update "Top integrators" --description "Volume, swaps, bridges and wallets per integrator over 90 days"
  contract-dev table list
  contract-dev table create "Withdrawal rounds" --on tag:"Wildcat markets" --each WithdrawalBatchCreated --closes WithdrawalBatchClosed --count "WithdrawalQueued:Queued on expiry" --hidden
  contract-dev table create "Withdrawal rounds" --on tag:"Wildcat markets" --each WithdrawalBatchCreated --id-shown date \\
    --sum "WithdrawalQueued.normalizedAmount:Requested on expiry token asset()" \\
    --sum "WithdrawalBatchPayment.normalizedAmountPaid:Paid on expiry token asset()" \\
    --event WithdrawalBatchExpired.expiry \\
    --formula "Outstanding=max({Requested} - {Paid}, 0); token asset(); show usd" \\
    --status "Stage: Expired=latest(WithdrawalBatchExpired); Paying=seen(WithdrawalBatchPayment); Queued" \\
    --status "Health: Overdue={Stage} == \\"Expired\\" and timeIn({Stage}) > 24h; At risk={Outstanding} > 100000; Healthy" \\
    --finished "{Stage} == \\"Expired\\" and {Outstanding} == 0"
  contract-dev table create "Open positions" --on PairInfos --each TradeInitialAccFeesStoredV2 --id tradeId \\
    --event TradeInitialAccFeesStoredV2.tradeId --finished "{Collateral} == 0" \\
    --formula "Trader=first(TradeInitialAccFeesStoredV2.trader)" --formula "Pair=first(TradeInitialAccFeesStoredV2.pairIndex)" \\
    --formula "Index=first(TradeInitialAccFeesStoredV2.index)" \\
    --formula "Collateral=c; call c=getOpenTrade(address,uint16,uint8).collateral on 0xccd5…66e7 with {Trader}, {Pair}, {Index} decimals 6"
  contract-dev table create "Pools" --on "Pool registry" --each PoolRegistered --id id \\
    --sum "Bribed.amount:Incentives on poolId from Voter incentives token token"
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

/** The flags of the older ways to make a table, each with the word that replaced it (5.0.0): refused where a person types them. */
const OLD_FLAGS: Record<string, string> = {
  opens: '--each <Event> --id <field> (the event that announces a row, and its field that names it)',
  from: '--on table:"<name>" for another table\'s rows, or --each <Event> for a row per event',
  group: '--on tag:<group>',
  contract: '--on <contract>',
  days: '--last <n>d',
};

/** Refuses an older flag by name, saying the word to use. */
export function refuseOldFlags(args: string[], names: string[] = Object.keys(OLD_FLAGS)): void {
  for (const a of args) {
    if (!a.startsWith('--')) continue;
    const name = a.slice(2).split('=')[0];
    if (names.includes(name)) throw new Error(`--${name} is gone: say ${OLD_FLAGS[name]} (contract-dev table help).`);
  }
}

/** `--on <what>` on list and show: a group as tag:<group>, else a contract (name or 0x). */
function onScope(flags: ParsedFlags, what: string, opts: { group: boolean }): Record<string, unknown> {
  const on = flag(flags, 'on');
  if (on === undefined) return {};
  if (on === 'true' || !on.trim()) throw new Error(`--on says which: ${opts.group ? 'tag:<group> or ' : ''}a contract's name or 0x address.`);
  const m = /^(tag|group):\s*(.+)$/i.exec(on.trim());
  const chainId = chainFlag(flags);
  if (m) {
    if (!opts.group) throw new Error(`${what} takes --on <contract>: one contract's rows.`);
    return { group: m[2].trim() };
  }
  if (/^(workspace|all)$/i.test(on.trim())) return {};
  return { contract: on.trim(), ...(chainId != null ? { chainId } : {}) };
}

const scopeInput = (flags: ParsedFlags): Record<string, unknown> => {
  const group = flag(flags, 'group');
  const contract = flag(flags, 'contract');
  const chainId = chainFlag(flags);
  return { ...(group ? { group } : {}), ...(contract ? { contract } : {}), ...(chainId != null && contract ? { chainId } : {}) };
};

/** A table over kept rows, as the saved-queries routes answer it. */
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

/** The table over kept rows a name means: its id, or its whole title (case-insensitive); null when none is called that. */
async function findLive(auth: ReturnType<typeof requireAuth>, ref: string): Promise<LiveTable | null> {
  const all = await liveTables(auth);
  const byId = all.find((t) => t.id === ref);
  if (byId) return byId;
  const byTitle = all.filter((t) => t.title.trim().toLowerCase() === ref.toLowerCase());
  if (byTitle.length > 1) throw new Error(`"${ref}" names ${byTitle.length} tables (${byTitle.map((t) => t.id).join(', ')}); pass the id.`);
  return byTitle[0] ?? null;
}

/** What --rows said until 2026-11-18, and the sentence it is refused with now: a table is made from events. */
const ROWS_GONE =
  '--rows is gone: a table is made from events (--each <Event>), or built on a table that is (--on table:"<name>"). Transactions, transfers, wallets and the other lists the platform keeps are asked with contract-dev query.';

/** `table create "<name>" --on table:"<name>" …` (rewritten to --from): the question asked of that table's rows (or a metric's records) through `query` and kept as a table, asked again while it is open. */
async function createLiveTable(args: string[]): Promise<unknown> {
  const name = args[0];
  if (!name || name.startsWith('--')) throw new Error('Name the table first: contract-dev table create "<name>" --on <what> --each <Event> ….');
  const rest = args.slice(1);
  const at = rest.findIndex((a) => a === '--from' || a.startsWith('--from='));
  const from = (rest[at].startsWith('--from=') ? rest[at].slice('--from='.length) : rest[at + 1] ?? '').trim();
  if (!from || from.startsWith('--')) throw new Error('Say what the rows are: --each <Event> (a row per event), or --on table:"<name>" (another table\'s rows or a metric\'s records: contract-dev table list).');
  const remaining = rest.filter((_, i) => i !== at && !(i === at + 1 && !rest[at].startsWith('--from=')));
  // the table's own words, not the question's: taken out before the rest is asked
  const description = descriptionFlag(parseFlags(remaining));
  const others = withoutFlags(remaining, ['description']);
  const events = from.toLowerCase() === 'events';
  // --keep is the parameters a table of events keeps; --status is a category on either kind of table (over a row's
  // facts where rows are things, a pill over its columns where rows are events, 2026-10-27)
  // --hidden (2026-11-07): off /tables, a report's own, deleted with it
  const hidden = others.includes('--hidden');
  const kept = others.filter((a) => a !== '--hidden');
  for (const f of ['--opens', '--closes', '--formula', '--finished', ...(events ? [] : ['--keep'])])
    if (others.some((a) => a === f || a.startsWith(`${f}=`)))
      throw new Error(`${f === '--opens' ? '--id' : f} is for a table whose rows are things an event announces (--each <Event> --id <field>); a table built on another takes the query's flags (contract-dev query help).`);
  if (events) return createEventsTable(name, kept, description, hidden);
  return queryCommand(['data', from, ...kept], { live: name, ...(description ? { description } : {}), ...(hidden ? { hidden: true } : {}) });
}

/** The flags that say what the rows are (the data kept underneath); every other flag is the question asked of them. */
const EVENTS_DATA_FLAGS = ['event', 'field', 'read', 'fixed', 'pair', 'keep', 'history', 'group', 'contract', 'chain', 'last'];
/** A --where that says which events are kept, not a question over them: "<field> in <Table>" (or in table:"<Table>"). */
const NARROWING = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(?:table:)?\s*["“]?([^"”]+?)["”]?\s*$/i;

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
 * `table create "<name>" --on <what> --each <E> [--field …] [the query's flags]` (rewritten to --from events; 2026-10-27): one step.
 * The events are kept as rows of the table's own (define_data: off the Metrics page, named after the
 * table, deleted with it), then the question is asked of them by id and kept as the table. --where, --by, --measure
 * and the rest are the question, in the table language over the fields; the per-event figures are --field.
 */
async function createEventsTable(name: string, args: string[], description?: string, hidden = false): Promise<unknown> {
  const flags = parseFlags(args);
  for (const k of ['value', 'aggregate', 'unit', 'split', 'line'])
    if (flag(flags, k) !== undefined) throw new Error(`--${k} makes a metric (contract-dev metric define); a table keeps the events as rows and adds them up with --by and --measure.`);
  const definition = definitionFrom(flags);
  // the question's --where is over the rows (the table language); nothing here filters the events as they are kept,
  // except a --where that only says which ones: "<indexed field> in <Table>" (id in Pools) keeps the events whose field
  // is a row id of that item table, and on a contract the workspace does not watch it is all that is read of it
  // (the server's source, 2026-11-17: a contract a whole chain shares, read for one protocol's pools)
  const where = flag(flags, 'where');
  const narrows = typeof where === 'string' && NARROWING.test(where) && !/\b(and|or|not)\b|[<>=!&|()+*/]/i.test(where.replace(NARROWING, '$2'));
  for (const k of ['where', 'split', 'line', 'value', 'aggregate', 'unit']) delete definition[k];
  if (narrows) definition.where = where;
  if (!definition.events) throw new Error('--each names what each row is: contract-dev table create "<name>" --on <what> --each <Event> [--field "vol=usd(amount, token)"] [--by … --measure …].');
  const scope = scopeInput(flags);
  if (!scope.group && !scope.contract) throw new Error('Say whose events: --on <contract> or --on tag:<group>.');
  // --last reaches back over the rows kept, in whole days, and is the question's window too
  const last = lastFlag(flags);
  const days = last === undefined ? undefined : lastDays(last, 'The rows of a table of events');
  if (days !== undefined && definition.history === undefined) definition.history = days;
  // one call (2026-10-30): the rows and the table together, the server keeping nothing when the question is refused
  // (until then this chained define_data and a query, and a failed column check left the rows behind under the name)
  const question = parseFlags(withoutFlags(args, narrows ? [...EVENTS_DATA_FLAGS, 'where'] : EVENTS_DATA_FLAGS));
  const table: Record<string, unknown> = { title: name, ...(description ? { description } : {}), ...(hidden ? { listed: false } : {}), ...clausesFromFlags(question) };
  // the columns a listing shows, in order, and the lines a row opens onto (as contract-dev query takes them)
  const columns = flagAll(question, 'column').flatMap((c) => String(c).split(',')).map((c) => c.trim()).filter(Boolean);
  if (columns.length > 0) table.columns = columns;
  const detail = flagAll(question, 'detail').flatMap((c) => String(c).split(',')).map((c) => c.trim()).filter(Boolean);
  if (detail.length > 0) table.detail = detail;
  if (days !== undefined) table.days = days;
  const r = (await runTool<Record<string, unknown>>(requireAuth(), 'define_data', { name, ...scope, ...definition, table })) as Record<string, unknown> | undefined;
  // never the rows so far (Theo, 2026-10-27): the table is indexing until every row is in
  if (r?.filling) console.log(`Indexing the events in the background; its rows show once every one is in (contract-dev table show "${name}").`);
  const kept = savedLine(r);
  if (kept) console.log(kept);
  return r;
}

async function listTables(args: string[]): Promise<unknown> {
  if (HELP_WORDS.includes(args[0])) return void console.log(HELP);
  refuseOldFlags(args, ['group', 'contract']);
  const flags = parseFlags(args);
  const auth = requireAuth();
  const scope = onScope(flags, 'table list', { group: true });
  const scoped = Object.keys(scope).length > 0;
  // tables over rows the workspace keeps are the workspace's, not a group's: a scoped list is the tables of things alone
  const [result, live] = await Promise.all([runTool<Record<string, unknown>>(auth, 'list_tables', scope), scoped ? Promise.resolve([]) : liveTables(auth)]);
  if (live.length > 0) {
    console.log(`Tables over rows the workspace keeps (${live.length})`);
    for (const line of columnsTable(['Id', 'Name', 'Rows', 'Link', 'Description'], live.map((t) => [t.id, t.title, String(t.rows), t.url, t.description ?? '—']))) console.log(line);
    console.log('');
    // the counts that follow are of the tables of things: said so, since "Tables: 0" under the list above read as a contradiction (2026-10-27)
    console.log('Tables of things inside contracts (one row per id, over its life)');
  }
  for (const line of printResult(result)) console.log(line);
  return live.length > 0 ? { ...result, live } : result;
}

/** A table over kept rows, asked now: the question's own columns first, its window said, and whether it is still filling (2026-10-27); `limit` rows printed (every one with --json). */
async function showLive(auth: ReturnType<typeof requireAuth>, found: LiveTable, limit = 25): Promise<LiveTableView> {
  const { query } = await apiRequest<{ query: LiveTableView }>(auth, 'POST', `/api/mainnet/queries/${found.id}/refresh`, undefined, { timeoutMs: 90_000 });
  const snap = query.snapshot;
  const args = query.args ?? {};
  const days = typeof args.days === 'number' ? args.days : undefined;
  // a table still indexing shows no rows, never the ones so far (Theo, 2026-10-27): its count would read as the answer
  const filling = snap.meta?.filling === true;
  const count = filling ? 'indexing' : `${snap.rows.length} row${snap.rows.length === 1 ? '' : 's'}${snap.matched > snap.rows.length ? ` of ${snap.matched}` : ''}`;
  console.log(`${query.title} · ${count}${days ? ` · last ${days} day${days === 1 ? '' : 's'}` : ''} · ${query.url}`);
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
  refuseOldFlags(args, ['group', 'contract']);
  const flags = parseFlags(args);
  const table = (flags._ as string[]).join(' ').trim();
  if (!table) throw new Error('Name the table (contract-dev table list shows them).');
  const auth = requireAuth();
  const live = await findLive(auth, table);
  if (live) return showLive(auth, live, flag(flags, 'limit') !== undefined ? limitFlag(flags, 1, 5_000) : 25);
  // --on <contract>: one contract's rows of the table
  const input: Record<string, unknown> = { table, ...onScope(flags, 'table show', { group: false }) };
  for (const key of ['row', 'by', 'since', 'column', 'among'] as const) {
    const v = flag(flags, key);
    if (v !== undefined) input[key] = v;
  }
  // the old words for the rows still read: open → active, closed → done
  if (input.among === 'open') input.among = 'active';
  if (input.among === 'closed') input.among = 'done';
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 5, 25);
  // --row <id|name> --last 30d: how the row's number columns moved over those days; --series adds every day's value
  const last = lastFlag(flags);
  if (last !== undefined) {
    if (input.row === undefined) throw new Error('--last reads one row over time: contract-dev table show <table> --row <id or name> --last 30d.');
    input.days = lastDays(last, 'A row\'s history');
    if (flag(flags, 'series') !== undefined) input.series = true;
  } else if (flag(flags, 'series') !== undefined) throw new Error('--series goes with --row and --last: contract-dev table show <table> --row <id or name> --last 30d --series.');
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
    console.log(`Deleted table "${live.title}" (${live.id}); rows it kept for itself went with it.`);
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

function tokenRef(value: string, what: string, orField = false): string {
  if (!TOKEN_REF.test(value))
    throw new Error(`${what}: a token is its 0x address, self (the contract itself), ${orField ? "a view with no arguments that returns its address, like asset(), or one of the event's own fields, like token" : 'or a view with no arguments that returns its address, like asset()'} (got: ${value})`);
  return value;
}

function showOf(value: string, what: string): 'token' | 'usd' {
  if (value !== 'usd' && value !== 'token') throw new Error(`${what}: show is usd or token (got: ${value})`);
  return value;
}

/** A token named by one of the event's own fields (a bare name, or a struct's member): `token token`, `token swapInfo.fromToken`. */
const TOKEN_FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** What may follow `Event[.field][:Label]` on a --count or --sum, each said once, in any order. */
export interface ColumnClauses {
  rest: string;
  /** The event's field that holds the row id, stated when more than one could. */
  on?: string;
  /** The contract that emits the event when it is not the row's own: a watched contract's name or 0x address. */
  from?: string;
  /** The event's field the column is split by; a row then opens onto its parts. */
  by?: string;
  /** Only the events whose field equals one of the row's columns, as written: `epoch == {Next epoch}`. */
  where?: string;
  token?: string;
  show?: 'token' | 'usd';
  decimals?: number;
  /** Over a window back from now in place of the whole history: `last 7d`, `last 24h`, `last 2w`. */
  last?: string;
}

const CLAUSE_WORDS = ['on', 'from', 'by', 'token', 'show', 'decimals', 'last'] as const;
type ClauseWord = (typeof CLAUSE_WORDS)[number];

/**
 * The clauses at the end of a --count or --sum (5.0.0): `on <field>`, `from <contract>`, `by <field>`,
 * `token <ref>`, `show token|usd`, `decimals <n>`, read from the last keyword backwards, since a contract's name
 * may be several words (`from Voter incentives`). A name that holds a clause word goes in quotes
 * (`from "Fee on transfer"`). The keywords are lower case, so a label that says Token is a label. `allowed` are
 * the clauses the flag takes.
 */
export function columnClauses(whole: string, what: string, allowed: readonly ClauseWord[] = CLAUSE_WORDS): ColumnClauses {
  let rest = whole.trim();
  const out: Omit<ColumnClauses, 'rest'> = {};
  const said = (word: ClauseWord) => {
    if ((out as Record<string, unknown>)[word] !== undefined) throw new Error(`${what}: "${word}" is said once.`);
  };
  // where <field> == {Column} first, wherever it stands: the column's name is in braces, so its words are never read as clauses
  const filtered = /(^|\s)where\s+([A-Za-z_][A-Za-z0-9_]*\s*==\s*\{[^}]+\})(?=\s|$)/.exec(rest);
  if (filtered) {
    out.where = filtered[2].trim();
    rest = `${rest.slice(0, filtered.index)} ${rest.slice(filtered.index + filtered[0].length)}`.trim();
  } else if (/(^|\s)where\s/.test(rest)) throw new Error(`${what}: where reads "<field> == {Column}": one of the event's number fields and a column of the row it must equal, like where epoch == {Next epoch}.`);
  // a quoted name next: from "…" or from '…' wherever it stands, so the words inside it are never read as clauses
  const quoted = /(^|\s)from\s+(["'])(.+?)\2(?=\s|$)/.exec(rest);
  if (quoted && allowed.includes('from')) {
    out.from = quoted[3].trim();
    rest = `${rest.slice(0, quoted.index)} ${rest.slice(quoted.index + quoted[0].length)}`.trim();
  }
  for (;;) {
    // greedy: the last keyword that has something after it
    const m = new RegExp(`^(.*)\\s+(${allowed.join('|')})\\s+(.+)$`, 's').exec(rest);
    if (!m) break;
    const word = m[2] as ClauseWord;
    const value = m[3].trim();
    if (word !== 'from' && /\s/.test(value)) throw new Error(`${what}: after "${word}" comes one word (got: ${value}). A contract's name with a clause word in it goes in quotes: from "Fee on transfer".`);
    said(word);
    if (word === 'on' || word === 'by') {
      // by may join several fields, comma-separated with no spaces: by tickLower,tickUpper (one part per price range)
      const ok = word === 'by' ? /^[A-Za-z_][A-Za-z0-9_]*(,[A-Za-z_][A-Za-z0-9_]*){0,3}$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
      if (!ok.test(value)) throw new Error(`${what}: ${word} takes ${word === 'by' ? 'one of the event\'s fields, or up to four joined by commas,' : 'one of the event\'s fields,'} like ${word} ${word === 'on' ? 'expiry' : 'token or by tickLower,tickUpper'} (got: ${value})`);
      out[word] = value;
    } else if (word === 'from') out.from = value;
    else if (word === 'token') out.token = TOKEN_FIELD.test(value) && value !== 'self' ? value : tokenRef(value, what, true);
    else if (word === 'show') out.show = showOf(value, what);
    else if (word === 'last') {
      if (!/^\d+[hdw]$/.test(value)) throw new Error(`${what}: last takes a window like 24h, 7d or 2w (got: ${value}).`);
      out.last = value;
    } else {
      const d = Number(value);
      if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error(`${what}: decimals is 0 to 36 (got: ${value})`);
      out.decimals = d;
    }
    rest = m[1];
  }
  if (out.token && out.decimals !== undefined) throw new Error(`${what}: a token brings its own decimals; give one or the other.`);
  if (out.show && !out.token) throw new Error(`${what}: show needs a token.`);
  return { rest, ...out };
}

/**
 * `--count "WithdrawalQueued:Queued on expiry"` and `--sum "WithdrawalQueued.normalizedAmount:Queued amount token asset()"`
 * as the tool's columns. From another contract, matched on the row's id: `--count "Bribed:Incentives on poolId from
 * Voter incentives"`. Split by a field, the row opening onto its parts: `… by token`. In the token the event's own
 * field names, totalled in dollars: `--sum "Bribed.amount:Incentives on poolId from Voter incentives token token"`.
 */
export function columnsFrom(flags: ParsedFlags): Record<string, unknown>[] {
  const split = (raw: string): [string, string | null] => {
    const at = raw.indexOf(':');
    return at > 0 ? [raw.slice(0, at).trim(), raw.slice(at + 1).trim() || null] : [raw.trim(), null];
  };
  const out: Record<string, unknown>[] = [];
  // from table:"Swaps": the rows of a table of events, added up per row over a window; nothing here names an event
  const fromTable = (from: string | undefined): boolean => /^table:/i.test(from ?? '');
  const windowOnly = (what: string, by: unknown, where: unknown, last: string | undefined, from: string | undefined) => {
    if (last && (by || where)) throw new Error(`${what}: a column over a window (last ${last}) takes no by or where.`);
    if (fromTable(from) && !last) throw new Error(`${what}: from table: adds up a table's rows over a window; say last 7d (or 24h, 30d).`);
  };
  for (const whole of flagAll(flags, 'count')) {
    const { rest: raw, on, from, by, where, last } = columnClauses(whole, '--count', ['on', 'from', 'by', 'last']);
    windowOnly('--count', by, where, last, from);
    if (fromTable(from)) {
      // --count 'Swaps 7d from table:"Swaps" last 7d': what stands first is the column's label
      const label = raw.replace(/^:/, '').trim();
      if (!label) throw new Error('--count from a table takes the column\'s label first: --count \'Swaps 7d from table:"Swaps" last 7d\'.');
      out.push({ label, fold: 'count', from, last, ...(on ? { on } : {}) });
      continue;
    }
    const [event, label] = split(raw);
    if (!event) throw new Error('--count takes an event name, like --count WithdrawalQueued.');
    out.push({ label: label ?? `${event} count`, event, fold: 'count', ...(on ? { on } : {}), ...(from ? { from } : {}), ...(by ? { by } : {}), ...(where ? { where } : {}), ...(last ? { last } : {}) });
  }
  for (const whole of flagAll(flags, 'sum')) {
    // `… token asset() show usd` or `… decimals 18`: what the amount is, only as stated; left out, the plain number
    const { rest, on, from, by, where, last, ...amount } = columnClauses(whole, '--sum');
    windowOnly('--sum', by, where, last, from);
    const [ref, label] = split(rest);
    if (fromTable(from)) {
      // --sum 'feeusd:Fees 7d from table:"Swaps" last 7d': one of that table's columns, added up per row
      if (!ref || ref.includes('.')) throw new Error('--sum from a table takes one of its columns: --sum \'feeusd:Fees 7d from table:"Swaps" last 7d\'.');
      out.push({ label: label ?? ref, field: ref, fold: 'sum', from, last, ...(on ? { on } : {}) });
      continue;
    }
    const dot = ref.lastIndexOf('.');
    if (dot <= 0 || dot === ref.length - 1) throw new Error('--sum takes Event.field, like --sum WithdrawalQueued.normalizedAmount.');
    out.push({ label: label ?? `${ref.slice(dot + 1)}`, event: ref.slice(0, dot), field: ref.slice(dot + 1), fold: 'sum', ...(on ? { on } : {}), ...(from ? { from } : {}), ...(by ? { by } : {}), ...(where ? { where } : {}), ...(last ? { last } : {}), ...amount });
  }
  return out;
}

/** The arguments inside a call's parentheses, split on the commas at its own depth. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * `--column "Owed=accountDebt(id())"` on a state table: a view read on each open row (2026-11-08; the
 * help's own example was dropped without a word before). The view by name, its arguments in order:
 * id() where the row id goes, {Label} for a cell of the row, self, or a literal. After the call, in
 * any order: `.<output>` (which output of several), `; on 0x…` (read on another contract),
 * `; token <token> [; show usd]` or `; decimals <n>`.
 */
export function readColumnsFrom(flags: ParsedFlags): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of flagAll(flags, 'column')) {
    if (raw === 'true') throw new Error('--column needs Label=view(args): --column "Owed=accountDebt(id())".');
    const eq = raw.indexOf('=');
    const label = eq > 0 ? raw.slice(0, eq).trim() : '';
    const [call = '', ...more] = (eq > 0 ? raw.slice(eq + 1) : '').split(';').map((x) => x.trim());
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)(?:\.([A-Za-z_][A-Za-z0-9_]*))?$/s.exec(call);
    if (!label || !m) throw new Error(`--column on a state table is a view read on each open row, Label=view(args): --column "Owed=accountDebt(id())" (got: ${raw}). A fold of an event is --sum or --count; a sum of columns is --formula.`);
    const col: Record<string, unknown> = { label, read: m[1] };
    const args = splitArgs(m[2]);
    if (args.length > 0) col.args = args.map((a) => (a === 'id()' ? ':id' : a));
    if (m[3]) col.output = m[3];
    for (const part of more.filter(Boolean)) {
      // on {Token 0}: a column's label may hold spaces, so the braces are read whole
      const w = /^(on)\s+(\{[^{}]+\})$/.exec(part) ?? /^(on|token|show|decimals|unit)\s+(\S+)$/.exec(part);
      if (!w) throw new Error(`--column: after the call come "; on 0x… | {Column} | id()", "; token <token>", "; show usd", "; decimals <n>" or "; unit <unit>" (got: ${part})`);
      if (w[1] === 'on') {
        // where the read goes: one contract for every row (0x…), the address a row holds ({Hook}), or the row's id itself
        if (/^0x[0-9a-fA-F]{40}$/.test(w[2])) col.target = w[2].toLowerCase();
        else if (w[2] === 'id()' || /^\{[^{}]+\}$/.test(w[2])) col.target = w[2];
        else throw new Error(`--column: on takes a contract's 0x address, a column of the row in braces ({Hook}), or id() where the row id is an address (got: ${w[2]}).`);
      } else if (w[1] === 'token') col.token = tokenRef(w[2], '--column');
      else if (w[1] === 'show') col.show = showOf(w[2], '--column');
      else if (w[1] === 'decimals') {
        const n = Number(w[2]);
        if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error(`--column: decimals is a whole number from 0 to 36 (got: ${w[2]}).`);
        col.decimals = n;
      } else col.unit = w[2];
    }
    if (col.show && !col.token) throw new Error('--column: show needs a token.');
    out.push(col);
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
  // the one grammar: the older flags are refused as typed, then the words are handed on in the shapes the tools take
  refuseOldFlags(args);
  args = rewriteTableArgs(args);
  if (args.some((a) => a === '--from' || a.startsWith('--from='))) return createLiveTable(args);
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'name');
  const opens = flag(flags, 'opens');
  if (!opens) throw new Error('Say what a row is: --each <Event> for a row per event (swaps, deposits; with --id <field>, a row per thing the event announces, read live over its life), or --on table:"<name>" to build on another table (contract-dev table help).');
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
  const columns = [...columnsFrom(flags), ...readColumnsFrom(flags)];
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
  const foundLabel = foundLabelFlag(flags);
  if (foundLabel) input.foundLabel = foundLabel;
  const rowName = rowNameFlag(flags);
  if (rowName) input.rowName = rowName;
  const detail = detailFlag(flags);
  if (detail?.length) input.detail = detail;
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
  // a table over kept rows is renamed or described through its own route; every other flag is for a table of things
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
  const foundLabel = foundLabelFlag(flags, true);
  const rowName = rowNameFlag(flags, true);
  const detail = detailFlag(flags, true);
  // --count and --sum add event columns to a table that has rows already (2026-11-17), as table create takes them
  // and --column adds a read on each row (2026-11-19), on the row's own contract, another, or an address the row holds
  const columns = [...columnsFrom(flags), ...readColumnsFrom(flags)];
  if (show && hide) throw new Error('Pick one: --show or --hide.');
  if (!name && description === undefined && !show && !hide && finished === undefined && !never && statuses.length === 0 && formulas.length === 0 && tokens.length === 0 && events.length === 0 && columns.length === 0 && foundLabel === undefined && rowName === undefined && detail === undefined)
    throw new Error('Nothing to change: pass --name "<name>", --description "<sentence>", --column …, --count …, --sum …, --status …, --formula …, --token …, --finished "<rule>", --never-finishes, --found-label "<word>", --row-name "<template>", --detail "<columns>", --show or --hide.');
  const input: Record<string, unknown> = {
    table,
    ...(name ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(formulas.length > 0 ? { formulas } : {}),
    ...(columns.length > 0 ? { columns } : {}),
    ...(tokens.length > 0 ? { tokens } : {}),
    ...(events.length > 0 ? { events } : {}),
    ...(finished !== undefined ? { finished } : never ? { finished: '' } : {}),
    ...(show ? { listed: true } : hide ? { listed: false } : {}),
    ...(foundLabel !== undefined ? { foundLabel } : {}),
    ...(rowName !== undefined ? { rowName } : {}),
    ...(detail !== undefined ? { detail } : {}),
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

/**
 * --detail "<Column>, <Column>…" (repeatable): the columns shown on a row's own page and not in the table, by label;
 * on update "" puts every column back in the table.
 */
function detailFlag(flags: ParsedFlags, emptyClears = false): string[] | undefined {
  const all = flagAll(flags, 'detail');
  if (all.length === 0) return undefined;
  if (all.some((v) => v === 'true')) throw new Error('--detail names columns by label: --detail "Hook, Token 0, Token 1"' + (emptyClears ? ', or --detail "" to put every column back in the table.' : '.'));
  const names = all.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
  if (names.length === 0) {
    if (emptyClears) return [];
    throw new Error('--detail names columns by label, like "Hook, Token 0, Token 1".');
  }
  if (names.length > 40) throw new Error(`--detail holds 40 columns (got ${names.length}).`);
  return names;
}

/** --row-name "<template>": what a row is called, over the table's columns in braces ("{Token 0} / {Token 1}"); on update "" goes back to the id. */
function rowNameFlag(flags: ParsedFlags, emptyClears = false): string | undefined {
  const raw = flag(flags, 'row-name');
  if (raw === undefined) return undefined;
  if (raw === 'true') throw new Error('--row-name takes a template over the table\'s columns: --row-name "{Token 0} / {Token 1}"' + (emptyClears ? ', or --row-name "" to go back to the id.' : '.'));
  const text = raw.trim();
  if (!text) {
    if (emptyClears) return '';
    throw new Error('--row-name takes a template, like "{Token 0} / {Token 1}".');
  }
  if (!/\{[^{}]+\}/.test(text)) throw new Error('--row-name names at least one column in braces, like "{Token 0} / {Token 1}".');
  if (text.length > 80) throw new Error(`--row-name holds 80 characters (got ${text.length}).`);
  return text;
}

/** --found-label "<word>": the header of the column saying when a row was found ("Registered"); on update "" goes back to the event's own word. */
function foundLabelFlag(flags: ParsedFlags, emptyClears = false): string | undefined {
  const raw = flag(flags, 'found-label');
  if (raw === undefined) return undefined;
  if (raw === 'true') throw new Error('--found-label takes a word for when each row was found: --found-label "Registered"' + (emptyClears ? ', or --found-label "" for the event\'s own word.' : '.'));
  const text = raw.trim();
  if (!text && !emptyClears) throw new Error('--found-label takes a word, like "Registered".');
  if (text.length > 24) throw new Error(`--found-label holds 24 characters (got ${text.length}).`);
  return text;
}

/** The table over kept rows `ref` names, unless a table of things answers to it first (as table delete reads a name). */
async function liveFor(auth: ReturnType<typeof requireAuth>, ref: string): Promise<LiveTable | null> {
  const listed = await runTool<{ rows?: Array<{ id: string; name: string }> }>(auth, 'list_tables', {});
  const rows = listed.rows ?? [];
  if (rows.some((t) => t.id === ref || t.name.trim().toLowerCase() === ref.toLowerCase())) return null;
  return findLive(auth, ref);
}

/** `table update <table> [--name …] [--description …]` on a table over kept rows: the two things its own route changes. */
async function updateLive(auth: ReturnType<typeof requireAuth>, live: LiveTable, name: string | undefined, description: string | undefined): Promise<unknown> {
  const { query } = await apiRequest<{ query: LiveTable }>(auth, 'PATCH', `/api/mainnet/queries/${live.id}`, { ...(name ? { title: name } : {}), ...(description !== undefined ? { description } : {}) });
  console.log(`Updated table "${query.title}" (${query.id})${query.description ? `: ${query.description}` : description === '' ? ': description removed' : ''}`);
  return query;
}

/**
 * The one grammar's words in the shapes the tools underneath take: --on and --each (2026-11-07; --rows until 2026-11-18). The words it
 * writes (--group, --contract, --opens, --event, --from) are internal since 5.0.0: typed, they are refused first
 * (refuseOldFlags).
 */
export function rewriteTableArgs(args: string[]): string[] {
  const out: string[] = [];
  const has = (f: string) => args.some((a) => a === `--${f}` || a.startsWith(`--${f}=`));
  // the words only a table of things takes. --status is both kinds' pill and --column both kinds' column, so neither
  // decides alone (2026-11-09: `--each Swap --status …` or `--column trader` made a table of things out of swaps,
  // silently); a --column that reads something, "Owed=accountDebt(id())", is one's
  // --count and --sum are its event columns, and with --by the measure a table of events folds by
  const stateWords = ['id', 'finished', 'closes', 'closes-on', 'formula', 'id-shown', 'found-label', 'row-name', ...(has('by') ? [] : ['count', 'sum'])];
  const values = (f: string) => args.flatMap((a, i) => (a === `--${f}` ? [args[i + 1] ?? ''] : a.startsWith(`--${f}=`) ? [a.slice(f.length + 3)] : []));
  const state = stateWords.some(has) || values('column').some((v) => v.includes('='));
  let each: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith('--') ? a.slice(2).split('=')[0] : null;
    // `--on value` and `--on=value` alike
    const v = (): string | undefined => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i]);
    if (name === 'on') {
      const w = v();
      if (w === undefined || w.startsWith('--')) throw new Error('--on says what the table is on: a contract or wallet, tag:<group>, workspace, or table:"<other>".');
      const m = /^(tag|group|table):\s*(.+)$/i.exec(w);
      if (/^(workspace|all)$/i.test(w)) continue;
      if (m && m[1].toLowerCase() === 'table') out.push('--from', m[2].trim().replace(/^"(.*)"$/, '$1'));
      else if (m) out.push('--group', m[2].trim());
      else out.push('--contract', w);
    } else if (name === 'each') {
      const w = v();
      if (w === undefined || w.startsWith('--')) throw new Error('--each names the event a row is: --each Swap.');
      if (state && !each) {
        each = w;
        out.push('--opens', w);
      } else out.push('--event', w);
    } else if (name === 'rows') {
      throw new Error(ROWS_GONE);
    } else out.push(a);
  }
  const built = out.includes('--from');
  if (has('each') && built) throw new Error('A table built on another (--on table:"<name>") takes its rows from it: leave --each out and ask with --where, --by, --measure.');
  // a row per event: --each alone
  if (has('each') && !state) out.push('--from', 'events');
  return out;
}

/** The table a create answered with: one over kept rows (the query's save, or define_data's table: store live) or one of things (create_table: store item). */
export function savedTable(result: unknown): { id: string; store: 'live' | 'item' } | null {
  const o = (result ?? {}) as { saved?: { id?: unknown }; table?: { saved?: { id?: unknown }; id?: unknown } };
  const live = o.saved?.id ?? o.table?.saved?.id;
  if (typeof live === 'string') return { id: live, store: 'live' };
  return typeof o.table?.id === 'string' ? { id: o.table.id, store: 'item' } : null;
}
