// ONE GRAMMAR FOR A METRIC (2026-11-07). The flags of `metric define` and the clauses of an inline
// definition (a report row "metric:<name>=on steth; call totalSupply()", an alert's --on) build the
// same `define_metric` input, and the server decides the kind: `call` reads how things stand (a
// STATE metric), `each` counts what happens (an ACTIVITY metric), `on table:` takes the table's.
// The person never names the store, and never makes a metric by hand to put one in a report.

import { flag, flagAll, onlyFlags, parseFlags, requirePositional, type ParsedFlags } from './_args';
import { definitionFrom } from './eventMetric';
import { chainFlag } from '../data';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';

export const DEFINE_FLAGS = [
  'on',
  'chain',
  'call',
  'value',
  'decimals',
  'token',
  'show',
  'each',
  'event',
  'where',
  'read',
  'fixed',
  'field',
  'aggregate',
  'split',
  'line',
  'unit',
  'history',
  'keep',
  'pair',
  'column',
  'among',
  'description',
  'hidden',
  'preview',
  'group',
  'contract',
] as const;

export const DEFINE_HELP = `contract-dev metric define "<name>" --on <what> [--chain <id>] …

What it is on (--on): a contract or wallet by its name or 0x address · tag:<group> (every member, added up)
· table:"<table>" (its rows) · workspace (every watched contract). Then one of:

  A STATE metric — how things stand, read every minute from now on (any address, watched or not):
    --call "<read>"…  [--value "<expr>"] [--decimals <n>] [--token <t>] [--show usd] [--split contract]
      a read: "totalSupply()", "balanceOf(self) on 0xA0b8…" (a token balance; self = what the metric is on),
      "balance(self)" (the coin), "pooled=getTotalPooledEther() decimals 18", "cap=slot(self, 7)";
      several reads take --value, the expression over their names: --value "pooled / shares";
      on a group, each member is read and they add up; --split contract keeps each member's line

  An ACTIVITY metric — what happened, added up from events per window (the address is watched for you):
    --each <Event>… [--value "<expr>"] [--where "<rule>"] [--read "<name>=<call>…"]… [--field "<name>=<expr>"]…
      [--aggregate sum|count|avg|min|max|latest] [--split contract|<field>] [--unit usd|count|number]
      [--keep <param>…] [--pair "<Event> [on <field>]"]… [--history <days>] [--line "<what one line is>"]
      no --value counts the events; dollars only through a stated token: --value "usd(amount, token0())"

  On a table (--on table:"<t>"): [--column "<label>"] [--among active|done|all] [--aggregate …] (a state
    table: the column added up across its rows) or [--value "<expr>"] [--where …] (a table over events: its
    rows counted or summed, under the table's own where)

  [--description "<sentence>"]  [--hidden: off the Metrics page, made for one report or alert]  [--preview]

Examples:
  contract-dev metric define "stETH supply" --on steth --call "totalSupply()"
  contract-dev metric define "Treasury USDC" --on tag:treasury --call "balanceOf(self) on 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  contract-dev metric define "stETH per share" --on steth --call "pooled=getTotalPooledEther() decimals 18" \\
    --call "shares=getTotalShares() decimals 18" --value "pooled / shares"
  contract-dev metric define "Swap fees" --on tag:pools --each Swap --read "fee=fee()" --read "t0=token0()" \\
    --value "usd(abs(amount0) * fee / 1000000, t0)"
  contract-dev metric define "LP value" --on table:"Positions" --column Value
  contract-dev metric define "Big swaps a day" --on table:"Big swaps" --aggregate count

The same words inline, in a report row or an alert, make the metric for it and keep it off the Metrics page:
  --row "metric:LP value=on table:Positions; column Value"     --on "metric:Supply=on steth; call totalSupply()"
`;

/** The define flags as the tool's input. */
export function defineInputFromFlags(name: string, flags: ParsedFlags): Record<string, unknown> {
  const definition = definitionFrom(flags);
  const each = [...flagAll(flags, 'each'), ...((definition.events as string[] | undefined) ?? [])];
  delete definition.events;
  const input: Record<string, unknown> = { name, ...definition };
  const group = flag(flags, 'group');
  const on = flag(flags, 'on') ?? (group ? `tag:${group}` : flag(flags, 'contract'));
  if (on) input.on = on;
  const chainId = chainFlag(flags);
  if (chainId != null) input.chainId = chainId;
  const calls = flagAll(flags, 'call');
  if (calls.length > 0) input.call = calls;
  if (each.length > 0) input.each = each;
  for (const k of ['token', 'column', 'among', 'description'] as const) {
    const v = flag(flags, k);
    if (v !== undefined) input[k] = v;
  }
  const decimals = flag(flags, 'decimals');
  if (decimals !== undefined) {
    const n = Number(decimals);
    if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error('--decimals takes a whole number from 0 to 36.');
    input.decimals = n;
  }
  const show = flag(flags, 'show');
  if (show !== undefined) {
    if (show !== 'usd') throw new Error('--show takes usd: the value in dollars at its token\'s price.');
    input.show = 'usd';
  }
  if (flag(flags, 'hidden') !== undefined) input.listed = false;
  if (flag(flags, 'preview') !== undefined) input.preview = true;
  return input;
}

/** Clauses split on `;` outside brackets and quotes. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out.filter(Boolean);
}

export const CLAUSE_HELP = 'An inline metric is "<name>=<clause>; <clause>…", each clause a define flag without its dashes: on steth; call totalSupply(); each Swap; value usd(amount, token0()); where amount > 0; aggregate count; split contract; unit usd; column Value; among active; token 0x…; show usd; decimals 18; history 30; hidden.';

const CLAUSE_WORDS = new Set<string>(DEFINE_FLAGS);

/** `"on steth; call totalSupply(); hidden"` as the same flags `metric define` takes. */
export function clausesToArgs(text: string): string[] {
  const args: string[] = [];
  for (const clause of splitClauses(text)) {
    const m = /^([a-z-]+)(?:\s+(.*))?$/s.exec(clause);
    const word = m?.[1] ?? '';
    if (!m || !CLAUSE_WORDS.has(word)) throw new Error(`Unknown clause "${clause.split(/\s/)[0]}". ${CLAUSE_HELP}`);
    const rest = (m[2] ?? '').trim();
    if (word === 'hidden' || word === 'preview') {
      args.push(`--${word}`);
      continue;
    }
    if (!rest) throw new Error(`"${word}" needs a value. ${CLAUSE_HELP}`);
    // several events in one clause: each Swap, Mint
    if (word === 'each' || word === 'event') for (const e of rest.split(',').map((x) => x.trim()).filter(Boolean)) args.push(`--${word}`, e);
    else args.push(`--${word}`, rest.replace(/^"(.*)"$/s, '$1'));
  }
  return args;
}

/** The inline form, when `raw` has one: `<name>=<clauses>` with the `=` before any bracket. */
export function inlineDefinition(raw: string): { name: string; clauses: string } | null {
  const eq = raw.indexOf('=');
  const paren = raw.search(/[(;]/);
  if (eq <= 0 || (paren >= 0 && paren < eq)) return null;
  const name = raw.slice(0, eq).trim();
  const clauses = raw.slice(eq + 1).trim();
  if (!name || !clauses) return null;
  return { name, clauses };
}

export function defineInputFromClauses(name: string, clauses: string): Record<string, unknown> {
  return defineInputFromFlags(name, parseFlags([name, ...clausesToArgs(clauses)]));
}

export interface Defined {
  created: boolean;
  preview?: boolean;
  metric: { id: string | null; name: string; kind: 'state' | 'activity'; source: 'tracked' | 'custom'; on: string };
  url: string | null;
  watched?: { chainId: number; address: string; name: string; kind: 'contract' | 'wallet' };
  note?: string;
  detail?: unknown;
}

/** What a define answered, in lines. */
export function definedLines(r: Defined): string[] {
  const out: string[] = [];
  if (r.watched) out.push(`Watched ${r.watched.name} (${r.watched.kind}, chain ${r.watched.chainId}) to keep its history.`);
  if (r.preview) out.push(`Preview of ${r.metric.name}: ${r.metric.kind === 'activity' ? 'an' : 'a'} ${r.metric.kind} metric on ${r.metric.on}. Nothing saved.`);
  else out.push(`${r.created ? 'Defined' : 'Already defined:'} ${r.metric.name} — ${r.metric.kind === 'activity' ? 'an' : 'a'} ${r.metric.kind} metric on ${r.metric.on}${r.metric.id ? ` (${r.metric.id})` : ''}.`);
  if (r.url && !r.preview) out.push(r.url);
  if (r.note) out.push(r.note);
  return out;
}

/** Define a metric for a report row or an alert, off the Metrics page; the id for the thing that owns it. */
export async function defineInline(name: string, clauses: string): Promise<{ id: string; name: string }> {
  const input = { ...defineInputFromClauses(name, clauses), listed: false };
  delete (input as Record<string, unknown>).preview;
  const r = await runTool<Defined>(requireAuth(), 'define_metric', input);
  for (const line of definedLines(r)) console.log(line);
  if (!r.metric.id) throw new Error(`"${name}" was not saved.`);
  return { id: r.metric.id, name };
}

/** `metric define "<name>" …` */
export async function defineMetricCommand(args: string[]): Promise<unknown> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) return void console.log(DEFINE_HELP);
  const flags = parseFlags(args);
  onlyFlags(flags, 'metric define', DEFINE_FLAGS);
  const name = requirePositional(flags._ as string[], 0, 'name');
  const input = defineInputFromFlags(name, flags);
  if (!input.on) throw new Error('--on says what the metric is on: a contract or wallet, tag:<group>, table:"<table>", or workspace.');
  if (!input.call && !input.each && !String(input.on).toLowerCase().startsWith('table:')) throw new Error('Say what the metric is: --call "<read>" for how things stand (a balance, a supply), or --each <Event> for what happens (try: metric define help).');
  const r = await runTool<Defined>(requireAuth(), 'define_metric', input);
  for (const line of definedLines(r)) console.log(line);
  return r;
}

export interface MetricRow {
  source: 'tracked' | 'custom';
  id: string;
  name: string;
  kind: 'state' | 'activity';
  listed: boolean;
  enabled: boolean;
  pinned?: boolean;
  on: string;
  reads: string;
  unit: string | null;
  chainId: number | null;
}

/** Every metric, both kinds, as the server lists them. */
export async function listAllMetrics(opts: { hidden?: boolean; kind?: 'state' | 'activity'; on?: string } = {}): Promise<MetricRow[]> {
  const r = await runTool<{ metrics: MetricRow[] }>(requireAuth(), 'list_metrics', { ...(opts.hidden ? { hidden: true } : {}), ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.on ? { on: opts.on } : {}) });
  return r.metrics ?? [];
}

/** One metric by id or name, whichever kind it is. */
export async function resolveAnyMetric(ref: string): Promise<MetricRow> {
  const all = await listAllMetrics({ hidden: true });
  const q = ref.trim().toLowerCase();
  const byId = all.find((m) => m.id === ref.trim());
  if (byId) return byId;
  const named = all.filter((m) => m.name.trim().toLowerCase() === q);
  const hits = named.some((m) => m.listed) ? named.filter((m) => m.listed) : named;
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`"${ref}" names ${hits.length} metrics: ${hits.map((h) => `${h.name} (${h.kind}, ${h.id})`).join(', ')}. Pass the id.`);
  const near = all.filter((m) => m.listed && m.name.toLowerCase().includes(q)).slice(0, 6);
  throw new Error(`No metric matches "${ref}".${near.length ? ` Close: ${near.map((h) => `${h.name} (${h.id})`).join(', ')}.` : ' Run `contract-dev metrics` to list them.'}`);
}

/** `metrics [--kind state|activity] [--hidden] [--on <what>]` */
export async function listMetricsCommand(args: string[]): Promise<MetricRow[]> {
  const flags = parseFlags(args);
  onlyFlags(flags, 'metrics', ['kind', 'hidden', 'on']);
  const kind = flag(flags, 'kind');
  if (kind !== undefined && kind !== 'state' && kind !== 'activity') throw new Error('--kind takes state (how things stand) or activity (what happened).');
  const rows = await listAllMetrics({ hidden: flag(flags, 'hidden') !== undefined, kind: kind as 'state' | 'activity' | undefined, on: flag(flags, 'on') });
  if (rows.length === 0) {
    console.log(kind ? `No ${kind} metrics.` : 'No metrics. Define one with `contract-dev metric define "<name>" --on <what> --call "<read>" | --each <Event>` (try: metric define help).');
    return rows;
  }
  console.log(`${'KIND'.padEnd(9)} ${'NAME'.padEnd(34)} ${'ON'.padEnd(28)} ${'READS'.padEnd(36)} ${'UNIT'.padEnd(7)} ID`);
  for (const m of rows) {
    const flagsWord = [m.listed ? '' : 'hidden', m.enabled ? '' : 'paused'].filter(Boolean).join(', ');
    console.log(`${m.kind.padEnd(9)} ${m.name.slice(0, 34).padEnd(34)} ${m.on.slice(0, 28).padEnd(28)} ${m.reads.slice(0, 36).padEnd(36)} ${(m.unit ?? '').padEnd(7)} ${m.id}${flagsWord ? `  (${flagsWord})` : ''}`);
  }
  return rows;
}
