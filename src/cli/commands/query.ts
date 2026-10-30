// `contract-dev query <noun> …` — one command over every dataset the platform keeps, named as the
// app's pages name them: contracts, a table, a metric, monitors, alerts, reports. The clauses are the
// same for all of them (where, show, sort, by with a measure, total, limit) and are the server's
// query_* tools' arguments one to one, so an agent reading this and the Slack assistant speak the
// same language. Prints the rows as a table; --json hands back the tool's own result.
import { parseFlags, flag, flagAll, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { cell, columnsTable, byUnit, partCells, type BreakdownColumn, coverageLine } from './_print';
import { statusesFrom } from './_status';
import { parseRead } from './eventMetric';

const HELP = `contract-dev query — ask one dataset a question, in the table language

Usage:
  contract-dev query contracts [--group <g>] [--chain <id>] [--kind pool|vault|token|…]   The watched contracts, with a group's columns
      [--read <name>=<view()> [in <token>] [as usd|amount] [at <time>]]…   A figure read on every contract now: --read cov="coverageLiquidity() in asset()"
                                                               …or as it was then: --read bal7="balanceOf(0x…)(uint256) in asset() at 7d" (7d, 24h, 2w, or a UTC date)
                                                               …one of several outputs, with arguments: --read n="getConnectedGardens(uint256,uint256).total with 0, 1"
      [--read <name>=<expression>]…                            …or an expression over earlier reads and the group's columns
      [--series <from>[..<to>] [--every 1h|6h|1d|1w]]           Every read at each step over a window: one row per time per contract
  contract-dev query table "<name>" [--days <n>] [--among active|done|all]                 A table's rows (contract-dev table list names them): a live table
                                                               (the rows it reads, its own --where carried in), an item table's rows
                                                               (active by default), or a metric's records (one row per event)
  contract-dev query metric "<name>" [--days <n>]                                         What is behind a metric: its records or readings
  contract-dev query metrics --metric "<name>"… [--split contract|<param>] [--days <n>]     Metrics split the same way, side by side: one row per
                                                               split value (an integrator, a sender, a contract), one column per metric's total
  contract-dev query monitors · query alerts [--days <n>] · query reports
  contract-dev query transactions [--group <g> | --contract <c>] [--days <n>] [--signer <0x>] [--failed] [--direct | --routed] [--method <name>]
                                                                                          The transactions that reached the contracts (or a watched wallet sent and received), newest first
                                                               Columns: time, day, contract, chain, wallet, who, via, method, status, value, events, revert (why a
                                                               failed direct call failed, in the failing contract's own words, from its trace; paid plans),
                                                               revertBy (the contract whose failure it was), and a direct call's arguments as {args.<path>}
                                                               by the ABI's names, [index] for a list item: {args.swapExecutionData[0].dex}, usable in --where,
                                                               --by, --column and --sort
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
  --by <a,b> --sum|--avg|--min|--max|--distinct|--first|--last "<expr>" | --count     Fold the rows into groups, one value each
  --measure <name>="<fn>(<expr>) [where <rule>]"   With --by, in place of --sum…: several values per group, each a column by its
                                name (repeat it). fn: count, sum, avg, min, max, distinct (how many different values),
                                first, last (on the group's earliest or latest row); where counts or adds only its rows:
                                --measure swaps=count --measure volume="sum({Value})" --measure chains="distinct(chain)"
                                --measure bridges='count where {Event} == "BridgeStarted"'
  --having "<expr>"             With --by: keep the groups this holds for, over their columns and measures by name
  --sort "<expr>" [--asc]       With --by: rank the groups by a measure (default: the first, largest first)
  --breakdown <column>          With --by: split each group again, its parts listed under it and counted:
                                --by wallet --sum "{Value}" --breakdown chain  (each wallet's total and chains, then per chain)
  --total <a,b>                 Add these columns up over every matching row
  --column <name>               Event rows (a table, a metric's records) listed, not folded: a column to show, in order
                                (repeat it); only those show. A field, a parameter, or the row's own time, day, tx, chain,
                                contract, event or wallet (the wallet that signed it)
  --detail <name>               Event rows listed: a column each row opens onto, one line per item of a list field (a
                                batch swap's swaps; a single swap is one line), repeat it; printed under the row
  --status "<Label>: <Opt>=<rule>; <Opt>"   A category on each row (a pill on the page): its options in order, each with
                                the rule (as --where) that puts a row in it, the last without one the rest; usable by
                                name in the clauses: --status 'Type: Batch={Event} == "DZapBatchTokenSwapped"; Single'
  --limit <n>                   Rows or groups to print (default 25; the answer says how many matched)
  --json                        The tool's own result

Examples:
  contract-dev query contracts --group "Wildcat markets" --show headroom="{Held} - {Required}" --where "headroom < 0" --sort headroom --asc
  contract-dev query contracts --group "Wildcat markets" --by kind --sum "{Supplied}"
  contract-dev query contracts --group "Wildcat markets" --read cov="coverageLiquidity() in asset()" --read held="totalAssets() in asset()" --read gap="held - cov" --sort gap --asc
  contract-dev query contracts --group Vaults --read sp="convertToAssets(1000000000000000000)" --read sp7="convertToAssets(1000000000000000000) at 7d" --show apr="(sp - sp7) / sp7 * 52" --sort apr
  contract-dev query contracts --group Vaults --read sp="convertToAssets(1000000000000000000)" --series 30d --every 1d
  contract-dev query contracts --group Vaults --read sp="convertToAssets(1000000000000000000)" --series 2026-09-01..2026-10-01 --by day --avg sp
  contract-dev query table "Withdrawal rounds" --where '{Stage} == "Paying" and age > 7d' --sort "{Outstanding}"
  contract-dev query metric Deposits --days 30 --by day --sum "{value}"
  contract-dev query table "DZap activity" --days 90 --by integrator --measure swaps='count where {Event} != "BridgeStarted"' --measure bridges='count where {Event} == "BridgeStarted"' --measure volume="sum({Value})"
  contract-dev query table "DZap activity" --days 90 --by wallet --measure volume="sum(vol)" --measure swaps=count --having "volume > 10000" --breakdown chain
  contract-dev query metrics --metric "DZap bridges" --metric "DZap swaps" --metric "DZap swap volume" --split integrator
  contract-dev query metric "DZap swap volume" --where "{Value} > 10000" --sort "{Value}"
  contract-dev query monitors --where '{State} == "breached"'
  contract-dev query alerts --days 30 --by monitor --count
  contract-dev query transactions --group "Wildcat markets" --days 30 --by day --count
  contract-dev query transactions --signer 0x1234…abcd --days 90
  contract-dev query transactions --group "DZap Routers" --days 7 --failed --by "args.swapExecutionData[0].dex" --measure failed=count --measure reason='last({revert})'
  contract-dev query transfers --contract Treasury --out --days 30 --by counterparty --sum "{USD}"
  contract-dev query transfers --group "Wildcat markets" --out --by counterparty --sum "{USD}" --limit 10
  contract-dev query wallets --group "Wildcat markets" --days 7 --where '{Status} == "new"'
  contract-dev query transfers --group DZap --days 30 --by day,token --sum "{USD}"
`;

const DATASETS = ['contracts', 'table', 'metric', 'metrics', 'data', 'monitors', 'alerts', 'reports', 'transactions', 'transfers', 'wallets'] as const;
const ACTIVITY: readonly string[] = ['transactions', 'transfers', 'wallets'];
type Dataset = (typeof DATASETS)[number];
const MEASURES = ['sum', 'avg', 'min', 'max', 'distinct', 'first', 'last'] as const;
const MEASURE_FNS = ['count', ...MEASURES] as readonly string[];

/**
 * `--measure volume="sum({Value})"`, `swaps=count`, `bridges="count where {Event} == \"BridgeStarted\""`,
 * `chains="distinct(chain)"`: a named measure as the server takes it ({name, fn, expr?, where?}). The
 * expression runs to the parenthesis that closes the measure's own, so it may call functions itself.
 */
export function parseMeasure(raw: string): { name: string; fn: string; expr?: string; where?: string } {
  const usage = '--measure takes name="fn(expression) [where <rule>]": --measure volume="sum({Value})", --measure swaps=count, --measure chains="distinct(chain)"';
  const eq = raw.indexOf('=');
  const name = eq > 0 ? raw.slice(0, eq).trim() : '';
  const body = eq > 0 ? raw.slice(eq + 1).trim() : '';
  if (!/^[A-Za-z_]\w*$/.test(name) || !body) throw new Error(`${usage}; got "${raw}"`);
  const head = /^([A-Za-z]+)\s*/.exec(body);
  const fn = head?.[1].toLowerCase();
  if (!head || !fn || !MEASURE_FNS.includes(fn)) throw new Error(`--measure ${name}: "${head?.[1] ?? body}" is not a measure (${MEASURE_FNS.join(', ')}).`);
  let rest = body.slice(head[0].length);
  let expr: string | undefined;
  if (rest.startsWith('(')) {
    let depth = 0;
    let quote: string | null = null;
    let i = 0;
    for (; i < rest.length; i++) {
      const ch = rest[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    if (depth !== 0) throw new Error(`--measure ${name}: the parenthesis after ${fn} never closes.`);
    expr = rest.slice(1, i).trim();
    rest = rest.slice(i + 1).trim();
  }
  let where: string | undefined;
  if (rest) {
    const w = /^where\s+([\s\S]+)$/i.exec(rest);
    if (!w) throw new Error(`--measure ${name}: after ${fn}(…) comes only "where <rule>"; got "${rest}".`);
    where = w[1].trim();
  }
  return { name, fn, ...(expr ? { expr } : {}), ...(where ? { where } : {}) };
}

const COLUMNS_SHOWN = 8;


/** The rows as one table: the time first for a series, then the name, then the columns the clauses name, then the rest, at most eight across. */
type PrintColumn = { key: string; label: string; unit?: string; symbolKey?: string };

/** A token amount with its symbol after the figure (the row's symbolKey, 2026-10-27); every other cell as it is. */
function withSymbols(rows: Record<string, unknown>[], columns: PrintColumn[]): Record<string, unknown>[] {
  const amounts = columns.filter((c) => c.symbolKey);
  if (amounts.length === 0) return rows;
  return rows.map((r) => {
    const out = { ...r };
    for (const c of amounts) {
      const v = r[c.key];
      const sym = r[c.symbolKey as string];
      if (typeof v === 'number') out[c.key] = `${v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1 ? 4 : 8 })}${typeof sym === 'string' ? ` ${sym}` : ''}`;
      // a token column: its symbol, then the short address (the page draws the logo and symbol)
      else if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && typeof sym === 'string') out[c.key] = `${sym} ${v.slice(0, 6)}…${v.slice(-4)}`;
    }
    return out;
  });
}

/**
 * A table whose columns were named (--column, 2026-10-27) prints them all, in their order. A row that opens onto
 * lines (--detail: a batch swap's swaps) prints them under it, indented, under the lines' own header.
 */
export function printRows(rows: Record<string, unknown>[], columns: PrintColumn[], named: string[], first: string[] = [], split?: BreakdownColumn, chosen = false, detail?: PrintColumn[]): void {
  if (rows.length === 0) return;
  rows = withSymbols(rows, columns);
  const keys = columns.map((c) => c.key);
  if (chosen) first = keys;
  const wanted = (ref: string): string | null => {
    const r = ref.trim().replace(/^\{|\}$/g, '').toLowerCase();
    return columns.find((c) => c.key === r)?.key ?? columns.find((c) => c.label.toLowerCase() === r)?.key ?? null;
  };
  const order: string[] = [];
  const push = (k: string | null) => {
    if (k && keys.includes(k) && !order.includes(k)) order.push(k);
  };
  for (const k of first) push(k);
  push(columns.find((c) => c.key === 'name')?.key ?? null);
  for (const n of named) for (const m of n.match(/\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*/g) ?? []) push(wanted(m));
  for (const k of keys) push(k);
  const shown = chosen ? order : order.slice(0, COLUMNS_SHOWN);
  const header = shown.map((k) => columns.find((c) => c.key === k)?.label ?? k);
  const unitOf = new Map(columns.map((c) => [c.key, c.unit]));
  const lines = columnsTable(header, partCells(rows, shown, unitOf, split));
  const opens = detail && !split && rows.some((r) => Array.isArray(r.lines));
  if (!opens) for (const line of lines) console.log(line);
  else {
    // one printed line per row (no parts without a split): each row, then its lines under it
    const dKeys = detail.map((c) => c.key);
    const dHeader = detail.map((c) => c.label);
    const dUnit = new Map(detail.map((c) => [c.key, c.unit]));
    console.log(lines[0]);
    rows.forEach((r, i) => {
      console.log(lines[i + 1]);
      const ls = Array.isArray(r.lines) ? withSymbols(r.lines as Record<string, unknown>[], detail) : [];
      if (ls.length === 0) return;
      for (const l of columnsTable(dHeader, ls.map((x) => dKeys.map((k) => cell(byUnit(x[k], dUnit.get(k))))), '    ')) console.log(l);
    });
  }
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
  const statuses = statusesFrom(flags);
  if (statuses.length > 0) input.status = statuses;
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
  const named = flagAll(flags, 'measure').map(parseMeasure);
  if (named.length > 0) {
    if (measures.length > 0 || count) throw new Error('Give --measure, or one of --sum, --avg, --min, --max, --distinct, --first, --last, --count: not both.');
    input.measures = named;
  }
  if ((measures.length > 0 || count || named.length > 0) && !by) throw new Error('A measure folds groups: say --by <column> too.');
  const having = wordFlag(flags, 'having');
  if (having) {
    if (!by) throw new Error('--having keeps groups: say --by <column> too.');
    input.having = having;
  }
  const breakdown = wordFlag(flags, 'breakdown');
  if (breakdown) {
    if (!by) throw new Error('--breakdown splits groups again: say --by <column> too.');
    input.breakdown = breakdown;
  }
  const total = listFlag(flags, 'total');
  if (total && total.length > 0) input.total = total;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 25, 200);
  return input;
}

/** `live`: the question kept as a live table under Tables with this name (`table create "<name>" --from …`), not a snapshot; `description`: what it shows. */
export async function queryCommand(args: string[], opts: { live?: string; description?: string } = {}): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0]) || args.includes('--help') || args.includes('-h')) return void console.log(HELP);
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  // `query metric help`: help after the dataset is help, never a table or metric called "help"
  if (positional.length === 2 && positional[1] === 'help') return void console.log(HELP);
  const noun = positional[0] as Dataset | undefined;
  if (!noun || !(DATASETS as readonly string[]).includes(noun)) throw new Error(`Say which dataset: ${DATASETS.filter((d) => d !== 'data').join(', ')} (try: contract-dev query help).`);
  const input = clausesFromFlags(flags);
  const name = positional.slice(1).join(' ').trim();
  if (noun === 'table' || noun === 'metric' || noun === 'data') {
    if (!name) throw new Error(`Name the ${noun}: contract-dev query ${noun} "<name>"${noun === 'table' ? ' (contract-dev table list names them)' : ''}.`);
    // `query table` asks any table (query_data resolves a live table, an item table or a metric's records); `data` stays as its quiet alias
    input[noun === 'table' ? 'data' : noun] = name;
  } else if (name) throw new Error(`query ${noun} takes no name; scope it with the flags (try: contract-dev query help).`);
  if (noun === 'contracts') {
    const group = wordFlag(flags, 'group');
    if (group) input.group = group;
    const chainId = chainFlag(flags);
    if (chainId !== undefined) input.chainId = chainId;
    const kind = wordFlag(flags, 'kind');
    if (kind) input.kind = kind;
    const reads = flagAll(flags, 'read').map((raw) => {
      const m = raw.match(/^([A-Za-z_]\w*)\s*=\s*(.+?)(?:\s+in\s+(\S+))?(?:\s+as\s+(usd|amount))?(?:\s+at\s+(\S+))?\s*$/);
      if (!m) throw new Error(`--read takes name=<view()> [in <token>] [as usd|amount] [at <time>], or name=<expression>; got "${raw}"`);
      const [, name, body, token, show, at] = m;
      // the call itself, without its ".output", "on <target>" and "with <args>"
      const bare = body.replace(/\s+with\s.*$/, '').replace(/\s+on\s.*$/, '').replace(/\)\.[A-Za-z_][\w.]*$/, ')');
      const isCall = /^[A-Za-z_]\w*\(.*\)$/.test(bare) && !/^(usd|amount|price|min|max|abs|round|floor|ceil|sqrt|ln|exp|if|len|sum|indexOf|contains|keccak|now)\s*\(/.test(bare);
      if (!isCall && (token || show || at)) throw new Error(`--read ${name}: "in <token>", "as" and "at" go with a view, not an expression`);
      if (!isCall) return { name, expr: body };
      const read = parseRead(`${name}=${body}`, new Set());
      return { ...read, ...(token ? { token } : {}), ...(show ? { show } : {}), ...(at ? { at } : {}) };
    });
    if (reads.length > 0) input.reads = reads;
    const series = wordFlag(flags, 'series');
    const every = wordFlag(flags, 'every');
    if (series) {
      if (reads.length === 0) throw new Error('--series reads the --read figures at each step: say what to read.');
      const [from, to] = series.split('..').map((s) => s.trim());
      if (!from) throw new Error('--series takes <from> or <from>..<to>: --series 30d, --series 2026-09-01..2026-10-01');
      input.series = { from, ...(to ? { to } : {}), ...(every ? { every } : {}) };
    } else if (every) throw new Error('--every goes with --series.');
  }
  if (noun === 'table' || noun === 'data') {
    const among = wordFlag(flags, 'among');
    if (among) input.among = among;
  }
  // the columns a listing of event rows shows, in order, and no others (2026-10-27): repeated, or a comma list
  if (noun === 'table' || noun === 'data' || noun === 'metric') {
    const columns = flagAll(flags, 'column').flatMap((c) => String(c).split(',')).map((c) => c.trim()).filter(Boolean);
    if (columns.length > 0) input.columns = columns;
    const detail = flagAll(flags, 'detail').flatMap((c) => String(c).split(',')).map((c) => c.trim()).filter(Boolean);
    if (detail.length > 0) input.detail = detail;
  }
  if (noun === 'metrics') {
    const metrics = flagAll(flags, 'metric').map((m) => String(m).trim()).filter(Boolean);
    if (metrics.length === 0) throw new Error('Name the metrics, one --metric each: contract-dev query metrics --metric "DZap bridges" --metric "DZap swaps" --split integrator.');
    input.metrics = metrics;
    const split = wordFlag(flags, 'split');
    if (split) input.split = split;
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
  if (noun === 'metric' || noun === 'metrics' || noun === 'data' || noun === 'table' || noun === 'alerts' || ACTIVITY.includes(noun)) {
    const days = wordFlag(flags, 'days');
    if (days !== undefined) {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1) throw new Error('--days takes a whole number of days');
      input.days = n;
    }
  }
  // a question is answered where asked; a table kept under Tables is `table create` (--save, the snapshot under Queries, went 2026-10-28)
  if (['save', 'title', 'draw', 'keep'].some((k) => flag(flags, k) !== undefined)) throw new Error('--save is gone: a table kept under Tables is contract-dev table create "<name>" --from <rows> with the same flags (contract-dev table help).');
  if (opts.live) input.save = { title: opts.live, ...(opts.description ? { description: opts.description } : {}) };
  const r = (await runTool(requireAuth(), noun === 'table' ? 'query_data' : `query_${noun}`, input)) as Record<string, unknown>;
  const matched = Number(r.matched ?? 0);
  const returned = Number(r.returned ?? 0);
  const grouped = r.grouped as { by: string[]; measure: string } | undefined;
  const head = grouped ? `${matched} group${matched === 1 ? '' : 's'} by ${grouped.by.join(', ')} · ${grouped.measure}` : `${matched} row${matched === 1 ? '' : 's'} matched`;
  // data still reading its history answers from the rows so far, which are not the answer: it says it is indexing and
  // prints none of them (Theo, 2026-10-27: never incomplete rows)
  if (r.filling === true) {
    // table create says it in its own words, with the command that shows the rows; the table's link still prints
    if (!opts.live) console.log('Indexing: the rows show once every one is in.');
    const cov = coverageLine(r.coverage);
    if (cov) console.log(cov);
    const saved = savedLine(r);
    if (saved) console.log(saved);
    return r;
  }
  console.log(`${head}${returned < matched ? ` · showing ${returned}` : ''}`);
  const { rows, columns, totals, ...rest } = r as { rows?: Record<string, unknown>[]; columns?: { key: string; label: string; unit?: string }[]; totals?: Record<string, number | null> } & Record<string, unknown>;
  const named = [...((input.reads as { name: string }[] | undefined)?.map((r) => r.name) ?? []), input.sort, input.where, ...((input.show as { name: string; expr: string }[] | undefined)?.flatMap((x) => [x.name, x.expr]) ?? []), ...((input.by as string[] | undefined) ?? []), ...((input.total as string[] | undefined) ?? [])].filter((x): x is string => typeof x === 'string');
  const series = rest.series as { from: string; to: string; every: string; points: number; chosen: 'auto' | 'asked' } | undefined;
  if (series) console.log(`Series: every ${series.every}${series.chosen === 'auto' ? ' (chosen to fit)' : ''} · ${series.points} point${series.points === 1 ? '' : 's'} · ${byUnit(Date.parse(series.from) / 1000, 'time')} → ${byUnit(Date.parse(series.to) / 1000, 'time')}`);
  // a fold prints its groups' own columns first, so a breakdown's parts sit under them
  printRows(rows ?? [], columns ?? [], named, series ? ['time'] : (grouped?.by ?? []), rest.breakdown as BreakdownColumn | undefined, (Array.isArray(input.columns) || rest.chosen === true) && !grouped, (rest.detail as { columns: PrintColumn[] } | undefined)?.columns);
  const readAt = rest.readAt as Record<string, { at: string; blocks: { chainId: number; block: number; time: string }[] }> | undefined;
  for (const [name, r] of Object.entries(readAt ?? {})) console.log(`${name}: as of ${byUnit(Date.parse(r.at) / 1000, 'time')} (${r.blocks.map((b) => `block ${b.block.toLocaleString('en-US')}${r.blocks.length > 1 ? ` on chain ${b.chainId}` : ''}`).join(', ')})`);
  if (totals) {
    const unitOf = new Map((columns ?? []).map((c) => [c.key, c.unit]));
    console.log(`Totals: ${Object.entries(totals).map(([k, v]) => `${k} ${v == null ? '—' : unitOf.get(k) === 'usd' ? byUnit(v, 'usd') : v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`).join(' · ')}`);
  }
  const counts = rest.active as { now: number; before: number } | undefined;
  const fresh = rest.new as { now: number; before: number } | undefined;
  if (counts && fresh) console.log(`Active ${counts.now} (the window before: ${counts.before}) · New ${fresh.now} (before: ${fresh.before})`);
  const note = ['readFrom', 'readings', 'among'].map((k) => rest[k]).filter(Boolean);
  if (note.length > 0) console.log(note.join(' · '));
  // how much of the window the rows cover, under them: the figures above stand over what it says, and no further
  const cov = coverageLine(rest.coverage);
  if (cov) console.log(cov);
  for (const n of (rest.notes as string[] | undefined) ?? []) console.log(n);
  const next = rest.next as { before?: string } | undefined;
  if (next?.before) console.log(`More: --before ${next.before}`);
  const saved = savedLine(r);
  if (saved) console.log(saved);
  return r;
}

/** The line under an answer kept as a live table (table create prints it too). */
export function savedLine(result: Record<string, unknown> | null | undefined): string | null {
  const saved = result?.saved as { url?: string; title?: string } | undefined;
  return saved?.url ? `Live table under Tables${saved.title ? ` · ${saved.title}` : ''}: ${saved.url}` : null;
}

export default queryCommand;
