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
  contract-dev report create --each --metric "<event metric>" --when "<condition>" --message "<text>" [--name "…"] [--to <dest>…]
                                                          A message on every new record of the metric that meets --when
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
                            customMetric:<event or item metric name>
  --to <dest>               Where it goes: channel ids, labels ("#alerts") or kinds (telegram) from
                            \`contract-dev channels\`; repeat or comma-separate. Optional: without one the
                            report still runs on schedule and its table shows in the app only, on the
                            report's page, until a destination is linked there.
  --at <hour>               The hour it sends, 0–23 on the report's own clock (default 9)
  --on <weekday>            Weekly reports: monday…sunday or 1–7 (default monday). Makes a report weekly.
  --tz <zone>               The IANA zone the schedule reads in (default: this machine's)

Each time (--each): news, not trouble, so it never opens an alert.
  --metric "<name>"         The event metric whose records it follows (\`contract-dev metric events\`)
  --when "<condition>"      Which records send: value >= 10000
  --message "<text>"        What each says: text with {expressions} over the record: its value, parameters,
                            reads and fields; sender(), tx(); usd()/amount()/price(); name(address) (the
                            address book or ENS), symbol(token), door() (the contract the signer called, a router).
                            Dollar figures print as dollars; each message links its transaction.

Examples:
  contract-dev report create --each --name "Large swaps" --metric "Swap size (USD)" --when "value >= 10000" \\
    --message "{name(sender())} swapped {value} of {symbol(t0)} via {name(door())}" --to "#alerts"
  contract-dev report create --template daily --to "#alerts"
  contract-dev report create --template weekly --scope tag:pools --on friday --at 17 --to telegram
  contract-dev report create --name "Swaps" --scope steth --row transactions --row eventCount:Swap --to "#alerts"
  contract-dev report preview --template daily --scope steth

A daily report prints the last 24h, its change against the day before, then 7d and 30d; a
weekly one 7d, its change, then 30d and 90d. A report is named by its id or, when
unambiguous, its name.
`;

export type ReportScope = { kind: 'workspace' } | { kind: 'tag'; tag: string } | { kind: 'contract'; chainId: number; address: string };

export type ReportCadence = 'daily' | 'weekly';

export interface ReportRowSpec {
  kind: string;
  /** `eventCount` names the event; `trackedMetric` names the tracked value. */
  params?: { name?: string; id?: string };
  /** What the row is called in the table; the catalogue's label when absent. */
  label?: string | null;
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
  rows: ReportRowSpec[];
  origin: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  channels: AlertChannel[];
  lastRun: { id: string; status: string; periodKey: string; trigger: string; finishedAt: string | null; createdAt: string } | null;
  /** An each-time report: the event metric it follows, which records send, and its message. */
  each?: { metricId: string; metricName: string; when: string; message: string } | null;
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
export function scheduleWords(r: Pick<ReportView, 'cadence' | 'weekday' | 'hour' | 'timezone' | 'each'>): string {
  if (r.each) return `each time: ${r.each.metricName} where ${r.each.when}`;
  const day = r.cadence === 'weekly' ? `${weekdayName(r.weekday)} ` : '';
  return `${r.cadence} ${day}${String(r.hour).padStart(2, '0')}:00 ${r.timezone}`;
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
export async function parseRow(auth: ResolvedAuth, raw: string, catalogue: Record<string, CatalogueEntry>): Promise<ReportRowSpec> {
  const i = raw.indexOf(':');
  const kindRaw = (i < 0 ? raw : raw.slice(0, i)).trim();
  const param = i < 0 ? '' : raw.slice(i + 1).trim();
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
  if (entry.needs === 'id') {
    if (!param) throw new Error(`${kind} names a tracked metric: --row ${kind}:<id or label> (see \`contract-dev metrics\`)`);
    const metric = await resolveMetric(auth, param);
    return { kind, params: { id: metric.id } };
  }
  if (param) throw new Error(`${kind} takes no parameter (got: ${raw})`);
  return { kind };
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
      `  sends:      each time "${r.each.metricName}" has a record where ${r.each.when}`,
      `  says:       ${r.each.message}`,
      `  sends to:   ${r.channels.length ? r.channels.map(describeChannel).join(', ') : 'nobody'}`,
      `  state:      ${r.enabled ? 'on' : 'paused'}`,
    ];
    if (r.lastRunAt) each.push(`  last sent:  ${fmtLocalTime(at(r.lastRunAt))}`);
    return each;
  }
  const lines = [
    `  scope:      ${scopeLabel(r.scope, contracts)}`,
    `  schedule:   ${scheduleWords(r)}`,
    `  rows:       ${r.rows.map((row) => rowLabel(row, catalogue, metricNames)).join(' · ')}`,
    `  sends to:   ${r.channels.length ? r.channels.map(describeChannel).join(', ') : 'nobody'}`,
    `  next send:  ${r.enabled ? fmtLocalTime(at(r.nextRunAt)) : 'paused'}`,
  ];
  if (r.lastRunAt) lines.push(`  last run:   ${fmtLocalTime(at(r.lastRunAt))}${r.lastRun ? ` · ${r.lastRun.status}` : ''}`);
  return lines;
}

// a scheduled run is named by its period, a manual or each-time one by when it was for
const runPeriod = (run: ReportRunView): string => (run.periodKey.startsWith('manual-') || run.trigger === 'event' ? fmtTime(at(run.scheduledFor)) : run.periodKey);

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
  rows: ReportRowSpec[];
}

// A create or preview body from the flags, the way the app's drawer builds one: a template
// gives the name, cadence and rows; --row replaces the rows; --on makes it weekly.
async function buildDraft(auth: ResolvedAuth, flags: ReturnType<typeof parseFlags>, payload: ReportsPayload, mode: 'create' | 'preview'): Promise<Draft> {
  const templateRaw = flag(flags, 'template');
  let templateKey: ReportCadence | null = null;
  if (templateRaw !== undefined) {
    const key = templateRaw.trim().toLowerCase();
    if (key !== 'daily' && key !== 'weekly') throw new Error(`--template must be daily or weekly (got: ${templateRaw})`);
    templateKey = key;
  }
  const template = templateKey ? payload.templates[templateKey] : null;
  if (templateKey && !template) throw new Error(`The server has no ${templateKey} template — pass --name and --row instead.`);

  const onRaw = flag(flags, 'on');
  const cadence: ReportCadence = templateKey ?? (onRaw !== undefined ? 'weekly' : 'daily');
  if (onRaw !== undefined && cadence !== 'weekly') throw new Error('--on is for a weekly report (--template weekly)');
  const weekday = cadence === 'weekly' ? (onRaw !== undefined ? parseWeekday(onRaw) : 1) : undefined;
  const hour = parseHour(flag(flags, 'at'));
  const timezone = parseTimeZone(flag(flags, 'tz'));

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

  return { ...(name ? { name } : {}), scope, cadence, ...(weekday !== undefined ? { weekday } : {}), hour, timezone, rows };
}

const toRefs = (flags: ReturnType<typeof parseFlags>): string[] =>
  flagAll(flags, 'to')
    .filter((v) => v !== 'true')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);

/** --each's parts: the metric, the condition and the message, each required. */
function eachParts(flags: ReturnType<typeof parseFlags>): { metric: string; when: string; message: string } {
  const get = (k: string) => {
    const v = flag(flags, k);
    return v === undefined || v === 'true' ? '' : v.trim();
  };
  const parts = { metric: get('metric'), when: get('when'), message: get('message') };
  const missing = Object.entries(parts).filter(([, v]) => !v).map(([k]) => `--${k}`);
  if (missing.length) throw new Error(`--each needs ${missing.join(', ')}: the event metric it follows, which records send (--when "value >= 10000") and what each message says.`);
  return parts;
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
  const name = nameRaw && nameRaw !== 'true' ? nameRaw.trim() : `Each time: ${parts.metric}`;
  const channelIds = refs.length ? resolveChannelIds(await listChannels(auth), refs) : [];
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'POST', '/api/mainnet/reports', { name, cadence: 'each', ...parts, channelIds });
  console.log(`Created report "${report.name}" (${report.id}).`);
  for (const line of settingsLines(report, {})) console.log(line);
  const preview = await runTool<EachPreview>(auth, 'preview_report', { cadence: 'each', ...parts }).catch(() => null);
  if (preview) printEachPreview(preview.each);
  console.log('It sends on every new match from now; the history never sends.');
  if (!channelIds.length) console.log("No destination yet: each message shows on the report's page in the app until one is linked.");
  return report;
}

async function createReport(args: string[]): Promise<ReportView> {
  const flags = parseFlags(args);
  const refs = toRefs(flags);

  const auth = requireAuth();
  if (flag(flags, 'each') !== undefined) return createEachReport(auth, flags, refs);
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
  if (flag(flags, 'each') !== undefined) {
    const preview = await runTool<EachPreview>(auth, 'preview_report', { cadence: 'each', ...eachParts(flags) });
    printEachPreview(preview.each);
    return preview;
  }
  const payload = await loadReports(auth);
  const draft = await buildDraft(auth, flags, payload, 'preview');
  const body = { ...(draft.name ? { name: draft.name } : {}), scope: draft.scope, cadence: draft.cadence, timezone: draft.timezone, rows: draft.rows };
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
  console.log(`Sending "${report.name}" now (run ${run.id}, ${run.status}) — its destinations get it within a minute.`);
  if (run.text) {
    console.log('');
    console.log(run.text);
  }
  return run;
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
