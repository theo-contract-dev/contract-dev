import { apiRequest, requireAuth } from '../credentials';
import { formatInt } from '../format';
import { shortHex } from './metrics';
import type { WatchedAccount } from './watch';
import { monitorState, type Invariant } from './monitor';
import type { WhoamiPayload } from './login';

const HELP = `contract-dev status — the workspace at a glance

Usage:
  contract-dev status          Contracts, 24h transactions, metrics, monitors, open alerts

Add --json for the same figures as JSON.
`;

interface Vitals {
  org: { contracts: number; chains: number; txTotal: number; txFailed: number };
  updating?: boolean;
}

interface IncidentRow {
  id: string;
  name: string;
  exprText: string;
  sentence?: string | null;
  level: string;
  openedAt: string;
  resolvedAt: string | null;
  chainId: number | null;
  address: string | null;
}

export interface StatusReport {
  workspace: { id: string; name: string; slug?: string } | null;
  contracts: number;
  chains: number;
  tx24h: number | null;
  failed24h: number | null;
  metrics: number;
  monitors: { total: number; healthy: number; warning: number; alerting: number; warming: number; disabled: number };
  openAlerts: Array<{ id: string; name: string; level: string; since: string; what: string; chainId: number | null; address: string | null }>;
}

const settle = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export async function statusCommand(args: string[] = []): Promise<StatusReport | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const auth = requireAuth();
  // The figures that can be unknown (a slow store, a chain that did not answer) degrade to a
  // dash; the ones read from the workspace's own rows always come back.
  const [who, accountsRes, vitals, invariantsRes, incidentsRes, metricsRes] = await Promise.all([
    apiRequest<WhoamiPayload>(auth, 'GET', '/api/cli/whoami'),
    apiRequest<{ accounts: WatchedAccount[] }>(auth, 'GET', '/api/mainnet/accounts?accountType=contract'),
    settle(apiRequest<Vitals>(auth, 'GET', '/api/mainnet/vitals?range=24h')),
    apiRequest<{ invariants: Invariant[] }>(auth, 'GET', '/api/mainnet/invariants'),
    apiRequest<{ incidents: IncidentRow[] }>(auth, 'GET', '/api/mainnet/incidents?days=1'),
    apiRequest<{ trackedMetrics: unknown[] }>(auth, 'GET', '/api/mainnet/tracked-metrics'),
  ]);

  const contracts = (accountsRes.accounts ?? []).filter((a) => a.accountType === 'contract');
  const chains = new Set(contracts.map((c) => c.chainId));

  const invariants = invariantsRes.invariants ?? [];
  const monitors = { total: invariants.length, healthy: 0, warning: 0, alerting: 0, warming: 0, disabled: 0 };
  for (const inv of invariants) monitors[monitorState(inv)] += 1;

  const open = (incidentsRes.incidents ?? []).filter((i) => !i.resolvedAt);

  const report: StatusReport = {
    workspace: who.org ?? null,
    contracts: contracts.length,
    chains: chains.size,
    tx24h: vitals ? vitals.org.txTotal : null,
    failed24h: vitals ? vitals.org.txFailed : null,
    metrics: (metricsRes.trackedMetrics ?? []).length,
    monitors,
    openAlerts: open.map((i) => ({
      id: i.id,
      name: i.name,
      level: i.level,
      since: i.openedAt,
      what: i.sentence ?? i.exprText,
      chainId: i.chainId,
      address: i.address,
    })),
  };

  console.log(`Workspace:     ${report.workspace ? `${report.workspace.name}${report.workspace.slug ? ` (${report.workspace.slug})` : ''}` : 'unknown'}`);
  console.log(`Contracts:     ${formatInt(report.contracts)} on ${formatInt(report.chains)} chain${report.chains === 1 ? '' : 's'}`);
  console.log(`Transactions:  ${formatInt(report.tx24h)} in 24h · ${formatInt(report.failed24h)} failed${vitals?.updating ? '  (updating)' : ''}`);
  console.log(`Metrics:       ${formatInt(report.metrics)} tracked`);
  console.log(
    `Monitors:      ${formatInt(monitors.total)} · ${formatInt(monitors.healthy)} healthy · ${formatInt(monitors.warning)} warning · ${formatInt(monitors.alerting)} alerting${monitors.warming ? ` · ${formatInt(monitors.warming)} warming up` : ''}${monitors.disabled ? ` · ${formatInt(monitors.disabled)} disabled` : ''}`,
  );
  console.log(`Open alerts:   ${formatInt(report.openAlerts.length)}`);
  for (const a of report.openAlerts.slice(0, 10)) {
    const where = a.chainId != null && a.address ? `  [chain ${a.chainId} ${shortHex(a.address)}]` : '';
    console.log(`  ${a.level.padEnd(7)} ${a.name} — ${a.what}${where}  since ${a.since}`);
  }
  if (report.openAlerts.length > 10) console.log(`  … ${report.openAlerts.length - 10} more (contract-dev alerts)`);
  return report;
}
