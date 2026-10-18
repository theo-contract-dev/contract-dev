// `contract-dev query <noun> …` — one command over every dataset the platform keeps, named as the
// app's pages name them: contracts, a table, a metric, monitors, alerts, reports. The clauses are the
// same for all of them (where, show, sort, by with a measure, total, limit) and are the server's
// query_* tools' arguments one to one, so an agent reading this and the Slack assistant speak the
// same language. Prints the rows as a table; --json hands back the tool's own result.
import { parseFlags, flag, flagAll, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { columnsTable, cell } from './_print';

const HELP = `contract-dev query — ask one dataset a question, in the table language

Usage:
  contract-dev query contracts [--group <g>] [--chain <id>] [--kind pool|vault|token|…]   The watched contracts, with a group's columns
      [--read <name>=<view()> [in <token>] [as usd|amount]]…   A figure read on every contract now: --read cov="coverageLiquidity() in asset()"
      [--read <name>=<expression>]…                            …or an expression over earlier reads and the group's columns
  contract-dev query table "<name>" [--among active|done|all]                             One table's rows (active by default)
  contract-dev query metric "<name>" [--days <n>]                                         What is behind a metric: its records or readings
  contract-dev query monitors · query alerts [--days <n>] · query reports
  contract-dev query transactions [--group <g> | --contract <c>] [--days <n>] [--signer <0x>] [--failed] [--direct | --routed] [--method <name>]
                                                                                          The transactions that reached the contracts (or a watched wallet sent and received), newest first
  contract-dev query transfers [--group <g> | --contract <c>] [--days <n>] [--in | --out] [--token <symbol|0x|native>] [--counterparty <0x>] [--signer <0x>]
                                                                                          What moved in and out of them, each leg priced on its day
  contract-dev query wallets [--group <g> | --contract <c>] [--days <n>] [--signer <0x>]    The wallets behind them: new or returning, first and last seen, dollars in and out
      [--before <time>]   transactions and transfers page further back: the window counted back from this time (the answer's "next" gives it)
      A --by over a stored column (day, contract, wallet, counterparty, token, method, status, via) with --count, --sum "{Value}" or --sum "{USD}"
      is folded in the database over the whole window, exact at any size.

--contract takes a watched contract or a watched wallet (its name or address): a wallet's transactions are the ones it
sent and received, its transfers the legs naming it. --signer keeps one address's own transactions within the scope.

Clauses (any dataset; columns by label in braces or by key):
  --where "<expr>"              Keep the rows this holds for:        --where "{Held} < {Required}"
  --show <name>="<expr>"        A worked-out column, usable below:   --show headroom="{Held} - {Required}"  (repeat for more)
  --sort "<expr>" [--asc]       Rank the rows, largest first
  --by <a,b> --sum|--avg|--min|--max "<expr>" | --count     Fold the rows into groups, one value each
  --total <a,b>                 Add these columns up over every matching row
  --limit <n>                   Rows or groups to print (default 25; the answer says how many matched)
  --json                        The tool's own result

Examples:
  contract-dev query contracts --group "Wildcat markets" --show headroom="{Held} - {Required}" --where "headroom < 0" --sort headroom --asc
  contract-dev query contracts --group "Wildcat markets" --by kind --sum "{Supplied}"
  contract-dev query contracts --group "Wildcat markets" --read cov="coverageLiquidity() in asset()" --read held="totalAssets() in asset()" --read gap="held - cov" --sort gap --asc
  contract-dev query table "Withdrawal rounds" --where '{Stage} == "Paying" and age > 7d' --sort "{Outstanding}"
  contract-dev query metric Deposits --days 30 --by day --sum "{value}"
  contract-dev query monitors --where '{State} == "breached"'
  contract-dev query alerts --days 30 --by monitor --count
  contract-dev query transactions --group "Wildcat markets" --days 30 --by day --count
  contract-dev query transactions --signer 0x1234…abcd --days 90
  contract-dev query transfers --contract Treasury --out --days 30 --by counterparty --sum "{USD}"
  contract-dev query transfers --group "Wildcat markets" --out --by counterparty --sum "{USD}" --limit 10
  contract-dev query wallets --group "Wildcat markets" --days 7 --where '{Status} == "new"'
`;

const DATASETS = ['contracts', 'table', 'metric', 'monitors', 'alerts', 'reports', 'transactions', 'transfers', 'wallets'] as const;
const ACTIVITY: readonly string[] = ['transactions', 'transfers', 'wallets'];
type Dataset = (typeof DATASETS)[number];
const MEASURES = ['sum', 'avg', 'min', 'max'] as const;

const COLUMNS_SHOWN = 8;

/** A unix time prints as a date and time; everything else as the server sent it. */
const shown_ = (v: unknown, unit: string | undefined): unknown => (unit === 'time' && typeof v === 'number' ? new Date(v * 1000).toISOString().slice(0, 16).replace('T', ' ') : v);

/** The rows as one table: the name first, then the columns the clauses name, then the rest, at most eight across. */
function printRows(rows: Record<string, unknown>[], columns: { key: string; label: string; unit?: string }[], named: string[]): void {
  if (rows.length === 0) return;
  const keys = columns.map((c) => c.key);
  const wanted = (ref: string): string | null => {
    const r = ref.trim().replace(/^\{|\}$/g, '').toLowerCase();
    return columns.find((c) => c.key === r)?.key ?? columns.find((c) => c.label.toLowerCase() === r)?.key ?? null;
  };
  const order: string[] = [];
  const push = (k: string | null) => {
    if (k && keys.includes(k) && !order.includes(k)) order.push(k);
  };
  push(columns.find((c) => c.key === 'name')?.key ?? null);
  for (const n of named) for (const m of n.match(/\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*/g) ?? []) push(wanted(m));
  for (const k of keys) push(k);
  const shown = order.slice(0, COLUMNS_SHOWN);
  const header = shown.map((k) => columns.find((c) => c.key === k)?.label ?? k);
  const unitOf = new Map(columns.map((c) => [c.key, c.unit]));
  for (const line of columnsTable(header, rows.map((r) => shown.map((k) => cell(shown_(r[k], unitOf.get(k))))))) console.log(line);
  if (keys.length > shown.length) console.log(`(${keys.length - shown.length} more column${keys.length - shown.length === 1 ? '' : 's'}: --json for all)`);
}

const wordFlag = (flags: ParsedFlags, name: string): string | undefined => {
  const v = flag(flags, name);
  if (v === 'true') throw new Error(`--${name} needs a value`);
  return v;
};
const listFlag = (flags: ParsedFlags, name: string): string[] | undefined => {
  const v = wordFlag(flags, name);
  return v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);
};

/** The clauses as the server's query_* tools take them. */
export function clausesFromFlags(flags: ParsedFlags): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const where = wordFlag(flags, 'where');
  if (where) input.where = where;
  const shows = flagAll(flags, 'show');
  if (shows.length > 0) {
    input.show = shows.map((s) => {
      const i = s.indexOf('=');
      if (i <= 0) throw new Error(`--show takes name=expression, like --show headroom="{Held} - {Required}"; got "${s}"`);
      return { name: s.slice(0, i).trim(), expr: s.slice(i + 1).trim() };
    });
  }
  const sort = wordFlag(flags, 'sort');
  if (sort) input.sort = sort;
  if (flag(flags, 'asc') === 'true') input.asc = true;
  const by = listFlag(flags, 'by');
  if (by && by.length > 0) input.by = by;
  const measures = MEASURES.filter((m) => flag(flags, m) !== undefined);
  const count = flag(flags, 'count') === 'true';
  if (measures.length + (count ? 1 : 0) > 1) throw new Error('Pick one measure: --sum, --avg, --min, --max or --count.');
  if (measures.length === 1) {
    const expr = wordFlag(flags, measures[0]);
    if (!expr) throw new Error(`--${measures[0]} needs an expression`);
    input.measure = { fn: measures[0], expr };
  } else if (count) input.measure = { fn: 'count' };
  if ((measures.length > 0 || count) && !by) throw new Error('A measure folds groups: say --by <column> too.');
  const total = listFlag(flags, 'total');
  if (total && total.length > 0) input.total = total;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 25, 200);
  return input;
}

export async function queryCommand(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const noun = positional[0] as Dataset | undefined;
  if (!noun || !(DATASETS as readonly string[]).includes(noun)) throw new Error(`Say which dataset: ${DATASETS.join(', ')} (try: contract-dev query help).`);
  const input = clausesFromFlags(flags);
  const name = positional.slice(1).join(' ').trim();
  if (noun === 'table' || noun === 'metric') {
    if (!name) throw new Error(`Name the ${noun}: contract-dev query ${noun} "<name>".`);
    input[noun] = name;
  } else if (name) throw new Error(`query ${noun} takes no name; scope it with the flags (try: contract-dev query help).`);
  if (noun === 'contracts') {
    const group = wordFlag(flags, 'group');
    if (group) input.group = group;
    const chainId = chainFlag(flags);
    if (chainId !== undefined) input.chainId = chainId;
    const kind = wordFlag(flags, 'kind');
    if (kind) input.kind = kind;
    const reads = flagAll(flags, 'read').map((raw) => {
      const m = raw.match(/^([A-Za-z_]\w*)\s*=\s*(.+?)(?:\s+in\s+(\S+))?(?:\s+as\s+(usd|amount))?\s*$/);
      if (!m) throw new Error(`--read takes name=<view()> [in <token>] [as usd|amount], or name=<expression>; got "${raw}"`);
      const [, name, body, token, show] = m;
      const isCall = /^[A-Za-z_]\w*\(.*\)$/.test(body) && !/^(usd|amount|price|min|max|abs|round|floor|ceil|if|len|sum|indexOf|contains|keccak|now)\s*\(/.test(body);
      if (!isCall && (token || show)) throw new Error(`--read ${name}: "in <token>" and "as" go with a view, not an expression`);
      return isCall ? { name, call: body, ...(token ? { token } : {}), ...(show ? { show } : {}) } : { name, expr: body };
    });
    if (reads.length > 0) input.reads = reads;
  }
  if (noun === 'table') {
    const among = wordFlag(flags, 'among');
    if (among) input.among = among;
  }
  if (ACTIVITY.includes(noun)) {
    const group = wordFlag(flags, 'group');
    if (group) input.group = group;
    const contract = wordFlag(flags, 'contract');
    if (contract) input.contract = contract;
    const chainId = chainFlag(flags);
    if (chainId !== undefined) input.chainId = chainId;
    if (flag(flags, 'wallet') !== undefined) throw new Error('--wallet is now --signer (one address\'s own transactions); a watched wallet is --contract <name|address>.');
    const signer = wordFlag(flags, 'signer');
    if (signer) input.signer = signer;
    const before = wordFlag(flags, 'before');
    if (before && noun !== 'wallets') input.before = before;
    if (noun === 'transactions') {
      if (flag(flags, 'failed') === 'true') input.failed = true;
      if (flag(flags, 'direct') === 'true' && flag(flags, 'routed') === 'true') throw new Error('Pick --direct or --routed, not both.');
      if (flag(flags, 'direct') === 'true') input.direct = true;
      if (flag(flags, 'routed') === 'true') input.direct = false;
      const method = wordFlag(flags, 'method');
      if (method) input.method = method;
    }
    if (noun === 'transfers') {
      if (flag(flags, 'in') === 'true' && flag(flags, 'out') === 'true') throw new Error('Pick --in or --out, not both.');
      if (flag(flags, 'in') === 'true') input.direction = 'in';
      if (flag(flags, 'out') === 'true') input.direction = 'out';
      const token = wordFlag(flags, 'token');
      if (token) input.token = token;
      const counterparty = wordFlag(flags, 'counterparty');
      if (counterparty) input.counterparty = counterparty;
    }
  }
  if (noun === 'metric' || noun === 'alerts' || ACTIVITY.includes(noun)) {
    const days = wordFlag(flags, 'days');
    if (days !== undefined) {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1) throw new Error('--days takes a whole number of days');
      input.days = n;
    }
  }
  const r = (await runTool(requireAuth(), `query_${noun}`, input)) as Record<string, unknown>;
  const matched = Number(r.matched ?? 0);
  const returned = Number(r.returned ?? 0);
  const grouped = r.grouped as { by: string[]; measure: string } | undefined;
  const head = grouped ? `${matched} group${matched === 1 ? '' : 's'} by ${grouped.by.join(', ')} · ${grouped.measure}` : `${matched} row${matched === 1 ? '' : 's'} matched`;
  console.log(`${head}${returned < matched ? ` · showing ${returned}` : ''}`);
  const { rows, columns, totals, ...rest } = r as { rows?: Record<string, unknown>[]; columns?: { key: string; label: string; unit?: string }[]; totals?: Record<string, number | null> } & Record<string, unknown>;
  const named = [...((input.reads as { name: string }[] | undefined)?.map((r) => r.name) ?? []), input.sort, input.where, ...((input.show as { name: string; expr: string }[] | undefined)?.flatMap((x) => [x.name, x.expr]) ?? []), ...((input.by as string[] | undefined) ?? []), ...((input.total as string[] | undefined) ?? [])].filter((x): x is string => typeof x === 'string');
  printRows(rows ?? [], columns ?? [], named);
  if (totals) console.log(`Totals: ${Object.entries(totals).map(([k, v]) => `${k} ${v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`).join(' · ')}`);
  const counts = rest.active as { now: number; before: number } | undefined;
  const fresh = rest.new as { now: number; before: number } | undefined;
  if (counts && fresh) console.log(`Active ${counts.now} (the window before: ${counts.before}) · New ${fresh.now} (before: ${fresh.before})`);
  const note = ['readFrom', 'readings', 'among'].map((k) => rest[k]).filter(Boolean);
  if (note.length > 0) console.log(note.join(' · '));
  for (const n of (rest.notes as string[] | undefined) ?? []) console.log(n);
  const next = rest.next as { before?: string } | undefined;
  if (next?.before) console.log(`More: --before ${next.before}`);
  return r;
}

export default queryCommand;
