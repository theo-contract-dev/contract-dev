import { parseFormulaCall } from './eventMetric';
import { parseFlags, flag, flagAll, requirePositional } from './_args';
import { apiRequest, ApiRequestError, requireAuth, ResolvedAuth } from '../credentials';
import { runTool } from '../tools';
import { listChannels, resolveChannelIds, type AlertChannel } from './monitor';
import { resolveMetric, type TrackedMetric } from './metrics';
import { chainFlag, resolveContract, workspaceContracts } from '../data';
import type { WatchedAccount } from './watch';
import { chainLabel, DASH, fmtLocalTime, fmtTime, shortAddr, table } from '../view';

const HELP = `contract-dev report — a table of your metrics, sent on a schedule, or a message each time something happens

Usage:
  contract-dev report list                                List reports (scope, cadence, destinations, next send, last run)
  contract-dev report create [--template daily|weekly] [--name "…"] [--scope <scope>] [--row <kind>[:<param>]]…
                             [--to <dest>…] [--at <hour>] [--on <weekday>] [--tz <zone>]
  contract-dev report preview [the same flags]            The table a draft would send, computed now, saved nowhere
  contract-dev report create --every 10m|1h|6h --name "…" --row <kind>[:<param>][ | <window>]… [--window 24h|7d|30d|90d]
                             [--snapshot] [--only-when "<expr>"] [--scope <scope>] [--to <dest>…]
                                                          A table every N minutes on the UTC clock; --snapshot prints
                                                          the figures alone (no change column); --only-when sends only
                                                          when the condition over the rows holds ({Breached markets} > 0)
  contract-dev report update <id|name> [--name "…"] [--row …]… [--add-row …]… [--remove-row <kind|label>]…
                             [--every …] [--window …] [--snapshot | --compare] [--only-when "<expr>" | --always]
                             [--at <hour>] [--on <weekday>] [--tz <zone>] [--scope <scope>] [--to <dest>…]
  contract-dev report create --each --metric "<event metric>" --when "<condition>" --message "<text>" [--name "…"] [--to <dest>…]
                                                          A message on every new record of the metric that meets --when
  contract-dev report create --on-event "Swap" | --on-call "transfer(address,uint256)" | --on-value "<tracked value>" |
                             --on-row "<table>[:opened|finished|both]" | --on-member "<group>[:joined|left|both]" |
                             --on-monitor "any|<monitor>[:fired|recovered|both]"
                             --message "<text>" [--when "<condition>"] [--digest 30m] [--scope <scope>] [--name "…"] [--to <dest>…]
                                                          A message each time it happens; --digest sends the matches as
                                                          one message every so often instead
  contract-dev report preview --each --metric … --when … --message …   How many it would have sent, and the newest few
  contract-dev report show <id|name>                      Settings, the latest table, every run and where it went
  contract-dev report run <id|name>                       Send it now (its destinations get it within a minute)
  contract-dev report pause <id|name> / resume <id|name>
  contract-dev report delete <id|name>

Flags (create and preview):
  --template daily|weekly   Start from the app's template: its name, cadence and rows
  --name "<text>"           The report's name (required without a template)
  --scope <scope>           workspace (default) · tag:<group> · a watched contract's address or name
                            (--chain <id> picks between the same address on two chains)
  --add-row <kind>[:<param>]  A row added after the template's (or --row's): --template daily --add-row customMetric:"Swap fees"
  --row <kind>[:<param>]    A row, in order; repeat for more. Given, they replace the template's rows. Kinds:
                            activeWallets · transactions · revertedShare · volumeInUsd · volumeOutUsd · tvlUsd ·
                            alertsOpened · eventCount:<event name> · trackedMetric:<id or label> ·
                            customMetric:<event or item metric name> ·
                            "formula:<Label>=<expr>[; call <name>=<call>]…[; token <t>][; show usd]" (the read grammar on
                            every contract in the scope, summed: calls as \`track formula\` takes them, dollars through a token)
  --to <dest>               Where it goes: channel ids, labels ("#alerts") or kinds (telegram) from
                            \`contract-dev channels\`; repeat or comma-separate. Optional: without one the
                            report still runs on schedule and its table shows in the app only, on the
                            report's page, until a destination is linked there.
  --at <hour>               The hour it sends, 0–23 on the report's own clock (default 9)
  --on <weekday>            Weekly reports: monday…sunday or 1–7 (default monday). Makes a report weekly.
  --tz <zone>               The IANA zone the schedule reads in (default: this machine's)

Each time: news, not trouble, so it never opens an alert and never makes a monitor.
  --each --metric "<name>"  The event metric whose records it follows (\`contract-dev metric events\`)
  --on-event "<event>"      An event on the scope's contracts, by name or signature; the report keeps an event
                            metric of its own for it (off the lists, deleted with it). --value "<expr>" says what
                            a record is worth (usd(amount, token)); without it each record counts 1.
  --on-call "<method>"      A method called on the scope's contracts: a signature or a 0x selector (needs --scope)
  --on-value "<value>"      A tracked value moving: each new reading, with the one before it
  --on-row "<table>[:on]"   A row of an item table: opened (default), finished, or both
  --on-member "<group>[:on]"  A contract joining (default) or leaving a group, or both
  --on-monitor "<m>[:on]"   A monitor firing (default), recovering, or both; "any" for every monitor
  --when "<condition>"      Which send: an event's value >= 10000; a value's {value} > {prev}; a row's columns by
                            {Label} and {what}; a member's {what}; a monitor's {level}, {what}; a call's {ok}, {value}
  --message "<text>"        What each says: text with {expressions} over what happened. An event: its value,
                            parameters, reads and fields; sender(), tx(); usd()/amount()/price(); name(address),
                            symbol(token), door(). A value: {value}, {prev}, {label}, {name(contract)}. A row: its
                            columns by {Label}, {id}, {what}, {name(contract)}. A member: {name(contract)}, {what},
                            {group}. A monitor: {monitor}, {level}, {what}, {name(contract)}. A call: {name(caller)},
                            {method}, {name(contract)}, {ok}. Dollar figures print as dollars; a message with a
                            transaction links it.
  --digest <every>          Hold the matches and send them as one message every 5m…12h or 1d (--no-digest on update)

Examples:
  contract-dev report create --each --name "Large swaps" --metric "Swap size (USD)" --when "value >= 10000" \\
    --message "{name(sender())} swapped {value} of {symbol(t0)} via {name(door())}" --to "#alerts"
  contract-dev report create --on-member "Wildcat markets" --message "{name(contract)} joined {group}" --to "#alerts"
  contract-dev report create --on-row "Loans:finished" --message "Loan {id} on {name(contract)} repaid: {Principal}" --digest 1h
  contract-dev report create --on-monitor any --message "{monitor} {what} on {name(contract)} ({level})" --to telegram
  contract-dev report create --template daily --to "#alerts"
  contract-dev report create --template weekly --scope tag:pools --on friday --at 17 --to telegram
  contract-dev report create --name "Swaps" --scope steth --row transactions --row eventCount:Swap --to "#alerts"
  contract-dev report preview --template daily --scope steth

A daily report prints the last 24h, its change against the day before, then 7d and 30d; a
weekly one 7d, its change, then 30d and 90d. A report is named by its id or, when
unambiguous, its name.
`;

export type ReportScope = { kind: 'workspace' } | { kind: 'tag'; tag: string } | { kind: 'contract'; chainId: number; address: string };

export type ReportCadence = 'daily' | 'weekly' | 'interval';

export interface ReportRowSpec {
  kind: string;
  /** `eventCount` names the event; `trackedMetric` names the tracked value; `formula` carries its calls and expression. */
  params?: { name?: string; id?: string; [k: string]: unknown };
  /** What the row is called in the table; the catalogue's label when absent. */
  label?: string | null;
  /** The window this row reads over, when not the report's. */
  window?: string;
  /** false: this row prints no change column. */
  compare?: boolean;
}

export interface CatalogueEntry {
  label: string;
  unit: string;
  scopes: string[];
  needs?: 'name' | 'id';
  definition: string;
}

export interface ReportView {
  id: string;
  name: string;
  enabled: boolean;
  scope: ReportScope;
  cadence: ReportCadence;
  /** 1 = Monday … 7 = Sunday; null for a daily report */
  weekday: number | null;
  hour: number;
  timezone: string;
  /** Interval reports: every N minutes (UTC clock), the window read, the change column, the sending condition. */
  everyMinutes?: number | null;
  window?: string | null;
  compare?: boolean;
  onlyWhen?: string | null;
  rows: ReportRowSpec[];
  origin: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  channels: AlertChannel[];
  lastRun: { id: string; status: string; periodKey: string; trigger: string; finishedAt: string | null; createdAt: string } | null;
  /** An each-time report: what it listens for (in words), which happenings send, its message and its digest. */
  each?: { kind: string; subject: string; metricId: string | null; metricName: string | null; when: string; message: string; digestMinutes: number | null } | null;
}

export interface ReportDelivery {
  id: string;
  channel: Pick<AlertChannel, 'id' | 'kind' | 'label' | 'target'> | null;
  status: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
}

export interface ReportRunView {
  id: string;
  /** '2026-10-12' · '2026-W41' · 'manual-<ms>' */
  periodKey: string;
  trigger: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: 'pending' | 'rendered' | 'sent' | 'partial' | 'failed' | string;
  error: string | null;
  table: unknown | null;
  /** An each-time report's run: the message it sent. */
  message?: { text: string; txUrl: string | null; time: number | null } | null;
  /** The run as plain text — what a chat destination shows. */
  text: string | null;
  deliveries: ReportDelivery[];
}

export interface ReportsPayload {
  reports: ReportView[];
  catalogue: Record<string, CatalogueEntry>;
  templates: Record<ReportCadence, { name: string; rows: ReportRowSpec[] }>;
  quota: { plan: string; used: number; limit: number; columns: 'period' | 'full' };
}

export interface PreviewPayload {
  table: unknown;
  text: string;
}

// ── the schedule, in words ──

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** monday…sunday (or a prefix of three letters or more), or 1–7 → 1 = Monday … 7 = Sunday. */
export function parseWeekday(raw: string): number {
  const v = raw.trim().toLowerCase();
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
  const i = WEEKDAYS.findIndex((d) => d === v || (v.length >= 3 && d.startsWith(v)));
  if (i >= 0) return i + 1;
  throw new Error(`--on must be a weekday (monday…sunday) or 1–7 (got: ${raw})`);
}

const weekdayName = (n: number | null | undefined): string => {
  const d = WEEKDAYS[(n ?? 1) - 1] ?? WEEKDAYS[0];
  return d[0].toUpperCase() + d.slice(1);
};

function parseHour(raw: string | undefined): number {
  if (raw === undefined) return 9;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error(`--at must be an hour from 0 to 23 (got: ${raw})`);
  return n;
}

export const machineTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function parseTimeZone(raw: string | undefined): string {
  if (raw === 'true') throw new Error('--tz needs a zone name, like Europe/London');
  const tz = (raw ?? '').trim() || machineTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`--tz must be an IANA zone name, like Europe/London (got: ${raw})`);
  }
  return tz;
}

/** daily 09:00 Australia/Sydney · weekly Monday 09:00 Europe/London */
/** `10m` · `1h` · `6h` */
export const everyWord = (minutes: number): string => (minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);

export function scheduleWords(r: Pick<ReportView, 'cadence' | 'weekday' | 'hour' | 'timezone' | 'each'> & { everyMinutes?: number | null; window?: string | null; compare?: boolean }): string {
  if (r.each) return `each time: ${r.each.subject}${r.each.when && r.each.when !== 'true' ? ` where ${r.each.when}` : ''}${r.each.digestMinutes ? ` · digest every ${everyWord(r.each.digestMinutes)}` : ''}`;
  if (r.cadence === 'interval') return `every ${everyWord(r.everyMinutes ?? 60)} · ${r.window ?? '24h'}${r.compare === false ? ' snapshot' : ''}`;
  const day = r.cadence === 'weekly' ? `${weekdayName(r.weekday)} ` : '';
  return `${r.cadence} ${day}${String(r.hour).padStart(2, '0')}:00 ${r.timezone}`;
}

const EVERY_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720];

/** `10m`, `15`, `1h`, `6h` → minutes, one of the intervals a report may run on. */
export function parseEvery(raw: string): number {
  const m = /^(\d+)\s*(m|min|minutes?|h|hours?)?$/i.exec(raw.trim());
  if (!m) throw new Error(`--every takes minutes or hours, like 10m or 1h (got: ${raw})`);
  const n = Number(m[1]) * (m[2] && /^h/i.test(m[2]) ? 60 : 1);
  if (!EVERY_MINUTES.includes(n)) throw new Error(`--every must be one of ${EVERY_MINUTES.map(everyWord).join(', ')} (got: ${raw})`);
  return n;
}

const WINDOWS = ['24h', '7d', '30d', '90d'];

export function parseWindow(raw: string, what = '--window'): string {
  const w = raw.trim().toLowerCase();
  if (!WINDOWS.includes(w)) throw new Error(`${what} must be one of ${WINDOWS.join(', ')} (got: ${raw})`);
  return w;
}

const at = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);

// ── scope and rows, from what a person types ──

/** The scope as the list shows it: Workspace · tag:pools · the contract's name, else its chain and address. */
export function scopeLabel(scope: ReportScope, contracts: WatchedAccount[] = []): string {
  if (scope.kind === 'workspace') return 'Workspace';
  if (scope.kind === 'tag') return `tag:${scope.tag}`;
  const lower = scope.address.toLowerCase();
  const hit = contracts.find((c) => c.chainId === scope.chainId && c.address.toLowerCase() === lower);
  return hit?.name ?? `${chainLabel(scope.chainId)} ${shortAddr(scope.address)}`;
}

/** workspace · tag:<group> · contract:<ref> · a watched contract's address or name. */
export async function parseScope(auth: ResolvedAuth, raw: string | undefined, chainId?: number): Promise<ReportScope> {
  if (raw === 'true') throw new Error('--scope needs a value: workspace, tag:<group>, or a contract');
  const ref = (raw ?? '').trim();
  if (!ref || ref.toLowerCase() === 'workspace') return { kind: 'workspace' };
  const tag = /^(?:tag|group):(.*)$/i.exec(ref);
  if (tag) {
    const name = tag[1].trim();
    if (!name) throw new Error('--scope tag: needs the group\'s name');
    return { kind: 'tag', tag: name };
  }
  const contract = await resolveContract(auth, ref.replace(/^contract:/i, ''), chainId);
  return { kind: 'contract', chainId: contract.chainId, address: contract.address.toLowerCase() };
}

/** `transactions` · `eventCount:Swap` · `trackedMetric:<id or label>` → the row the API stores. */
export async function parseRow(auth: ResolvedAuth, rawRow: string, catalogue: Record<string, CatalogueEntry>): Promise<ReportRowSpec> {
  // a row may read its own window and stand without a change column: --row "customMetric:Swap fees | 7d nocompare"
  let raw = rawRow;
  const extra: { window?: string; compare?: boolean } = {};
  const bar = rawRow.indexOf('|');
  if (bar >= 0) {
    raw = rawRow.slice(0, bar);
    for (const word of rawRow.slice(bar + 1).trim().split(/\s+/).filter(Boolean)) {
      if (/^nocompare$|^snapshot$/i.test(word)) extra.compare = false;
      else extra.window = parseWindow(word, `--row ${rawRow}: after |`);
    }
  }
  const i = raw.indexOf(':');
  const kindRaw = (i < 0 ? raw : raw.slice(0, i)).trim();
  const param = i < 0 ? '' : raw.slice(i + 1).trim();
  const row = await parseRowBase(auth, raw, kindRaw, param, catalogue);
  return { ...row, ...extra };
}

async function parseRowBase(auth: ResolvedAuth, raw: string, kindRaw: string, param: string, catalogue: Record<string, CatalogueEntry>): Promise<ReportRowSpec> {
  const kinds = Object.keys(catalogue);
  const kind = kinds.find((k) => k.toLowerCase() === kindRaw.toLowerCase());
  if (!kind) throw new Error(`Unknown row kind "${kindRaw}". One of: ${kinds.join(', ')}`);
  const entry = catalogue[kind];
  if (entry.needs === 'name') {
    if (!param) throw new Error(`${kind} names an event: --row ${kind}:Swap`);
    return { kind, params: { name: param } };
  }
  if (kind === 'customMetric') {
    // an event or item metric (metric define / metric item), by its name or id
    if (!param) throw new Error('customMetric names an event or item metric: --row customMetric:"Swap fees" (see `contract-dev metric events`)');
    const { metrics } = await apiRequest<{ metrics: Array<{ id: string; name: string }> }>(auth, 'GET', '/api/mainnet/custom-metrics');
    const lower = param.toLowerCase();
    const hit = (metrics ?? []).find((m) => m.id === param) ?? (metrics ?? []).find((m) => m.name.toLowerCase() === lower);
    if (!hit) throw new Error(`No event or item metric is called "${param}" (contract-dev metric events lists them).`);
    return { kind, params: { id: hit.id } };
  }
  if (kind === 'formula') return formulaRow(param);
  if (entry.needs === 'id') {
    if (!param) throw new Error(`${kind} names a tracked metric: --row ${kind}:<id or label> (see \`contract-dev metrics\`)`);
    const metric = await resolveMetric(auth, param);
    return { kind, params: { id: metric.id } };
  }
  if (param) throw new Error(`${kind} takes no parameter (got: ${raw})`);
  return { kind };
}

const FORMULA_ROW_HELP = 'formula takes Label=expression, then its calls: --row "formula:Headroom=held - debt; call held=totalAssets(); call debt=totalDebt() on 0xRisk…; token asset(); show usd"';

/** `formula:<Label>=<expr>; call <name>=<call>…; token <t>; show usd` (the read grammar, as a group column or a table formula takes it). */
function formulaRow(param: string): ReportRowSpec {
  const eq = param.indexOf('=');
  const label = eq > 0 ? param.slice(0, eq).trim() : '';
  const [expr = '', ...more] = (eq > 0 ? param.slice(eq + 1) : '').split(';').map((x) => x.trim());
  if (!label || !expr) throw new Error(FORMULA_ROW_HELP);
  const params: Record<string, unknown> = { expr };
  const calls: Record<string, unknown>[] = [];
  for (const part of more.filter(Boolean)) {
    const call = /^call\s+(.+)$/s.exec(part);
    if (call) {
      calls.push(parseFormulaCall(call[1]));
      continue;
    }
    const m = /^(token|show)\s+(\S+)$/.exec(part);
    if (!m) throw new Error(`formula: after the expression come "; call <name>=<call>", "; token <token>" or "; show usd" (got: ${part})`);
    params[m[1]] = m[2];
  }
  if (calls.length) params.calls = calls;
  return { kind: 'formula', label, params };
}

/** What a row is called: its label, the event's name, the tracked metric's label, else the catalogue's word. */
export function rowLabel(row: ReportRowSpec, catalogue: Record<string, CatalogueEntry>, metricNames = new Map<string, string>()): string {
  if (row.label && row.label.trim()) return row.label.trim();
  if (row.kind === 'eventCount' && row.params?.name) return row.params.name;
  if (row.kind === 'trackedMetric' && row.params?.id) return metricNames.get(row.params.id) ?? `Tracked metric ${row.params.id}`;
  return catalogue[row.kind]?.label ?? row.kind;
}

// The tracked metrics a report's rows name, by id — one read, and never a reason to fail.
async function metricNamesFor(auth: ResolvedAuth, rows: ReportRowSpec[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!rows.some((r) => r.kind === 'trackedMetric')) return names;
  try {
    const { trackedMetrics } = await apiRequest<{ trackedMetrics: TrackedMetric[] }>(auth, 'GET', '/api/mainnet/tracked-metrics');
    for (const m of trackedMetrics ?? []) if (m.label) names.set(m.id, m.label);
  } catch {
    /* the id still names it */
  }
  return names;
}

// ── finding a report ──

export async function loadReports(auth: ResolvedAuth): Promise<ReportsPayload> {
  const payload = await apiRequest<ReportsPayload>(auth, 'GET', '/api/mainnet/reports');
  return { ...payload, reports: payload.reports ?? [], catalogue: payload.catalogue ?? {}, templates: payload.templates ?? ({} as ReportsPayload['templates']) };
}

/**
 * One report from what a person would type: its id, or its name as the list shows it — exact
 * first, then a whole word of it, then any part — the way a contract is named.
 */
export function matchReport(reports: ReportView[], ref: string): ReportView {
  const byId = reports.find((r) => r.id === ref);
  if (byId) return byId;
  const q = ref.trim().toLowerCase();
  if (!q) throw new Error('Name a report: its id or its name.');
  const pick = (found: ReportView[]): ReportView | null => {
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error(`"${ref}" matches ${found.length} reports — use an id: ${found.map((r) => `${r.name} (${r.id})`).join(', ')}`);
    return null;
  };
  const word = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
  const hit =
    pick(reports.filter((r) => r.name.toLowerCase() === q)) ??
    pick(reports.filter((r) => word.test(r.name.toLowerCase()))) ??
    pick(reports.filter((r) => r.name.toLowerCase().includes(q)));
  if (hit) return hit;
  throw new Error(`No report matches "${ref}" (run \`contract-dev report list\` to list them).`);
}

export async function resolveReport(auth: ResolvedAuth, ref: string): Promise<{ report: ReportView; payload: ReportsPayload }> {
  const payload = await loadReports(auth);
  return { report: matchReport(payload.reports, ref), payload };
}

// ── printing ──

const describeChannel = (c: Pick<AlertChannel, 'kind' | 'label' | 'target'>) => `${c.kind} ${c.label ?? c.target}`;

/** The settings block under a report's name — what `show` and `create` print. */
export function settingsLines(r: ReportView, catalogue: Record<string, CatalogueEntry>, contracts: WatchedAccount[] = [], metricNames = new Map<string, string>()): string[] {
  if (r.each) {
    const each = [
      `  scope:      ${scopeLabel(r.scope, contracts)}`,
      `  sends:      each time ${r.each.kind === 'metricRecord' && !r.each.subject.endsWith(' fires') ? `"${r.each.subject}" has a record` : r.each.subject}${r.each.when && r.each.when !== 'true' ? ` where ${r.each.when}` : ''}`,
      `  says:       ${r.each.message}`,
      ...(r.each.digestMinutes ? [`  digest:     one message every ${everyWord(r.each.digestMinutes)}`] : []),
      `  sends to:   ${r.channels.length ? r.channels.map(describeChannel).join(', ') : 'nobody'}`,
      `  state:      ${r.enabled ? 'on' : 'paused'}`,
    ];
    if (r.lastRunAt) each.push(`  last sent:  ${fmtLocalTime(at(r.lastRunAt))}`);
    return each;
  }
  const lines = [
    `  scope:      ${scopeLabel(r.scope, contracts)}`,
    `  schedule:   ${scheduleWords(r)}`,
    ...(r.onlyWhen ? [`  only when:  ${r.onlyWhen}`] : []),
    `  rows:       ${r.rows.map((row) => `${rowLabel(row, catalogue, metricNames)}${row.window ? ` (${row.window})` : ''}`).join(' · ')}`,
    `  sends to:   ${r.channels.length ? r.channels.map(describeChannel).join(', ') : 'nobody'}`,
    `  next send:  ${r.enabled ? fmtLocalTime(at(r.nextRunAt)) : 'paused'}`,
  ];
  if (r.lastRunAt) lines.push(`  last run:   ${fmtLocalTime(at(r.lastRunAt))}${r.lastRun ? ` · ${r.lastRun.status}` : ''}`);
  return lines;
}

// a scheduled run is named by its period, a manual or each-time one by when it was for
const runPeriod = (run: ReportRunView): string => (run.periodKey.startsWith('manual-') || !/^schedul/.test(run.trigger) ? fmtTime(at(run.scheduledFor)) : run.periodKey);

/** The run history: one line per run under a header, one per delivery beneath each run. */
export function runLines(runs: ReportRunView[]): string[] {
  const lines = [`  runs: ${runs.length}${runs.length ? ' (newest first)' : ''}`];
  if (!runs.length) return lines;
  const rows = table(
    runs,
    [
      { header: 'Period', value: runPeriod },
      { header: 'Trigger', value: (r) => r.trigger },
      { header: 'Status', value: (r) => r.status },
      // a table rendered with nowhere to send is done, not failed: it shows here and in the app
      { header: 'Finished', value: (r) => `${r.finishedAt ? fmtTime(at(r.finishedAt)) : 'not finished'}${r.error ? (r.status === 'rendered' && r.error === 'No destinations' ? '  not sent: no destination yet' : `  error: ${r.error}`) : ''}` },
    ],
    '    ',
  );
  lines.push(rows[0]);
  runs.forEach((run, i) => {
    lines.push(rows[i + 1]);
    for (const d of run.deliveries) {
      const dest = d.channel ? describeChannel(d.channel) : 'a removed destination';
      const attempts = d.attempts > 1 ? `  ${d.attempts} attempts` : '';
      lines.push(`      ${d.status.padEnd(8)} ${dest}${d.sentAt ? `  sent ${fmtTime(at(d.sentAt))}` : ''}${d.lastError ? `  error: ${d.lastError}` : ''}${attempts}`);
    }
  });
  return lines;
}

// ── commands ──

export async function reportCommand(args: string[] = []): Promise<unknown> {
  const [sub, ...rest] = args;
  // `report create help` (any subcommand) answers with the help, as every command does
  if (sub !== undefined && rest.some((a) => ['help', '-h', '--help'].includes(a))) {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case undefined:
    case 'list':
      return await listReports();
    case 'show':
      return await showReport(rest);
    case 'create':
    case 'add':
      return await createReport(rest);
    case 'preview':
      return await previewReport(rest);
    case 'run':
    case 'send':
      return await runReport(rest);
    case 'pause':
      return await patchReport(rest, 'pause');
    case 'resume':
      return await patchReport(rest, 'resume');
    case 'update':
    case 'edit':
      return await updateReport(rest);
    case 'delete':
    case 'remove':
    case 'rm':
      return await deleteReport(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown report subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function listReports(): Promise<ReportsPayload> {
  const auth = requireAuth();
  const payload = await loadReports(auth);
  const reports = payload.reports;
  if (!reports.length) {
    console.log('No reports. Create one with `contract-dev report create --template daily --to <dest>`.');
    return payload;
  }
  const contracts = reports.some((r) => r.scope.kind === 'contract') ? await workspaceContracts(auth).catch(() => [] as WatchedAccount[]) : [];
  for (const line of table(reports, [
    { header: 'Name', value: (r) => r.name, max: 32 },
    { header: 'Scope', value: (r) => scopeLabel(r.scope, contracts), max: 28 },
    { header: 'Cadence', value: scheduleWords },
    { header: 'Sends to', value: (r) => r.channels.map((c) => c.label ?? c.target).join(', ') || 'nobody', max: 40 },
    { header: 'Next send', value: (r) => (!r.enabled ? 'paused' : r.each ? 'each match' : fmtLocalTime(at(r.nextRunAt))) },
    { header: 'Last run', value: (r) => r.lastRun?.status ?? DASH },
  ])) {
    console.log(line);
  }
  return payload;
}

async function showReport(args: string[]): Promise<{ report: ReportView; runs: ReportRunView[] }> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'report (id or name)');
  const auth = requireAuth();
  const { report: found, payload } = await resolveReport(auth, ref);
  const [{ report, runs }, contracts, metricNames] = await Promise.all([
    apiRequest<{ report: ReportView; runs: ReportRunView[] }>(auth, 'GET', `/api/mainnet/reports/${found.id}`),
    found.scope.kind === 'contract' ? workspaceContracts(auth).catch(() => [] as WatchedAccount[]) : Promise.resolve([] as WatchedAccount[]),
    metricNamesFor(auth, found.rows),
  ]);
  const history = runs ?? [];

  console.log(`${report.name}  (${report.id})${report.enabled ? '' : '  (paused)'}`);
  for (const line of settingsLines(report, payload.catalogue, contracts, metricNames)) console.log(line);
  console.log('');
  const latest = history[0];
  if (!latest) console.log('No runs');
  else if (latest.text) console.log(latest.text);
  else console.log(`Latest run ${latest.status}${latest.error ? `: ${latest.error}` : ''}`);
  console.log('');
  for (const line of runLines(history)) console.log(line);
  return { report, runs: history };
}

interface Draft {
  name?: string;
  scope: ReportScope;
  cadence: ReportCadence;
  weekday?: number;
  hour: number;
  timezone: string;
  everyMinutes?: number;
  window?: string;
  compare?: boolean;
  onlyWhen?: string;
  rows: ReportRowSpec[];
}

/** --every, --window, --snapshot/--compare and --only-when/--always, as a create or an update body takes them. */
function shapeFlags(flags: ReturnType<typeof parseFlags>): { everyMinutes?: number; window?: string | null; compare?: boolean; onlyWhen?: string | null } {
  const out: { everyMinutes?: number; window?: string | null; compare?: boolean; onlyWhen?: string | null } = {};
  const every = flag(flags, 'every');
  if (every !== undefined) {
    if (every === 'true') throw new Error('--every needs an interval, like 10m or 1h');
    out.everyMinutes = parseEvery(every);
  }
  const window = flag(flags, 'window');
  if (window !== undefined) {
    if (window === 'true') throw new Error('--window needs one of 24h, 7d, 30d, 90d');
    out.window = parseWindow(window);
  }
  if (flag(flags, 'snapshot') !== undefined && flag(flags, 'compare') !== undefined) throw new Error('Pass --snapshot (figures alone) or --compare (with the change column), not both.');
  if (flag(flags, 'snapshot') !== undefined) out.compare = false;
  if (flag(flags, 'compare') !== undefined) out.compare = true;
  const onlyWhen = flag(flags, 'only-when');
  if (onlyWhen !== undefined) {
    if (onlyWhen === 'true' || !onlyWhen.trim()) throw new Error('--only-when takes a condition over the rows by label: --only-when "{Breached markets} > 0"');
    out.onlyWhen = onlyWhen.trim();
  }
  if (flag(flags, 'always') !== undefined) out.onlyWhen = null;
  return out;
}

// A create or preview body from the flags, the way the app's drawer builds one: a template
// gives the name, cadence and rows; --row replaces the rows; --on makes it weekly; --every
// makes it an interval report.
async function buildDraft(auth: ResolvedAuth, flags: ReturnType<typeof parseFlags>, payload: ReportsPayload, mode: 'create' | 'preview'): Promise<Draft> {
  const templateRaw = flag(flags, 'template');
  let templateKey: 'daily' | 'weekly' | null = null;
  if (templateRaw !== undefined) {
    const key = templateRaw.trim().toLowerCase();
    if (key !== 'daily' && key !== 'weekly') throw new Error(`--template must be daily or weekly (got: ${templateRaw})`);
    templateKey = key;
  }
  const template = templateKey ? payload.templates[templateKey] : null;
  if (templateKey && !template) throw new Error(`The server has no ${templateKey} template — pass --name and --row instead.`);

  const shape = shapeFlags(flags);
  const onRaw = flag(flags, 'on');
  const cadence: ReportCadence = shape.everyMinutes !== undefined ? 'interval' : (templateKey ?? (onRaw !== undefined ? 'weekly' : 'daily'));
  if (cadence === 'interval' && templateKey) throw new Error('--every makes an interval report; a template is daily or weekly. Pass --row instead.');
  if (onRaw !== undefined && cadence !== 'weekly') throw new Error('--on is for a weekly report (--template weekly)');
  const weekday = cadence === 'weekly' ? (onRaw !== undefined ? parseWeekday(onRaw) : 1) : undefined;
  const hour = cadence === 'interval' ? 0 : parseHour(flag(flags, 'at'));
  const timezone = cadence === 'interval' ? 'UTC' : parseTimeZone(flag(flags, 'tz'));

  const nameRaw = flag(flags, 'name');
  if (nameRaw === 'true') throw new Error('--name needs a value');
  const name = (nameRaw ?? '').trim() || template?.name;
  if (!name && mode === 'create') throw new Error('Name the report with --name, or start from --template daily|weekly.');

  const scope = await parseScope(auth, flag(flags, 'scope'), chainFlag(flags));
  const rowRefs = flagAll(flags, 'row');
  const rows: ReportRowSpec[] = [];
  for (const ref of rowRefs) rows.push(await parseRow(auth, ref, payload.catalogue));
  if (!rows.length) rows.push(...(template?.rows ?? []));
  // --add-row keeps the template's (or --row's) rows and appends: the daily template plus a protocol's own number
  for (const ref of flagAll(flags, 'add-row')) rows.push(await parseRow(auth, ref, payload.catalogue));
  if (!rows.length) throw new Error('Pick rows with --row <kind>[:<param>], or start from --template daily|weekly.');

  const shaped = Object.fromEntries(Object.entries(shape).filter(([, v]) => v !== undefined && v !== null)) as Pick<Draft, 'everyMinutes' | 'window' | 'compare' | 'onlyWhen'>;
  return { ...(name ? { name } : {}), scope, cadence, ...(weekday !== undefined ? { weekday } : {}), hour, timezone, ...shaped, rows };
}

const toRefs = (flags: ReturnType<typeof parseFlags>): string[] =>
  flagAll(flags, 'to')
    .filter((v) => v !== 'true')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);

const ON_FLAGS: Record<string, string> = { 'on-event': 'event', 'on-call': 'call', 'on-value': 'value', 'on-row': 'row', 'on-member': 'member', 'on-monitor': 'monitor' };
const DIGEST_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];

/** `--each`, or one of the `--on-*` triggers, asks for an each-time report. */
export const isEach = (flags: ReturnType<typeof parseFlags>): boolean => flag(flags, 'each') !== undefined || Object.keys(ON_FLAGS).some((k) => flag(flags, k) !== undefined);

/** `--digest 30m|1h|1d` → minutes. */
export function parseDigest(raw: string): number {
  const m = /^(\d+)\s*(m|min|h|hr|d)?$/i.exec(raw.trim());
  const n = m ? Number(m[1]) * (m[2]?.toLowerCase().startsWith('h') ? 60 : m[2]?.toLowerCase() === 'd' ? 1440 : 1) : NaN;
  if (!DIGEST_MINUTES.includes(n)) throw new Error(`--digest must be one of 5m, 10m, 15m, 30m, 1h, 2h, 3h, 6h, 12h, 1d (got: ${raw})`);
  return n;
}

type EachParts = { metric?: string; trigger?: Record<string, string>; when?: string; message: string; digestMinutes?: number };

/** An each-time report's parts: what it listens for (--each --metric, or one --on-*), --when, --message and --digest. */
function eachParts(flags: ReturnType<typeof parseFlags>): EachParts {
  const get = (k: string) => {
    const v = flag(flags, k);
    return v === undefined || v === 'true' ? '' : v.trim();
  };
  const ons = Object.keys(ON_FLAGS).filter((k) => flag(flags, k) !== undefined);
  if (ons.length > 1) throw new Error(`Pass one trigger, not ${ons.map((k) => `--${k}`).join(' and ')}.`);
  const message = get('message');
  const when = get('when');
  const digest = get('digest');
  const out: EachParts = { message, ...(when ? { when } : {}), ...(digest ? { digestMinutes: parseDigest(digest) } : {}) };
  if (ons.length === 1) {
    const kind = ON_FLAGS[ons[0]];
    const raw = get(ons[0]);
    if (!raw) throw new Error(`--${ons[0]} needs ${kind === 'event' ? 'the event (Swap, or its signature)' : kind === 'call' ? 'the method (transfer(address,uint256), or a 0x selector)' : kind === 'value' ? 'the tracked value (its label or id)' : kind === 'row' ? 'the table (its name)[:opened|finished|both]' : kind === 'member' ? 'the group[:joined|left|both]' : 'a monitor or any[:fired|recovered|both]'}.`);
    const trigger: Record<string, string> = { kind };
    if (kind === 'event') {
      trigger.event = raw;
      const value = get('value');
      if (value) trigger.value = value;
    } else if (kind === 'call') trigger.method = raw;
    else if (kind === 'value') trigger.metric = raw;
    else {
      // "<subject>:<on>": the last colon word, when it is one of the kind's words
      const m = /^(.*?)(?::(opened|finished|joined|left|fired|recovered|both))?$/i.exec(raw)!;
      trigger[kind === 'row' ? 'table' : kind === 'member' ? 'group' : 'monitor'] = m[1].trim();
      if (m[2]) trigger.on = m[2].toLowerCase();
    }
    if (!message) throw new Error(`--${ons[0]} needs --message: what each message says.`);
    out.trigger = trigger;
    return out;
  }
  const parts = { metric: get('metric'), when, message };
  const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => `--${k}`);
  if (missing.length) throw new Error(`--each needs ${missing.join(', ')}: the event metric it follows, which records send (--when "value >= 10000") and what each message says.`);
  out.metric = parts.metric;
  return out;
}

interface EachPreview {
  each: { days: number; from: string | null; looked: number; matches: number; unvalued?: number; samples: { time: string; text: string; txUrl: string }[] };
  note: string;
}

function printEachPreview(p: EachPreview['each']): void {
  console.log(p.matches === 0 ? `None of the metric's records since ${p.from ? fmtLocalTime(at(p.from)) : 'it began'} would have sent.` : `It would have sent ${p.matches} message${p.matches === 1 ? '' : 's'} since ${p.from ? fmtLocalTime(at(p.from)) : 'the metric began'}.`);
  for (const s of p.samples) console.log(`  ${fmtLocalTime(at(s.time))}  ${s.text}`);
  if (p.unvalued) console.log(`${p.unvalued} of ${p.looked} records have no value (a token with no price, a read with no answer) and can never send.`);
}

async function createEachReport(auth: ResolvedAuth, flags: ReturnType<typeof parseFlags>, refs: string[]): Promise<ReportView> {
  const parts = eachParts(flags);
  const nameRaw = flag(flags, 'name');
  const subject = parts.metric ?? parts.trigger?.event ?? parts.trigger?.method ?? parts.trigger?.metric ?? parts.trigger?.table ?? parts.trigger?.group ?? parts.trigger?.monitor ?? 'any monitor';
  const name = nameRaw && nameRaw !== 'true' ? nameRaw.trim() : `Each time: ${subject}`;
  const channelIds = refs.length ? resolveChannelIds(await listChannels(auth), refs) : [];
  const scope = flag(flags, 'scope') !== undefined ? { scope: await parseScope(auth, flag(flags, 'scope'), chainFlag(flags)) } : {};
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'POST', '/api/mainnet/reports', { name, cadence: 'each', ...parts, ...scope, channelIds });
  console.log(`Created report "${report.name}" (${report.id}).`);
  for (const line of settingsLines(report, {})) console.log(line);
  console.log('It sends on every new match from now; the history never sends.');
  if (!channelIds.length) console.log("No destination yet: each message shows on the report's page in the app until one is linked.");
  return report;
}

async function createReport(args: string[]): Promise<ReportView> {
  const flags = parseFlags(args);
  const refs = toRefs(flags);

  const auth = requireAuth();
  if (isEach(flags)) return createEachReport(auth, flags, refs);
  const payload = await loadReports(auth);
  const draft = await buildDraft(auth, flags, payload, 'create');
  // A report needs no destination to exist: it runs on schedule and its table shows on its page.
  const channelIds = refs.length ? resolveChannelIds(await listChannels(auth), refs) : [];

  // runNow: the first table is queued at once rather than waiting for the schedule
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'POST', '/api/mainnet/reports', { ...draft, channelIds, runNow: true });
  const metricNames = await metricNamesFor(auth, report.rows);
  const contracts = report.scope.kind === 'contract' ? await workspaceContracts(auth).catch(() => [] as WatchedAccount[]) : [];
  console.log(`Created report "${report.name}" (${report.id}).`);
  for (const line of settingsLines(report, payload.catalogue, contracts, metricNames)) console.log(line);
  console.log("First table queued: it shows on the report's page within a minute, then the report runs on schedule.");
  if (!channelIds.length) console.log("No destination yet: the table shows on the report's page in the app until one is linked.");
  return report;
}

async function previewReport(args: string[]): Promise<PreviewPayload | EachPreview> {
  const flags = parseFlags(args);
  const auth = requireAuth();
  if (isEach(flags)) {
    const parts = eachParts(flags);
    if (!parts.metric) throw new Error('A preview looks back over an event metric\'s records (--each --metric … --when …). A report on another trigger has nothing to look back on: create it and it sends from now.');
    const preview = await runTool<EachPreview>(auth, 'preview_report', { cadence: 'each', ...parts });
    printEachPreview(preview.each);
    return preview;
  }
  const payload = await loadReports(auth);
  const draft = await buildDraft(auth, flags, payload, 'preview');
  const body = {
    ...(draft.name ? { name: draft.name } : {}),
    scope: draft.scope,
    cadence: draft.cadence,
    timezone: draft.timezone,
    ...(draft.everyMinutes !== undefined ? { everyMinutes: draft.everyMinutes } : {}),
    ...(draft.window !== undefined ? { window: draft.window } : {}),
    ...(draft.compare !== undefined ? { compare: draft.compare } : {}),
    rows: draft.rows,
  };
  // Computing a table reads every window the rows need; the server allows itself a minute.
  const preview = await apiRequest<PreviewPayload>(auth, 'POST', '/api/mainnet/reports/preview', body, { timeoutMs: 60_000 });
  console.log(preview.text);
  return preview;
}

async function runReport(args: string[]): Promise<ReportRunView> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'report (id or name)');
  const auth = requireAuth();
  const { report } = await resolveReport(auth, ref);
  let run: ReportRunView;
  try {
    ({ run } = await apiRequest<{ run: ReportRunView }>(auth, 'POST', `/api/mainnet/reports/${report.id}/run`, undefined, { timeoutMs: 60_000 }));
  } catch (err) {
    // A run the server computed and filed as failed comes back as an error status with the run on it.
    const failed = err instanceof ApiRequestError ? (err.payload as { run?: ReportRunView } | null)?.run : undefined;
    if (!failed) throw err;
    run = failed;
  }
  if (run.status === 'failed') throw new Error(`Run ${run.id} of "${report.name}" failed: ${run.error ?? 'the table could not be computed'}`);
  if (run.status === 'skipped') console.log(`Not sent: the condition of "${report.name}"${report.onlyWhen ? ` (${report.onlyWhen})` : ''} did not hold. The table is on the report's page (run ${run.id}).`);
  else console.log(`Sending "${report.name}" now (run ${run.id}, ${run.status}) — its destinations get it within a minute.`);
  if (run.text) {
    console.log('');
    console.log(run.text);
  }
  return run;
}

/** `report update <ref> …`: the parts that change, as a PATCH; rows replaced whole with --row, grown with --add-row, pruned with --remove-row. */
async function updateReport(args: string[]): Promise<ReportView> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'report (id or name)');
  const auth = requireAuth();
  const { report: existing, payload } = await resolveReport(auth, ref);
  if (existing.each) return await updateEachReport(auth, existing, flags, payload);
  const body: Record<string, unknown> = { ...shapeFlags(flags) };
  const nameRaw = flag(flags, 'name');
  if (nameRaw !== undefined) {
    if (nameRaw === 'true' || !nameRaw.trim()) throw new Error('--name needs a value');
    body.name = nameRaw.trim();
  }
  if (flag(flags, 'scope') !== undefined) body.scope = await parseScope(auth, flag(flags, 'scope'), chainFlag(flags));
  const onRaw = flag(flags, 'on');
  if (onRaw !== undefined) {
    body.cadence = 'weekly';
    body.weekday = parseWeekday(onRaw);
  }
  if (flag(flags, 'at') !== undefined) body.hour = parseHour(flag(flags, 'at'));
  if (flag(flags, 'tz') !== undefined) body.timezone = parseTimeZone(flag(flags, 'tz'));
  if (body.everyMinutes !== undefined) body.cadence = 'interval';
  const rowRefs = flagAll(flags, 'row');
  const addRefs = flagAll(flags, 'add-row');
  const removeRefs = flagAll(flags, 'remove-row').map((r) => r.trim().toLowerCase());
  if (rowRefs.length && (addRefs.length || removeRefs.length)) throw new Error('Pass --row (the whole list) or --add-row/--remove-row, not both.');
  if (rowRefs.length) {
    const rows: ReportRowSpec[] = [];
    for (const r of rowRefs) rows.push(await parseRow(auth, r, payload.catalogue));
    body.rows = rows;
  } else if (addRefs.length || removeRefs.length) {
    const metricNames = await metricNamesFor(auth, existing.rows);
    const kept = existing.rows.filter((r) => !removeRefs.includes(r.kind.toLowerCase()) && !removeRefs.includes(rowLabel(r, payload.catalogue, metricNames).toLowerCase()));
    const missing = removeRefs.filter((d) => !existing.rows.some((r) => r.kind.toLowerCase() === d || rowLabel(r, payload.catalogue, metricNames).toLowerCase() === d));
    if (missing.length) throw new Error(`"${existing.name}" has no row ${missing.join(', ')}. Its rows: ${existing.rows.map((r) => rowLabel(r, payload.catalogue, metricNames)).join(', ')}.`);
    const added: ReportRowSpec[] = [];
    for (const r of addRefs) added.push(await parseRow(auth, r, payload.catalogue));
    body.rows = [...kept, ...added.filter((a) => !kept.some((k) => k.kind === a.kind && (k.params?.id ?? null) === (a.params?.id ?? null) && (k.params?.name ?? null) === (a.params?.name ?? null)))];
  }
  const refs = toRefs(flags);
  if (refs.length) body.channelIds = resolveChannelIds(await listChannels(auth), refs);
  if (Object.keys(body).length === 0) throw new Error('Nothing to change: pass --name, --row/--add-row/--remove-row, --every, --window, --snapshot/--compare, --only-when/--always, --at, --on, --tz, --scope or --to.');
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'PATCH', `/api/mainnet/reports/${existing.id}`, body);
  const metricNames = await metricNamesFor(auth, report.rows);
  const contracts = report.scope.kind === 'contract' ? await workspaceContracts(auth).catch(() => [] as WatchedAccount[]) : [];
  console.log(`Updated report "${report.name}" (${report.id}).`);
  for (const line of settingsLines(report, payload.catalogue, contracts, metricNames)) console.log(line);
  return report;
}

/** `report update` on an each-time report: --when, --message, --digest/--no-digest, --on, --name, --to. */
async function updateEachReport(auth: ResolvedAuth, existing: ReportView, flags: ReturnType<typeof parseFlags>, payload: ReportsPayload): Promise<ReportView> {
  const body: Record<string, unknown> = {};
  const get = (k: string) => {
    const v = flag(flags, k);
    return v === undefined ? undefined : v === 'true' ? '' : v.trim();
  };
  for (const k of ['row', 'add-row', 'remove-row', 'every', 'window', 'snapshot', 'compare', 'only-when', 'always', 'at', 'tz', 'scope'])
    if (flag(flags, k) !== undefined) throw new Error(`"${existing.name}" sends each time something happens; --${k} is for a scheduled report. Change --when, --message, --digest, --on, --name or --to.`);
  const name = get('name');
  if (name !== undefined) {
    if (!name) throw new Error('--name needs a value');
    body.name = name;
  }
  const when = get('when');
  if (when !== undefined) body.when = when;
  const message = get('message');
  if (message !== undefined) {
    if (!message) throw new Error('--message needs a value');
    body.message = message;
  }
  const digest = get('digest');
  if (digest !== undefined) {
    if (!digest) throw new Error('--digest needs an interval, like 30m or 1h');
    body.digestMinutes = parseDigest(digest);
  }
  if (flag(flags, 'no-digest') !== undefined) body.digestMinutes = null;
  const on = get('on');
  if (on !== undefined) body.on = on;
  const metric = get('metric');
  if (metric !== undefined) body.metric = metric;
  const refs = toRefs(flags);
  if (refs.length) body.channelIds = resolveChannelIds(await listChannels(auth), refs);
  if (Object.keys(body).length === 0) throw new Error('Nothing to change: pass --when, --message, --digest/--no-digest, --on, --name or --to.');
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'PATCH', `/api/mainnet/reports/${existing.id}`, body);
  console.log(`Updated report "${report.name}" (${report.id}).`);
  for (const line of settingsLines(report, payload.catalogue)) console.log(line);
  return report;
}

async function patchReport(args: string[], action: 'pause' | 'resume'): Promise<ReportView> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'report (id or name)');
  const auth = requireAuth();
  const { report: existing } = await resolveReport(auth, ref);
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'PATCH', `/api/mainnet/reports/${existing.id}`, { enabled: action === 'resume' });
  if (action === 'pause') console.log(`Paused "${report.name}" — nothing sends until it is resumed.`);
  else console.log(`Resumed "${report.name}" — next send ${fmtLocalTime(at(report.nextRunAt))}.`);
  return report;
}

async function deleteReport(args: string[]): Promise<{ ok: true; id: string }> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'report (id or name)');
  const auth = requireAuth();
  const { report: existing } = await resolveReport(auth, ref);
  await apiRequest(auth, 'DELETE', `/api/mainnet/reports/${existing.id}`);
  console.log(`Deleted report "${existing.name}" (${existing.id}) and its run history.`);
  return { ok: true, id: existing.id };
}
