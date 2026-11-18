import { parseFormulaCall, parseRead } from './eventMetric';
import { ALERT_TYPE_WORD, eachTriggerWord } from './_alertWords';
import { parseFlags, flag, flagAll, requirePositional } from './_args';
import { apiRequest, ApiRequestError, requireAuth, ResolvedAuth } from '../credentials';
import { runTool } from '../tools';
import { defineInline, inlineDefinition, splitClauses } from './_define';
import { listChannels, resolveChannelIds, type AlertChannel } from './monitor';
import { resolveMetric, type TrackedMetric } from './metrics';
import { chainFlag, resolveContract, workspaceContracts } from '../data';
import type { WatchedAccount } from './watch';
import { chainLabel, DASH, fmtLocalTime, fmtTime, shortAddr, table } from '../view';

// The flags this module takes are written once, in `notify help` (./notify): `report` is no longer a
// command of its own (4.4.0, 2026-11-08), only what `notify` hands a report to.
const HELP = `Reports are notifications: contract-dev notify help (contract-dev notify add report …).`;

/** A table a report sends: the table's id (a name on the way in) and the clauses each run asks it with. */
export interface ReportTableSpec {
  table: string;
  /** The table's name when the report was saved, for showing it. */
  name?: string;
  label?: string | null;
  sort?: string | null;
  asc?: boolean;
  limit?: number | null;
  where?: string | null;
  days?: number | null;
  among?: 'active' | 'done' | 'all' | null;
  columns?: string[] | null;
}

export type ReportScope = { kind: 'workspace' } | { kind: 'tag'; tag: string } | { kind: 'contract'; chainId: number; address: string };

export type ReportCadence = 'daily' | 'weekly' | 'interval';

export interface ReportRowSpec {
  kind: string;
  /** `eventCount` names the event; `trackedMetric` names the tracked value; `formula` carries its calls and expression. */
  params?: { name?: string; id?: string; [k: string]: unknown };
  /** What the row is called in the table; the catalogue's label when absent. */
  label?: string | null;
  /** false: this row prints no change column. */
  compare?: boolean;
  /** A default line's own scope (2026-11-06): what it adds up over, instead of the report's. */
  scope?: ReportScope | null;
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
  /** Interval reports: every N minutes (UTC clock). The columns (window words, in order; named on every create with rows), the change column (off unless asked), the sending condition. */
  everyMinutes?: number | null;
  columns?: string[];
  compare?: boolean;
  onlyWhen?: string | null;
  rows: ReportRowSpec[];
  /** Tables sent under the rows, by table id, each asked again on every run (2026-10-30). */
  tables?: ReportTableSpec[];
  origin: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  channels: AlertChannel[];
  lastRun: { id: string; status: string; periodKey: string; trigger: string; finishedAt: string | null; createdAt: string } | null;
  /** An each-time report: what it listens for (in words), which happenings send, its message and its digest. */
  each?: { kind: string; subject: string; metricId: string | null; metricName: string | null; on?: string; when: string; message: string; digestMinutes: number | null } | null;
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
/** `1m` · `10m` · `1h` · `6h` · `1d` */
export const everyWord = (minutes: number): string => (minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);

export function scheduleWords(r: Pick<ReportView, 'cadence' | 'weekday' | 'hour' | 'timezone' | 'each'> & { everyMinutes?: number | null; columns?: string[]; compare?: boolean }): string {
  if (r.each) return `each time: ${r.each.subject}${r.each.when && r.each.when !== 'true' ? ` where ${r.each.when}` : ''}${r.each.digestMinutes ? ` · digest every ${everyWord(r.each.digestMinutes)}` : ''}`;
  if (r.cadence === 'interval') return `every ${everyWord(r.everyMinutes ?? 60)}${r.compare ? ' · with change' : ''}`;
  const day = r.cadence === 'weekly' ? `${weekdayName(r.weekday)} ` : '';
  return `${r.cadence} ${day}${String(r.hour).padStart(2, '0')}:00 ${r.timezone}`;
}

/** The longest interval a report runs on or a digest waits, in minutes: a week (the server's bound too; a minute is the shortest). */
const INTERVAL_MAX_MINUTES = 10_080;

/** `1m`, `15`, `90m`, `4h`, `1d` → whole minutes from 1 to a week, as an interval report or a digest takes them. */
function parseInterval(raw: string, what: string): number {
  const m = /^(\d+)\s*(m|min|minutes?|h|hr|hours?|d|days?|w|weeks?)?$/i.exec(raw.trim());
  if (!m) throw new Error(`${what} takes minutes, hours or days, like 1m, 10m, 4h or 1d (got: ${raw})`);
  const unit = (m[2] ?? 'm').toLowerCase();
  const n = Number(m[1]) * (unit.startsWith('w') ? 10_080 : unit.startsWith('d') ? 1440 : unit.startsWith('h') ? 60 : 1);
  if (n < 1 || n > INTERVAL_MAX_MINUTES) throw new Error(`${what} must be from 1m to 7d (got: ${raw})`);
  return n;
}

/** `1m`, `10m`, `15`, `1h`, `6h` → minutes: any whole number from 1 to a week. */
export const parseEvery = (raw: string): number => parseInterval(raw, '--every');

const WINDOW_UNIT_SEC: Record<string, number> = { m: 60, h: 3_600, d: 86_400, w: 604_800, y: 31_536_000 };

/** A column's window as a duration word: 1m, 15m, 1h, 24h, 7d, 2w, 1y (1m at the least), normalised. */
export function parseWindow(raw: string, what = '--columns'): string {
  const m = /^\s*(\d{1,5})\s*([mhdwy])\s*$/i.exec(raw);
  const n = m ? Number(m[1]) : 0;
  const unit = m ? m[2].toLowerCase() : '';
  if (!m || n <= 0 || n * WINDOW_UNIT_SEC[unit] < 60) throw new Error(`${what} takes windows like 1m, 15m, 1h, 24h, 7d, 2w or 1y (got: ${raw})`);
  return `${n}${unit}`;
}

/** `24h,7d,30d` → the column windows, in order. */
export function parseColumns(raw: string): string[] {
  const words = raw.split(',').map((w) => w.trim()).filter(Boolean);
  if (words.length === 0) throw new Error('--columns needs windows, like --columns 24h,7d,30d');
  return words.map((w) => parseWindow(w));
}

const at = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);

// ── scope, rows and tables, from what a person types ──

/** \`--table "Swaps | sort {Amount} | top 5 | days 1"\`: the table by name or id, then its clauses, each after a |. */
/** The tables a report create made on the way (inline --table), deleted again if the report is not saved. */
export const MADE_TABLES: { id: string; store: 'live' | 'item' }[] = [];

/** `"on tag:pools; each Swap; where usd(amount, token0()) > 10000"` as `table create`'s flags. */
export function tableClausesToArgs(text: string): string[] {
  const args: string[] = [];
  for (const clause of splitClauses(text)) {
    const m = /^([a-z-]+)(?:\s+(.*))?$/s.exec(clause);
    if (!m) throw new Error(`Unknown table clause "${clause}".`);
    const rest = (m[2] ?? '').trim();
    if (!rest) throw new Error(`"${m[1]}" needs a value: on tag:pools; each Swap; rows transfers; where …; keep …; field …; days …; by …`);
    if (m[1] === 'each' || m[1] === 'event') for (const e of rest.split(',').map((x) => x.trim()).filter(Boolean)) args.push(`--${m[1]}`, e);
    else args.push(`--${m[1]}`, rest.replace(/^"(.*)"$/s, '$1'));
  }
  return args;
}

/**
 * A --table: a table of the workspace by name or id with the report's clauses after a |, or
 * "<name>=<clauses>" (2026-11-07), a table made for this report (the clauses of `table create`:
 * on, each or rows, where, keep, field, days, by, measure), kept off /tables and deleted with it.
 */
export async function tableSpecFromFlag(raw: string): Promise<ReportTableSpec> {
  const bar = raw.indexOf('|');
  const head = (bar >= 0 ? raw.slice(0, bar) : raw).trim();
  const inline = inlineDefinition(head);
  if (!inline) return parseTableFlag(raw);
  const { tableCommand, savedTable } = await import('./table');
  const result = await tableCommand(['create', inline.name, ...tableClausesToArgs(inline.clauses), '--hidden']);
  const made = savedTable(result);
  if (!made) throw new Error(`"${inline.name}" was not saved.`);
  MADE_TABLES.push(made);
  const spec = parseTableFlag(`${made.id}${bar >= 0 ? ` ${raw.slice(bar)}` : ''}`);
  spec.name = inline.name;
  return spec;
}

export function parseTableFlag(raw: string): ReportTableSpec {
  const [head, ...parts] = raw.split('|').map((p) => p.trim());
  if (!head) throw new Error('--table names a table: --table "Swaps | sort {Amount} | top 5" (see `contract-dev table list`)');
  const spec: ReportTableSpec = { table: head };
  for (const part of parts) {
    const m = /^(\S+)\s*(.*)$/.exec(part);
    const word = (m?.[1] ?? '').toLowerCase();
    const rest = (m?.[2] ?? '').trim();
    if (word === 'sort' || word === 'by') {
      const asc = /\s+asc$/i.test(rest);
      const desc = /\s+desc$/i.test(rest);
      const what = rest.replace(/\s+(asc|desc)$/i, '').trim();
      if (!what) throw new Error(`--table ${raw}: sort needs a column, like sort {Amount} or sort volume asc`);
      spec.sort = what;
      if (asc) spec.asc = true;
      else if (desc) spec.asc = false;
    } else if (word === 'top' || word === 'limit') {
      const n = Number(rest);
      if (!Number.isInteger(n) || n < 1 || n > 25) throw new Error(`--table ${raw}: top is the rows sent, 1 to 25`);
      spec.limit = n;
    } else if (word === 'where') {
      if (!rest) throw new Error(`--table ${raw}: where needs a condition, like where {Amount} > 10000`);
      spec.where = rest;
    } else if (word === 'days') {
      const n = Number(rest);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--table ${raw}: days is a whole number of days back, like days 1`);
      spec.days = n;
    } else if (word === 'columns') {
      const cols = rest.split(',').map((c) => c.trim()).filter(Boolean);
      if (!cols.length) throw new Error(`--table ${raw}: columns lists them, like columns Wallet,Volume`);
      spec.columns = cols;
    } else if (word === 'among') {
      const a = rest.toLowerCase();
      if (a !== 'active' && a !== 'done' && a !== 'all') throw new Error(`--table ${raw}: among is active, done or all`);
      spec.among = a;
    } else if (word === 'label') {
      if (!rest) throw new Error(`--table ${raw}: label needs a name`);
      spec.label = rest;
    } else throw new Error(`--table ${raw}: after a | come sort, top, where, days, columns, among or label (got "${part}")`);
  }
  return spec;
}

/** A sent table in words: "Swaps · sort {Amount} · top 5 · last 1 day". */
export function tableLabel(t: ReportTableSpec): string {
  const parts = [t.label || t.name || t.table];
  if (t.sort) parts.push(`sort ${t.sort}${t.asc ? ' asc' : ''}`);
  parts.push(`top ${t.limit ?? 10}`);
  if (t.where) parts.push(`where ${t.where}`);
  if (t.days) parts.push(`last ${t.days} day${t.days === 1 ? '' : 's'}`);
  if (t.among) parts.push(t.among);
  if (t.columns?.length) parts.push(`columns ${t.columns.join(', ')}`);
  return parts.join(' · ');
}

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
  // a row may stand without a change column: --row "customMetric:Swap fees | nocompare" (its windows are the report's --columns)
  let raw = rawRow;
  const extra: { compare?: boolean } = {};
  const bar = rawRow.indexOf('|');
  if (bar >= 0) {
    raw = rawRow.slice(0, bar);
    for (const word of rawRow.slice(bar + 1).trim().split(/\s+/).filter(Boolean)) {
      if (/^nocompare$|^snapshot$/i.test(word)) extra.compare = false;
      else throw new Error(`--row ${rawRow}: after | only nocompare is understood; the windows a row prints are the report's --columns.`);
    }
  }
  // a default line's own scope: --row "transactions@tag:pools", --row "volumeInUsd@steth" (a watched contract), @workspace
  let scopeRaw: string | null = null;
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    scopeRaw = raw.slice(at + 1).trim();
    raw = raw.slice(0, at);
    if (!scopeRaw) throw new Error(`--row ${rawRow}: after @ name what the line covers: tag:<group>, a watched contract, or workspace.`);
  }
  const i = raw.indexOf(':');
  const kindRaw = (i < 0 ? raw : raw.slice(0, i)).trim();
  const param = i < 0 ? '' : raw.slice(i + 1).trim();
  const row = await parseRowBase(auth, raw, kindRaw, param, catalogue);
  if (scopeRaw != null) {
    if (catalogue[row.kind]?.needs === 'id' || row.kind === 'metric') throw new Error(`--row ${rawRow}: a metric line reads its own metric, so it takes no @scope; @ is for the defaults (transactions, volume, wallets, an event's count).`);
    return { ...row, ...extra, scope: await parseScope(auth, scopeRaw) };
  }
  return { ...row, ...extra };
}

/** The metrics a report create defined on the way (inline rows), deleted again if the report is not saved. */
export const MADE_FOR_REPORT: string[] = [];

async function parseRowBase(auth: ResolvedAuth, raw: string, kindRaw: string, param: string, catalogue: Record<string, CatalogueEntry>): Promise<ReportRowSpec> {
  // a metric by name or id, whichever kind (2026-11-07); or defined here for this report, off the Metrics page
  if (kindRaw.toLowerCase() === 'metric') {
    if (!param) throw new Error('metric names a metric, or defines one for this report: --row metric:"Swap fees", --row "metric:Supply=on steth; call totalSupply()" (try: metric define help).');
    const inline = inlineDefinition(param);
    if (inline) {
      const made = await defineInline(inline.name, inline.clauses);
      MADE_FOR_REPORT.push(made.id);
      return { kind: 'metric', params: { ref: made.id }, label: inline.name };
    }
    return { kind: 'metric', params: { ref: param } };
  }
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

const FORMULA_ROW_HELP = 'formula takes Label=expression, then its calls: --row "formula:Headroom=held - debt; call held=totalAssets(); call debt=totalDebt() on 0xRisk…; token asset(); show usd"; ago(<call>, window) in the expression is each column\'s own window: --row "formula:Earned=sh * (rate - ago(rate, window)); call sh=balanceOf(address) on 0xVault… with self decimals 18; call rate=convertToAssets(uint256) on 0xVault… with 1e18 decimals 18"';

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
  const ref = typeof row.params?.ref === 'string' ? row.params.ref : '';
  const base = row.label && row.label.trim() ? row.label.trim() : row.kind === 'metric' && ref ? (metricNames.get(ref) ?? ref) : row.kind === 'eventCount' && row.params?.name ? row.params.name : row.kind === 'trackedMetric' && row.params?.id ? (metricNames.get(row.params.id) ?? `Tracked metric ${row.params.id}`) : (catalogue[row.kind]?.label ?? row.kind);
  // a line on a group or one contract says so, as the table it sends does
  const s = row.scope;
  return s && s.kind !== 'workspace' ? `${base} @ ${s.kind === 'tag' ? `tag:${s.tag}` : shortAddr(s.address)}` : base;
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
  throw new Error(`No report matches "${ref}" (run \`contract-dev notify --type report\` to list them).`);
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
      `  type:       ${ALERT_TYPE_WORD.event}`,
      `  trigger:    ${eachTriggerWord(r.each)}`,
      `  scope:      ${scopeLabel(r.scope, contracts)}`,
      `  sends:      each time ${r.each.kind === 'metricRecord' && !r.each.subject.endsWith(' fires') ? `"${r.each.subject}" has a record` : r.each.subject}${r.each.when && r.each.when !== 'true' ? ` where ${r.each.when}` : ''}`,
      `  says:       ${r.each.message}`,
      ...(r.each.digestMinutes ? [`  digest:     one message every ${everyWord(r.each.digestMinutes)}`] : []),
      `  sends to:   ${r.channels.length ? r.channels.map(describeChannel).join(', ') : 'the app'}`,
      `  state:      ${r.enabled ? 'on' : 'paused'}`,
    ];
    if (r.lastRunAt) each.push(`  latest:     ${fmtLocalTime(at(r.lastRunAt))}`);
    return each;
  }
  const lines = [
    `  scope:      ${scopeLabel(r.scope, contracts)}`,
    `  schedule:   ${scheduleWords(r)}`,
    ...(r.onlyWhen ? [`  only when:  ${r.onlyWhen}`] : []),
    `  columns:    ${r.columns?.length ? r.columns.join(', ') : '—'}${r.compare ? ' (with the change against the window before)' : ''}`,
    ...(r.rows.length ? [`  rows:       ${r.rows.map((row) => rowLabel(row, catalogue, metricNames)).join(' · ')}`] : []),
    ...(r.tables ?? []).map((t, i) => `  ${i === 0 ? 'tables:    ' : '           '} ${tableLabel(t)}`),
    `  sends to:   ${r.channels.length ? r.channels.map(describeChannel).join(', ') : 'the app'}`,
    `  next run:   ${r.enabled ? fmtLocalTime(at(r.nextRunAt)) : 'paused'}`,
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
      // a run with nowhere to send is done, not failed: it is in the app, and that is where it went
      { header: 'Status', value: (r) => (r.status === 'unsent' ? 'in app' : r.status) },
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
      return await createReportOwning(rest);
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
    console.log('No reports. Create one with `contract-dev notify add report --template daily --to <dest>`.');
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
  columns?: string[];
  compare?: boolean;
  onlyWhen?: string;
  rows: ReportRowSpec[];
  tables?: ReportTableSpec[];
}

/** --every, --columns, --snapshot/--compare and --only-when/--always, as a create or an update body takes them. */
function shapeFlags(flags: ReturnType<typeof parseFlags>): { everyMinutes?: number; columns?: string[] | null; compare?: boolean; onlyWhen?: string | null } {
  const out: { everyMinutes?: number; columns?: string[] | null; compare?: boolean; onlyWhen?: string | null } = {};
  const every = flag(flags, 'every');
  if (every !== undefined) {
    if (every === 'true') throw new Error('--every needs an interval, like 10m or 1h');
    out.everyMinutes = parseEvery(every);
  }
  const columns = flag(flags, 'columns') ?? flag(flags, 'window');
  if (columns !== undefined) {
    if (columns === 'true') throw new Error('--columns needs windows, like --columns 24h,7d,30d');
    out.columns = parseColumns(columns);
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

// A create body from the flags, the way the app's drawer builds one: a template
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
  // --day since 2026-11-07 (--on means what a thing is on, everywhere else); --on <weekday> still taken here
  const onRaw = flag(flags, 'day') ?? flag(flags, 'on');
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
  const tables = await Promise.all(flagAll(flags, 'table').filter((t) => t !== 'true').map(tableSpecFromFlag));
  if (tables.length > 3) throw new Error('A report sends at most 3 tables.');
  if (!rows.length && !tables.length) throw new Error('Pick rows with --row <kind>[:<param>], tables with --table "<table> | sort <col> | top <n>", or start from --template daily|weekly.');
  // a report prints only what was asked for (2026-11-07, Theo): its columns are named here, never filled in
  if (rows.length && !shape.columns?.length && mode === 'create') throw new Error('Say which columns the table prints: --columns 24h for the day, --columns 24h,7d,30d for the day, the week and the month.');

  const shaped = Object.fromEntries(Object.entries(shape).filter(([, v]) => v !== undefined && v !== null)) as Pick<Draft, 'everyMinutes' | 'columns' | 'compare' | 'onlyWhen'>;
  return { ...(name ? { name } : {}), scope, cadence, ...(weekday !== undefined ? { weekday } : {}), hour, timezone, ...shaped, rows, ...(tables.length ? { tables } : {}) };
}

const toRefs = (flags: ReturnType<typeof parseFlags>): string[] =>
  flagAll(flags, 'to')
    .filter((v) => v !== 'true')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);

// no --on-monitor since 2026-11-07: each alert has its own destinations, so an alert on an alert sent the same thing twice
const ON_FLAGS: Record<string, string> = { 'on-event': 'event', 'on-value': 'value', 'on-row': 'row', 'on-member': 'member' };

/** Function-call alerts are off for now (2026-11-08): calls are not collected; an event the method emits is. */
export const NO_CALLS = 'Alerts on a function call are not available: calls are not collected. Follow the event the method emits instead: --each <Event>.';

/** `--each`, or one of the `--on-*` triggers, asks for an each-time report. */
export const isEach = (flags: ReturnType<typeof parseFlags>): boolean => flag(flags, 'each') !== undefined || Object.keys(ON_FLAGS).some((k) => flag(flags, k) !== undefined);

/** Digests are gone (2026-11-08): an alert on something happening sends once per block. */
const NO_DIGEST = 'An alert on something happening sends once per block, every match in the block in one message: it takes no --digest. Figures every so often are a report: `contract-dev notify add report --every 1h`.';

type EachParts = { metric?: string; trigger?: Record<string, unknown>; when?: string; message: string };

/** An each-time report's parts: what it listens for (--each --metric, or one --on-*), --when and --message. */
function eachParts(flags: ReturnType<typeof parseFlags>): EachParts {
  const get = (k: string) => {
    const v = flag(flags, k);
    return v === undefined || v === 'true' ? '' : v.trim();
  };
  if (flag(flags, 'on-call') !== undefined) throw new Error(NO_CALLS);
  const ons = Object.keys(ON_FLAGS).filter((k) => flag(flags, k) !== undefined);
  if (ons.length > 1) throw new Error(`Pass one trigger, not ${ons.map((k) => `--${k}`).join(' and ')}.`);
  const message = get('message');
  // `--when true` (and a bare `--when`) is the condition every record meets, which the server takes as the word true
  const when = flag(flags, 'when') === 'true' ? 'true' : get('when');
  if (flag(flags, 'digest') !== undefined) throw new Error(NO_DIGEST);
  const out: EachParts = { message, ...(when ? { when } : {}) };
  if (ons.length === 1) {
    const kind = ON_FLAGS[ons[0]];
    const raw = get(ons[0]);
    if (!raw) throw new Error(`--${ons[0]} needs ${kind === 'event' ? 'the event (Swap, or its signature)' : kind === 'call' ? 'the method (transfer(address,uint256), or a 0x selector)' : kind === 'value' ? 'the tracked value (its label or id)' : kind === 'row' ? 'the table (its name)[:opened|finished|both]' : kind === 'member' ? 'the group[:joined|left|both]' : 'a monitor or any[:fired|recovered|both]'}.`);
    const trigger: Record<string, unknown> = { kind };
    if (kind === 'event') {
      trigger.event = raw;
      const value = get('value');
      if (value) trigger.value = value;
      // views on the emitting contract the value may use, the way `metric define --read` takes them (2026-11-07)
      const reads = flagAll(flags, 'read').map((r) => parseRead(r, new Set()));
      if (reads.length > 0) trigger.reads = reads;
      const where = get('where');
      if (where) trigger.where = where;
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

async function createEachReport(auth: ResolvedAuth, flags: ReturnType<typeof parseFlags>, refs: string[]): Promise<ReportView> {
  const parts = eachParts(flags);
  const nameRaw = flag(flags, 'name');
  const subject = parts.metric ?? parts.trigger?.event ?? parts.trigger?.method ?? parts.trigger?.metric ?? parts.trigger?.table ?? parts.trigger?.group ?? parts.trigger?.monitor ?? 'any monitor';
  const name = nameRaw && nameRaw !== 'true' ? nameRaw.trim() : `Each time: ${subject}`;
  const channelIds = refs.length ? resolveChannelIds(await listChannels(auth), refs) : [];
  const scope = flag(flags, 'scope') !== undefined ? { scope: await parseScope(auth, flag(flags, 'scope'), chainFlag(flags)) } : {};
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'POST', '/api/mainnet/reports', { name, cadence: 'each', ...parts, ...scope, channelIds });
  console.log(`Created alert "${report.name}" (${report.id}).`);
  for (const line of settingsLines(report, {})) console.log(line);
  console.log('It sends on every new match from now; the history never sends.');
  if (!channelIds.length) console.log("No destination yet: each message shows on the alert's page in the app until one is linked.");
  return report;
}

async function createReport(args: string[]): Promise<ReportView> {
  const flags = parseFlags(args);
  const refs = toRefs(flags);

  if (flag(flags, 'on-call') !== undefined) throw new Error(NO_CALLS);
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
  else if (run.status === 'unsent') console.log(`Ran "${report.name}" now (run ${run.id}): it has no destination, so the table is on the report's page in the app.`);
  else console.log(`Running "${report.name}" now (run ${run.id}, ${run.status}) — its destinations get it within a minute.`);
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
  // --day since 2026-11-07 (--on means what a thing is on, everywhere else); --on <weekday> still taken here
  const onRaw = flag(flags, 'day') ?? flag(flags, 'on');
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
  const tableRefs = flagAll(flags, 'table').filter((t) => t !== 'true');
  if (tableRefs.length && flag(flags, 'no-tables') !== undefined) throw new Error('Pass --table (the new list) or --no-tables, not both.');
  if (tableRefs.length) body.tables = await Promise.all(tableRefs.map(tableSpecFromFlag));
  if (flag(flags, 'no-tables') !== undefined) body.tables = [];
  const refs = toRefs(flags);
  if (refs.length) body.channelIds = resolveChannelIds(await listChannels(auth), refs);
  if (Object.keys(body).length === 0) throw new Error('Nothing to change: pass --name, --row/--add-row/--remove-row, --table/--no-tables, --every, --columns, --snapshot/--compare, --only-when/--always, --at, --on, --tz, --scope or --to.');
  const { report } = await apiRequest<{ report: ReportView }>(auth, 'PATCH', `/api/mainnet/reports/${existing.id}`, body);
  const metricNames = await metricNamesFor(auth, report.rows);
  const contracts = report.scope.kind === 'contract' ? await workspaceContracts(auth).catch(() => [] as WatchedAccount[]) : [];
  console.log(`Updated report "${report.name}" (${report.id}).`);
  for (const line of settingsLines(report, payload.catalogue, contracts, metricNames)) console.log(line);
  return report;
}

/** An update to an each-time report: --when, --message, --on, --name, --to; --no-digest takes an older digest off. */
async function updateEachReport(auth: ResolvedAuth, existing: ReportView, flags: ReturnType<typeof parseFlags>, payload: ReportsPayload): Promise<ReportView> {
  const body: Record<string, unknown> = {};
  const get = (k: string) => {
    const v = flag(flags, k);
    return v === undefined ? undefined : v === 'true' ? '' : v.trim();
  };
  for (const k of ['row', 'add-row', 'remove-row', 'table', 'no-tables', 'every', 'columns', 'window', 'snapshot', 'compare', 'only-when', 'always', 'at', 'tz', 'scope'])
    if (flag(flags, k) !== undefined) throw new Error(`"${existing.name}" sends each time something happens; --${k} is for a scheduled report. Change --when, --message, --on, --name or --to.`);
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
  if (flag(flags, 'digest') !== undefined) throw new Error(NO_DIGEST);
  // a report made before 2026-11-08 may still hold its matches for a digest: this takes it off
  if (flag(flags, 'no-digest') !== undefined) body.digestMinutes = null;
  const on = get('on');
  if (on !== undefined) body.on = on;
  const metric = get('metric');
  if (metric !== undefined) body.metric = metric;
  const refs = toRefs(flags);
  if (refs.length) body.channelIds = resolveChannelIds(await listChannels(auth), refs);
  if (Object.keys(body).length === 0) throw new Error('Nothing to change: pass --when, --message, --on, --name or --to.');
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
  else console.log(report.each ? `Resumed "${report.name}" — it sends on every new match from now.` : `Resumed "${report.name}" — next send ${fmtLocalTime(at(report.nextRunAt))}.`);
  return report;
}

async function deleteReport(args: string[]): Promise<{ ok: true; id: string }> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'report (id or name)');
  const auth = requireAuth();
  const { report: existing } = await resolveReport(auth, ref);
  await apiRequest(auth, 'DELETE', `/api/mainnet/reports/${existing.id}`);
  // an each-time report is an alert on something happening, as the app names it (2026-11-08)
  console.log(`Deleted ${existing.each ? 'alert' : 'report'} "${existing.name}" (${existing.id}) and its run history.`);
  return { ok: true, id: existing.id };
}

/**
 * A report create that owns what it made on the way (2026-11-07): the metrics and tables defined inline
 * for it are deleted again when the report is not saved, whatever stopped it (a flag refused after the
 * rows were read, the server refusing the save).
 */
async function createReportOwning(args: string[]): Promise<unknown> {
  if (args.some((x) => x === '--on-monitor' || x.startsWith('--on-monitor='))) throw new Error('--on-monitor is gone: an alert on another alert only sent the same thing twice. Give each alert the destination instead (notify set <alert> --to <dest>).');
  MADE_FOR_REPORT.splice(0);
  MADE_TABLES.splice(0);
  try {
    const made = await createReport(args);
    MADE_FOR_REPORT.splice(0);
    MADE_TABLES.splice(0);
    return made;
  } catch (e) {
    const auth = requireAuth();
    for (const id of MADE_FOR_REPORT.splice(0)) await runTool(auth, 'delete_metric', { metric: id }).catch(() => undefined);
    for (const t of MADE_TABLES.splice(0)) await apiRequest(auth, 'DELETE', t.store === 'item' ? `/api/console/tables/${t.id}` : `/api/mainnet/queries/${t.id}`).catch(() => undefined);
    throw e;
  }
}
