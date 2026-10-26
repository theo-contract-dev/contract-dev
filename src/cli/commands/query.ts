// `contract-dev query <noun> …` — one command over every dataset the platform keeps, named as the
// app's pages name them: contracts, a table, a metric, monitors, alerts, reports. The clauses are the
// same for all of them (where, show, sort, by with a measure, total, limit) and are the server's
// query_* tools' arguments one to one, so an agent reading this and the Slack assistant speak the
// same language. Prints the rows as a table; --json hands back the tool's own result.
import { parseFlags, flag, flagAll, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { columnsTable, byUnit, partCells, type BreakdownColumn } from './_print';
import { SAVE_HELP, saveFromFlags, savedLine } from './_save';
import { parseRead } from './eventMetric';

const HELP = `contract-dev query — ask one dataset a question, in the table language

Usage:
  contract-dev query contracts [--group <g>] [--chain <id>] [--kind pool|vault|token|…]   The watched contracts, with a group's columns
      [--read <name>=<view()> [in <token>] [as usd|amount] [at <time>]]…   A figure read on every contract now: --read cov="coverageLiquidity() in asset()"
                                                               …or as it was then: --read bal7="balanceOf(0x…)(uint256) in asset() at 7d" (7d, 24h, 2w, or a UTC date)
                                                               …one of several outputs, with arguments: --read n="getConnectedGardens(uint256,uint256).total with 0, 1"
      [--read <name>=<expression>]…                            …or an expression over earlier reads and the group's columns
      [--series <from>[..<to>] [--every 1h|6h|1d|1w]]           Every read at each step over a window: one row per time per contract
  contract-dev query table "<name>" [--among active|done|all]                             One table's rows (active by default)
  contract-dev query metric "<name>" [--days <n>]                                         What is behind a metric: its records or readings
  contract-dev query data "<name>" [--days <n>] [--among active|done|all]                  Any named data: event data (one row per event: data define,
                                                               or a metric's records) or a table's rows (contract-dev data list names it)
  contract-dev query metrics --metric "<name>"… [--split contract|<param>] [--days <n>]     Metrics split the same way, side by side: one row per
                                                               split value (an integrator, a sender, a contract), one column per metric's total
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
  --limit <n>                   Rows or groups to print (default 25; the answer says how many matched)
${SAVE_HELP}
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
  contract-dev query data "DZap activity" --days 90 --by integrator --measure swaps='count where {Event} != "BridgeStarted"' --measure bridges='count where {Event} == "BridgeStarted"' --measure volume="sum({Value})" --save table
  contract-dev query data "DZap swaps" --days 90 --by wallet --measure volume="sum(vol)" --measure swaps=count --having "volume > 10000" --breakdown chain
  contract-dev query metrics --metric "DZap bridges" --metric "DZap swaps" --metric "DZap swap volume" --split integrator --save --title "Integrators"
  contract-dev query metric "DZap swap volume" --where "{Value} > 10000" --sort "{Value}" --save --title "Swaps over 10K USD"
  contract-dev query monitors --where '{State} == "breached"'
  contract-dev query alerts --days 30 --by monitor --count
  contract-dev query transactions --group "Wildcat markets" --days 30 --by day --count
  contract-dev query transactions --signer 0x1234…abcd --days 90
  contract-dev query transfers --contract Treasury --out --days 30 --by counterparty --sum "{USD}"
  contract-dev query transfers --group "Wildcat markets" --out --by counterparty --sum "{USD}" --limit 10
  contract-dev query wallets --group "Wildcat markets" --days 7 --where '{Status} == "new"'
  contract-dev query transfers --group DZap --days 30 --by day,token --sum "{USD}" --save stacked --title "Volume by token"
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
function printRows(rows: Record<string, unknown>[], columns: { key: string; label: string; unit?: string }[], named: string[], first: string[] = [], split?: BreakdownColumn): void {
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
  for (const k of first) push(k);
  push(columns.find((c) => c.key === 'name')?.key ?? null);
  for (const n of named) for (const m of n.match(/\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*/g) ?? []) push(wanted(m));
  for (const k of keys) push(k);
  const shown = order.slice(0, COLUMNS_SHOWN);
  const header = shown.map((k) => columns.find((c) => c.key === k)?.label ?? k);
  const unitOf = new Map(columns.map((c) => [c.key, c.unit]));
  for (const line of columnsTable(header, partCells(rows, shown, unitOf, split))) console.log(line);
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

/** `live`: the question kept as a live table under Tables with this name (`table create "<name>" --from …`), not a snapshot. */
export async function queryCommand(args: string[], opts: { live?: string } = {}): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0]) || args.includes('--help') || args.includes('-h')) return void console.log(HELP);
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  // `query metric help`: help after the dataset is help, never a table or metric called "help"
  if (positional.length === 2 && positional[1] === 'help') return void console.log(HELP);
  const noun = positional[0] as Dataset | undefined;
  if (!noun || !(DATASETS as readonly string[]).includes(noun)) throw new Error(`Say which dataset: ${DATASETS.join(', ')} (try: contract-dev query help).`);
  const input = clausesFromFlags(flags);
  const name = positional.slice(1).join(' ').trim();
  if (noun === 'table' || noun === 'metric' || noun === 'data') {
    if (!name) throw new Error(`Name the ${noun}: contract-dev query ${noun} "<name>"${noun === 'data' ? ' (contract-dev data list names it)' : ''}.`);
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
  if (noun === 'metric' || noun === 'metrics' || noun === 'data' || noun === 'alerts' || ACTIVITY.includes(noun)) {
    const days = wordFlag(flags, 'days');
    if (days !== undefined) {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1) throw new Error('--days takes a whole number of days');
      input.days = n;
    }
  }
  if (opts.live && ['save', 'title', 'draw'].some((k) => flag(flags, k) !== undefined)) throw new Error('A live table is a table named by table create: leave out --save, --title and --draw (a snapshot is contract-dev query … --save).');
  const save = opts.live ? { as: 'table' as const, title: opts.live, keep: true } : saveFromFlags(flags);
  if (save) input.save = save;
  const r = (await runTool(requireAuth(), `query_${noun}`, input)) as Record<string, unknown>;
  const matched = Number(r.matched ?? 0);
  const returned = Number(r.returned ?? 0);
  const grouped = r.grouped as { by: string[]; measure: string } | undefined;
  const head = grouped ? `${matched} group${matched === 1 ? '' : 's'} by ${grouped.by.join(', ')} · ${grouped.measure}` : `${matched} row${matched === 1 ? '' : 's'} matched`;
  console.log(`${head}${returned < matched ? ` · showing ${returned}` : ''}`);
  const { rows, columns, totals, ...rest } = r as { rows?: Record<string, unknown>[]; columns?: { key: string; label: string; unit?: string }[]; totals?: Record<string, number | null> } & Record<string, unknown>;
  const named = [...((input.reads as { name: string }[] | undefined)?.map((r) => r.name) ?? []), input.sort, input.where, ...((input.show as { name: string; expr: string }[] | undefined)?.flatMap((x) => [x.name, x.expr]) ?? []), ...((input.by as string[] | undefined) ?? []), ...((input.total as string[] | undefined) ?? [])].filter((x): x is string => typeof x === 'string');
  const series = rest.series as { from: string; to: string; every: string; points: number; chosen: 'auto' | 'asked' } | undefined;
  if (series) console.log(`Series: every ${series.every}${series.chosen === 'auto' ? ' (chosen to fit)' : ''} · ${series.points} point${series.points === 1 ? '' : 's'} · ${byUnit(Date.parse(series.from) / 1000, 'time')} → ${byUnit(Date.parse(series.to) / 1000, 'time')}`);
  // a fold prints its groups' own columns first, so a breakdown's parts sit under them
  printRows(rows ?? [], columns ?? [], named, series ? ['time'] : (grouped?.by ?? []), rest.breakdown as BreakdownColumn | undefined);
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
  for (const n of (rest.notes as string[] | undefined) ?? []) console.log(n);
  const next = rest.next as { before?: string } | undefined;
  if (next?.before) console.log(`More: --before ${next.before}`);
  const saved = savedLine(r);
  if (saved) console.log(saved);
  return r;
}

export default queryCommand;
