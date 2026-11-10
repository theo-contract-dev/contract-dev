// `contract-dev notify` — everything the workspace sends (2026-11-08): a REPORT on a schedule, or an
// ALERT, when something happens (an each-time Report) or when a condition is met (an Invariant, or a
// rule on a table's rows). The one command for them since 4.4.0: `report` and `monitor` are retired as
// commands, and their modules (./report, ./monitor) are what this hands to. The words match the app's
// Notifications page: the types, and the status a row wears.
import { apiRequest, requireAuth, type ResolvedAuth } from '../credentials';
import { defineInline, inlineDefinition } from './_define';
import { runTool } from '../tools';
import { flag, parseFlags } from './_args';
import { ALERT_TYPE_WORD, monitorTrigger, type AlertTrigger } from './_alertWords';
import { listChannels, monitorCommand, resolveChannelIds, type AlertChannel, type Invariant } from './monitor';
import { loadReports, NO_CALLS, reportCommand, scheduleWords, type ReportView } from './report';
import { DASH, fmtAge, plural, table } from '../view';

const HELP = `contract-dev notify — everything the workspace sends: reports and alerts

Usage:
  contract-dev notify [list] [--type report|alert] [--status <status>]
                                                          Every notification: type, name, when it sends, status

A report: a table of figures on a schedule.
  contract-dev notify add report ["<name>"] [--template daily|weekly] [--row <line>]… [--table "<table>[ | …]"]…
                             --columns 24h[,7d,30d] [--compare] [--at <hour>] [--on <weekday>] [--tz <zone>]
                             [--every 1m|10m|1h|6h] [--only-when "<expr>"] [--scope <scope>] [--to <dest>…]
    --template daily|weekly   Active wallets, transactions, reverted share, volume in and out (weekly: and alerts opened)
    --row <line>              A line, in order; repeat for more: activeWallets · transactions · revertedShare ·
                              volumeInUsd · volumeOutUsd · alertsOpened · eventCount:<Event> ·
                              metric:"<name>" (any metric, state or activity) ·
                              "metric:<name>=<clauses>" (one made for this report: on steth; call totalSupply()) ·
                              "formula:<Label>=<expr>[; call <name>=<call>]…" · <line>@<scope> for its own scope
    --table "<table> | sort <col> | top <n> | days <n> | where <expr> | columns a,b"
                              A table of rows under the lines, up to 3; "<name>=<clauses>" makes one for this report
    --columns <w>,<w>…        The windows every line prints (1m at the least, the plan's history at the most)
    --compare                 Add the change against the window before
    --at <hour> --on <day>    Daily at an hour (9 unless said), weekly on a day; --tz <zone> the clock it reads
    --every <interval>        Every N minutes on the UTC clock instead; --only-when sends only when it holds
    --scope <scope>           workspace (default) · tag:<group> · one watched contract

An alert: a message on one of two triggers.
  When something happens (once per block: a block's matches in one message):
  contract-dev notify add alert ["<name>"] --on <contract> --event <Name> --message "<text>" [--when "<condition>"]
                             [--value "<expr>"] [--read name=call()]… [--to <dest>…]
                                                          --value is what each emission is worth (usd(amount, token));
                                                          a view of the emitting contract it needs is a --read, named
                                                          (--read t0=token0() --value "usd(abs(amount0), t0)")
                                                          Instead of --event: --on-value "<metric>",
                                                          --on-row "<table>[:opened|finished|both]",
                                                          --on-member "<group>[:joined|left|both]", --metric "<event metric>";
                                                          --group <g> instead of --on for every contract in a group
  When a condition is met (sent when it starts, and the all-clear when it clears):
  contract-dev notify add alert ["<name>"] --on metric:"<metric>" --when "<formula>" [--remind] [--to <dest>…] [--max-age <sec>]
                                                          Any metric, state or activity, by name or id; or defined here for
                                                          this alert: --on "metric:Supply=on steth; call totalSupply()"
                                                          (the clauses of metric define, off the Metrics page)
  contract-dev notify add alert ["<name>"] --on <contract> --silence --event <Name> [--for 24h] [--remind]
                                                          It goes quiet: no such event for the window
  contract-dev notify add alert ["<name>"] --on <contract> --failures [--rows "<where>"] [--by <column>] [--when "<rule>"] [--for 1h]
                                                          Its calls fail: a rule over failed, total and share in the window
  contract-dev notify add alert ["<name>"] --on <contract> --overdue --event <Open> --answer <Close>… [--match <field>]… --for 3d
                                                          Something opened is not answered in time; --match pairs each open
                                                          with its own answer (requestId, or requestId=_requestId); without
                                                          it any answer closes the oldest open
  contract-dev notify add alert "<name>" --on table:"<table>" --column "<label>" --when "value < 1.1" [--to <dest>…]
                                                          A row threshold: the rule on every open row of a state table, on a
                                                          read column; each row alerts and clears on its own, and sends where
                                                          the rule does (notify set <name> --to … changes it for every row)
                                                          --remind re-sends an alert every hour while it holds, until it
                                                          clears or is acknowledged (off: one message, then the all-clear)

  contract-dev notify show <name>                         Its settings and its history: a report's runs, an alert's messages
  contract-dev notify set <name> [--when …] [--message …] [--row …] [--columns …] [--to <dest>…] [--remind | --no-remind] …
                                                          Change it: the flags it was made with (a report also takes
                                                          --add-row, --remove-row, --no-tables, --always)
  contract-dev notify rename <name> "<new name>"
  contract-dev notify pause <name> / resume <name>
  contract-dev notify delete <name>…
  contract-dev notify run <name>                          A report now, off its schedule
  contract-dev notify ack <name>                          A reminding alert: stop the reminders (the all-clear still comes)

<name> is the notification's name or id. Status: Active (running) or Paused; an active alert on a condition may
also be Alerting (it is met) or No data (no fresh reading to judge, so it cannot alert). Where one sends is in
\`notify show <name>\`. Nothing sends for what happened before it was made.

Destinations (--to): channel ids, labels ("#alerts") or kinds (telegram) from \`contract-dev channels\`. Optional:
without one it still runs, and every run and alert shows on its page in the app.

An alert on a condition has one line: --warn is not taken.

Examples:
  contract-dev notify add report --template daily --to "#alerts"
  contract-dev notify add report "Morning" --row transactions --row metric:"Treasury ETH" --columns 24h,7d --at 9
  contract-dev notify add report "Hourly swaps" --every 1h --row eventCount:Swap --columns 1h --to telegram
  contract-dev notify add alert "Large swaps" --group "Uniswap pools" --event Swap --read t0=token0() --read t1=token1() \\
    --value "max(usd(abs(amount0), t0), usd(abs(amount1), t1))" --when "value >= 100000" \\
    --message "{name(sender())} swapped {value} on {name(emitter())}" --to "#trades"
  contract-dev notify add alert "New markets" --on-member "Wildcat markets" --message "{name(contract)} joined"
  contract-dev notify add alert "Treasury low" --on metric:"Treasury ETH" --when "value < 25000" --remind --to telegram
  contract-dev notify add alert "stETH quiet" --on steth --silence --event Transfer --for 24h
  contract-dev notify add alert "Withdrawal unclaimed" --on "Withdrawal Queue" --overdue --event WithdrawalRequested \\
    --answer WithdrawalClaimed --match requestId --for 7d
  contract-dev notify add alert "Loan at risk" --on table:"Loans" --column "Health factor" --when "value < 1.1"
  contract-dev notify pause "Large swaps"
`;

export type NotifyType = 'report' | 'alert';
export type { AlertTrigger } from './_alertWords';
export type NotifyStatus = 'Alerting' | 'No data' | 'Active' | 'Paused';

/** Each status's place in the list: what needs a look first. */
const STATUS_RANK: Record<NotifyStatus, number> = { Alerting: 0, 'No data': 1, Active: 2, Paused: 3 };


export interface NotifyItem {
  type: NotifyType;
  /** An alert's trigger; absent on a report. */
  trigger?: AlertTrigger;
  id: string;
  name: string;
  /** When it sends: the schedule, the trigger, the rule. */
  when: string;
  /** Where it goes, by label or target; empty = nowhere (in --json; the list leaves it to `notify show`). */
  sendsTo: string[];
  status: NotifyStatus;
  /** Its latest run or alert (ISO), null when none. */
  lastAt: string | null;
  /** Which of the server's stores it is, for the commands it hands to: a report, a monitor, or a rule on a table's rows. */
  source: 'report' | 'monitor' | 'table';
  /** A row threshold (source table): its table and the alert each open row has. */
  tableId?: string;
  rows?: string[];
}

const destinationName = (c: Pick<AlertChannel, 'label' | 'target' | 'kind'>): string => c.label ?? c.target ?? c.kind;

export { monitorTrigger };

/** A monitor read as the app's row: its type, its one line, where it pages and its status. */
export function monitorItem(m: Invariant, channels: AlertChannel[] | null): NotifyItem {
  const type: NotifyType = 'alert';
  const trigger = monitorTrigger(m);
  const live = (channels ?? []).filter((c) => c.enabled);
  const dests = m.notifyAll ? live : live.filter((c) => (m.channelIds ?? []).includes(c.id));
  let status: NotifyStatus;
  if (!m.enabled || m.status === 'disabled') status = 'Paused';
  // one line per monitor since 2026-11-06: an older warning tier crossed pages too, so it reads Alerting
  else if (trigger === 'condition' && ['breached', 'alerting', 'warning'].includes(m.status)) status = 'Alerting';
  else if (trigger === 'condition' && ['stale', 'warming'].includes(m.status)) status = 'No data';
  else status = 'Active';
  const w = m.alertsWhen;
  const line = w?.critical ?? w?.warning ?? null;
  const when = trigger === 'event' ? line ?? m.exprText : line ? `alerts when ${line.charAt(0).toLowerCase()}${line.slice(1)}` : m.exprText;
  return {
    type,
    trigger,
    id: m.id,
    name: m.name,
    when,
    sendsTo: channels ? dests.map(destinationName) : (m.channelIds ?? []),
    status,
    lastAt: m.lastIncidentAt ?? null,
    source: 'monitor',
  };
}

/** A report read as the app's row: a report on a schedule, an alert (on something happening) when it sends each time. */
export function reportItem(r: ReportView): NotifyItem {
  const type: NotifyType = r.each ? 'alert' : 'report';
  const live = (r.channels ?? []).filter((c) => c.enabled);
  const status: NotifyStatus = r.enabled ? 'Active' : 'Paused';
  const when = r.each ? `each ${r.each.subject}${r.each.when && r.each.when !== 'true' ? ` when ${r.each.when}` : ''}${r.each.digestMinutes ? ` (digest every ${fmtMinutes(r.each.digestMinutes)})` : ''}` : scheduleWords(r);
  return {
    type,
    ...(r.each ? { trigger: 'event' as const } : {}),
    id: r.id,
    name: r.name,
    when,
    sendsTo: live.map(destinationName),
    status,
    lastAt: r.lastRun ? r.lastRun.finishedAt ?? r.lastRun.createdAt : null,
    source: 'report',
  };
}

/** The table rule a monitor is one row of (lib/console/tables fans a row threshold out, one alert per open row), or null. */
const tableRuleOf = (m: Invariant): { monitorId: string; tableId: string } | null => {
  const p = (m.params ?? {}) as { tagTableMonitorId?: unknown; tagTableId?: unknown };
  return typeof p.tagTableMonitorId === 'string' && typeof p.tagTableId === 'string' ? { monitorId: p.tagTableMonitorId, tableId: p.tagTableId } : null;
};

/**
 * A row threshold as one line (2026-11-08): the rule, however many open rows carry it. Its name is
 * the rule's own (each row's alert is named "<rule> · <contract> · <row>"); it is Alerting while any
 * row is, Paused when every row is.
 */
export function tableRuleItems(monitors: Invariant[], channels: AlertChannel[] | null): { items: NotifyItem[]; rest: Invariant[] } {
  const groups = new Map<string, { tableId: string; rows: Invariant[] }>();
  const rest: Invariant[] = [];
  for (const m of monitors) {
    const rule = tableRuleOf(m);
    if (!rule) {
      rest.push(m);
      continue;
    }
    const g = groups.get(rule.monitorId) ?? { tableId: rule.tableId, rows: [] };
    g.rows.push(m);
    groups.set(rule.monitorId, g);
  }
  const items = Array.from(groups, ([id, g]) => {
    const each = g.rows.map((m) => monitorItem(m, channels));
    const alerting = each.filter((i) => i.status === 'Alerting').length;
    const status: NotifyStatus = alerting > 0 ? 'Alerting' : each.every((i) => i.status === 'Paused') ? 'Paused' : each.some((i) => i.status === 'No data') ? 'No data' : 'Active';
    const latest = each.map((i) => i.lastAt).filter((x): x is string => !!x).sort().pop() ?? null;
    return {
      type: 'alert' as const,
      trigger: 'condition' as const,
      id,
      name: g.rows[0].name.split(' · ')[0],
      when: `${each[0].when} · ${plural(each.length, 'open row')}${alerting > 0 ? `, ${alerting} alerting` : ''}`,
      sendsTo: each[0].sendsTo,
      status,
      lastAt: latest,
      source: 'table' as const,
      tableId: g.tableId,
      rows: g.rows.map((m) => m.id),
    };
  });
  return { items, rest };
}

const fmtMinutes = (m: number): string => (m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`);

export function compareItems(a: NotifyItem, b: NotifyItem): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name);
}

interface Loaded {
  items: NotifyItem[];
  monitors: Invariant[];
  reports: ReportView[];
}

async function loadAll(auth: ResolvedAuth): Promise<Loaded> {
  const [{ invariants }, payload, channels] = await Promise.all([
    apiRequest<{ invariants: Invariant[] }>(auth, 'GET', '/api/mainnet/invariants'),
    loadReports(auth),
    listChannels(auth).catch(() => null),
  ]);
  const monitors = invariants ?? [];
  const reports = payload.reports ?? [];
  const rules = tableRuleItems(monitors, channels);
  const items = [...rules.rest.map((m) => monitorItem(m, channels)), ...rules.items, ...reports.map(reportItem)].sort(compareItems);
  return { items, monitors, reports };
}

/** A notification by id, or by name when exactly one matches (case-insensitive), across reports and monitors. */
export function matchItem(items: NotifyItem[], ref: string): NotifyItem {
  const byId = items.find((i) => i.id === ref);
  if (byId) return byId;
  const lower = ref.trim().toLowerCase();
  const byName = items.filter((i) => i.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`${byName.length} notifications are named "${ref}" — use an id: ${byName.map((i) => `${i.id} (${i.type})`).join(', ')}`);
  throw new Error(`No notification matches "${ref}" (run \`contract-dev notify list\`).`);
}

async function resolveItem(ref: string | undefined, what: string): Promise<{ item: NotifyItem; loaded: Loaded }> {
  if (!ref) throw new Error(`Missing required ${what}`);
  const loaded = await loadAll(requireAuth());
  return { item: matchItem(loaded.items, ref), loaded };
}

const TYPES: readonly NotifyType[] = ['report', 'alert'];
const STATUSES: readonly NotifyStatus[] = ['Alerting', 'No data', 'Active', 'Paused'];

async function listNotifications(args: string[]): Promise<NotifyItem[]> {
  const flags = parseFlags(args);
  const typeRaw = flag(flags, 'type');
  const type = typeRaw === undefined ? undefined : (typeRaw.toLowerCase().replace(/s$/, '') as NotifyType);
  if (type !== undefined && !TYPES.includes(type)) throw new Error(`--type is report or alert (got "${typeRaw}").`);
  const statusRaw = flag(flags, 'status');
  const status = statusRaw === undefined ? undefined : STATUSES.find((s) => s.toLowerCase() === statusRaw.toLowerCase().replace(/-/g, ' '));
  if (statusRaw !== undefined && !status) throw new Error(`--status is one of ${STATUSES.join(', ')} (got "${statusRaw}").`);
  const { items } = await loadAll(requireAuth());
  const shown = items.filter((i) => (!type || i.type === type) && (!status || i.status === status || (status === 'Active' && i.status !== 'Paused')));
  if (!items.length) {
    console.log('No notifications. Create one with `contract-dev notify add report --template daily --to <dest>` (try: notify help).');
    return [];
  }
  if (!shown.length) {
    console.log('No notifications match.');
    return [];
  }
  const word = (t: NotifyType) => t.charAt(0).toUpperCase() + t.slice(1);
  for (const line of table(shown, [
    { header: 'Type', value: (i) => word(i.type) },
    { header: 'Name', value: (i) => i.name, max: 32 },
    { header: 'When', value: (i) => i.when, max: 48 },
    // as the page's two pills: whether it runs, then what needs a look
    { header: 'Status', value: (i) => (i.status === 'Alerting' || i.status === 'No data' ? `Active · ${i.status}` : i.status) },
    { header: 'Latest', value: (i) => (i.lastAt ? fmtAge(Date.parse(i.lastAt)) : DASH) },
    { header: 'Id', value: (i) => i.id },
  ])) {
    console.log(line);
  }
  return shown;
}

// ── create: the type's own command, the flags translated where notify's grammar differs ──

/** The arguments as written: a positional, or a flag with its value (null for a bare flag), in order. */
type Token = { flag: string; value: string | null } | { positional: string };

function tokens(args: string[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      out.push({ positional: a });
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out.push({ flag: a.slice(2, eq), value: a.slice(eq + 1) });
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.push({ flag: a.slice(2), value: next });
      i++;
    } else out.push({ flag: a.slice(2), value: null });
  }
  return out;
}

const untokens = (ts: Token[]): string[] => ts.flatMap((t) => ('positional' in t ? [t.positional] : t.value === null ? [`--${t.flag}`] : [`--${t.flag}`, t.value]));
const has = (ts: Token[], ...names: string[]) => ts.some((t) => 'flag' in t && names.includes(t.flag));
const positionals = (ts: Token[]) => ts.filter((t): t is { positional: string } => 'positional' in t).map((t) => t.positional);
const flagsOnly = (ts: Token[]) => ts.filter((t) => 'flag' in t);

/** The update flags that name what happens: one is needed. */
const UPDATE_TRIGGERS = ['event', 'method', 'on-event', 'on-call', 'on-value', 'on-row', 'on-member', 'metric', 'each'];
// (--method and --on-call stay in the list so they are read as an alert on something happening, and refused: NO_CALLS)

/**
 * A condition's subject as one word (2026-11-07): --on metric:<name or id> names any metric, state or activity;
 * "metric:<name>=<clauses>" defines one for this alert, off the Metrics page. Rewritten to --value, which
 * the older form still takes.
 */
/** The metrics an alert create defined on the way (inline --on), deleted again if the alert is not made. */
export const MADE_FOR_ALERT: string[] = [];

export async function inlineMetrics(args: string[]): Promise<string[]> {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] !== '--on' && out[i] !== '--value') continue;
    const raw = out[i + 1];
    if (out[i] === '--on' && !/^metric:/i.test(raw)) continue;
    const ref = raw.replace(/^metric:/i, '').trim();
    const inline = inlineDefinition(ref);
    const value = inline ? (await defineInline(inline.name, inline.clauses)).id : ref;
    if (inline) MADE_FOR_ALERT.push(value);
    out[i] = '--value';
    out[i + 1] = value;
    i++;
  }
  return out;
}

export function reportArgs(rest: string[]): string[] {
  const ts = tokens(rest);
  if (has(ts, ...UPDATE_TRIGGERS)) throw new Error('A message each time something happens is an alert on an event: `contract-dev notify add alert … --event <Name> --message "…"` (try: notify help).');
  const [name, ...more] = positionals(ts);
  if (more.length) throw new Error(`Unexpected "${more[0]}": a report takes its name, then flags (try: notify help).`);
  return ['create', ...(name ? ['--name', name] : []), ...untokens(flagsOnly(ts))];
}

export function updateArgs(rest: string[]): string[] {
  const ts = tokens(rest);
  if (has(ts, 'call')) throw new Error('--call is a read, the way a metric takes one (metric define help); a method called on the contract is --method <name>.');
  if (!has(ts, ...UPDATE_TRIGGERS)) throw new Error('An alert on something happening needs what happens: --event <Name> (with --on <contract> or --group <group>), --on-value, --on-row, --on-member or --metric (try: notify help).');
  if (has(ts, 'silence', 'failures', 'overdue')) throw new Error('A contract going quiet, failing or leaving something unanswered is an alert on a condition: `contract-dev notify add alert … --silence` (try: notify help).');
  if (has(ts, 'on', 'group') && has(ts, 'scope')) throw new Error('Pass --on <contract> or --group <group>, not --scope as well.');
  // once per block since 2026-11-06: no summaries (figures every hour are a report: notify add report --every 1h)
  if (has(ts, 'digest')) throw new Error('An alert on something happening sends once per block, every match in the block in one message: it takes no --digest. Figures every hour are a report: `contract-dev notify add report --every 1h`.');
  const [name, ...more] = positionals(ts);
  if (more.length) throw new Error(`Unexpected "${more[0]}": an alert takes its name, then flags (try: notify help).`);
  const out: Token[] = [];
  if (has(ts, 'method', 'on-call')) throw new Error(NO_CALLS);
  for (const t of flagsOnly(ts) as Array<{ flag: string; value: string | null }>) {
    if (t.flag === 'event') out.push({ flag: 'on-event', value: t.value });
    else if (t.flag === 'call') throw new Error('--call is a read, the way a metric takes one (metric define help); a method called on the contract is --method <name>.');
    else if (t.flag === 'on') out.push({ flag: 'scope', value: t.value });
    else if (t.flag === 'group') out.push({ flag: 'scope', value: t.value === null ? null : `tag:${t.value}` });
    else out.push(t);
  }
  // a metric's records: the each-time form of a report
  if (has(ts, 'metric') && !has(ts, 'each')) out.unshift({ flag: 'each', value: null });
  return ['create', ...(name ? ['--name', name] : []), ...untokens(out)];
}

export function monitorArgs(rest: string[]): string[] {
  const ts = tokens(rest);
  if (has(ts, 'warn')) throw new Error('An alert on a condition has one line: --when. Make a second alert for a second line.');
  if (has(ts, 'call')) throw new Error('--call is a read, the way a metric takes one (metric define help); a method called on the contract is --method <name>.');
  if (has(ts, 'message', 'digest', ...UPDATE_TRIGGERS.filter((f) => f.startsWith('on-')))) throw new Error('A message each time something happens is an alert on an event: `contract-dev notify add alert … --event <Name> --message "…"` (try: notify help).');
  const sentence = has(ts, 'on', 'group', 'event', 'silence', 'failures', 'overdue');
  // an event firing is news: an update. A monitor on an event watches it stop, or waits for its answer.
  if (sentence && has(ts, 'event') && !has(ts, 'silence', 'failures', 'overdue')) {
    throw new Error('An event each time it is emitted is an alert on something happening: add --message (`contract-dev notify add alert … --event <Name> --message "…"`), or --silence to alert when it stops.');
  }
  const [name, valueArg, ...more] = positionals(ts);
  if (more.length) throw new Error(`Unexpected "${more[0]}": an alert takes its name, then flags (try: notify help).`);
  const valueFlag = (flagsOnly(ts) as Array<{ flag: string; value: string | null }>).find((t) => t.flag === 'value');
  const value = valueFlag?.value ?? valueArg;
  const rest2 = (flagsOnly(ts) as Array<{ flag: string; value: string | null }>).filter((t) => t.flag !== 'value');
  if (sentence) {
    if (value) throw new Error('Pass --on metric:"<metric>" for an alert on a metric, or --on <contract> with --silence or --failures for one on a contract, not both.');
    return ['add', ...untokens(rest2), ...(name ? ['--name', name] : [])];
  }
  if (!value) throw new Error('An alert on a condition needs what it watches: --on metric:"<metric>" --when "value < 25000", or --on <contract> --silence (try: notify help).');
  return ['add', value, ...untokens(rest2), ...(name ? ['--name', name] : [])];
}

/**
 * Which trigger an alert's flags describe: something happening (an event, a call, a value moving,
 * a row, a member, a monitor, a metric's records) unless it watches a contract go quiet or fail, or
 * names a metric against a line (--value with --when and no event, or a second positional).
 */
export function alertTrigger(rest: string[]): AlertTrigger {
  const ts = tokens(rest);
  if (has(ts, 'silence', 'failures', 'overdue')) return 'condition';
  if (has(ts, ...UPDATE_TRIGGERS)) return 'event';
  return 'condition';
}

/** The ids of the alerts a create made, whatever shape it answered in (one, several, a group's set). */
function createdIds(result: unknown): string[] {
  const out = new Set<string>();
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(walk);
    const o = x as Record<string, unknown>;
    const m = o.monitor as { id?: unknown } | undefined;
    if (m && typeof m.id === 'string') out.add(m.id);
    if (Array.isArray(o.created)) for (const c of o.created as { id?: unknown }[]) if (typeof c?.id === 'string') out.add(c.id);
    if (o.result) walk(o.result);
  };
  walk(result);
  return Array.from(out);
}

/** `--on table:"<table>"`: the table a row threshold is on, or null. */
function onTable(rest: string[]): string | null {
  const ts = tokens(rest);
  const on = (ts.find((t) => 'flag' in t && t.flag === 'on') as { value: string | null } | undefined)?.value ?? null;
  const m = on ? /^table:\s*(.+)$/i.exec(on) : null;
  return m ? m[1].trim().replace(/^"(.*)"$/, '$1') : null;
}

interface RowThresholdResult {
  table: { id: string; name: string; url?: string };
  monitor: { id: string; name: string; words?: string; rows?: number };
}

/**
 * A row threshold: one rule on every open row of a state table, on a read column (add_table_monitor).
 * Each row alerts and clears on its own; a row gets it when it opens and loses it when it finishes.
 */
async function addRowThreshold(rest: string[]): Promise<RowThresholdResult> {
  const ts = tokens(rest);
  const allowed = new Set(['on', 'column', 'when', 'name', 'to']);
  const bad = flagsOnly(ts).find((t) => !allowed.has((t as { flag: string }).flag)) as { flag: string } | undefined;
  if (bad) throw new Error(`--${bad.flag} is not taken on a row threshold: --on table:"<table>" --column <label> --when "<formula>" [--to <dest>…].`);
  const get = (k: string) => (flagsOnly(ts) as Array<{ flag: string; value: string | null }>).find((t) => t.flag === k)?.value ?? null;
  const table = onTable(rest)!;
  const column = get('column');
  const when = get('when');
  if (!column) throw new Error('A row threshold needs the read column it judges: --column "<label>" (contract-dev table show <table> lists them).');
  if (!when) throw new Error('A row threshold needs its rule: --when "value < 1000" (or value < {Other column}).');
  const [name, ...more] = positionals(ts);
  if (more.length) throw new Error(`Unexpected "${more[0]}": an alert takes its name, then flags (try: notify help).`);
  if (!name) throw new Error('Name the row threshold: contract-dev notify add alert "<name>" --on table:"<table>" --column … --when ….');
  const to = (flagsOnly(ts) as Array<{ flag: string; value: string | null }>).filter((t) => t.flag === 'to').flatMap((t) => {
    if (!t.value) throw new Error('--to needs a destination (see `contract-dev channels`).');
    return t.value.split(',').map((x) => x.trim()).filter(Boolean);
  });
  const r = await runTool<RowThresholdResult>(requireAuth(), 'add_table_monitor', { table, name, column, when, ...(to.length ? { to } : {}) });
  const rows = r.monitor.rows ?? 0;
  console.log(`Created row threshold "${r.monitor.name}" (${r.monitor.id}) on ${r.table.name}: ${r.monitor.words ?? when}.`);
  console.log(`${plural(rows, 'open row')} carry it now; each row opened from now gets it, each row finished loses it.`);
  console.log(to.length ? `Every row's alert sends to ${to.join(', ')}.` : 'No destination yet: its alerts show in the app until one is set (notify set <name> --to <dest>).');
  return r;
}

async function addNotification(args: string[]): Promise<unknown> {
  try {
    const made = await addNotificationOnce(args);
    MADE_FOR_ALERT.splice(0);
    return made;
  } catch (e) {
    // a metric defined for this alert goes with it when the alert is not made
    for (const id of MADE_FOR_ALERT.splice(0)) await runTool(requireAuth(), 'delete_metric', { metric: id }).catch(() => undefined);
    throw e;
  }
}

async function addNotificationOnce(args: string[]): Promise<unknown> {
  const [type, ...rawRest] = args;
  // --remind: a condition alert re-sent hourly while it holds (2026-11-06), set once it is made
  const remind = rawRest.includes('--remind');
  const rest = await inlineMetrics(rawRest.filter((a) => a !== '--remind'));
  switch (type) {
    case 'report':
    case 'reports':
      if (remind) throw new Error('--remind is for an alert on a condition: a report sends on its schedule.');
      return await reportCommand(reportArgs(rest));
    // the older names, kept for scripts: an update is an alert on something happening, a monitor one on a condition
    case 'alert':
    case 'alerts':
    case 'update':
    case 'updates':
    case 'monitor':
    case 'monitors': {
      const trigger = type.startsWith('update') ? 'event' : type.startsWith('monitor') ? 'condition' : alertTrigger(rest);
      if (trigger === 'event') {
        if (remind) throw new Error('--remind is for an alert on a condition: an alert on something happening sends once per block.');
        return await reportCommand(updateArgs(rest));
      }
      // a row threshold: --on table:"<table>" --column <label> --when "<formula>" (2026-11-08)
      if (onTable(rest) !== null) {
        if (remind) throw new Error('--remind is not taken on a row threshold: each open row alerts once, then the all-clear.');
        return await addRowThreshold(rest);
      }
      const made = await monitorCommand(monitorArgs(rest));
      if (remind) {
        const auth = requireAuth();
        const ids = createdIds(made);
        for (const id of ids) await apiRequest(auth, 'PATCH', `/api/mainnet/invariants/${id}`, { remind: true });
        if (ids.length > 0) console.log(`Reminders on: it is re-sent every hour while it holds, until it clears or is acknowledged.`);
      }
      return made;
    }
    default:
      throw new Error(`notify add takes a type first: report or alert${type ? ` (got "${type}")` : ''}. Try: notify help.`);
  }
}

// ── the rest: resolve the name across both, hand it to the command that owns it ──

async function setNotification(args: string[]): Promise<unknown> {
  const [ref, ...raw] = args;
  const { item } = await resolveItem(ref, 'notification (name or id)');
  const remind = raw.includes('--remind') ? true : raw.includes('--no-remind') ? false : null;
  const rest = raw.filter((a) => a !== '--remind' && a !== '--no-remind');
  if (item.source === 'table') return await setRowThresholdTo(item, raw);
  if (remind != null && item.trigger !== 'condition') throw new Error(`--remind is for an alert on a condition: "${item.name}" ${item.type === 'report' ? 'is a report' : 'sends each time something happens'}.`);
  if (item.source === 'report') return await reportCommand(['update', item.id, ...rest]);
  if (rest.includes('--warn')) throw new Error('An alert on a condition has one line: --when. --no-warn drops an older warning line.');
  let out: unknown = null;
  if (remind != null) {
    out = await apiRequest(requireAuth(), 'PATCH', `/api/mainnet/invariants/${item.id}`, { remind });
    console.log(remind ? `Reminders on for "${item.name}": re-sent every hour while it holds.` : `Reminders off for "${item.name}": one message, then the all-clear.`);
  }
  return rest.length > 0 ? await monitorCommand(['set', item.id, ...rest]) : out;
}

/** `notify set <row threshold> --to <dest>…` (or `--to none`): where the rule sends, every row's alert with it. Its rule is changed by making it again. */
async function setRowThresholdTo(item: NotifyItem, raw: string[]): Promise<unknown> {
  const flags = parseFlags(raw);
  const other = Object.keys(flags).filter((k) => k !== '_' && k !== 'to');
  if (other.length || !flag(flags, 'to') || flag(flags, 'to') === 'true')
    throw new Error(`"${item.name}" is a row threshold: \`notify set\` changes where it sends (--to <dest>…, or --to none). Its rule is changed by deleting it and adding it again.`);
  const auth = requireAuth();
  const refs = String(flag(flags, 'to')).split(',').map((x) => x.trim()).filter(Boolean);
  const channelIds = refs.length === 1 && refs[0].toLowerCase() === 'none' ? [] : resolveChannelIds(await listChannels(auth), refs);
  const r = await apiRequest<{ rows: number }>(auth, 'PATCH', `/api/console/tables/${item.tableId}/monitors`, { monitorId: item.id, channelIds });
  console.log(channelIds.length ? `"${item.name}" sends to ${refs.join(', ')}, on ${plural(r.rows, 'open row')} and every row that opens.` : `"${item.name}" sends nowhere: its alerts show in the app.`);
  return { id: item.id, channelIds, rows: r.rows };
}

async function renameNotification(args: string[]): Promise<unknown> {
  const [ref, name, ...more] = args;
  if (!name) throw new Error('Missing the new name: contract-dev notify rename <name> "<new name>"');
  if (more.length) throw new Error(`Unexpected "${more[0]}": quote a name with spaces.`);
  const { item } = await resolveItem(ref, 'notification (name or id)');
  if (item.source === 'table') throw new Error(`"${item.name}" is a row threshold: its name is set when it is made.`);
  if (item.source === 'report') return await reportCommand(['update', item.id, '--name', name]);
  return await monitorCommand(['rename', item.id, name]);
}

async function toggleNotification(args: string[], action: 'pause' | 'resume'): Promise<unknown> {
  const { item } = await resolveItem(args[0], 'notification (name or id)');
  if (item.source === 'table') {
    // every open row's alert; a row opened later carries the rule as made
    for (const id of item.rows ?? []) await apiRequest(requireAuth(), 'PATCH', `/api/mainnet/invariants/${id}`, { enabled: action === 'resume' });
    console.log(`${action === 'pause' ? 'Paused' : 'Resumed'} "${item.name}" on ${plural(item.rows?.length ?? 0, 'open row')}.`);
    return { id: item.id, rows: item.rows?.length ?? 0, enabled: action === 'resume' };
  }
  return item.source === 'report' ? await reportCommand([action, item.id]) : await monitorCommand([action, item.id]);
}

async function deleteNotifications(args: string[]): Promise<unknown[]> {
  if (!args.length) throw new Error('Missing required notification (name or id)');
  const { items } = await loadAll(requireAuth());
  // every name resolves before anything is deleted, so a typo deletes nothing
  const picked = args.map((ref) => matchItem(items, ref));
  const out: unknown[] = [];
  for (const item of picked) {
    if (item.source === 'table') {
      // the rule and every row's alert under it
      await apiRequest(requireAuth(), 'DELETE', `/api/console/tables/${item.tableId}/monitors?monitorId=${encodeURIComponent(item.id)}`);
      console.log(`Deleted row threshold "${item.name}" and its alert on ${plural(item.rows?.length ?? 0, 'open row')}.`);
      out.push({ id: item.id, deleted: true });
    } else out.push(item.source === 'report' ? await reportCommand(['delete', item.id]) : await monitorCommand(['delete', item.id]));
  }
  return out;
}

async function showNotification(args: string[]): Promise<unknown> {
  const [ref, ...rest] = args;
  const { item, loaded } = await resolveItem(ref, 'notification (name or id)');
  if (item.source === 'table') {
    const rows = loaded.monitors.filter((m) => (item.rows ?? []).includes(m.id)).map((m) => monitorItem(m, null));
    console.log(`${item.name}  (${item.id})`);
    console.log(`  type:        ${ALERT_TYPE_WORD.condition}`);
    console.log(`  trigger:     Row threshold`);
    console.log(`  alerts when: ${item.when}`);
    console.log(`  sends to:    ${item.sendsTo.length ? item.sendsTo.join(', ') : 'nobody: every alert shows on its page in the app'}`);
    console.log('');
    for (const line of table(rows, [
      { header: 'Row', value: (i) => i.name.split(' · ').slice(1).join(' · '), max: 40 },
      { header: 'Status', value: (i) => i.status },
      { header: 'Latest', value: (i) => (i.lastAt ? fmtAge(Date.parse(i.lastAt)) : DASH) },
      { header: 'Id', value: (i) => i.id },
    ]))
      console.log(line);
    return { ...item, rowAlerts: rows };
  }
  return item.source === 'report' ? await reportCommand(['show', item.id, ...rest]) : await monitorCommand(['show', item.id, ...rest]);
}

async function sendNotification(args: string[]): Promise<unknown> {
  const { item } = await resolveItem(args[0], 'notification (name or id)');
  if (item.type !== 'report') throw new Error(`"${item.name}" is an alert: it sends ${item.trigger === 'event' ? 'each time it happens' : 'when its condition is met'}. Only a report sends on demand.`);
  return await reportCommand(['run', item.id]);
}

async function ackNotification(args: string[]): Promise<{ id: string; acked: true }> {
  const { item, loaded } = await resolveItem(args[0], 'notification (name or id)');
  if (item.source === 'table') throw new Error(`"${item.name}" is a row threshold: it sends no reminders, so there is nothing to acknowledge.`);
  if (item.source !== 'monitor') throw new Error(`"${item.name}" sends each time something happens: there is nothing open to acknowledge.`);
  const open = loaded.monitors.find((m) => m.id === item.id)?.openIncident;
  if (!open) throw new Error(`"${item.name}" has no open alert.`);
  await apiRequest(requireAuth(), 'PATCH', `/api/mainnet/incidents/${open.id}`, { acked: true });
  console.log(`Acknowledged "${item.name}" — reminders stop; you'll still hear when it clears.`);
  return { id: open.id, acked: true };
}

export async function notifyCommand(args: string[] = []): Promise<unknown> {
  const [sub, ...rest] = args;
  if (sub !== undefined && sub !== 'add' && rest.some((a) => ['help', '-h', '--help'].includes(a))) {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return await listNotifications(rest);
    case 'add':
    case 'create':
    case 'new':
      if (rest.some((a) => ['help', '-h', '--help'].includes(a)) || rest.length === 0) {
        console.log(HELP);
        return;
      }
      return await addNotification(rest);
    case 'show':
      return await showNotification(rest);
    case 'set':
    case 'edit':
      return await setNotification(rest);
    case 'rename':
      return await renameNotification(rest);
    case 'pause':
      return await toggleNotification(rest, 'pause');
    case 'resume':
      return await toggleNotification(rest, 'resume');
    case 'delete':
    case 'remove':
    case 'rm':
      return await deleteNotifications(rest);
    case 'run':
    case 'send':
      return await sendNotification(rest);
    case 'ack':
      return await ackNotification(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      // `notify --type monitor`: the list's flags with no subcommand
      if (sub.startsWith('--')) return await listNotifications(args);
      console.error(`Unknown notify subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}
