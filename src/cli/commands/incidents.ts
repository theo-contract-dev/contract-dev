import { parseFlags, flag, requirePositional } from './_args';
import { apiRequest, requireAuth } from '../credentials';
import { formatValue, shortHex, TrackedMetric } from './metrics';

const HELP = `contract.dev incidents — the workspace's alert episodes

Usage:
  contract.dev incidents [--days <n>] [--limit <n>]   What fired (default: last 7 days + anything still open)
  contract.dev incidents show <id>                   One episode in full: evidence, deliveries, who acked
  contract.dev incidents ack <id>                    Stop the reminders (the all-clear still comes)
  contract.dev incidents unack <id>                  Hand it back — reminders resume

Acking silences repeat pages without silencing the recovery, which pausing the monitor
would. Windows beyond 24h need a paid plan; the server clamps otherwise.
`;

interface IncidentRow {
  id: string;
  kind: string;
  openedAt: string;
  resolvedAt: string | null;
  ackedAt: string | null;
  notifyCount: number;
  level: string;
  peakLevel: string;
  invariantId: string;
  name: string;
  exprText: string;
  warnExprText: string | null;
  enabled: boolean;
  chainId: number | null;
  address: string | null;
  /** 'rule' for a custom monitor; controlChange / outboundCalls / revertRate for a default */
  monitorKind?: string;
  /** a default monitor's own words for the episode */
  sentence?: string | null;
  detail?: string | null;
  txHash?: string | null;
}

// A default monitor's episode carries its reading instead of alias-keyed metric values.
interface BuiltinEvidence {
  builtin: string;
  chainId: number;
  address: string;
  label: string | null;
  at: string;
  sentence: string;
  detail: string;
  reading: Record<string, number | string | null>;
  txHashes: string[];
}

type InputEvidence = Record<string, { raw: string; at: string | null; block?: string }>;

const isBuiltinEvidence = (e: unknown): e is BuiltinEvidence =>
  !!e && typeof e === 'object' && typeof (e as BuiltinEvidence).builtin === 'string' && typeof (e as BuiltinEvidence).sentence === 'string';

interface IncidentDetail {
  id: string;
  kind: string;
  openedAt: string;
  resolvedAt: string | null;
  level: string;
  peakLevel: string;
  alertedAt: string | null;
  openInputs: InputEvidence | BuiltinEvidence;
  alertInputs: InputEvidence | BuiltinEvidence | null;
  ackedAt: string | null;
  ackedBy: { name: string | null; email: string | null } | null;
  notifyCount: number;
  deliveries: Array<{
    id: string;
    round: number;
    status: string;
    attempts: number;
    lastError: string | null;
    sentAt: string | null;
    channel: { id: string; kind: string; label: string | null } | null;
  }>;
  invariant: {
    id: string;
    name: string;
    exprText: string;
    warnExprText: string | null;
    inputs: Array<{ alias: string; trackedOnchainValue: TrackedMetric | null }>;
  };
}

export async function incidentsCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list':
      return await listIncidents(sub === undefined ? args : rest);
    case 'show':
      return await showIncident(rest);
    case 'ack':
      return await ackIncident(rest, true);
    case 'unack':
      return await ackIncident(rest, false);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      if (sub.startsWith('--')) return await listIncidents(args);
      console.error(`Unknown incidents subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function listIncidents(args: string[]): Promise<IncidentRow[]> {
  const flags = parseFlags(args);
  const query: string[] = [];
  for (const key of ['days', 'limit'] as const) {
    const raw = flag(flags, key);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${key} must be a positive integer`);
    query.push(`${key}=${n}`);
  }
  const auth = requireAuth();
  const { incidents, days } = await apiRequest<{ incidents: IncidentRow[]; days: number }>(
    auth,
    'GET',
    `/api/mainnet/incidents${query.length ? `?${query.join('&')}` : ''}`,
  );
  if (!incidents?.length) {
    console.log(`No incidents in the last ${days} day${days === 1 ? '' : 's'}.`);
    return [];
  }
  for (const inc of incidents) {
    const state = inc.resolvedAt ? `resolved ${inc.resolvedAt}` : 'OPEN';
    const acked = inc.ackedAt ? '  acked' : '';
    const where = inc.chainId != null && inc.address ? `  [chain ${inc.chainId} ${shortHex(inc.address)}]` : '';
    // A default monitor's row says what it saw ("Reverting 6.7% of transactions…"); a rule's says its assertion.
    const what = inc.sentence ?? inc.exprText;
    console.log(`${inc.id}  ${inc.peakLevel.padEnd(7)} ${inc.openedAt}  ${state.padEnd(34)} ${inc.name} — ${what}${where}${acked}`);
  }
  return incidents;
}

async function showIncident(args: string[]): Promise<IncidentDetail> {
  const flags = parseFlags(args);
  const id = requirePositional(flags._ as string[], 0, 'incident id');
  const auth = requireAuth();
  const { incident } = await apiRequest<{ incident: IncidentDetail }>(auth, 'GET', `/api/mainnet/incidents/${id}`);
  const inv = incident.invariant;

  console.log(`${inv.name}  (incident ${incident.id}, monitor ${inv.id})`);
  console.log(`  ${incident.resolvedAt ? `resolved ${incident.resolvedAt}` : 'OPEN'}  — peaked at ${incident.peakLevel}, opened ${incident.openedAt}${incident.alertedAt ? `, escalated ${incident.alertedAt}` : ''}`);
  console.log(`  alert:  ${inv.exprText}`);
  if (inv.warnExprText) console.log(`  warn:   ${inv.warnExprText}`);
  if (incident.ackedAt) console.log(`  acked:  ${incident.ackedAt}${incident.ackedBy ? ` by ${incident.ackedBy.name ?? incident.ackedBy.email ?? 'a member'}` : ''}`);
  const evidence = incident.alertInputs ?? incident.openInputs;
  console.log(`  evidence (${incident.alertInputs ? 'at escalation' : 'at open'}):`);
  if (isBuiltinEvidence(evidence)) {
    console.log(`    contract: chain ${evidence.chainId} ${evidence.address}${evidence.label ? ` (${evidence.label})` : ''}`);
    console.log(`    reading:  ${evidence.sentence}`);
    if (evidence.detail) console.log(`              ${evidence.detail}`);
    for (const [k, v] of Object.entries(evidence.reading ?? {})) console.log(`    ${k.padEnd(24)} ${v == null ? '—' : String(v)}`);
    if (evidence.txHashes.length) console.log(`    tx: ${evidence.txHashes.join(', ')}`);
  } else {
    for (const input of inv.inputs) {
      const e = evidence?.[input.alias];
      const m = input.trackedOnchainValue;
      const now = m ? formatValue(m.liveValue != null ? m.liveValue : m.lastValue) : '—';
      console.log(`    ${input.alias.padEnd(24)} raw ${e?.raw ?? '—'}${e?.block ? ` @ block ${e.block}` : ''}   now ${now}`);
    }
  }
  console.log(`  deliveries: ${incident.deliveries.length} (${incident.notifyCount} notification${incident.notifyCount === 1 ? '' : 's'})`);
  for (const d of incident.deliveries) {
    const dest = d.channel ? `${d.channel.kind} ${d.channel.label ?? d.channel.id}` : 'unknown destination';
    console.log(`    round ${d.round}  ${d.status.padEnd(9)} ${dest}${d.sentAt ? `  sent ${d.sentAt}` : ''}${d.lastError ? `  error: ${d.lastError}` : ''}`);
  }
  return incident;
}

async function ackIncident(args: string[], acked: boolean): Promise<{ id: string; acked: boolean }> {
  const flags = parseFlags(args);
  const id = requirePositional(flags._ as string[], 0, 'incident id');
  const auth = requireAuth();
  await apiRequest(auth, 'PATCH', `/api/mainnet/incidents/${id}`, { acked });
  console.log(acked ? `Acknowledged ${id} — reminders stop; you'll still hear when it resolves.` : `Un-acknowledged ${id} — reminders resume.`);
  return { id, acked };
}
