// A tool's answer as terminal lines, for the commands that print a whole result (table, history):
// a scalar as `label  value`, a list of flat rows as an aligned table, a section indented under its
// name. --json still hands back the tool's own result, so nothing here decides what is said.
import { DASH, fmtSpan, fmtUsd, table, type Column } from '../view';

const isScalar = (v: unknown): v is string | number | boolean | null => v == null || ['string', 'number', 'boolean'].includes(typeof v);
const human = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** A cell: a number grouped, a URL or an address kept whole, an unknown as the dash. */
export function cell(v: unknown): string {
  if (v == null) return DASH;
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.every(isScalar) ? v.map(cell).join(', ') : `${v.length} items`;
  // a named address ({ address, name }) reads as its name, else the address
  const o = v as Record<string, unknown>;
  if (typeof o.address === 'string') return typeof o.name === 'string' && o.name ? `${o.name} (${o.address})` : o.address;
  return JSON.stringify(v);
}

/** A value as its column's unit says: a unix time as a UTC stamp, a duration (held in seconds) compactly (3h, 12d), dollars as dollars ($436.8K); anything else as the server sent it. */
export function byUnit(v: unknown, unit: string | undefined): unknown {
  if (typeof v !== 'number') return v;
  if (unit === 'time') return new Date(v * 1000).toISOString().slice(0, 16).replace('T', ' ');
  if (unit === 'duration') return fmtSpan(v);
  if (unit === 'usd') return fmtUsd(v);
  return v;
}

/** A breakdown's column: each row's `breakdown` holds its parts (that column's value, `value`, `rows`). */
export interface BreakdownColumn {
  key: string;
  label: string;
  unit?: string;
}

/**
 * The cells of rows split again by a column (a wallet, then its chains): each row as it is, then
 * one line per part under it, indented, its value in the first column and its own figures (each
 * measure, its rows) under the row's; the row's other columns stay blank on a part's line.
 */
export function partCells(rows: Record<string, unknown>[], keys: string[], unitOf: Map<string, string | undefined>, split: BreakdownColumn | undefined): string[][] {
  const out: string[][] = [];
  for (const r of rows) {
    out.push(keys.map((k) => cell(byUnit(r[k], unitOf.get(k)))));
    const parts = split && Array.isArray(r.breakdown) ? (r.breakdown as Record<string, unknown>[]) : [];
    // the part's own figures (each measure, its rows) under the row's; the row's other columns stay blank
    for (const x of parts) out.push(keys.map((k, i) => (i === 0 ? `  ${cell(byUnit(x[split!.key], split!.unit))}` : k !== 'parts' && Object.prototype.hasOwnProperty.call(x, k) ? cell(byUnit(x[k], unitOf.get(k))) : '')));
  }
  return out;
}

/** A list of rows as a table: the columns the first rows carry, scalars first, at most `maxColumns`. */
export function rowsTable(rows: Record<string, unknown>[], indent = '', maxColumns = 8, skip: string[] = ['url', 'chainId']): string[] {
  const keys: string[] = [];
  for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!keys.includes(k) && !skip.includes(k)) keys.push(k);
  const columns: Column<Record<string, unknown>>[] = keys.slice(0, maxColumns).map((k) => ({
    header: human(k),
    value: (r) => cell(r[k]),
    align: rows.every((r) => r[k] == null || typeof r[k] === 'number') ? 'right' : 'left',
    max: 48,
  }));
  return table(rows, columns, indent);
}

/** A timeline given as columns and rows ({ columns, rows }). */
export function columnsTable(columns: string[], rows: unknown[][], indent = ''): string[] {
  return table(
    rows,
    columns.map((c, i) => ({ header: human(c), value: (r: unknown[]) => cell(r[i]), align: i === 0 ? 'left' : 'right' })),
    indent,
  );
}

/** Every part of a result, in its own order. `omit` leaves out keys a command already printed. */
export function printResult(result: unknown, opts: { omit?: string[]; indent?: string } = {}): string[] {
  const out: string[] = [];
  const indent = opts.indent ?? '';
  if (!result || typeof result !== 'object') return [`${indent}${cell(result)}`];
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (opts.omit?.includes(k) || v === undefined) continue;
    if (isScalar(v) || (Array.isArray(v) && v.every(isScalar))) {
      out.push(`${indent}${human(k)}: ${cell(v)}`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out.push('', `${indent}${human(k)}`);
      const flat = v.every((r) => r && typeof r === 'object' && !Array.isArray(r));
      out.push(...(flat ? rowsTable(v as Record<string, unknown>[], `${indent}  `) : v.map((x) => `${indent}  ${cell(x)}`)));
    } else {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.columns) && Array.isArray(o.rows)) {
        out.push('', `${indent}${human(k)}${o.by ? ` (by ${String(o.by)}${o.timezone ? `, ${String(o.timezone)}` : ''})` : ''}`);
        out.push(...columnsTable(o.columns as string[], o.rows as unknown[][], `${indent}  `));
        continue;
      }
      out.push('', `${indent}${human(k)}`);
      out.push(...printResult(o, { indent: `${indent}  ` }));
    }
  }
  return out;
}
