// Groups, through the platform's tools: what a group holds (its rules, table, monitors and
// members), the rules that keep it filled, its name pattern, its columns and its monitors — and
// `factory`, the question asked before a rule: what did this factory deploy, and is it watched.
// Each command sends the tool its input, prints the answer, and hands --json the tool's own result.
import { parseFlags, flag, flagAll, onlyFlags, requireFlag, requirePositional, type ParsedFlags } from './_args';
import { parseFormulaCall } from './eventMetric';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { chainFlag, limitFlag } from '../data';
import { watchSummaryLines, type WatchContractsResult } from './watch';
import { DASH, chainLabel, fmtCompact, fmtInt, fmtTime, fmtUsd, plural, shortAddr, table } from '../view';

const HELP = `contract-dev group — a group of contracts: the rules that fill it, its table, its monitors, its members

Usage:
  contract-dev group show <group>                     Rules, table columns, monitors and members with each column's value
  contract-dev group rule add <group> --factory <address> --event <Name> --field <arg> [--chain <id|name>]
                              [--name-pattern "…"] [--recent] [--preview]
                                                      Every contract the factory has ever deployed joins the group, in
                                                      the background (thousands take a while), then each new one;
                                                      --recent: only the last few weeks and what comes next
  contract-dev group rule add <group> --registry <address> --function "getAllMarkets()" [--chain <id|name>]
                              [--name-pattern "…"] [--preview]
                                                      Every contract the registry lists joins the group
  contract-dev group name-pattern <group> "<pattern>" [--preview]
                                                      Name every member from its own reads: "{token0().symbol()} pool"
  contract-dev group name-pattern <group> --clear     Members keep their own names again
  contract-dev group column add <group> --label "…" --read "totalAssets()" [--args a,b] [--word <n>] [--decimals <n>]
                              (then: contract-dev metric group "<name>" --group <group> --column <key> rolls it up)
                              [--decimals-from "decimals()"] [--token <token> [--show usd]] [--unit int|pct|duration|rate|raw] [--attribute]
                              [--type address|uint|bool|string] [--key <key>] [--preview]
                                                      A column on the group's table: one read on every member, tracked
  contract-dev group column add <group> --label "…" [--call "<name>=<call> [on <target>] [with <args>] [decimals <n>]"]…
                              --formula "<expr>" [--type bool] [--token <token> [--show usd]] [--unit …] [--key <key>] [--preview]
                                                      A FORMULA column: calls resolved on every member (a view, balance(self),
                                                      slot(self, <key>)) and an expression over them and the group's other
                                                      columns ({Held} - {Required}), one calculated value per member; a
                                                      yes/no (--type bool, or inferred) a count roll-up counts
  contract-dev group monitor add <group> --name "…" --column <key|label> --when "<formula>" [--warn "<formula>"] [--preview]
                                                      One monitor on every member, judged on a column of the table

--preview on rule add, name-pattern, column add and monitor add shows what would happen — the contracts
found, the names, the first readings, the monitor's sentence — and saves nothing.
--chain takes an id or a name (ethereum, arbitrum, avalanche, sepolia); the server reads ethereum without one.
--event / --field name the factory's creation event and its address argument that is the new contract. Both are
required: nothing is picked from names. Without them the answer lists every event with an address argument.
--args: the read's argument values in order, comma-separated. Nothing is assumed about what a reading is: --token
says it is an amount of a token (its 0x address, self for each member itself, or a view each member answers with the
token's address, like asset()); its decimals then scale it, --show usd puts it in dollars, and a roll-up can price it.
Without one it is the plain number: --decimals scales the raw word, --decimals-from names a view on each member that
answers its own scale. --attribute reads a non-numeric value once.
--when names the column's reading as value: value < 1000000, value > 95 (in the column's display unit, 95 for 95%
on a pct column), or value > {Cap} against another column of the same table. --warn is the same comparison nearer
the healthy side, a warning tier: --warn "value < 1100000" beside --when "value < 1000000", --warn "value > {Cap} * 0.9"
beside --when "value > {Cap}".

Examples:
  contract-dev group show pools
  contract-dev group rule add pools --factory 0x1F98431c8aD98523631AE4a59f267346ea31F984 --event PoolCreated --field pool --preview
  contract-dev group name-pattern pools "{token0().symbol()}/{token1().symbol()} pool"
  contract-dev group column add vaults --label "Assets" --read "totalAssets()" --token "asset()" --show usd
  contract-dev group column add vaults --label "Headroom" --call "held=totalAssets()" --call "required=coverageLiquidity()" \\
    --formula "held - required" --token "asset()" --show usd
  contract-dev group column add vaults --label "Breached" --formula "{Held} < {Required}"
  contract-dev group monitor add vaults --name "Vault draining" --column assets --when "value < 1000000" --warn "value < 1100000"
  contract-dev group monitor add vaults --name "Over cap" --column util --when "value > {Cap}"
`;

const FACTORY_HELP = `contract-dev factory — the contracts a factory deployed

Usage:
  contract-dev factory <address> --event <Name> --field <arg> [--chain <id|name>] [--limit <n>]
                                                      How many, the newest with their dates, which are watched
  contract-dev factory <address> --event <Name> --field <arg> --watch --group <name>
                                                      Then watch the ones not yet watched, tagged into the group

--event is the factory's event that announces a new contract (PoolCreated, MarketDeployed…) and --field its address
argument that IS the new contract (pool, market…). Both are required: nothing is picked from names. Without them
the answer lists every event with an address argument. The new contracts get no invented names: name them with
contract-dev group name-pattern <group> "<pattern>". A long history is read as far as one go allows; the answer then says how far
it got, and the total is a floor. --watch takes the newest not yet watched, up to 150 at a time: on a factory
with thousands of children, watch the ones that matter by address instead. Afterwards a rule keeps the group
filled: contract-dev group rule add <group> --factory <address> --event <Name> --field <arg>.

Examples:
  contract-dev factory 0x1F98431c8aD98523631AE4a59f267346ea31F984 --event PoolCreated --field pool --limit 50
  contract-dev factory 0x02Ca7772FF14a9F6c1a08aF385aA96bb1b34175A --event VaultCreated --field vault --watch --group Lido
`;

const HELP_WORDS = ['help', '-h', '--help'];

// Past this many new contracts in one go, the tool wants it said twice.
const MANY = 25;

// ── shapes the tools answer with ──

type RuleField = { topic: 1 | 2 | 3 } | { word: number };

export interface GroupRule {
  id: string;
  kind: 'factory' | 'registry';
  chainId: number;
  address: string;
  function?: string;
  topic0?: string;
  field?: RuleField;
  lastSyncAt: string | null;
  /** A history rule (every child since the factory began): how far it has read, against the chain's head. */
  history?: boolean;
  readToBlock?: number;
  headBlock?: number | null;
  filling?: boolean | null;
}

export type ColumnUnit = 'usd' | 'int' | 'pct' | 'duration' | 'rate' | 'raw';

export interface GroupColumn {
  key: string;
  label: string;
  read: string;
  args: string[];
  word: number;
  decimals: number;
  decimalsFrom: string | null;
  unit: ColumnUnit;
  /** A formula column (the read grammar): its expression, its calls, and `type` bool when it answers yes or no. */
  expr?: string;
  type?: string;
  calls?: Array<{ name: string; kind?: string; signature?: string; on?: string; args?: string[]; key?: string; decimals?: number }>;
  kind: string;
}

export interface GroupMonitor {
  id: string;
  name: string;
  column: string;
  when: 'above' | 'below';
  threshold: number | null;
  otherColumn: string | null;
  warnPct: number | null;
  contracts: number;
  states: Record<string, number>;
}

export interface GroupMember {
  chainId: number;
  address: string;
  name: string;
  values: Record<string, number | null>;
}

export interface GroupDescription {
  group: string;
  contracts: number;
  namePattern: string | null;
  rules: GroupRule[];
  columns: GroupColumn[];
  monitors: GroupMonitor[];
  members: GroupMember[];
  membersMore?: number;
}

type RuleWords = { kind: 'factory'; chainId: number; address: string; event: string; field: string; history?: boolean } | { kind: 'registry'; chainId: number; address: string; function: string };

export interface RuleResult {
  preview?: true;
  group: string;
  rule: RuleWords & { id?: string };
  namePattern: string | null;
  sample: Array<{ address: string; name: string | null }>;
  note?: string | null;
  /** 'started': saved at once, the first fill runs in the background (older servers answered with the tally). */
  sync?: 'started' | { discovered: number; tagged: number; watched: number; pending: number; failed: Array<{ address: string; reason: string }> };
}

export interface NamePatternResult {
  preview?: true;
  group: string;
  pattern: string | null;
  named?: number;
  sample: Array<{ address: string; name: string }>;
  contracts: number;
}

export interface ColumnResult {
  preview?: true;
  group: string;
  column: {
    key: string;
    label: string;
    kind: string;
    signature: string;
    args: string[];
    word: number;
    decimals: number;
    unit: ColumnUnit;
    decimalsFrom?: string | null;
    /** A formula column: its calls and its expression; `type` bool when it answers yes or no. */
    calls?: Array<{ name: string; kind?: string; signature?: string; on?: string; args?: string[]; key?: string; decimals?: number }>;
    expr?: string;
    type?: string;
    token?: string;
    show?: string;
  };
  sample: Array<{ address: string; name: string; value: number | string | null; error?: string }>;
  contracts: number;
  note?: string | null;
}

/** A formula column's call in words: `held = totalAssets() on asset() decimals 18`, `eth = balance(self)`, `cap = slot(self, 7)`. */
function callWords(c: NonNullable<ColumnResult['column']['calls']>[number]): string {
  const on = c.on && c.on !== 'self' ? c.on : null;
  let text: string;
  if (c.kind === 'balance') text = `balance(${on ?? 'self'})`;
  else if (c.kind === 'slot') text = `slot(${on ?? 'self'}, ${c.key ?? '0'})`;
  else text = `${c.signature ?? ''}${on ? ` on ${on}` : ''}${c.args?.length ? ` with ${c.args.join(', ')}` : ''}`;
  return `${c.name} = ${text}${c.decimals ? ` decimals ${c.decimals}` : ''}`;
}

export interface GroupMonitorResult {
  preview?: true;
  group: string;
  monitor: { id?: string; name: string; columnKey: string; op: 'lt' | 'gt'; threshold?: number; otherColumnKey?: string; warnPct?: number; words: string; contracts?: number };
  contracts: number;
}

export interface FactoryResult {
  factory: string;
  chainId: number;
  events: string[];
  used: Array<{ event: string; field: string }>;
  candidates: Array<{ event: string; addressArgs: string[] }>;
  total: number;
  complete: boolean;
  /** The read goes newest first: when it stopped short, the oldest day it reached. */
  readBackTo?: string | null;
  /** Older servers read oldest first and said how far forward they got. */
  readThrough?: string | null;
  source: 'history' | 'window';
  since: string | null;
  watched: number;
  notWatched: number;
  newest: Array<{ address: string; at: string | null; watched: boolean }>;
  notWatchedAddresses: string[];
  notWatchedMore?: number;
}

// ── words ──

/** A column's value in its display unit: dollars, a count, a percentage (the server sends 95 for 95%), else compact. */
export function fmtColumnValue(v: number | null | undefined, unit: string | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (unit === 'usd') return fmtUsd(v);
  if (unit === 'int') return fmtInt(v);
  if (unit === 'pct') return `${fmtCompact(v)}%`;
  return fmtCompact(v);
}

const fieldWords = (f: RuleField | undefined): string => (f ? ('topic' in f ? `topic ${f.topic}` : `word ${f.word}`) : DASH);

/** What a rule reads: the registry's function, or the factory's creation event (its topic) and the argument. */
const ruleReads = (r: GroupRule): string => (r.kind === 'registry' ? r.function ?? DASH : `${r.topic0 ? shortAddr(r.topic0) : DASH} · ${fieldWords(r.field)}`);

const syncWords = (iso: string | null | undefined): string => (iso ? fmtTime(Date.parse(iso)) : 'never');

/** above 1.00M · below reserves · (warn 10% before) */
const monitorWhen = (m: GroupMonitor): string => {
  const line = m.otherColumn ?? (m.threshold != null ? fmtCompact(m.threshold) : DASH);
  return `${m.when} ${line}${m.warnPct != null ? ` (warn ${m.warnPct}% before)` : ''}`;
};

const statesWords = (states: Record<string, number> | null | undefined): string =>
  Object.entries(states ?? {})
    .map(([state, n]) => `${state} ${fmtInt(n)}`)
    .join(' · ') || DASH;

const decimalsWords = (c: { decimals?: number | null; decimalsFrom?: string | null }): string => (c.decimalsFrom ? `from ${c.decimalsFrom}` : c.decimals != null ? String(c.decimals) : DASH);

/** The header line, the name pattern, then one block per section; an empty section is one line. */
/** A history rule's progress in a word or two: how far back through the factory's past it has read. */
function ruleFill(r: GroupRule): string {
  if (!r.history) return DASH;
  if (r.filling === false) return 'complete';
  if (r.headBlock && r.readToBlock != null) return `${Math.min(99, Math.floor((r.readToBlock / r.headBlock) * 100))}% of history`;
  return 'filling';
}

export function groupLines(g: GroupDescription): string[] {
  const lines = [`${g.group} · ${plural(g.contracts, 'contract')}`];
  if (g.namePattern) lines.push(`Name pattern: ${g.namePattern}`);

  const rules = g.rules ?? [];
  lines.push('', rules.length ? `Rules (${fmtInt(rules.length)})` : 'No rules.');
  if (rules.length) {
    lines.push(
      ...table(
        rules,
        [
          { header: 'Kind', value: (r) => r.kind },
          { header: 'Chain', value: (r) => chainLabel(r.chainId) },
          { header: 'Address', value: (r) => r.address },
          { header: 'Reads', value: ruleReads, max: 40 },
          { header: 'Last sync', value: (r) => syncWords(r.lastSyncAt) },
          { header: 'Filled', value: ruleFill },
        ],
        '  ',
      ),
    );
  }

  const columns = g.columns ?? [];
  lines.push('', columns.length ? `Columns (${fmtInt(columns.length)})` : 'No columns.');
  if (columns.length) {
    lines.push(
      ...table(
        columns,
        [
          { header: 'Key', value: (c) => c.key },
          { header: 'Label', value: (c) => c.label, max: 32 },
          { header: 'Read', value: (c) => (c.kind === 'formula' ? `formula ${c.expr ?? ''}${c.calls?.length ? ` with ${c.calls.map(callWords).join('; ')}` : ''}` : `${c.read}${c.args?.length ? ` (${c.args.join(', ')})` : ''}`), max: 64 },
          { header: 'Unit', value: (c) => c.unit ?? 'raw' },
          { header: 'Decimals', value: decimalsWords },
        ],
        '  ',
      ),
    );
  }

  const monitors = g.monitors ?? [];
  lines.push('', monitors.length ? `Monitors (${fmtInt(monitors.length)})` : 'No monitors.');
  if (monitors.length) {
    lines.push(
      ...table(
        monitors,
        [
          { header: 'Name', value: (m) => m.name, max: 40 },
          { header: 'Column', value: (m) => m.column },
          { header: 'When', value: monitorWhen },
          { header: 'Contracts', value: (m) => fmtInt(m.contracts), align: 'right' },
          { header: 'States', value: (m) => statesWords(m.states) },
        ],
        '  ',
      ),
    );
  }

  const members = g.members ?? [];
  const more = g.membersMore ?? 0;
  lines.push('', members.length ? `Members (${more ? `${fmtInt(members.length)} of ${fmtInt(members.length + more)}` : fmtInt(members.length)})` : 'No members.');
  if (members.length) {
    lines.push(
      ...table(
        members,
        [
          { header: 'Chain', value: (m) => chainLabel(m.chainId) },
          { header: 'Name', value: (m) => m.name || DASH, max: 40 },
          { header: 'Address', value: (m) => m.address },
          ...columns.map((c) => ({
            header: c.key,
            // a yes/no formula column reads 1 or 0
            value: (m: GroupMember) => (c.kind === 'formula' && c.type === 'bool' ? (m.values?.[c.key] == null ? DASH : m.values?.[c.key] ? 'Yes' : 'No') : fmtColumnValue(m.values?.[c.key], c.unit)),
            align: 'right' as const,
          })),
        ],
        '  ',
      ),
    );
  }
  return lines;
}

const sampleTable = (sample: Array<{ address: string; name: string | null }>): string[] =>
  table(sample, [{ header: 'Name', value: (s) => s.name || DASH, max: 40 }, { header: 'Address', value: (s) => s.address }], '  ');

/** What the rule reads and from where, the contracts it found, and (once saved) what the sync did. */
export function ruleLines(r: RuleResult): string[] {
  const rule = r.rule;
  const reads = rule.kind === 'factory' ? `${rule.event}.${rule.field}` : rule.function;
  const lines = [
    r.preview ? 'Preview: nothing saved.' : `Rule ${rule.id} added to ${r.group}.`,
    `${rule.kind === 'factory' ? 'Factory' : 'Registry'} ${rule.address} on ${chainLabel(rule.chainId)} · reads ${reads}`,
  ];
  if (r.namePattern) lines.push(`Name pattern: ${r.namePattern}`);
  // a sample comes only with --preview (saving reads nothing first)
  const sample = r.sample ?? [];
  if (sample.length) lines.push('', `Found (${fmtInt(sample.length)})`, ...sampleTable(sample));
  else if (r.preview) lines.push('', 'No contracts found yet.');
  if (r.note) lines.push('', r.note);
  if (r.sync === 'started') {
    lines.push(
      '',
      rule.kind === 'factory' && rule.history
        ? 'Saved. It adds every contract the factory has ever made, in the background (thousands take a while; `group show` says how far it has got), then each new one.'
        : 'Saved. It fills the group in the background, and keeps adding what comes next.',
    );
  } else if (r.sync) {
    const s = r.sync;
    const failed = s.failed ?? [];
    lines.push('', `Synced: ${fmtInt(s.discovered)} discovered · ${fmtInt(s.tagged)} tagged · ${fmtInt(s.watched)} watched · ${fmtInt(s.pending)} pending · ${fmtInt(failed.length)} failed`);
    for (const f of failed) lines.push(`  failed ${f.address} — ${f.reason}`);
  }
  return lines;
}

export function namePatternLines(r: NamePatternResult): string[] {
  const lines: string[] = [];
  if (r.preview) lines.push('Preview: nothing saved.');
  lines.push(r.pattern ? `Name pattern: ${r.pattern}` : 'Name pattern: none — members keep their own names.');
  if (r.named != null) lines.push(`Named ${fmtInt(r.named)} of ${plural(r.contracts, 'contract')}.`);
  const sample = r.sample ?? [];
  if (sample.length) lines.push('', `Sample (${fmtInt(sample.length)})`, ...sampleTable(sample));
  return lines;
}

export function columnLines(r: ColumnResult): string[] {
  const c = r.column;
  const read = `${c.signature}${c.args?.length ? ` with ${c.args.join(', ')}` : ''}`;
  const lines = [r.preview ? 'Preview: nothing saved.' : `Added column "${c.label}" (${c.key}) to ${r.group} · ${plural(r.contracts, 'contract')}.`];
  if (c.kind === 'formula') {
    const amount = c.token ? ` · amount of ${c.token}${c.show === 'usd' ? ' shown in dollars' : ''}` : '';
    lines.push(`Column ${c.key} · ${c.label} · formula ${c.expr ?? ''} · ${c.type === 'bool' ? 'yes/no' : (c.unit ?? 'raw')}${amount}`);
    for (const call of c.calls ?? []) lines.push(`  ${callWords(call)}`);
  } else lines.push(`Column ${c.key} · ${c.label} · reads ${read} · ${c.unit ?? 'raw'} · decimals ${decimalsWords(c)}`);
  const sample = r.sample ?? [];
  if (sample.length) lines.push('', `Readings (${fmtInt(sample.length)})`);
  else if (r.preview) lines.push('', 'No readings yet.');
  if (sample.length) {
    const yesNo = c.kind === 'formula' && c.type === 'bool';
    lines.push(
      ...table(
        sample,
        [
          { header: 'Name', value: (s) => s.name || DASH, max: 40 },
          { header: 'Address', value: (s) => s.address },
          { header: 'Value', value: (s) => (s.error ? DASH : yesNo ? (s.value == null ? DASH : Number(s.value) ? 'Yes' : 'No') : fmtColumnValue(s.value == null ? null : Number(s.value), c.unit)), align: 'right' },
          ...(sample.some((s) => s.error) ? [{ header: 'Reason', value: (s: (typeof sample)[number]) => s.error ?? '', max: 60 }] : []),
        ],
        '  ',
      ),
    );
  }
  if (r.note) lines.push('', r.note);
  return lines;
}

export function groupMonitorLines(r: GroupMonitorResult): string[] {
  const m = r.monitor;
  return [r.preview ? 'Preview: nothing saved.' : `Added monitor "${m.name}" (${m.id}) to ${r.group}.`, m.words, `Covers ${plural(m.contracts ?? r.contracts, 'contract')}.`];
}

/** What was read, the totals, and the newest contracts. */
export function factoryLines(r: FactoryResult): string[] {
  const used = r.used?.[0];
  const lines: string[] = [];
  if (used) lines.push(`Read ${used.event}.${used.field}`);
  const coverage = r.complete
    ? 'the whole history'
    : r.readBackTo !== undefined
      ? `the newest, back to ${r.readBackTo ?? DASH}; older ones not read`
      : `read through ${r.readThrough ?? DASH}, not complete`;
  lines.push(`${plural(r.total, 'contract')} · ${fmtInt(r.watched)} watched · ${fmtInt(r.notWatched)} not watched · ${coverage}${r.since ? ` · since ${r.since}` : ''}`);
  const newest = r.newest ?? [];
  if (newest.length) {
    lines.push(
      '',
      ...table(newest, [
        { header: 'Address', value: (c) => c.address },
        { header: 'Deployed', value: (c) => c.at ?? DASH },
        { header: 'Watched', value: (c) => (c.watched ? 'yes' : 'no') },
      ]),
    );
  }
  return lines;
}

// ── flags ──

function numberFlag(flags: ParsedFlags, name: string): number | undefined {
  const raw = flag(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw === 'true' || raw.trim() === '' || !Number.isFinite(n)) throw new Error(`--${name} must be a number (got: ${raw})`);
  return n;
}

function wordFlag<T extends string>(flags: ParsedFlags, name: string, allowed: readonly T[]): T | undefined {
  const raw = flag(flags, name);
  if (raw === undefined) return undefined;
  const hit = allowed.find((w) => w === raw.trim().toLowerCase());
  if (!hit) throw new Error(`--${name} must be one of ${allowed.join(', ')} (got: ${raw})`);
  return hit;
}

const previewFlag = (flags: ParsedFlags): boolean => flag(flags, 'preview') === 'true';

// ── commands ──

export async function groupCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'show':
      return await showGroup(rest);
    case 'rule':
    case 'rules':
      return await ruleCommand(rest);
    case 'name-pattern':
    case 'pattern':
      return await namePatternCommand(rest);
    case 'column':
    case 'columns':
      return await columnCommand(rest);
    case 'monitor':
    case 'monitors':
      return await groupMonitorCommand(rest);
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      // `group pools` reads as `group show pools`.
      return await showGroup(args);
  }
}

async function showGroup(args: string[]): Promise<GroupDescription | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const group = (flags._ as string[]).join(' ').trim();
  if (!group) throw new Error('Name the group.');
  const g = await runTool<GroupDescription>(requireAuth(), 'describe_group', { group });
  for (const line of groupLines(g)) console.log(line);
  return g;
}

async function ruleCommand(args: string[]): Promise<unknown> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'add':
    case 'create':
      return await addRule(rest);
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown group rule subcommand: ${verb}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function addRule(args: string[]): Promise<RuleResult | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const group = requirePositional(flags._ as string[], 0, 'group');
  const factory = flag(flags, 'factory');
  const registry = flag(flags, 'registry');
  if (factory !== undefined && registry !== undefined) throw new Error('Pick one source: --factory <address> or --registry <address>, not both.');
  if (factory === undefined && registry === undefined) throw new Error('Say where the contracts come from: --factory <address> or --registry <address>.');
  if (factory === 'true') throw new Error("--factory needs the factory's address");
  if (registry === 'true') throw new Error("--registry needs the registry's address");
  const event = flag(flags, 'event');
  const field = flag(flags, 'field');
  const fn = flag(flags, 'function');
  if (registry !== undefined && (event !== undefined || field !== undefined)) throw new Error('--event and --field go with --factory');
  if (registry !== undefined && (fn === undefined || fn === 'true')) throw new Error('--registry needs --function "<view()>", the one that lists the contracts.');
  if (factory !== undefined && fn !== undefined) throw new Error('--function goes with --registry');
  if (factory !== undefined && (event === undefined || event === 'true' || field === undefined || field === 'true'))
    throw new Error("--factory needs --event <Name> (the event that announces a new contract) and --field <arg> (its address argument that is the new contract). contract-dev describe <factory> lists its events.");
  const pattern = flag(flags, 'name-pattern');
  if (pattern === 'true') throw new Error('--name-pattern needs the pattern, in quotes');
  const chainId = chainFlag(flags);

  const input: Record<string, unknown> = { group };
  if (chainId !== undefined) input.chainId = chainId;
  if (factory !== undefined) {
    input.factory = factory;
    input.event = event;
    input.field = field;
  } else {
    input.registry = registry;
    input.function = fn;
  }
  if (pattern !== undefined) input.namePattern = pattern;
  // a factory rule reads the whole history by default; --recent keeps it to the last few weeks and what comes next
  if (flag(flags, 'recent') === 'true') input.history = false;
  if (previewFlag(flags)) input.preview = true;

  const r = await runTool<RuleResult>(requireAuth(), 'create_watch_rule', input);
  for (const line of ruleLines(r)) console.log(line);
  return r;
}

async function namePatternCommand(args: string[]): Promise<NamePatternResult | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const group = requirePositional(positional, 0, 'group');
  const clear = flag(flags, 'clear') === 'true';
  const pattern = positional.slice(1).join(' ').trim();
  if (clear && pattern) throw new Error('Give a pattern or --clear, not both.');
  if (!clear && !pattern) throw new Error('Give the pattern in quotes, like "{token0().symbol()} pool", or --clear to drop it.');
  const input: Record<string, unknown> = { group, pattern: clear ? '' : pattern };
  if (previewFlag(flags)) input.preview = true;
  const r = await runTool<NamePatternResult>(requireAuth(), 'set_name_pattern', input);
  for (const line of namePatternLines(r)) console.log(line);
  return r;
}

const UNITS = ['usd', 'int', 'pct', 'duration', 'rate', 'raw'] as const;
const TYPES = ['address', 'uint', 'bool', 'string'] as const;
const COLUMN_HELP = 'A column is one read on every member (--read "totalAssets()"), or a formula: --call "held=totalAssets()" --call "eth=balance(self)" --formula "held - {Required}" (try: contract-dev group help).';

async function columnCommand(args: string[]): Promise<unknown> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'add':
    case 'create':
      return await addColumn(rest);
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown group column subcommand: ${verb}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function addColumn(args: string[]): Promise<ColumnResult | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const group = requirePositional(flags._ as string[], 0, 'group');
  const label = requireFlag(flags, 'label');
  // one read on every member (--read), or a formula column: --call … (each a view, balance(…) or slot(…)) and --formula
  const read = flag(flags, 'read');
  const calls = flagAll(flags, 'call').map(parseFormulaCall);
  const formula = flag(flags, 'formula');
  if ((read === undefined || read === 'true') && (formula === undefined || formula === 'true')) throw new Error(COLUMN_HELP);
  if (read !== undefined && read !== 'true' && (formula !== undefined || calls.length > 0)) throw new Error('Pass --read for one view on every member, or --call … --formula "<expr>" for a formula column, not both.');
  const input: Record<string, unknown> = { group, label };
  if (read !== undefined && read !== 'true') input.read = read;
  if (formula !== undefined && formula !== 'true') {
    input.formula = formula;
    if (calls.length > 0) input.calls = calls;
  }
  const key = flag(flags, 'key');
  if (key !== undefined && key !== 'true') input.key = key;
  const argsRaw = flag(flags, 'args');
  if (argsRaw !== undefined && argsRaw !== 'true') {
    input.args = argsRaw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  const word = numberFlag(flags, 'word');
  if (word !== undefined) input.word = word;
  const decimals = numberFlag(flags, 'decimals');
  if (decimals !== undefined) input.decimals = decimals;
  const decimalsFrom = flag(flags, 'decimals-from');
  if (decimalsFrom !== undefined && decimalsFrom !== 'true') input.decimalsFrom = decimalsFrom;
  const unit = wordFlag(flags, 'unit', UNITS);
  if (unit !== undefined) input.unit = unit;
  const token = flag(flags, 'token');
  if (token !== undefined && token !== 'true') input.token = token;
  const show = flag(flags, 'show');
  if (show !== undefined && show !== 'true') {
    if (show !== 'usd' && show !== 'token') throw new Error(`--show is usd or token (got: ${show})`);
    if (input.token === undefined) throw new Error('--show needs --token: the token the reading is an amount of.');
    input.show = show;
  }
  if (flag(flags, 'attribute') === 'true') input.attribute = true;
  const type = wordFlag(flags, 'type', TYPES);
  if (type !== undefined) input.type = type;
  if (previewFlag(flags)) input.preview = true;

  const r = await runTool<ColumnResult>(requireAuth(), 'add_table_column', input);
  for (const line of columnLines(r)) console.log(line);
  return r;
}

async function groupMonitorCommand(args: string[]): Promise<unknown> {
  const [verb, ...rest] = args;
  switch (verb) {
    case 'add':
    case 'create':
      return await addGroupMonitor(rest);
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown group monitor subcommand: ${verb}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function addGroupMonitor(args: string[]): Promise<GroupMonitorResult | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const group = requirePositional(flags._ as string[], 0, 'group');
  onlyFlags(flags, 'group monitor add', ['name', 'column', 'when', 'warn', 'preview']);
  const name = requireFlag(flags, 'name');
  const column = requireFlag(flags, 'column');
  // one formula in the shared grammar, judged by the server: value < 1000000, value > {Required}
  const when = flag(flags, 'when');
  if (when === undefined || when === 'true' || !when.trim()) throw new Error('Draw the line with --when: --when "value < 1000000" (or "value > {Other column}").');
  const input: Record<string, unknown> = { group, name, column, when };
  const warn = flag(flags, 'warn');
  if (warn !== undefined) {
    if (warn === 'true' || !warn.trim()) throw new Error('--warn needs the formula: --warn "value < 1100000".');
    if (/^-?[\d.,%]+$/.test(warn.trim())) throw new Error(`--warn is a formula: the same comparison as --when, nearer the healthy side (--warn "value < 1100000" beside --when "value < 1000000").`);
    input.warn = warn;
  }
  if (previewFlag(flags)) input.preview = true;

  const r = await runTool<GroupMonitorResult>(requireAuth(), 'add_group_monitor', input);
  for (const line of groupMonitorLines(r)) console.log(line);
  return r;
}

// ── factory ──

export async function factoryCommand(args: string[]): Promise<FactoryResult | (FactoryResult & { watch: WatchContractsResult }) | void> {
  if (!args.length || HELP_WORDS.includes(args[0])) {
    console.log(FACTORY_HELP);
    return;
  }
  const flags = parseFlags(args);
  const address = requirePositional(flags._ as string[], 0, "factory's address");
  const watch = flag(flags, 'watch') === 'true';
  const group = flag(flags, 'group');
  if (watch && (group === undefined || group === 'true')) throw new Error('--watch needs --group <name>: the group the new contracts join.');
  if (!watch && group !== undefined) throw new Error('--group goes with --watch');
  const input: Record<string, unknown> = { factory: address };
  const chainId = chainFlag(flags);
  if (chainId !== undefined) input.chainId = chainId;
  if (flag(flags, 'limit') !== undefined) input.limit = limitFlag(flags, 20, 500);
  const event = flag(flags, 'event');
  const field = flag(flags, 'field');
  if (event === undefined || event === 'true' || field === undefined || field === 'true')
    throw new Error("Say which event announces a new contract and which of its address arguments is the new contract: --event <Name> --field <arg>. contract-dev describe <factory> lists its events.");
  input.event = event;
  input.field = field;

  const auth = requireAuth();
  const r = await runTool<FactoryResult>(auth, 'factory_contracts', input);
  for (const line of factoryLines(r)) console.log(line);
  if (!watch) return r;

  const addresses = r.notWatchedAddresses ?? [];
  console.log('');
  if (!addresses.length) {
    console.log('Every contract it deployed is watched already.');
    return r;
  }
  // a factory's children are named by the group's name pattern: the explorer lookup (a second each) is skipped
  const watched = await runTool<WatchContractsResult>(auth, 'watch_contracts', {
    lookupNames: false,
    chainId: r.chainId,
    addresses,
    group,
    ...(addresses.length > MANY ? { confirmMany: true } : {}),
  });
  for (const line of watchSummaryLines(watched)) console.log(line);
  return { ...r, watch: watched };
}
