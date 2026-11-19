// `contract-dev users` (2026-11-17): who uses the protocol. One definition per workspace, written in the table's
// own words plus two: --who (which field of which event names the user) and --segment (a named rule a user is in
// while it holds). The rows are worked out on the server from the workspace's history and live reads and shown on
// the Users page; this command defines them, lists them in the table language, and imports address lists.
import { readFileSync } from 'fs';
import { parseFlags, flag, flagAll, onlyFlags, type ParsedFlags } from './_args';
import { requireAuth } from '../credentials';
import { runTool } from '../tools';
import { byUnit, cell, columnsTable } from './_print';
import { DASH } from '../view';
import { clausesFromFlags, printRows } from './query';

const HELP = `contract-dev users — who uses the protocol, and what each one holds and has done

A user is one address across every watched contract: the account a --who line names, the event field that holds
who owns the position (not the signer: a deposit made for someone, a keeper, a router). A workspace has no users
until it is defined. Every user has first and last activity, transactions, dollars in and out; the definition adds
columns in the table's own words and segments over them.

  contract-dev users define --who "Deposit.owner on tag:Vaults" \\
    --sum "Deposit.assets:Deposited token asset() show usd" \\
    --column "Supplied=convertToAssets(balanceOf(user())); on tag:Vaults; token asset(); show usd" \\
    --segment "Whales={Supplied} > 1000000" --value Supplied
  contract-dev users --segment Whales --sort "{Supplied}" --limit 20
  contract-dev users show 0x1234…

Usage:
  contract-dev users [list] [--segment <name>] [--kind wallet|contract|exchange] [the query's flags]
                                          The users, ranked by the value column (else most recently seen); --where,
                                          --sort, --by with --measure, --total and --limit as in contract-dev query
  contract-dev users --holdings [--segment <name>]
                                          What the segment's users hold everywhere, over the ones whose wallets were
                                          read (the top of each ranked segment): tokens, protocols, chains, apps
  contract-dev users show                 The definition, the segments with their counts, how many users
  contract-dev users show <0x address>    One user: its columns, each by contract, what it did here, and what it
                                          holds everywhere (its wallet on every chain, its positions in protocols)
  contract-dev users define [--who "<Event>.<field> [on <contract|tag:<group>>]"]…
                            [--count "<Event>[:<Label>] [on <field>]"]…
                            [--sum "<Event>.<field>[:<Label>] [on <field>] [token <token>] [show usd] [decimals <n>]"]…
                            [--column "<Label>=<view>(<args>)[.<output>][; on <contract|tag:<group>>][; token <token>][; show usd][; decimals <n>]"]…
                            [--formula "<Label>=<expr>[; show usd|pct|count]"]…
                            [--status "<Label>: <Opt>=<rule>; <Opt>"]… [--segment "<Name>=<rule>[; show <Column>, …][; rank <Column>]"]… [--value <Label>]
                                          The workspace's definition, whole: what it does not name is gone
  contract-dev users update [the same flags] [--remove <label|segment|Event>]…
                                          Add to the definition or change it: a clause with a label already there
                                          replaces it; --remove takes a column, a segment or an event's who line out
  contract-dev users import <file|0x…>… --segment "<name>" [--replace]
                                          Put addresses in a segment by hand (a file of addresses in any layout, or
                                          the addresses themselves); each becomes a user and wears the segment
  contract-dev users segment remove "<name>"   Drop a hand-made segment and its list
  contract-dev users refresh              Work the rows out again now

--who     the event's field that is the user: an address the event declares. At least one; one line per event; "on"
          narrows it to a contract or a group. Read the source for which field owns the position: nothing is matched by
          name.
--count   how many of an event name the user. --sum adds one of its number fields up; token says what the amount
          counts in (a 0x address, self, or a view each contract answers with it, like asset()), show usd prices it.
          "on <field>" says which address field holds the user when no --who line covers the event. A signed field
          (what a swap took and gave) nets out when added up: wrap it as abs(<Event>.<field>) to add each event by
          its size, which is a volume: --sum "abs(Swap.amount0):Volume token 0x… show usd".
--column  a view read with the user as an argument (user()), on each contract in its scope the user has used, added
          up. An argument may be another view on the same contract: convertToAssets(balanceOf(user())). "on" one
          named contract (a pool with getUserAccountData, a lens) reads every user there.
--formula an expression over the other columns by label in braces, and the built-in ones: {Transactions}, {In},
          {Out}, {First activity}, {Last activity}, {Contracts}.
--status  a category: the first option whose rule holds; one with no rule, last, is the rest.
--segment a named rule; a user is in every segment whose rule holds. New, Active and Dormant exist already
          (first or last activity within 30 days). On the Users page a segment shows the columns its rule reads, or
          the ones "; show <Column>, <Column>" names (Transactions, In and Out too), its users most recently active
          in those columns' events first. "; rank <Column>" ranks its users by one figure instead, largest first
          (a column, or Transactions, In, Out, Contracts): --segment "Traders={Swaps} > 0; rank Volume". The users
          at the top of each ranked segment have their holdings everywhere read once a day (users --holdings).
--value   the column that is the user's value here, in dollars: users rank by it and the page adds it up.

Event counts and sums reach as far back as the workspace's history; a --column is the chain now. Add --json for
everything.
`;

const DEFINE_FLAGS = ['who', 'count', 'sum', 'column', 'formula', 'status', 'segment', 'value', 'remove', 'json'] as const;

const clausesOf = (flags: ParsedFlags): Record<string, unknown> => {
  const input: Record<string, unknown> = {};
  const take = (name: string, key: string) => {
    const values = flagAll(flags, name);
    if (values.includes('true')) throw new Error(`--${name} needs a value (contract-dev users help shows its form).`);
    if (values.length > 0) input[key] = values;
  };
  take('who', 'who');
  take('count', 'counts');
  take('sum', 'sums');
  take('column', 'columns');
  take('formula', 'formulas');
  take('status', 'statuses');
  take('segment', 'segments');
  const value = flag(flags, 'value');
  if (value === 'true') throw new Error('--value takes a column\'s label: --value Supplied.');
  if (value !== undefined) input.value = value;
  return input;
};

const sayState = (r: Record<string, unknown>): void => {
  if (typeof r.pending === 'string') console.log(r.pending);
  else if (typeof r.users === 'number') console.log(`${r.users.toLocaleString('en-US')} user${r.users === 1 ? '' : 's'}${typeof r.reads === 'number' ? ` · ${r.reads.toLocaleString('en-US')} read${r.reads === 1 ? '' : 's'} made` : ''}`);
  for (const n of [...((r.defineNotes as string[] | undefined) ?? []), ...((r.notes as string[] | undefined) ?? [])]) console.log(n);
  if (typeof r.url === 'string') console.log(r.url);
};

const sayWords = (words: Record<string, unknown>): void => {
  const lines: [string, unknown][] = [
    ['--who', words.who],
    ['--count', words.counts],
    ['--sum', words.sums],
    ['--column', words.columns],
    ['--formula', words.formulas],
    ['--status', words.statuses],
    ['--segment', words.segments],
  ];
  // a clause that holds a double quote (a quoted label) is printed in single quotes, so the line can be pasted back
  for (const [name, list] of lines) for (const w of Array.isArray(list) ? list : []) console.log(String(w).includes('"') ? `  ${name} '${String(w)}'` : `  ${name} "${String(w)}"`);
  if (typeof words.value === 'string' && words.value) console.log(`  --value ${words.value}`);
};

async function define(args: string[], mode: 'replace' | 'update'): Promise<unknown> {
  const flags = parseFlags(args);
  onlyFlags(flags, `users ${mode === 'update' ? 'update' : 'define'}`, DEFINE_FLAGS);
  const input = clausesOf(flags);
  const remove = flagAll(flags, 'remove');
  if (remove.length > 0 && mode !== 'update') throw new Error('--remove goes with users update; users define replaces the definition whole.');
  if (mode === 'update' && Object.keys(input).length === 0 && remove.length === 0) throw new Error('Say what to change: a clause to add or replace, or --remove <label>.');
  const r = await runTool<Record<string, unknown>>(requireAuth(), 'define_users', { ...input, ...(mode === 'update' ? { mode, ...(remove.length ? { remove } : {}) } : {}) });
  console.log(mode === 'update' ? 'Users definition updated' : 'Users defined');
  const saved = (r.saved ?? {}) as Record<string, unknown>;
  sayWords(saved);
  sayState(r);
  return r;
}

const usd = (v: unknown): string => cell(byUnit(v, 'usd'));

/** One user's holdings everywhere: the totals, the largest positions, the latest transactions on any chain. */
function sayHolding(raw: unknown): void {
  if (typeof raw === 'string') {
    console.log(`\nHoldings: ${raw}`);
    return;
  }
  const h = raw as { readAt?: number; walletOnly?: string; totalUsd?: number; walletUsd?: number; inProtocolsUsd?: number | null; debtUsd?: number | null; positions?: { chain: string; token: string | null; amount: number; usd: number | null; where: string }[]; morePositions?: number; recent?: { time: number; chain: string; type: string; app?: string; usd: number | null; moved: string[] }[] } | undefined;
  if (!h) return;
  console.log(`\nHoldings everywhere · ${h.walletOnly ? `Wallet ${usd(h.walletUsd)}` : `${usd(h.totalUsd)} · Wallet ${usd(h.walletUsd)} · In protocols ${usd(h.inProtocolsUsd)} · Debt ${usd(h.debtUsd)}`} · Read ${cell(byUnit(h.readAt, 'time'))}`);
  if (h.walletOnly) console.log(h.walletOnly);
  const positions = h.positions ?? [];
  if (positions.length > 0) for (const line of columnsTable(['Token', 'Where', 'Chain', 'Amount', 'Value'], positions.map((p) => [p.token ?? DASH, p.where, p.chain, cell(byUnit(p.amount, undefined)), usd(p.usd)]), '  ')) console.log(line);
  if (h.morePositions) console.log(`  … ${h.morePositions} more`);
  const recent = h.recent ?? [];
  if (recent.length > 0) {
    console.log('\nWallet activity');
    for (const line of columnsTable(['When', 'Action', 'App', 'Chain', 'Moved', 'Value'], recent.map((m) => [cell(byUnit(m.time, 'time')), m.type, m.app ?? DASH, m.chain, m.moved.join(' · ') || DASH, usd(m.usd)]), '  ')) console.log(line);
  }
}

/** What a segment's read users hold between them: tokens, protocols, chains and the apps they use. */
function sayHoldings(r: Record<string, unknown>, segment: string | undefined): void {
  const read = Number(r.usersRead ?? 0);
  console.log(`Holdings${segment ? ` · ${segment}` : ''} · ${read.toLocaleString('en-US')} users read${r.usersInGroup != null ? ` of ${Number(r.usersInGroup).toLocaleString('en-US')}` : ''}${read > 0 ? ` · ${usd(r.totalUsd)} · Wallets ${usd(r.walletUsd)} · In protocols ${usd(r.inProtocolsUsd)} · Debt ${usd(r.debtUsd)}` : ''}`);
  if (typeof r.note === 'string') console.log(r.note);
  const tokens = (r.tokens ?? []) as { token: string | null; chain: string; holders: number; usd: number | null }[];
  if (tokens.length > 0) {
    console.log('\nTokens');
    for (const line of columnsTable(['Token', 'Chain', 'Holders', 'Held'], tokens.map((t) => [t.token ?? DASH, t.chain, t.holders.toLocaleString('en-US'), usd(t.usd)]), '  ')) console.log(line);
  }
  const protocols = (r.protocols ?? []) as { protocol: string; users: number; usd: number; positions: string[] }[];
  if (protocols.length > 0) {
    console.log('\nProtocols');
    for (const line of columnsTable(['Protocol', 'Positions', 'Users', 'Held'], protocols.map((p) => [p.protocol, p.positions.join(', '), p.users.toLocaleString('en-US'), usd(p.usd)]), '  ')) console.log(line);
  }
  const chains = (r.chains ?? []) as { chain: string; users: number; usd: number }[];
  if (chains.length > 0) {
    console.log('\nChains');
    for (const line of columnsTable(['Chain', 'Users', 'Held'], chains.map((c) => [c.chain, c.users.toLocaleString('en-US'), usd(c.usd)]), '  ')) console.log(line);
  }
  const apps = (r.apps ?? []) as { app: string; users: number; transactions: number }[];
  if (apps.length > 0) {
    console.log('\nApps used');
    for (const line of columnsTable(['App', 'Users', 'Transactions'], apps.map((a) => [a.app, a.users.toLocaleString('en-US'), a.transactions.toLocaleString('en-US')]), '  ')) console.log(line);
  }
  if (typeof r.url === 'string') console.log(`\n${r.url}`);
}

async function show(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  const address = (flags._ as string[])[0];
  const auth = requireAuth();
  if (address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an address: ${address}`);
    const r = await runTool<Record<string, unknown>>(auth, 'query_users', { user: address });
    if (r.found === false) {
      console.log(String(r.note ?? 'Not a user here.'));
      return r;
    }
    console.log(`${r.name ? `${String(r.name)} · ` : ''}${String(r.user)}${r.kind ? ` · ${String(r.kind)}` : ''}`);
    console.log(`First activity ${cell(byUnit(r.firstSeen, 'time'))} · Last activity ${cell(byUnit(r.lastSeen, 'time'))} · ${Number(r.transactions).toLocaleString('en-US')} transactions${Number(r.failed) > 0 ? ` (${Number(r.failed)} failed)` : ''} · In ${cell(byUnit(r.usdIn, 'usd'))} · Out ${cell(byUnit(r.usdOut, 'usd'))}`);
    const segments = (r.segments as string[] | undefined) ?? [];
    if (segments.length > 0) console.log(`Segments: ${segments.join(', ')}`);
    const units = (r.units ?? {}) as Record<string, string>;
    const figure = (label: string, v: unknown): string => cell(byUnit(v, units[label] === 'usd' ? 'usd' : undefined));
    const columns = Object.entries((r.columns ?? {}) as Record<string, unknown>);
    if (columns.length > 0) {
      console.log('\nHere');
      for (const line of columnsTable(['Column', 'Value'], columns.map(([label, v]) => [label, figure(label, v)]), '  ')) console.log(line);
    }
    for (const [label, parts] of Object.entries((r.byContract ?? {}) as Record<string, { contract: string; value: unknown }[]>)) {
      if (parts.length < 2) continue;
      console.log(`\n${label} by contract`);
      for (const line of columnsTable(['Contract', label], parts.map((p) => [p.contract, figure(label, p.value)]), '  ')) console.log(line);
    }
    const actions = (r.actions ?? []) as { time: number; action: string; contract: string; amount: number | null; amountOf?: string; tx: string }[];
    if (actions.length > 0) {
      console.log('\nActivity');
      const rows = actions.map((a) => [cell(byUnit(a.time, 'time')), a.action, a.contract, a.amountOf ? `${figure(a.amountOf, a.amount)} ${a.amountOf}` : DASH, a.tx]);
      for (const line of columnsTable(['When', 'Action', 'Contract', 'Amount', 'Transaction'], rows, '  ')) console.log(line);
    }
    sayHolding(r.holdings);
    if (typeof r.url === 'string') console.log(`\n${r.url}`);
    return r;
  }
  const r = await runTool<Record<string, unknown>>(auth, 'describe_users', {});
  console.log(`Users · ${Number(r.users).toLocaleString('en-US')}${Number(r.people) !== Number(r.users) ? ` (${Number(r.people).toLocaleString('en-US')} people)` : ''} · Active ${Number(r.active).toLocaleString('en-US')} · New ${Number(r.new).toLocaleString('en-US')}${r.valueUsd != null ? ` · ${String(r.value)} ${cell(byUnit(r.valueUsd, 'usd'))}` : ''}`);
  console.log(Array.isArray(r.who) ? 'A user is:' : `A user is: ${String(r.who)}`);
  sayWords({ ...((r.words ?? {}) as Record<string, unknown>), who: Array.isArray(r.who) ? r.who : [], value: r.value });
  const segments = (r.segments as { name: string; count: number }[] | undefined) ?? [];
  if (segments.length > 0) console.log(`Segments: ${segments.map((s) => `${s.name} ${s.count.toLocaleString('en-US')}`).join(' · ')}`);
  for (const n of (r.notes as string[] | undefined) ?? []) console.log(n);
  console.log(r.syncedAt ? `Worked out ${cell(byUnit(Date.parse(String(r.syncedAt)) / 1000, 'time'))}` : 'The rows are being worked out.');
  if (typeof r.url === 'string') console.log(r.url);
  return r;
}

async function list(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  const input: Record<string, unknown> = clausesFromFlags(flags);
  const segment = flag(flags, 'segment');
  if (segment === 'true') throw new Error('--segment takes a segment\'s name: --segment Whales.');
  if (segment) input.segment = segment;
  const kind = flag(flags, 'kind');
  if (kind !== undefined) {
    if (!['wallet', 'contract', 'exchange'].includes(kind)) throw new Error('--kind takes wallet, contract or exchange.');
    input.kind = kind;
  }
  if (flag(flags, 'holdings') === 'true') {
    const h = await runTool<Record<string, unknown>>(requireAuth(), 'query_users', { ...(segment ? { segment } : {}), holdings: true });
    sayHoldings(h, segment);
    return h;
  }
  const r = await runTool<Record<string, unknown>>(requireAuth(), 'query_users', input);
  const matched = Number(r.matched ?? 0);
  const returned = Number(r.returned ?? 0);
  const grouped = r.grouped as { by: string[]; measure: string } | undefined;
  const total = Number(r.total ?? matched);
  console.log(grouped ? `${matched} group${matched === 1 ? '' : 's'} by ${grouped.by.join(', ')} · ${grouped.measure}` : `${total.toLocaleString('en-US')} user${total === 1 ? '' : 's'}${segment ? ` in ${segment}` : ''}${returned < total ? ` · showing ${returned}` : ''}`);
  const columns = (r.columns as { key: string; label: string; unit?: string }[] | undefined) ?? [];
  const named = [input.sort, input.where, ...((input.by as string[] | undefined) ?? [])].filter((x): x is string => typeof x === 'string');
  // the user first, then the value and the definition's own columns ahead of the built-in figures
  const builtIn = new Set(['user', 'kind', 'firstSeen', 'lastSeen', 'transactions', 'failed', 'usdIn', 'usdOut', 'contracts', 'segments', 'name']);
  // a group's own columns first, in its order; otherwise the definition's
  const shown = Array.isArray(r.show) ? (r.show as string[]) : null;
  const own = shown ?? columns.map((c) => c.key).filter((k) => !builtIn.has(k) && k !== 'value');
  printRows((r.rows as Record<string, unknown>[] | undefined) ?? [], columns, named, grouped?.by ?? ['user', 'kind', ...own, 'lastSeen', 'transactions', 'usdIn', 'usdOut']);
  const totals = r.totals as Record<string, number | null> | undefined;
  if (totals) console.log(`Totals: ${Object.entries(totals).map(([k, v]) => `${k} ${v == null ? '—' : cell(byUnit(v, columns.find((c) => c.key === k)?.unit))}`).join(' · ')}`);
  for (const n of (r.notes as string[] | undefined) ?? []) console.log(n);
  if (typeof r.url === 'string') console.log(r.url);
  return r;
}

async function importList(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  onlyFlags(flags, 'users import', ['segment', 'replace', 'json']);
  const segment = flag(flags, 'segment');
  if (!segment || segment === 'true') throw new Error('Say which segment the addresses go in: --segment "Beta users".');
  const given = flags._ as string[];
  if (given.length === 0) throw new Error('Give a file of addresses, or the addresses themselves.');
  const addresses = new Set<string>();
  for (const g of given) {
    if (/^0x[0-9a-fA-F]{40}$/.test(g)) {
      addresses.add(g.toLowerCase());
      continue;
    }
    let text: string;
    try {
      text = readFileSync(g, 'utf8');
    } catch {
      throw new Error(`${g} is not an address and not a file that can be read.`);
    }
    // any layout: one a line, a CSV column, a JSON list
    for (const m of text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []) addresses.add(m.toLowerCase());
  }
  if (addresses.size === 0) throw new Error('No 0x addresses found in what was given.');
  if (addresses.size > 20_000) throw new Error(`${addresses.size.toLocaleString('en-US')} addresses: a segment takes 20,000 at most in one import.`);
  const r = await runTool<Record<string, unknown>>(requireAuth(), 'import_users', { segment, addresses: Array.from(addresses), ...(flag(flags, 'replace') === 'true' ? { replace: true } : {}) });
  console.log(`${String(r.segment)} · ${Number(r.added).toLocaleString('en-US')} added · ${Number(r.total).toLocaleString('en-US')} in the segment`);
  sayState(r);
  return r;
}

async function segmentCommand(args: string[]): Promise<unknown> {
  const [verb, ...rest] = args;
  if (verb !== 'remove' && verb !== 'rm') throw new Error('users segment takes remove: contract-dev users segment remove "<name>". A rule segment is taken out with users update --remove "<name>".');
  const name = (parseFlags(rest)._ as string[])[0];
  if (!name) throw new Error('Say which segment: contract-dev users segment remove "<name>".');
  const r = await runTool<Record<string, unknown>>(requireAuth(), 'import_users', { segment: name, remove: true });
  console.log(`Removed ${String(r.removed)} · ${Number(r.addresses).toLocaleString('en-US')} addresses`);
  sayState(r);
  return r;
}

/** `contract-dev users <verb>` */
export async function usersCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list':
      return await list(sub === undefined ? args : rest);
    case 'show':
    case 'describe':
      return await show(rest);
    case 'define':
      return await define(rest, 'replace');
    case 'update':
      return await define(rest, 'update');
    case 'import':
      return await importList(rest);
    case 'segment':
    case 'segments':
      return await segmentCommand(rest);
    case 'refresh':
    case 'sync': {
      const r = await runTool<Record<string, unknown>>(requireAuth(), 'refresh_users', {});
      sayState(r);
      return r;
    }
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      if (sub.startsWith('--')) return await list(args);
      if (/^0x[0-9a-fA-F]{40}$/.test(sub)) return await show(args);
      console.error(`Unknown users subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

export default usersCommand;
