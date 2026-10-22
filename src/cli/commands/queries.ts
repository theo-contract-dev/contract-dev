// `contract-dev queries` — the saved queries: answers kept at a page in the app by `--save` on
// `query`, `events` and `history` (or by the assistant). List them, print one, pull its rows as
// CSV, ask it again, rename it, draw it another way, delete it. Reads the same routes the page
// reads; --json hands back the route's own answer.
import { parseFlags, flag, type ParsedFlags } from './_args';
import { apiRequest, requireAuth, type ResolvedAuth } from '../credentials';
import { columnsTable, cell } from './_print';
import { SAVE_FORMS } from './_save';
import { fmtAge, table } from '../view';

const HELP = `contract-dev queries — the answers kept at a page in the app

Usage:
  contract-dev queries                                  List saved queries (title, drawn as, dataset, rows, who, when)
  contract-dev queries show <id|title>                  One saved query: what was asked, as of when, and its rows
  contract-dev queries csv <id|title>                   Its rows as CSV, on stdout (> file.csv)
  contract-dev queries refresh <id|title>               Ask the question again now; the page shows the new answer
  contract-dev queries rename <id|title> "<title>"
  contract-dev queries as <id|title> <bars|stacked|diverging|line|table>   Draw it another way (refused when the rows cannot carry it)
  contract-dev queries delete <id|title>
  contract-dev queries keep <id|title>                  Keep it as a table under Tables: re-run every time it is opened
  contract-dev queries unkeep <id|title>                Back to a snapshot under Queries

A saved query is made by --save on \`contract-dev query …\`, \`contract-dev events … --event …\` or \`contract-dev history …\`,
or by the assistant when someone asks to see a chart or a table. Add --json for the route's own answer.
`;

interface SavedQueryListItem {
  id: string;
  title: string;
  form: string;
  tool: string;
  rows: number;
  createdBy: { name: string | null };
  source: string | null;
  createdAt: string;
  url: string;
}
interface SavedQueryView extends SavedQueryListItem {
  args: Record<string, unknown>;
  asOf: string;
  snapshot: { columns: { key: string; label: string; unit?: string }[]; rows: Record<string, unknown>[]; matched: number; notes?: string[]; grouped?: { by: string[]; measure: string } };
}

const DATASET: Record<string, string> = {
  query_contracts: 'contracts',
  query_table: 'table',
  query_metric: 'metric',
  query_monitors: 'monitors',
  query_alerts: 'alerts',
  query_reports: 'reports',
  query_transactions: 'transactions',
  query_transfers: 'transfers',
  query_wallets: 'wallets',
  query_events: 'events',
  event_history: 'event history',
};

async function listQueries(auth: ResolvedAuth): Promise<SavedQueryListItem[]> {
  const { queries } = await apiRequest<{ queries: SavedQueryListItem[] }>(auth, 'GET', '/api/mainnet/queries');
  return queries ?? [];
}

/** An id, or a title (case-insensitive, whole); several titles alike ask for the id. */
async function resolve(auth: ResolvedAuth, ref: string | undefined): Promise<SavedQueryListItem> {
  if (!ref || ref === 'true') throw new Error('Name the saved query: its id or title (contract-dev queries lists them).');
  const all = await listQueries(auth);
  const byId = all.find((q) => q.id === ref);
  if (byId) return byId;
  const byTitle = all.filter((q) => q.title.toLowerCase() === ref.toLowerCase());
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new Error(`${byTitle.length} saved queries are called "${ref}"; use the id: ${byTitle.map((q) => q.id).join(', ')}.`);
  const close = all.filter((q) => q.title.toLowerCase().includes(ref.toLowerCase())).slice(0, 5);
  throw new Error(`No saved query is called "${ref}".${close.length > 0 ? ` Closest: ${close.map((q) => `${q.title} (${q.id})`).join(', ')}.` : ''}`);
}

const shown = (v: unknown, unit: string | undefined): unknown => (unit === 'time' && typeof v === 'number' ? new Date(v * 1000).toISOString().slice(0, 16).replace('T', ' ') : v);

function printRows(q: SavedQueryView): void {
  const columns = q.snapshot.columns.slice(0, 8);
  const unitOf = new Map(q.snapshot.columns.map((c) => [c.key, c.unit]));
  for (const line of columnsTable(columns.map((c) => c.label), q.snapshot.rows.map((r) => columns.map((c) => cell(shown(r[c.key], unitOf.get(c.key))))))) console.log(line);
  if (q.snapshot.columns.length > columns.length) console.log(`(${q.snapshot.columns.length - columns.length} more columns: queries csv, or --json)`);
}

const csvEsc = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvCell = (v: unknown, unit: string | undefined): string => {
  if (v == null) return '';
  if (unit === 'time' && typeof v === 'number') return new Date(v * 1000).toISOString();
  if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

export async function queriesCommand(args: string[]): Promise<unknown> {
  if (['help', '-h', '--help'].includes(args[0])) return void console.log(HELP);
  const flags: ParsedFlags = parseFlags(args);
  const [verb, ...rest] = flags._ as string[];
  const auth = requireAuth();

  if (!verb) {
    const queries = await listQueries(auth);
    if (queries.length === 0) {
      console.log('No saved queries. Add --save to a query (contract-dev query help), or ask the assistant to chart something.');
      return { queries };
    }
    for (const line of table(queries, [
      { header: 'Id', value: (q) => q.id },
      { header: 'Title', value: (q) => q.title, max: 48 },
      { header: 'Drawn as', value: (q) => q.form },
      { header: 'Where', value: (q) => ((q as { kept?: boolean }).kept ? 'Tables' : 'Queries') },
      { header: 'Dataset', value: (q) => DATASET[q.tool] ?? q.tool },
      { header: 'Rows', value: (q) => String(q.rows) },
      { header: 'Asked by', value: (q) => [q.createdBy?.name, q.source].filter(Boolean).join(' · ') || '—' },
      { header: 'When', value: (q) => fmtAge(Date.parse(q.createdAt)) },
    ]))
      console.log(line);
    return { queries };
  }

  const ref = rest[0];
  if (verb === 'show') {
    const found = await resolve(auth, ref);
    const { query } = await apiRequest<{ query: SavedQueryView }>(auth, 'GET', `/api/mainnet/queries/${found.id}`);
    console.log(`${query.title} · ${query.form} · ${DATASET[query.tool] ?? query.tool} · as of ${query.asOf.slice(0, 16).replace('T', ' ')} UTC`);
    if (query.snapshot.grouped) console.log(`By ${query.snapshot.grouped.by.join(', ')} · ${query.snapshot.grouped.measure}`);
    console.log(`${query.snapshot.rows.length} row${query.snapshot.rows.length === 1 ? '' : 's'}${query.snapshot.matched > query.snapshot.rows.length ? ` of ${query.snapshot.matched}` : ''} · ${query.url}`);
    printRows(query);
    for (const n of query.snapshot.notes ?? []) console.log(n);
    return query;
  }
  if (verb === 'csv') {
    const found = await resolve(auth, ref);
    const { query } = await apiRequest<{ query: SavedQueryView }>(auth, 'GET', `/api/mainnet/queries/${found.id}`);
    const named = query.snapshot.columns.map((c) => c.key);
    const extras = Array.from(new Set(query.snapshot.rows.flatMap((r) => Object.keys(r)))).filter((k) => !named.includes(k) && k !== 'url');
    const unitOf = new Map(query.snapshot.columns.map((c) => [c.key, c.unit]));
    console.log([...query.snapshot.columns.map((c) => c.label), ...extras].map(csvEsc).join(','));
    for (const r of query.snapshot.rows) console.log([...named.map((k) => csvCell(r[k], unitOf.get(k))), ...extras.map((k) => csvCell(r[k], undefined))].map(csvEsc).join(','));
    return query;
  }
  if (verb === 'refresh') {
    const found = await resolve(auth, ref);
    const { query } = await apiRequest<{ query: SavedQueryView }>(auth, 'POST', `/api/mainnet/queries/${found.id}/refresh`, undefined, { timeoutMs: 90_000 });
    console.log(`Refreshed · ${query.snapshot.rows.length} rows as of ${query.asOf.slice(0, 16).replace('T', ' ')} UTC · ${query.url}`);
    return query;
  }
  if (verb === 'rename') {
    const found = await resolve(auth, ref);
    const title = rest.slice(1).join(' ').trim();
    if (!title) throw new Error('Give the new title: contract-dev queries rename <id|title> "<title>".');
    const { query } = await apiRequest<{ query: SavedQueryView }>(auth, 'PATCH', `/api/mainnet/queries/${found.id}`, { title });
    console.log(`Renamed to "${query.title}" · ${query.url}`);
    return query;
  }
  if (verb === 'as') {
    const found = await resolve(auth, ref);
    const form = rest[1];
    if (!form || !(SAVE_FORMS as readonly string[]).includes(form)) throw new Error(`Say how to draw it: ${SAVE_FORMS.join(', ')}.`);
    const { query } = await apiRequest<{ query: SavedQueryView }>(auth, 'PATCH', `/api/mainnet/queries/${found.id}`, { form });
    console.log(`Drawn as ${query.form} · ${query.url}`);
    return query;
  }
  if (verb === 'keep' || verb === 'unkeep') {
    const found = await resolve(auth, ref);
    const { query } = await apiRequest<{ query: SavedQueryView }>(auth, 'PATCH', `/api/mainnet/queries/${found.id}`, { kept: verb === 'keep' });
    console.log(verb === 'keep' ? `Kept as a table under Tables · ${query.url}` : `A snapshot again under Queries · ${query.url}`);
    return query;
  }
  if (verb === 'delete') {
    const found = await resolve(auth, ref);
    if (flag(flags, 'yes') === undefined && process.stdin.isTTY) console.error(`Deleting "${found.title}" (${found.id}).`);
    await apiRequest<{ ok: boolean }>(auth, 'DELETE', `/api/mainnet/queries/${found.id}`);
    console.log(`Deleted "${found.title}".`);
    return { ok: true, id: found.id };
  }
  throw new Error(`Unknown queries command "${verb}" (try: contract-dev queries help).`);
}
