// `contract-dev data …` (2026-10-25): every set of rows the workspace keeps, by name. Event data is one row
// per event (data defined here, or any event metric's records); a table is one row per thing inside a
// contract; the built-in sets (contracts, transactions, …) have their own `query` nouns. `data define` keeps
// new event data with no number in mind; `query data "<name>"` asks any of it a question.
import { parseFlags, flag, requirePositional } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { DASH, fmtInt, table } from '../view';
import { printResult } from './_print';
import { definitionFrom, scopeInput } from './eventMetric';
import { queryCommand } from './query';

const HELP = `contract-dev data — the rows the workspace keeps, by name, and the questions asked of them

Usage:
  contract-dev data list [--columns]       Event data (one row per event), tables (one row per thing inside a contract)
                                           and the built-in sets; --columns adds each event dataset's columns
  contract-dev data define "<name>" --event <Event> [--event …] [--group <group> | --contract <ref>]
                              [--field "<name>=<expr>[ on <Event>]"]… [--read "<name>=<call>"]… [--where "<rule>"]
                              [--keep <param>[,<param>…] | --keep all] [--pair "<Event> [on <field>]"]…
                              [--split contract|none|<name> [--line "<an index>"]] [--history <days>] [--description "<sentence>"]
                                           Event data: each event a row with its fields, its history read in the
                                           background. No number in mind: put every figure a question might want in a
                                           field (--field "vol=usd(amount, token)"), then ask with query data. Its own
                                           figure is a count of rows; a number to track or alert on is a metric
  contract-dev data query "<name>" [clauses]   The same as contract-dev query data "<name>" (contract-dev query help)

Examples:
  contract-dev data define "DZap swaps" --group "DZap Routers" --event DZapTokenSwapped --event DZapBatchTokenSwapped \\
    --field "vol=usd(swapInfo.fromAmount, swapInfo.fromToken) on DZapTokenSwapped" \\
    --field "vol=sum(usd(swapInfo.fromAmount, swapInfo.fromToken)) on DZapBatchTokenSwapped" --keep integrator \\
    --description "Every swap through the DZap routers, priced on the day"
  contract-dev query data "DZap swaps" --days 90 --by wallet --measure volume="sum(vol)" --measure swaps=count --breakdown chain --keep
  contract-dev query data "DZap swaps" --days 30 --where "vol > 10000" --sort time --keep --title "Swaps over 10K USD"
  contract-dev query data "Withdrawal rounds" --among all --by contract --measure open='count where {Stage} == "active"'
`;

interface DataList {
  events: { name: string; id: string; kind: string; on: string; events: string[]; rows: number; status: string; columns?: string[] }[];
  tables: { name: string; id: string; rows: number; done: number; status: string }[];
  builtIn: { name: string; tool: string; what: string }[];
}

async function listData(args: string[]): Promise<DataList> {
  const flags = parseFlags(args);
  const columns = flag(flags, 'columns') === 'true';
  const r = await runTool<DataList>(requireAuth(), 'list_data', columns ? { columns: true } : {});
  const out: string[] = [];
  if (r.events.length > 0) {
    out.push(`Event data (${fmtInt(r.events.length)})`);
    out.push(
      ...table(
        r.events,
        [
          { header: 'Name', value: (e) => e.name, max: 40 },
          { header: 'Kind', value: (e) => e.kind },
          { header: 'On', value: (e) => e.on, max: 32 },
          { header: 'Events', value: (e) => e.events.join(', '), max: 48 },
          { header: 'Rows', value: (e) => fmtInt(e.rows), align: 'right' },
          { header: 'Status', value: (e) => e.status },
        ],
        '  ',
      ),
    );
    if (columns) for (const e of r.events) out.push(`  ${e.name}: ${(e.columns ?? []).join(', ') || DASH}`);
  }
  if (r.tables.length > 0) {
    if (out.length > 0) out.push('');
    out.push(`Tables (${fmtInt(r.tables.length)})`);
    out.push(
      ...table(
        r.tables,
        [
          { header: 'Name', value: (t) => t.name, max: 40 },
          { header: 'Active', value: (t) => fmtInt(t.rows), align: 'right' },
          { header: 'Done', value: (t) => fmtInt(t.done), align: 'right' },
          { header: 'Status', value: (t) => t.status },
        ],
        '  ',
      ),
    );
  }
  if (out.length > 0) out.push('');
  out.push('Built in');
  out.push(...table(r.builtIn, [{ header: 'Name', value: (b) => b.name }, { header: 'Asked with', value: (b) => `contract-dev query ${b.name}` }, { header: 'What', value: (b) => b.what }], '  '));
  for (const line of out) console.log(line);
  return r;
}

async function defineData(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(HELP);
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'name');
  for (const k of ['value', 'aggregate', 'unit'])
    if (flag(flags, k) !== undefined) throw new Error(`--${k} makes a number: data keeps rows and every question adds them up after. Put the figure in a field (--field "vol=…"), or make a metric (contract-dev metric define).`);
  const definition = definitionFrom(flags);
  if (!definition.events) throw new Error('--event names what each row is: --event Swap.');
  const description = flag(flags, 'description');
  const result = await runTool<Record<string, unknown>>(requireAuth(), 'define_data', { name, ...scopeInput(flags), ...(description ? { description } : {}), ...definition });
  for (const line of printResult(result)) console.log(line);
  return result;
}

export async function dataCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  if (!sub || ['help', '-h', '--help'].includes(sub)) return void console.log(HELP);
  if (sub === 'list' || sub === 'ls') return listData(rest);
  if (sub === 'define' || sub === 'add') return defineData(rest);
  if (sub === 'query') return queryCommand(['data', ...rest]);
  throw new Error(`Unknown data command "${sub}" (try: contract-dev data help).`);
}

export default dataCommand;
