import { parseFlags, flag, flagAll, requirePositional, type ParsedFlags } from './_args';
import { apiRequest, requireAuth, ResolvedAuth } from '../credentials';
import { runTool } from '../tools';
import { resolveMetric, formatValue, shortHex, TrackedMetric } from './metrics';
import { parseChainId } from './watch';
import { chainFlag, limitFlag, parseRange } from '../data';
import { DASH, chainLabel, fmtAge, fmtInt, fmtTime, plural, shortAddr, sparkline, table } from '../view';
import { fmtSpan } from './oracles';
import {
  buildBoundExpr,
  buildCompareExpr,
  buildWarnCompareExpr,
  DIRECTION_OP,
  parseUntil,
  toAlias,
  type CmpOp,
  type InvariantExpr,
} from '../monitor-expr';

const HELP = `contract-dev monitor — alert when a tracked metric crosses a line, an event is emitted, or a contract goes quiet

Usage:
  contract-dev monitors                                   List monitors (status, rule, open incident)
  contract-dev monitor add <metric> <rule> --to <dest,…> [--warn …] [--name "…"] [--max-age <sec>]
  contract-dev monitor compile --on <contract> --event <Name> [--where "<field> <op> <value>"]… [--to <dest>]… [--name "…"]
  contract-dev monitor compile --on <contract> --silence [--method <name> | --event <Name>] [--for 24h] [--to <dest>]…
                                                          What the monitor would say, and how often it would have fired in
                                                          the last 7 days; saved nowhere
  contract-dev monitor add (the same flags)               Save it
  contract-dev monitor show <id|name> [--range]           Rule, inputs, destinations, recent episodes; a silence monitor's
                                                          sightings, how long it has been quiet, and the quiet stretches
  contract-dev monitor sightings <id|name> [--range] [--limit]   Every sighting a silence monitor counts, newest first
  contract-dev monitor set <id|name> [<rule>] [--warn …|--no-warn] [--to <dest,…>] [--max-age <sec>|--no-max-age]
  contract-dev monitor rename <id|name> "<name>"
  contract-dev monitor pause <id|name> / resume <id|name>
  contract-dev monitor snooze <id|name> <30m|2h|1d|iso>   Mute pages until then (still evaluates)
  contract-dev monitor unsnooze <id|name>
  contract-dev monitor delete <id|name>…                 Delete one or several (ids from --json, or names)
  contract-dev monitor exclude <default> <address> [--chain <id>]   Leave a contract out of a default monitor
  contract-dev monitor include <default> <address> [--chain <id>]   Put it back
  contract-dev channels                                   Alert destinations — what --to accepts

Rules (exactly one):
  --below <n>              Alert when the metric falls below n         (metric >= n)
  --above <n>              Alert when the metric rises above n         (metric <= n)
  --below-metric <metric>  Alert when it falls below another metric   (a >= b)
  --above-metric <metric>  Alert when it rises above another metric   (a <= b)

Warning tier (optional, on the healthy side of the alert):
  --warn <n>               A number, for --below / --above
  --warn-pct <p>           A margin in percent, for --below-metric / --above-metric

Destinations:
  --to <dest,…>            Channel ids, labels ("#alerts") or kinds (telegram) from \`contract-dev channels\`.
                           Optional: without one the monitor records alerts on its page until a destination
                           is linked in the app.

<metric> is a tracked metric's id or label (\`contract-dev metrics\`). Examples:
  contract-dev monitor add "Treasury · Native balance" --below 25000 --warn 30000 --to telegram
  contract-dev monitor add vault_reserves --below-metric vault_liabilities --warn-pct 5 --to "#alerts"

From a sentence (an event monitor, or a silence monitor):
  --on <contract>          The watched contract, by address or name; --chain picks between chains
  --group <group>          Instead of --on: one monitor on each contract of the group that has the event
                           (every upgrade, every pause).
  --event <Name>           Alert when the event is emitted (with --silence: when it stops being emitted). Repeat
                           for several events in one go: --event Upgraded --event Paused --event AdminChanged
  --usd-above <n>          Alert when the event is worth more than n dollars at today's price, on the fields whose
                           token --token states (each in its own token, both directions), turned into token
                           amounts once
  --where "<field> <op> <value>"
                           A condition on the event's fields; repeat for more. In base units, or in the field's
                           token when --token states it ("12,500" on a field stated as USDC; never dollars).
                           Ops: is, is not, above, at least, below, at most (or =, !=, >, >=, <, <=)
  --token "<field>=<token>"
                           The token a numeric field is an amount of: its 0x address, self (the contract
                           itself), or a view the contract answers with it, like token0() or asset(); repeat
                           for more. Nothing is assumed from a field's name: without it a field is in base units
  --silence                Alert when the contract goes quiet: no call for --for; with --method, no call to that
                           method; with --event, no emission of it
  --method <name>          The method whose silence matters (silence only)
  --for <duration>         How long quiet counts: 90m, 24h, 3d (silence only; default 24h)
  --name "<text>"          The monitor's name (one is made from the event or method otherwise)
  --to <dest>              Destinations by id, label or kind; repeat or comma-separate. Optional here: without
                           one the monitor records alerts on its page and pages nobody.
add saves at once and replays nothing: set a --where value in the field's own unit (\`describe\` shows
each field's unit), and remove a monitor that turns out noisy with \`monitor delete\`. compile previews
the same flags with a 7-day replay of how often it would have fired; it is slow on busy contracts.
  contract-dev monitor add --on steth --event Transfer --where "value at least 1000 stETH" --to "#alerts"
  contract-dev monitor compile --on steth --silence --method submit --for 6h

Default monitors — control-change, dependency-failure, revert-spike — take pause / resume /
snooze / unsnooze / set --to / exclude / include by that slug or by name; they have no
thresholds to edit and cannot be deleted.

A silence monitor (made in the app: "no call to this method, or no emission of this event,
for longer than a window") judges how long since the thing last happened, so show and
sightings read the happenings themselves from the chain's record: --range 24h|7d|30d
(default 24h). The window ends where the record does, so a stretch nobody has collected yet
never reads as quiet.
`;

const CHANNELS_HELP = `contract-dev channels — the workspace's alert destinations

Usage:
  contract-dev channels                    List destinations (id, kind, label, target)
  contract-dev channels test <id|label>    Send a test alert to one destination
  contract-dev channels disable <id|label> Stop sending to it (kept, can be enabled again)
  contract-dev channels enable <id|label>
  contract-dev channels remove <id|label>  Disconnect it

Connect Telegram, Discord or Slack in the app under Monitoring → Destinations; this lists
what's there so \`contract-dev monitor add --to …\` can name it. Test, enable, disable and
remove need an owner or admin, as in the app.
`;

export interface AlertChannel {
  id: string;
  kind: string;
  enabled: boolean;
  label: string | null;
  target: string;
}

export interface BuiltinSubject {
  chainId: number;
  address: string;
  state: string;
  openIncidentId: string | null;
  level: 'warning' | 'alert' | null;
  since: string | null;
  sentence: string | null;
}

export const BUILTIN_KINDS = new Set(['controlChange', 'outboundCalls', 'revertRate']);
export const isBuiltinMonitor = (m: { kind?: string | null }) => !!m.kind && BUILTIN_KINDS.has(m.kind);

export type MonitorState = 'alerting' | 'warning' | 'healthy' | 'warming' | 'disabled';

/**
 * A monitor's state as the app shows it (lib/invariants/monitor.ts). The server records
 * breached / warning / warming / stale / ok; "breached" is what the app calls alerting, and a
 * stale reading leaves a rule healthy.
 */
export function monitorState(inv: Pick<Invariant, 'enabled' | 'status'>): MonitorState {
  if (!inv.enabled || inv.status === 'disabled') return 'disabled';
  switch (inv.status) {
    case 'breached':
    case 'alerting':
      return 'alerting';
    case 'warning':
      return 'warning';
    case 'warming':
      return 'warming';
    default:
      return 'healthy';
  }
}

/** What a silence or event monitor watches (the app's lib/invariants/watch WatchParams). */
export interface WatchParams {
  kind: 'silence' | 'eventFired';
  chainId: number;
  address: string;
  topic0: string | null;
  /** Silence only: the method's selector; null = any call to the contract. */
  selector: string | null;
  /** Silence only: how long a quiet stretch has to be before it is a breach. */
  windowSec: number;
  /** The method or event name, for the sentences. */
  subject: string | null;
}

export interface Invariant {
  id: string;
  name: string;
  /** null for a custom rule; controlChange / outboundCalls / revertRate for a default; silence / eventFired for a watch */
  kind?: string | null;
  /** a default's settings: the contracts left out, as "<chainId>:<address>"; a watch's subject and window */
  params?: (Partial<WatchParams> & { excluded?: string[] }) | null;
  /** a watch's last tick: `lastSeen` (unix seconds) for a silence monitor */
  lastEvalInputs?: { watch?: string; words?: string; txHash?: string | null; lastSeen?: number | null } | null;
  /** a default's contracts, each with its state (present on list and show) */
  subjects?: BuiltinSubject[] | null;
  exprAst: InvariantExpr;
  exprText: string;
  warnExprAst: InvariantExpr | null;
  warnExprText: string | null;
  maxInputAgeSec: number | null;
  enabled: boolean;
  snoozedUntil: string | null;
  notifyAll: boolean;
  channelIds: string[];
  status: string;
  statusSince: string | null;
  lastEvalAt: string | null;
  inputs: Array<{ alias: string; trackedOnchainValueId: string; trackedOnchainValue: TrackedMetric | null }>;
  openIncident?: { id: string; openedAt: string; level: string; peakLevel: string } | null;
  incidents30d?: number;
  lastIncidentAt?: string | null;
  incidents?: Array<{ id: string; openedAt: string; resolvedAt: string | null; level: string; peakLevel: string; ackedAt: string | null }>;
}

export async function listChannels(auth: ResolvedAuth): Promise<AlertChannel[]> {
  const { channels } = await apiRequest<{ channels: AlertChannel[] }>(auth, 'GET', '/api/cli/alert-channels');
  return channels ?? [];
}

// One destination by id, label (with or without its '#'), target, or kind when the workspace
// has exactly one of that kind — disabled ones included, so `enable` can name them.
export function findChannel(all: AlertChannel[], raw: string): AlertChannel {
  const ref = raw.trim();
  const lower = ref.toLowerCase();
  const bare = lower.replace(/^#/, '');
  const hit = all.find((c) => c.id === ref || (c.label ?? '').toLowerCase().replace(/^#/, '') === bare || c.target.toLowerCase() === lower);
  if (hit) return hit;
  const byKind = all.filter((c) => c.kind.toLowerCase() === lower || c.kind.toLowerCase().replace(/_bot$/, '') === lower);
  if (byKind.length === 1) return byKind[0];
  if (byKind.length > 1) throw new Error(`${byKind.length} ${ref} destinations — name one by label: ${byKind.map((c) => c.label ?? c.id).join(', ')}`);
  throw new Error(`No alert destination matches "${ref}" (run \`contract-dev channels\`).`);
}

const describeChannel = (c: AlertChannel) => `${c.kind} ${c.label ?? c.target}`;

export async function channelsCommand(args: string[] = []): Promise<AlertChannel[] | unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'help':
    case '-h':
    case '--help':
      console.log(CHANNELS_HELP);
      return;
    case 'test':
    case 'enable':
    case 'disable':
    case 'remove':
    case 'rm': {
      const flags = parseFlags(rest);
      const ref = requirePositional(flags._ as string[], 0, 'destination (id or label)');
      const auth = requireAuth();
      const channel = findChannel(await listChannels(auth), ref);
      if (sub === 'test') {
        await apiRequest(auth, 'POST', `/api/cli/alert-channels/${channel.id}/test`);
        console.log(`Test alert sent to ${describeChannel(channel)}.`);
        return { ok: true, id: channel.id };
      }
      if (sub === 'remove' || sub === 'rm') {
        await apiRequest(auth, 'DELETE', `/api/cli/alert-channels/${channel.id}`);
        console.log(`Removed ${describeChannel(channel)}. Monitors that sent there no longer do.`);
        return { ok: true, id: channel.id };
      }
      const enabled = sub === 'enable';
      await apiRequest(auth, 'PATCH', `/api/cli/alert-channels/${channel.id}`, { enabled });
      console.log(`${enabled ? 'Enabled' : 'Disabled'} ${describeChannel(channel)}.`);
      return { ok: true, id: channel.id, enabled };
    }
    case undefined:
    case 'list':
      break;
    default:
      console.error(`Unknown channels subcommand: ${sub}\n`);
      console.error(CHANNELS_HELP);
      process.exit(1);
  }
  const channels = await listChannels(requireAuth());
  if (!channels.length) {
    console.log('No alert destinations. Connect Telegram, Discord or Slack in the app under Monitoring → Destinations.');
    return [];
  }
  for (const c of channels) {
    console.log(`${c.id}  ${c.kind.padEnd(12)} ${(c.label ?? '').padEnd(24)} ${c.target}${c.enabled ? '' : '  (disabled)'}`);
  }
  return channels;
}

// `--to` entries → channel ids. Each entry matches an id exactly, else a label
// (with or without its leading '#'), else a target, else a kind when the workspace has
// exactly one destination of that kind. Only enabled destinations count — the composer
// offers the same set, and a disabled one would be a pick that never delivers.
export function resolveChannelIds(allChannels: AlertChannel[], refs: string[]): string[] {
  const channels = allChannels.filter((c) => c.enabled);
  const ids = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    const lower = ref.toLowerCase();
    const bare = lower.replace(/^#/, '');
    const matches = (c: AlertChannel) =>
      c.id === ref || (c.label ?? '').toLowerCase().replace(/^#/, '') === bare || c.target.toLowerCase() === lower;
    const hit = channels.find(matches);
    if (hit) {
      ids.add(hit.id);
      continue;
    }
    const disabled = allChannels.find((c) => !c.enabled && matches(c));
    if (disabled) throw new Error(`"${ref}" is a disabled destination — re-enable it under Monitoring → Destinations first.`);
    const byKind = channels.filter((c) => c.kind.toLowerCase() === lower || c.kind.toLowerCase().replace(/_bot$/, '') === lower);
    if (byKind.length === 1) {
      ids.add(byKind[0].id);
      continue;
    }
    if (byKind.length > 1) {
      throw new Error(`${byKind.length} ${ref} destinations — name one by label: ${byKind.map((c) => c.label ?? c.id).join(', ')}`);
    }
    throw new Error(`No alert destination matches "${ref}" (run \`contract-dev channels\`).`);
  }
  if (ids.size === 0) throw new Error('Pick at least one destination with --to (see `contract-dev channels`).');
  return Array.from(ids);
}

export const metricName = (m: TrackedMetric | null | undefined) => (m ? m.label ?? m.kind : 'value');

// A monitor by id, or by name when exactly one matches (case-insensitive). A default
// monitor also answers to its slug — control-change, dependency-failure, revert-spike — the
// name of its page in the app.
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export async function resolveMonitor(auth: ResolvedAuth, ref: string): Promise<Invariant> {
  const { invariants } = await apiRequest<{ invariants: Invariant[] }>(auth, 'GET', '/api/mainnet/invariants');
  const all = invariants ?? [];
  const byId = all.find((m) => m.id === ref);
  if (byId) return byId;
  const lower = ref.trim().toLowerCase();
  const byName = all.filter((m) => m.name.toLowerCase() === lower || slugOf(m.name) === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new Error(`${byName.length} monitors are named "${ref}" — use an id: ${byName.map((m) => m.id).join(', ')}`);
  throw new Error(`No monitor matches "${ref}" (run \`contract-dev monitors\` to list them).`);
}

type Rule =
  | { kind: 'bound'; direction: 'below' | 'above'; threshold: string }
  | { kind: 'compare'; direction: 'below' | 'above'; rhsRef: string };

function parseRule(flags: ReturnType<typeof parseFlags>): Rule | null {
  const picks = (['below', 'above', 'below-metric', 'above-metric'] as const).filter((k) => flag(flags, k) !== undefined);
  if (picks.length === 0) return null;
  if (picks.length > 1) throw new Error(`Pick one rule, not ${picks.map((p) => `--${p}`).join(' and ')}`);
  const pick = picks[0];
  const value = flag(flags, pick)!;
  if (value === 'true') throw new Error(`--${pick} needs a value`);
  if (pick === 'below' || pick === 'above') return { kind: 'bound', direction: pick, threshold: value };
  return { kind: 'compare', direction: pick === 'below-metric' ? 'below' : 'above', rhsRef: value };
}

interface Tiers {
  exprAst: InvariantExpr;
  warnExprAst: InvariantExpr | null;
  inputs: Array<{ alias: string; trackedOnchainValueId: string }>;
  rhs: TrackedMetric | null;
}

// Both tiers + bindings from a rule, the way the composer builds them: the subject is the
// left side, aliases come from labels, and a warning sits on the healthy side of the alert.
async function buildTiers(auth: ResolvedAuth, subject: TrackedMetric, rule: Rule, flags: ReturnType<typeof parseFlags>): Promise<Tiers> {
  const op: CmpOp = DIRECTION_OP[rule.direction];
  const alias = toAlias(metricName(subject));
  const warn = flag(flags, 'warn');
  const warnPct = flag(flags, 'warn-pct');
  if (warn !== undefined && warnPct !== undefined) throw new Error('Pass either --warn or --warn-pct, not both');

  if (rule.kind === 'bound') {
    if (warnPct !== undefined) throw new Error('--warn-pct is for --below-metric / --above-metric; use --warn <n> with a number threshold');
    return {
      exprAst: buildBoundExpr(alias, op, rule.threshold),
      warnExprAst: warn !== undefined ? buildBoundExpr(alias, op, warn) : null,
      inputs: [{ alias, trackedOnchainValueId: subject.id }],
      rhs: null,
    };
  }

  const rhs = await resolveMetric(auth, rule.rhsRef);
  if (rhs.id === subject.id) throw new Error('A metric cannot be compared against itself');
  if (warn !== undefined) throw new Error('--warn is for number thresholds; use --warn-pct <p> when comparing two metrics');
  const rhsBase = toAlias(metricName(rhs));
  const rhsAlias = rhsBase === alias ? `${rhsBase.slice(0, 38)}_b` : rhsBase;
  return {
    exprAst: buildCompareExpr(alias, op, rhsAlias),
    warnExprAst: warnPct !== undefined ? buildWarnCompareExpr(alias, op, rhsAlias, warnPct) : null,
    inputs: [
      { alias, trackedOnchainValueId: subject.id },
      { alias: rhsAlias, trackedOnchainValueId: rhs.id },
    ],
    rhs,
  };
}

function parseMaxAge(flags: ReturnType<typeof parseFlags>): number | undefined {
  const raw = flag(flags, 'max-age');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 30) throw new Error('--max-age is in seconds and must be at least 30');
  return n;
}

export async function monitorsCommand(args: string[] = []): Promise<Invariant[] | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const auth = requireAuth();
  const { invariants } = await apiRequest<{ invariants: Invariant[] }>(auth, 'GET', '/api/mainnet/invariants');
  if (!invariants?.length) {
    console.log('No monitors. Create one with `contract-dev monitor add <metric> --below <n> --to <dest>`.');
    return [];
  }
  for (const m of invariants) {
    const rule = `${m.exprText}${m.warnExprText ? `  (warn: ${m.warnExprText})` : ''}`;
    const open = m.openIncident ? `  OPEN ${m.openIncident.level} since ${m.openIncident.openedAt}` : '';
    const snoozed = m.snoozedUntil && new Date(m.snoozedUntil) > new Date() ? `  snoozed until ${m.snoozedUntil}` : '';
    console.log(`${monitorState(m).padEnd(9)} ${m.id}  ${m.name}  —  ${rule}${open}${snoozed}`);
  }
  return invariants;
}

export async function monitorCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add':
      return await addMonitor(rest);
    case 'compile':
      return await compileSubcommand(rest);
    case 'show':
      return await showMonitor(rest);
    case 'set':
      return await setMonitor(rest);
    case 'rename':
      return await patchMonitor(rest, 'rename');
    case 'pause':
      return await patchMonitor(rest, 'pause');
    case 'resume':
      return await patchMonitor(rest, 'resume');
    case 'snooze':
      return await patchMonitor(rest, 'snooze');
    case 'unsnooze':
      return await patchMonitor(rest, 'unsnooze');
    case 'delete':
    case 'remove':
      return await deleteMonitor(rest);
    case 'sightings':
      return await sightingsSubcommand(rest);
    case 'exclude':
      return await excludeSubcommand(rest, true);
    case 'include':
      return await excludeSubcommand(rest, false);
    case 'list':
      return await monitorsCommand(rest);
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown monitor subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function addMonitor(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  // --on / --event / --silence: a monitor from a sentence, compiled and saved by the server.
  if (isIntentForm(flags)) return await addMonitorFromIntent(flags);
  const ref = requirePositional(flags._ as string[], 0, 'metric (id or label)');
  const rule = parseRule(flags);
  if (!rule) throw new Error('A monitor needs a rule: --below <n>, --above <n>, --below-metric <metric> or --above-metric <metric>');
  const toRaw = flag(flags, 'to');
  if (toRaw === 'true') throw new Error('--to needs a destination (see `contract-dev channels`).');

  const auth = requireAuth();
  const subject = await resolveMetric(auth, ref);
  const tiers = await buildTiers(auth, subject, rule, flags);
  // no destination is fine: the monitor records alerts on its page until one is linked
  const channelIds = toRaw ? resolveChannelIds(await listChannels(auth), toRaw.split(',')) : [];
  const maxInputAgeSec = parseMaxAge(flags);

  const subjectLabel = metricName(subject);
  const defaultName = tiers.rhs ? `${subjectLabel} vs ${metricName(tiers.rhs)}` : subjectLabel;
  const name = (flag(flags, 'name') ?? '').trim() || defaultName;

  const { invariant } = await apiRequest<{ invariant: Invariant }>(auth, 'POST', '/api/mainnet/invariants', {
    name,
    exprAst: tiers.exprAst,
    warnExprAst: tiers.warnExprAst,
    inputs: tiers.inputs,
    notifyAll: false,
    channelIds,
    ...(maxInputAgeSec !== undefined ? { maxInputAgeSec } : {}),
  });
  console.log(`Created monitor "${invariant.name}" (${invariant.id}): ${invariant.exprText}${invariant.warnExprText ? `, warn at ${invariant.warnExprText}` : ''}`);
  console.log('First verdict on the next reading.');
  return invariant;
}

async function setMonitor(args: string[]): Promise<Invariant> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'monitor (id or name)');
  const auth = requireAuth();
  const existing = await resolveMonitor(auth, ref);
  const body: Record<string, unknown> = {};

  const rule = parseRule(flags);
  const noWarn = flag(flags, 'no-warn') === 'true';
  if (rule) {
    const subjectId = existing.inputs[0]?.trackedOnchainValueId;
    if (!subjectId) throw new Error('This monitor has no bound metric to rebuild a rule on.');
    const subject = await resolveMetric(auth, subjectId);
    const tiers = await buildTiers(auth, subject, rule, flags);
    body.exprAst = tiers.exprAst;
    body.inputs = tiers.inputs;
    // A new rule replaces the warning too: an old tier typed against a different bound
    // (or a different rhs) is meaningless, and the server would refuse a mismatched one.
    body.warnExprAst = noWarn ? null : tiers.warnExprAst;
  } else if (noWarn) {
    body.warnExprAst = null;
  } else if (flag(flags, 'warn') !== undefined || flag(flags, 'warn-pct') !== undefined) {
    // Warning-only edit: rebuild it against the existing alert tier.
    const alert = existing.exprAst;
    const op = alert.op;
    if (alert.lhs.type !== 'ref') throw new Error('Cannot add a warning to this rule.');
    const warn = flag(flags, 'warn');
    const warnPct = flag(flags, 'warn-pct');
    if (alert.rhs.type === 'lit') {
      if (warn === undefined) throw new Error('This rule compares against a number — use --warn <n>');
      body.warnExprAst = buildBoundExpr(alert.lhs.alias, op, warn);
    } else {
      if (warnPct === undefined) throw new Error('This rule compares two metrics — use --warn-pct <p>');
      body.warnExprAst = buildWarnCompareExpr(alert.lhs.alias, op, alert.rhs.alias, warnPct);
    }
  }

  const toRaw = flag(flags, 'to');
  if (toRaw !== undefined) {
    if (toRaw === 'true') throw new Error('--to needs at least one destination');
    body.channelIds = resolveChannelIds(await listChannels(auth), toRaw.split(','));
  }
  const maxInputAgeSec = parseMaxAge(flags);
  if (maxInputAgeSec !== undefined) body.maxInputAgeSec = maxInputAgeSec;
  if (flag(flags, 'no-max-age') === 'true') body.maxInputAgeSec = null;
  const name = flag(flags, 'name');
  if (name && name !== 'true') body.name = name;

  if (Object.keys(body).length === 0) throw new Error('Nothing to change — pass a rule, --warn/--no-warn, --to, --max-age or --name.');
  const { invariant } = await apiRequest<{ invariant: Invariant }>(auth, 'PATCH', `/api/mainnet/invariants/${existing.id}`, body);
  console.log(`Updated "${invariant.name}": ${invariant.exprText}${invariant.warnExprText ? `, warn at ${invariant.warnExprText}` : ''}`);
  return invariant;
}

// ── a monitor from a sentence: --on <contract> --event <Name> [--where …] / --silence [--method …] [--for …] ──
//
// The server's compile_monitor tool turns the intent into the exact monitor: the sentence it
// will print, the conditions in the field's units, a backtest over the last 7 days. `compile`
// shows that and saves nothing; `add` with the same flags calls create_monitor.

export interface MonitorIntent {
  mode: 'event' | 'silence';
  /** One contract, or `group` for one monitor on each contract of a group. */
  contract?: string;
  group?: string;
  chainId?: number;
  event?: string;
  method?: string;
  where?: Array<{ field: string; op: string; value: string }>;
  /** Fire when the event is worth more than this many dollars at today's price, on the fields whose token `tokens` states. */
  usdAbove?: number;
  /** The token each numeric field is an amount of, as stated: an address, self, or a view like token0(). */
  tokens?: Array<{ field: string; token: string }>;
  windowSec?: number;
  name?: string;
  destinations?: string[];
}

export interface BacktestFiring {
  txHash: string;
  at: string;
  blockNumber: number | null;
  from: string | null;
  args: Record<string, string>;
}

export type Backtest = { window: string; matches: number; recent: BacktestFiring[]; scanned?: number; capped?: boolean } | { window: string; occurrences: number; lastSeenAt: string | null };

export interface CompiledMonitor {
  body: Record<string, unknown>;
  name: string;
  sentence: string;
  contract: { chainId: number; address: string; name: string };
  conditions: string[];
  channelIds: string[];
  backtest: Backtest | null;
  notes: string[];
}

export interface CreatedFromIntent {
  monitor: Invariant;
  sentence: string;
  backtest: Backtest | null;
}

const TWO_WORD_OPS = ['is not', 'at least', 'at most'];
const ONE_WORD_OPS = ['is', 'above', 'below', '=', '==', '!=', '>', '>=', '<', '<='];
const WHERE_USAGE = '--where must read "<field> <op> <value>", like --where "amount0 at least 10000" (ops: is, is not, above, at least, below, at most, or =, !=, >, >=, <, <=)';

/** `"amount0 at least 10,000 USDC"` (or `"amount0>=10000"`) → the condition as the server takes it. */
export function parseWhere(raw: string): { field: string; op: string; value: string } {
  const text = raw.trim();
  const symbol = /^([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|!=|==|=|>|<)\s*(\S.*)$/.exec(text);
  if (symbol) return { field: symbol[1], op: symbol[2], value: symbol[3].trim() };
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) throw new Error(`${WHERE_USAGE}; got: "${raw}"`);
  const [field, ...rest] = tokens;
  const two = `${rest[0]} ${rest[1]}`.toLowerCase();
  const one = rest[0].toLowerCase();
  if (TWO_WORD_OPS.includes(two)) {
    const value = rest.slice(2).join(' ');
    if (!value) throw new Error(`${WHERE_USAGE}; got: "${raw}"`);
    return { field, op: two, value };
  }
  if (ONE_WORD_OPS.includes(one)) return { field, op: one, value: rest.slice(1).join(' ') };
  throw new Error(`${WHERE_USAGE}; got: "${raw}"`);
}

/** 90m · 24h · 3d (also 3600s, 1w) → seconds, from a minute to 30 days. */
export function parseDuration(raw: string, label = '--for'): number {
  const m = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)$/i.exec(raw.trim());
  if (!m) throw new Error(`${label} must be a duration like 90m, 24h or 3d (got: ${raw})`);
  const unit = m[2].toLowerCase()[0];
  const sec = Number(m[1]) * (unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86_400 : 604_800);
  if (sec < 60 || sec > 2_592_000) throw new Error(`${label} must be between 1 minute and 30 days (got: ${raw})`);
  return sec;
}

const isIntentForm = (flags: ParsedFlags): boolean => flag(flags, 'on') !== undefined || flag(flags, 'group') !== undefined || flag(flags, 'event') !== undefined || flag(flags, 'silence') !== undefined;

/** The flags → the intent compile_monitor and create_monitor take. */
export function buildIntent(flags: ParsedFlags): MonitorIntent {
  const on = flag(flags, 'on');
  const group = flag(flags, 'group');
  if (on === 'true') throw new Error('--on needs a contract: the watched contract, by address or name.');
  if (group === 'true') throw new Error('--group needs a group name.');
  if (on !== undefined && group !== undefined) throw new Error('Pick --on <contract> or --group <group>, not both.');
  if (on === undefined && group === undefined) throw new Error('Say where: --on <contract> (a watched contract, by address or name) or --group <group> (each contract of a group).');
  const silence = flag(flags, 'silence') !== undefined;
  if (flag(flags, 'silence') !== undefined && flag(flags, 'silence') !== 'true') throw new Error('--silence takes no value; name the method with --method <name>.');
  const event = flag(flags, 'event');
  const method = flag(flags, 'method');
  const forRaw = flag(flags, 'for');
  const name = flag(flags, 'name');
  if (event === 'true') throw new Error('--event needs the event\'s name');
  if (method === 'true') throw new Error('--method needs the method\'s name');
  if (name === 'true') throw new Error('--name needs a value');
  if (!silence && event === undefined) throw new Error('Say what to watch: --event <Name> (when it is emitted) or --silence (when the contract goes quiet).');
  if (!silence && method !== undefined) throw new Error('--method is for a silence monitor: add --silence.');
  if (!silence && forRaw !== undefined) throw new Error('--for is for a silence monitor: add --silence.');
  if (silence && event !== undefined && method !== undefined) throw new Error('A silence monitor watches an event or a method, not both.');
  const where = flagAll(flags, 'where')
    .filter((w) => w !== 'true')
    .map(parseWhere);
  if (silence && where.length) throw new Error('--where is for an event monitor (--event <Name>, without --silence).');
  const destinations = flagAll(flags, 'to')
    .filter((v) => v !== 'true')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  const chainId = chainFlag(flags);
  const intent: MonitorIntent = on !== undefined ? { mode: silence ? 'silence' : 'event', contract: on } : { mode: silence ? 'silence' : 'event', group };
  if (chainId !== undefined) intent.chainId = chainId;
  if (event !== undefined) intent.event = event;
  if (method !== undefined) intent.method = method;
  if (where.length) intent.where = where;
  const tokens = flagAll(flags, 'token')
    .filter((v) => v !== 'true')
    .map((raw) => {
      const eq = raw.indexOf('=');
      const field = eq > 0 ? raw.slice(0, eq).trim() : '';
      const token = eq > 0 ? raw.slice(eq + 1).trim() : '';
      if (!field || !/^(0x[0-9a-fA-F]{40}|self|[A-Za-z_][A-Za-z0-9_]*\(\))$/.test(token))
        throw new Error(`--token takes <field>=<token>: its 0x address, self, or a view like token0() (got: ${raw})`);
      return { field, token };
    });
  if (silence && tokens.length) throw new Error('--token is for an event monitor.');
  if (tokens.length) intent.tokens = tokens;
  const usdRaw = flag(flags, 'usd-above');
  if (usdRaw !== undefined) {
    if (silence) throw new Error('--usd-above is for an event monitor.');
    const usd = Number(usdRaw.replace(/[$,\s]/g, ''));
    if (usdRaw === 'true' || !Number.isFinite(usd) || usd <= 0) throw new Error(`--usd-above needs a dollar amount, like 1000000 or $1,000,000 (got: ${usdRaw})`);
    intent.usdAbove = usd;
  }
  if (forRaw !== undefined) intent.windowSec = parseDuration(forRaw);
  if (name !== undefined && name.trim()) intent.name = name.trim();
  if (destinations.length) intent.destinations = destinations;
  return intent;
}

const windowDays = (w: string): string => (/^\d+d$/.test(w) ? `${w.slice(0, -1)} days` : w);

/** The backtest, as the composer shows it: how often it would have fired, the newest firings; or how often it has been seen. */
export function backtestLines(b: Backtest | null | undefined): string[] {
  if (!b) return ['  backtest:    unavailable'];
  if ('matches' in b) {
    // a capped read is the newest events only: shorter than the window, so it must not claim the week
    const span = b.capped ? `the newest ${plural(b.scanned ?? 0, 'event')} read (less than ${windowDays(b.window)}: the week holds more)` : windowDays(b.window);
    const lines = [`  backtest:    Would have fired ${plural(b.matches, 'time')} in ${span}`];
    for (const f of (b.recent ?? []).slice(0, 3)) {
      const args = Object.entries(f.args ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      lines.push(`    ${fmtTime(Date.parse(f.at))}  ${f.from ? shortAddr(f.from) : DASH}  ${args || DASH}  ${f.txHash}`);
    }
    return lines;
  }
  return [`  backtest:    Seen ${plural(b.occurrences, 'time')} in ${windowDays(b.window)}${b.lastSeenAt ? `, last ${fmtTime(Date.parse(b.lastSeenAt))}` : ''}`];
}

/** What `compile` prints: the sentence, the subject, the conditions, the destinations, the backtest, the notes. */
export function compiledLines(c: CompiledMonitor, intent: MonitorIntent): string[] {
  const lines = [
    c.sentence,
    `  name:        ${c.name}`,
    `  on:          ${c.contract.name} (${chainLabel(c.contract.chainId)} ${c.contract.address})`,
    `  conditions:  ${c.conditions.length ? c.conditions.join(' · ') : 'none'}`,
    `  sends to:    ${c.channelIds.length ? (intent.destinations ?? []).join(', ') || plural(c.channelIds.length, 'destination') : 'nobody'}`,
    ...backtestLines(c.backtest),
  ];
  for (const note of c.notes ?? []) lines.push(`  note: ${note}`);
  return lines;
}

/** An argument as a person would retype it on the shell: bare when it is plain, double-quoted otherwise. */
export const shellQuote = (arg: string): string => (/^[A-Za-z0-9_\-.,:/=@+%]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`);

async function compileSubcommand(args: string[]): Promise<CompiledMonitor | void> {
  if (!args.length || ['help', '-h', '--help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const intent = buildIntent(flags);
  const compiled = await runTool<CompiledMonitor & GroupSet>(requireAuth(), 'compile_monitor', { ...intent });
  if (intent.group) {
    for (const line of groupSetLines(compiled, intent.group)) console.log(line);
    console.log(`Save them with: contract-dev monitor add ${args.map(shellQuote).join(' ')}`);
    return compiled;
  }
  for (const line of compiledLines(compiled, intent)) console.log(line);
  console.log(`Save it with: contract-dev monitor add ${args.map(shellQuote).join(' ')}`);
  return compiled;
}

/** What the server answers for a group: a sentence for all, the contracts it fitted, and the ones it left out. */
export interface GroupSet {
  monitors?: number;
  sentence?: string | null;
  /** Every contract left out; `skipped` names only those left out for a reason other than lacking the event. */
  skippedCount?: number;
  skipped?: Array<{ contract: string; reason: string }>;
  created?: Array<{ id: string; name: string; contract: string }>;
  failed?: Array<{ contract: string; error: string }>;
  notes?: string[];
}

/** A group's monitors in a few lines: the sentence, how many, and what was left out or failed. */
export function groupSetLines(r: GroupSet, group: string): string[] {
  const made = r.created ? r.created.length : r.monitors ?? 0;
  const lines = [r.sentence ?? DASH, `${r.created ? 'Created' : 'Would create'} ${plural(made, 'monitor')} in ${group}, one on each contract that has it.`];
  const skipped = r.skipped ?? [];
  const leftOut = r.skippedCount ?? skipped.length;
  if (leftOut) lines.push(`Left out ${plural(leftOut, 'contract')} that ${leftOut === 1 ? 'does' : 'do'} not have it.`);
  const byReason = new Map<string, string[]>();
  for (const x of skipped) byReason.set(x.reason, [...(byReason.get(x.reason) ?? []), x.contract]);
  for (const [reason, names] of byReason) if (!reason.startsWith('no ') || reason === 'no ABI known') lines.push(`  ${reason}: ${names.join(', ')}`);
  for (const f of r.failed ?? []) lines.push(`  failed ${f.contract} — ${f.error}`);
  return lines;
}

/** Several events in one call: one monitor (or one group set) per event, made side by side, one line each. */
async function addSeveralEvents(flags: ParsedFlags, events: string[]): Promise<Array<{ event: string; result?: CreatedFromIntent | GroupSet; error?: string }>> {
  if (flagAll(flags, 'where').some((w) => w !== 'true')) throw new Error('--where goes with one event: the fields differ from event to event. Add those monitors one at a time.');
  const base = buildIntent(flags);
  const auth = requireAuth();
  const outcomes = await Promise.all(
    events.map(async (event) => {
      const intent: MonitorIntent = { ...base, event, ...(base.name ? { name: `${base.name} · ${event}` } : {}) };
      try {
        const result = await runTool<CreatedFromIntent | GroupSet>(auth, 'create_monitor', { ...intent, ...(intent.group ? { confirmMany: true } : {}) });
        return { event, result };
      } catch (err) {
        return { event, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  for (const o of outcomes) {
    if (o.error) console.log(`${o.event}: not created — ${o.error}`);
    else if (base.group) {
      const set = o.result as GroupSet;
      const extra = groupSetLines(set, base.group).slice(2);
      console.log(`${o.event}: ${plural(set.created?.length ?? 0, 'monitor')}${set.skippedCount ? ` · left out ${fmtInt(set.skippedCount)}` : ''}`);
      for (const line of extra.filter((l) => l.startsWith('  '))) console.log(line);
    } else {
      const one = o.result as CreatedFromIntent;
      console.log(`${o.event}: created "${one.monitor.name}" (${one.monitor.id}) — ${one.sentence}`);
    }
  }
  if (outcomes.every((o) => o.error)) throw new Error(outcomes[0].error);
  return outcomes;
}

async function addMonitorFromIntent(flags: ParsedFlags): Promise<CreatedFromIntent | GroupSet | Array<{ event: string; result?: CreatedFromIntent | GroupSet; error?: string }>> {
  const events = flagAll(flags, 'event').filter((e) => e !== 'true');
  if (events.length > 1) return await addSeveralEvents(flags, events);
  const intent = buildIntent(flags);
  if (intent.group) {
    // the CLI acts on purpose: the server's many-at-once check is for chat, so it is passed here
    const set = await runTool<GroupSet>(requireAuth(), 'create_monitor', { ...intent, confirmMany: true });
    for (const line of groupSetLines(set, intent.group)) console.log(line);
    return set;
  }
  const created = await runTool<CreatedFromIntent>(requireAuth(), 'create_monitor', { ...intent });
  console.log(created.sentence);
  // saving replays nothing; an older server may still send a backtest, shown when it does
  if (created.backtest) for (const line of backtestLines(created.backtest)) console.log(line);
  console.log(`Created monitor "${created.monitor.name}" (${created.monitor.id}).`);
  return created;
}

// ── a silence monitor's sightings: the calls or emissions it counts, off the chain's record ──

const SIGHTING_RANGES = ['24h', '7d', '30d'] as const;
type SightingRange = (typeof SIGHTING_RANGES)[number];

export interface Sighting {
  /** unix seconds */
  s: number;
  tx: string;
}

export interface SightingsPayload {
  range: string;
  stepSec: number;
  fromSec: number;
  toSec: number;
  /** How far the chain's record reaches; null = the chain is not collected. */
  frontierSec: number | null;
  total: number;
  /** More sightings than `sightings` carries — the bins say the rest. */
  capped: boolean;
  /** Oldest first. */
  sightings: Sighting[];
  bins: Array<{ t: number; n: number }>;
}

export interface QuietStretch {
  fromSec: number;
  toSec: number;
  /** The last sighting before it; null when the stretch began before the window. */
  before: Sighting | null;
  /** The first sighting after it; null when it ran to the window's end. */
  after: Sighting | null;
}

/** How long a quiet stretch has to be, in words — as the app says it: 30 minutes · 6 hours · 3 days. */
export function windowWords(sec: number): string {
  if (sec < 5400) return `${Math.round(sec / 60)} minutes`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} hours`;
  return `${Math.round(sec / 86_400)} days`;
}

/**
 * The stretches between sightings that outgrew the window, as the page shades them: between
 * two consecutive sightings, from the window's start to the first (a lower bound — it may have
 * begun earlier), and from the last to the window's end. None when the read was capped: then
 * the sightings are a sample and a gap between them means nothing.
 */
export function quietStretches(p: SightingsPayload, windowSec: number): QuietStretch[] {
  if (p.capped || windowSec <= 0) return [];
  const out: QuietStretch[] = [];
  const s = p.sightings;
  if (!s.length) return p.toSec - p.fromSec > windowSec ? [{ fromSec: p.fromSec, toSec: p.toSec, before: null, after: null }] : [];
  if (s[0].s - p.fromSec > windowSec) out.push({ fromSec: p.fromSec, toSec: s[0].s, before: null, after: s[0] });
  for (let i = 1; i < s.length; i++) if (s[i].s - s[i - 1].s > windowSec) out.push({ fromSec: s[i - 1].s, toSec: s[i].s, before: s[i - 1], after: s[i] });
  const last = s[s.length - 1];
  if (p.toSec - last.s > windowSec) out.push({ fromSec: last.s, toSec: p.toSec, before: last, after: null });
  return out;
}

const watchOf = (inv: Invariant): WatchParams | null => {
  const w = inv.params;
  if (inv.kind !== 'silence' || !w || typeof w.chainId !== 'number' || typeof w.address !== 'string') return null;
  return { kind: 'silence', chainId: w.chainId, address: w.address, topic0: w.topic0 ?? null, selector: w.selector ?? null, windowSec: Number(w.windowSec ?? 0), subject: w.subject ?? null };
};

async function loadSightings(auth: ResolvedAuth, id: string, range: SightingRange): Promise<SightingsPayload> {
  return apiRequest<SightingsPayload>(auth, 'GET', `/api/mainnet/invariants/${id}/sightings?range=${range}`, undefined, { timeoutMs: 60_000 });
}

/** The lines `monitor show` adds for a silence monitor: the count, how long quiet, the longest gap, the strip, the quiet stretches. */
export function sightingLines(inv: Invariant, watch: WatchParams, p: SightingsPayload | null, now = Date.now()): string[] {
  const word = watch.topic0 ? 'emission' : 'call';
  const lines: string[] = [`  window:  alerts after ${windowWords(watch.windowSec)} without a${watch.topic0 ? 'n' : ''} ${word}`];
  if (!p) {
    lines.push('  sightings: unavailable right now. Retry in a moment.');
    return lines;
  }
  if (p.frontierSec == null) {
    lines.push('  sightings: chain not collected');
    return lines;
  }
  const endSec = p.toSec;
  const lastSeenSec = p.sightings.length ? p.sightings[p.sightings.length - 1].s : inv.lastEvalInputs?.lastSeen ?? null;
  const quietSec = lastSeenSec != null ? Math.max(0, endSec - lastSeenSec) : null;
  const parts = [`${plural(p.total, word)} in the last ${p.range}`];
  // the count already says "none in the window"; a last sighting from before it is worth a word
  if (lastSeenSec != null) parts.push(`last seen ${fmtSpan((now - lastSeenSec * 1000) / 1000)} ago (${fmtTime(lastSeenSec * 1000)})${p.sightings.length ? '' : ', from the monitor\'s own record'}`);
  if (quietSec != null) parts.push(`quiet ${fmtSpan(quietSec)}${watch.windowSec > 0 && quietSec > watch.windowSec ? ' (over the window)' : ''}`);
  if (!p.capped && p.sightings.length) {
    let longest = endSec - p.sightings[p.sightings.length - 1].s;
    for (let i = 1; i < p.sightings.length; i++) longest = Math.max(longest, p.sightings[i].s - p.sightings[i - 1].s);
    parts.push(`longest gap ${fmtSpan(longest)}`);
  }
  lines.push(`  sightings: ${parts.join(' · ')}`);
  if (p.bins.length) {
    // the strip: one bin per step across the whole window, empty bins included
    const n = Math.max(1, Math.round((p.toSec - p.fromSec) / p.stepSec));
    const counts = new Array<number>(n).fill(0);
    for (const b of p.bins) {
      const i = Math.floor((b.t - p.fromSec) / p.stepSec);
      if (i >= 0 && i < n) counts[i] += b.n;
    }
    lines.push(`    ${sparkline(counts, { width: 64 })}  ${fmtSpan(p.stepSec)} bins${p.capped ? ` · ${fmtInt(p.total)} sightings, more than the read carries` : ''}`);
  }
  const stretches = quietStretches(p, watch.windowSec);
  if (p.capped) lines.push('    quiet stretches: not read — the sightings are a sample at this volume');
  else if (!stretches.length) lines.push(`    quiet stretches over ${windowWords(watch.windowSec)}: none in the last ${p.range}`);
  else {
    lines.push(`    quiet stretches over ${windowWords(watch.windowSec)}: ${fmtInt(stretches.length)}`);
    for (const q of stretches) {
      const span = `${q.before ? '' : 'at least '}${fmtSpan(q.toSec - q.fromSec)}`;
      const ends = [q.before ? `after ${shortAddr(q.before.tx)}` : 'began before the window', q.after ? `ended by ${shortAddr(q.after.tx)}` : 'still quiet at the end of the record'];
      lines.push(`      ${fmtTime(q.fromSec * 1000)} → ${fmtTime(q.toSec * 1000)} · ${span} · ${ends.join(' · ')}`);
    }
  }
  if (p.frontierSec != null && p.frontierSec < Math.floor(now / 1000) - 600) lines.push(`    the record reaches ${fmtTime(p.frontierSec * 1000)}; later is not collected yet, not quiet`);
  return lines;
}

async function sightingsSubcommand(args: string[]): Promise<SightingsPayload> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'monitor (id or name)');
  const range = parseRange(flags, SIGHTING_RANGES, '24h');
  const limit = limitFlag(flags, 50, 2000);
  const auth = requireAuth();
  const inv = await resolveMonitor(auth, ref);
  const watch = watchOf(inv);
  if (!watch) throw new Error(`"${inv.name}" is not a silence monitor — sightings are what a silence monitor counts.`);
  const p = await loadSightings(auth, inv.id, range);
  const word = watch.topic0 ? 'emission' : 'call';
  console.log(`${inv.name} · sightings · last ${p.range}`);
  if (p.frontierSec == null) {
    console.log('Chain not collected');
    return p;
  }
  console.log(`${plural(p.total, word)} between ${fmtTime(p.fromSec * 1000)} and ${fmtTime(p.toSec * 1000)}${p.capped ? ` · the newest ${fmtInt(p.sightings.length)} listed` : ''}`);
  if (!p.sightings.length) {
    console.log(`No ${word}s in the window.`);
    return p;
  }
  console.log('');
  for (const line of table(
    p.sightings.slice().reverse().slice(0, limit),
    [
      { header: 'Time', value: (r) => fmtTime(r.s * 1000) },
      { header: 'Age', value: (r) => fmtAge(r.s * 1000), align: 'right' },
      { header: 'Tx', value: (r) => r.tx },
    ],
    '  ',
  )) {
    console.log(line);
  }
  if (p.sightings.length > limit) console.log(`  … ${fmtInt(p.sightings.length - limit)} more (--limit, or --json for all)`);
  return p;
}

async function showMonitor(args: string[]): Promise<Invariant> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'monitor (id or name)');
  const range = parseRange(flags, SIGHTING_RANGES, '24h');
  const auth = requireAuth();
  const found = await resolveMonitor(auth, ref);
  const [{ invariant }, channels] = await Promise.all([
    apiRequest<{ invariant: Invariant }>(auth, 'GET', `/api/mainnet/invariants/${found.id}`),
    listChannels(auth).catch(() => [] as AlertChannel[]),
  ]);
  const watch = watchOf(invariant);
  const sightings = watch ? await loadSightings(auth, invariant.id, range).catch(() => null) : null;

  console.log(`${invariant.name}  (${invariant.id})`);
  console.log(`  status: ${invariant.status}${invariant.statusSince ? ` since ${invariant.statusSince}` : ''}${invariant.enabled ? '' : '  (paused)'}`);
  console.log(`  alert:  ${invariant.exprText}`);
  if (invariant.warnExprText) console.log(`  warn:   ${invariant.warnExprText}`);
  if (invariant.maxInputAgeSec != null) console.log(`  stale after: ${invariant.maxInputAgeSec}s without a fresh reading`);
  if (invariant.snoozedUntil && new Date(invariant.snoozedUntil) > new Date()) console.log(`  snoozed until: ${invariant.snoozedUntil}`);
  if (watch) {
    console.log(`  watches: ${watch.subject ?? (watch.topic0 ? 'an event' : 'any call')} on ${watch.address} (chain ${watch.chainId})`);
    for (const line of sightingLines(invariant, watch, sightings)) console.log(line);
  }
  if (invariant.inputs.length) console.log('  inputs:');
  for (const input of invariant.inputs) {
    const m = input.trackedOnchainValue;
    const value = m ? formatValue(m.liveValue != null ? m.liveValue : m.lastValue) : '—';
    console.log(`    ${input.alias.padEnd(24)} = ${value.padStart(16)}   ${metricName(m)} (chain ${m?.chainId ?? '?'}, ${m ? shortHex(m.address) : '?'}, ${input.trackedOnchainValueId})`);
  }
  const destinations = invariant.channelIds.map((id) => {
    const c = channels.find((ch) => ch.id === id);
    return c ? `${c.kind} ${c.label ?? c.target}` : id;
  });
  console.log(`  sends to: ${destinations.length ? destinations.join(', ') : invariant.notifyAll ? 'every destination' : 'nobody'}`);
  if (isBuiltinMonitor(invariant)) {
    const subjects = invariant.subjects;
    const excluded = invariant.params?.excluded ?? [];
    if (subjects == null) console.log('  covers: unknown — the contracts could not be read right now');
    else {
      console.log(`  covers: ${subjects.length} contract${subjects.length === 1 ? '' : 's'}`);
      for (const s of subjects) {
        console.log(`    ${s.state.padEnd(9)} chain ${String(s.chainId).padEnd(9)} ${s.address}${s.sentence ? `  ${s.sentence}` : ''}`);
      }
    }
    if (excluded.length) console.log(`  excluded: ${excluded.join(', ')}`);
  }
  const incidents = invariant.incidents ?? [];
  console.log(`  episodes: ${incidents.length}${incidents.length ? ' (newest first)' : ''}`);
  for (const inc of incidents.slice(0, 10)) {
    const state = inc.resolvedAt ? `resolved ${inc.resolvedAt}` : 'OPEN';
    console.log(`    ${inc.id}  ${inc.peakLevel.padEnd(7)} opened ${inc.openedAt}  ${state}${inc.ackedAt ? '  acked' : ''}`);
  }
  return invariant;
}

async function patchMonitor(args: string[], action: 'rename' | 'pause' | 'resume' | 'snooze' | 'unsnooze'): Promise<Invariant> {
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const ref = requirePositional(positional, 0, 'monitor (id or name)');
  const auth = requireAuth();
  const existing = await resolveMonitor(auth, ref);

  let body: Record<string, unknown>;
  switch (action) {
    case 'rename': {
      const name = positional.slice(1).join(' ').trim();
      if (!name) throw new Error('Missing required name');
      body = { name };
      break;
    }
    case 'pause':
      body = { enabled: false };
      break;
    case 'resume':
      body = { enabled: true };
      break;
    case 'snooze': {
      const until = parseUntil(requirePositional(positional, 1, 'duration (30m, 2h, 1d) or ISO date'));
      if (until <= new Date()) throw new Error('The snooze must end in the future');
      body = { snoozedUntil: until.toISOString() };
      break;
    }
    case 'unsnooze':
      body = { snoozedUntil: null };
      break;
  }

  const { invariant } = await apiRequest<{ invariant: Invariant }>(auth, 'PATCH', `/api/mainnet/invariants/${existing.id}`, body);
  switch (action) {
    case 'rename':
      console.log(`Renamed ${existing.id} to "${invariant.name}".`);
      break;
    case 'pause':
      console.log(`Paused "${invariant.name}" — it stops evaluating (you won't hear it recover either).`);
      break;
    case 'resume':
      console.log(`Resumed "${invariant.name}" — warming up until the next reading.`);
      break;
    case 'snooze':
      console.log(`Snoozed "${invariant.name}" until ${invariant.snoozedUntil} — still evaluates, pages nobody.`);
      break;
    case 'unsnooze':
      console.log(`Unsnoozed "${invariant.name}".`);
  }
  return invariant;
}

// `monitor exclude|include <default> <address> [--chain <id>]`: edit a default monitor's
// excluded list — the one setting a default has besides on/off and destinations. Sent whole,
// as the API takes it (params.excluded replaces).
async function excludeSubcommand(args: string[], exclude: boolean): Promise<Invariant> {
  const flags = parseFlags(args);
  const positional = flags._ as string[];
  const ref = requirePositional(positional, 0, 'default monitor (control-change, dependency-failure or revert-spike)');
  const address = requirePositional(positional, 1, 'contract address');
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`contract address must be a 0x address (got: ${address})`);
  const chainId = parseChainId(flag(flags, 'chain') ?? '1', '--chain');

  const auth = requireAuth();
  const existing = await resolveMonitor(auth, ref);
  if (!isBuiltinMonitor(existing)) {
    throw new Error(`"${existing.name}" is a custom monitor — only default monitors cover contracts. Delete or edit its rule instead.`);
  }
  const key = `${chainId}:${address.toLowerCase()}`;
  const current = new Set((existing.params?.excluded ?? []).map((k) => k.toLowerCase()));
  if (exclude === current.has(key)) {
    console.log(`${shortHex(address)} on chain ${chainId} is already ${exclude ? 'excluded from' : 'covered by'} ${existing.name}.`);
    return existing;
  }
  if (exclude) current.add(key);
  else current.delete(key);
  const { invariant } = await apiRequest<{ invariant: Invariant }>(auth, 'PATCH', `/api/mainnet/invariants/${existing.id}`, {
    params: { excluded: Array.from(current) },
  });
  console.log(exclude ? `Excluded ${shortHex(address)} on chain ${chainId} from ${invariant.name}.` : `${invariant.name} covers ${shortHex(address)} on chain ${chainId} again.`);
  return invariant;
}

async function deleteMonitor(args: string[]): Promise<{ ok: true; id: string; ids: string[] } | void> {
  const flags = parseFlags(args);
  const refs = flags._ as string[];
  requirePositional(refs, 0, 'monitor (id or name)');
  const auth = requireAuth();
  // every ref resolved against one listing before anything is deleted, so a typo deletes nothing
  const { invariants } = await apiRequest<{ invariants: Invariant[] }>(auth, 'GET', '/api/mainnet/invariants');
  const all = invariants ?? [];
  const targets = refs.map((ref) => {
    const byId = all.find((m) => m.id === ref);
    if (byId) return byId;
    const lower = ref.trim().toLowerCase();
    const byName = all.filter((m) => m.name.toLowerCase() === lower || slugOf(m.name) === lower);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`${byName.length} monitors are named "${ref}" — use an id: ${byName.map((m) => m.id).join(', ')}. Nothing was deleted.`);
    throw new Error(`No monitor matches "${ref}" (run \`contract-dev monitors\` to list them). Nothing was deleted.`);
  });
  const ids: string[] = [];
  for (const m of targets) {
    if (ids.includes(m.id)) continue;
    await apiRequest(auth, 'DELETE', `/api/mainnet/invariants/${m.id}`);
    console.log(`Deleted monitor "${m.name}" (${m.id}) and its episode history.`);
    ids.push(m.id);
  }
  return { ok: true, id: ids[0], ids };
}
