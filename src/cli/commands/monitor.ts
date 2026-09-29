import { parseFlags, flag, requirePositional } from './_args';
import { apiRequest, requireAuth, ResolvedAuth } from '../credentials';
import { resolveMetric, formatValue, shortHex, TrackedMetric } from './metrics';
import { parseChainId } from './watch';
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

const HELP = `contract.dev monitor — alert when a tracked metric crosses a line

Usage:
  contract.dev monitors                                   List monitors (status, rule, open incident)
  contract.dev monitor add <metric> <rule> --to <dest,…> [--warn …] [--name "…"] [--max-age <sec>]
  contract.dev monitor show <id|name>                     Rule, inputs, destinations, recent episodes
  contract.dev monitor set <id|name> [<rule>] [--warn …|--no-warn] [--to <dest,…>] [--max-age <sec>|--no-max-age]
  contract.dev monitor rename <id|name> "<name>"
  contract.dev monitor pause <id|name> / resume <id|name>
  contract.dev monitor snooze <id|name> <30m|2h|1d|iso>   Mute pages until then (still evaluates)
  contract.dev monitor unsnooze <id|name>
  contract.dev monitor delete <id|name>
  contract.dev monitor exclude <default> <address> [--chain <id>]   Leave a contract out of a default monitor
  contract.dev monitor include <default> <address> [--chain <id>]   Put it back
  contract.dev channels                                   Alert destinations — what --to accepts

Rules (exactly one):
  --below <n>              Alert when the metric falls below n         (metric >= n)
  --above <n>              Alert when the metric rises above n         (metric <= n)
  --below-metric <metric>  Alert when it falls below another metric   (a >= b)
  --above-metric <metric>  Alert when it rises above another metric   (a <= b)

Warning tier (optional, on the healthy side of the alert):
  --warn <n>               A number, for --below / --above
  --warn-pct <p>           A margin in percent, for --below-metric / --above-metric

Destinations:
  --to <dest,…>            Channel ids, labels ("#alerts") or kinds (telegram) from \`contract.dev channels\`.
                           Required on add — a monitor with nowhere to send alerts nobody.

<metric> is a tracked metric's id or label (\`contract.dev metrics\`). Examples:
  contract.dev monitor add "Treasury · Native balance" --below 25000 --warn 30000 --to telegram
  contract.dev monitor add vault_reserves --below-metric vault_liabilities --warn-pct 5 --to "#alerts"

Default monitors — control-change, dependency-failure, revert-spike — take pause / resume /
snooze / unsnooze / set --to / exclude / include by that slug or by name; they have no
thresholds to edit and cannot be deleted.
`;

const CHANNELS_HELP = `contract.dev channels — the workspace's alert destinations

Usage:
  contract.dev channels                    List destinations (id, kind, label, target)
  contract.dev channels test <id|label>    Send a test alert to one destination
  contract.dev channels disable <id|label> Stop sending to it (kept, can be enabled again)
  contract.dev channels enable <id|label>
  contract.dev channels remove <id|label>  Disconnect it

Connect Telegram, Discord or Slack in the app under Monitoring → Destinations; this lists
what's there so \`contract.dev monitor add --to …\` can name it. Test, enable, disable and
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

export interface Invariant {
  id: string;
  name: string;
  /** null for a custom rule; controlChange / outboundCalls / revertRate for a default */
  kind?: string | null;
  /** a default's settings: the contracts left out, as "<chainId>:<address>" */
  params?: { excluded?: string[] } | null;
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
  throw new Error(`No alert destination matches "${ref}" (run \`contract.dev channels\`).`);
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
    throw new Error(`No alert destination matches "${ref}" (run \`contract.dev channels\`).`);
  }
  if (ids.size === 0) throw new Error('Pick at least one destination with --to (see `contract.dev channels`).');
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
  throw new Error(`No monitor matches "${ref}" (run \`contract.dev monitors\` to list them).`);
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
    console.log('No monitors. Create one with `contract.dev monitor add <metric> --below <n> --to <dest>`.');
    return [];
  }
  for (const m of invariants) {
    const rule = `${m.exprText}${m.warnExprText ? `  (warn: ${m.warnExprText})` : ''}`;
    const open = m.openIncident ? `  OPEN ${m.openIncident.level} since ${m.openIncident.openedAt}` : '';
    const snoozed = m.snoozedUntil && new Date(m.snoozedUntil) > new Date() ? `  snoozed until ${m.snoozedUntil}` : '';
    console.log(`${m.status.padEnd(9)} ${m.id}  ${m.name}  —  ${rule}${open}${snoozed}`);
  }
  return invariants;
}

export async function monitorCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add':
      return await addMonitor(rest);
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

async function addMonitor(args: string[]): Promise<Invariant> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'metric (id or label)');
  const rule = parseRule(flags);
  if (!rule) throw new Error('A monitor needs a rule: --below <n>, --above <n>, --below-metric <metric> or --above-metric <metric>');
  const toRaw = flag(flags, 'to');
  if (!toRaw || toRaw === 'true') throw new Error('Pick at least one destination with --to (see `contract.dev channels`).');

  const auth = requireAuth();
  const subject = await resolveMetric(auth, ref);
  const tiers = await buildTiers(auth, subject, rule, flags);
  const channelIds = resolveChannelIds(await listChannels(auth), toRaw.split(','));
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

async function showMonitor(args: string[]): Promise<Invariant> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'monitor (id or name)');
  const auth = requireAuth();
  const found = await resolveMonitor(auth, ref);
  const [{ invariant }, channels] = await Promise.all([
    apiRequest<{ invariant: Invariant }>(auth, 'GET', `/api/mainnet/invariants/${found.id}`),
    listChannels(auth).catch(() => [] as AlertChannel[]),
  ]);

  console.log(`${invariant.name}  (${invariant.id})`);
  console.log(`  status: ${invariant.status}${invariant.statusSince ? ` since ${invariant.statusSince}` : ''}${invariant.enabled ? '' : '  (paused)'}`);
  console.log(`  alert:  ${invariant.exprText}`);
  if (invariant.warnExprText) console.log(`  warn:   ${invariant.warnExprText}`);
  if (invariant.maxInputAgeSec != null) console.log(`  stale after: ${invariant.maxInputAgeSec}s without a fresh reading`);
  if (invariant.snoozedUntil && new Date(invariant.snoozedUntil) > new Date()) console.log(`  snoozed until: ${invariant.snoozedUntil}`);
  console.log('  inputs:');
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

async function deleteMonitor(args: string[]): Promise<{ ok: true; id: string } | void> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'monitor (id or name)');
  const auth = requireAuth();
  const existing = await resolveMonitor(auth, ref);
  await apiRequest(auth, 'DELETE', `/api/mainnet/invariants/${existing.id}`);
  console.log(`Deleted monitor "${existing.name}" (${existing.id}) and its episode history.`);
  return { ok: true, id: existing.id };
}
