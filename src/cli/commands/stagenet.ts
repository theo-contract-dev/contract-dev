import { parseFlags, flag, requirePositional } from './_args';
import { apiRequest, loadCredentials, requireAuth, saveCredentials } from '../credentials';
import { callRpc } from '../rpc';
import { fetchStagenetInfo } from '../stagenet-info';
import {
  activeStagenetFor,
  fetchStagenets,
  matchStagenet,
  resolveStagenetRpcUrl,
  StagenetsPayload,
  StagenetSummary,
} from '../target';
import { parseChainId } from './watch';

const HELP = `contract-dev stagenet — choose, create and reset the stagenet the CLI targets

Usage:
  contract-dev stagenets                       List the active workspace's stagenets
  contract-dev stagenet                        Show the active stagenet
  contract-dev stagenet use <ref>              Set it (ref = name or id; stored per workspace)
  contract-dev stagenet create <name> --chain <id|name>   Create a stagenet forking that chain, and make it active
  contract-dev stagenet delete <ref> --yes     Delete a stagenet — its state is gone for good
  contract-dev stagenet reset                  Return the stagenet's state to the live chain now, keeping your wallets
  contract-dev stagenet reset --every <6h|12h|1d|off>   Reset on a schedule (off stops it)
  contract-dev stagenet reset --show           Show the schedule and the last reset

Chains a stagenet can fork: ethereum, base, polygon, optimism, arbitrum, avalanche, bnb, monad.

Any stagenet command also takes a one-off override:
  --stagenet <name>       Resolve a name via the API instead of the active one
  --rpc-url <url>         Hit an RPC URL directly (no login needed)
`;

// The chains the app offers when creating a stagenet, in the app's order, with the slug its
// create endpoint takes.
export const FORK_CHAIN_ORDER = [1, 8453, 137, 10, 42161, 43114, 56, 143] as const;
export const FORK_CHAINS: Record<number, { slug: string; name: string }> = {
  1: { slug: 'ethereum', name: 'Ethereum' },
  8453: { slug: 'base', name: 'Base' },
  137: { slug: 'polygon', name: 'Polygon' },
  10: { slug: 'optimism', name: 'Optimism' },
  42161: { slug: 'arbitrum', name: 'Arbitrum' },
  43114: { slug: 'avalanche', name: 'Avalanche' },
  56: { slug: 'bnb', name: 'BNB Smart Chain' },
  143: { slug: 'monad', name: 'Monad' },
};

// Approval spenders whose Permit2 allowances a reset keeps, per fork chain — the same list
// the app's State Reset uses. Override with --routers.
const RESET_ROUTERS_BY_CHAIN: Record<number, string[]> = {
  42161: ['0xf708e11a7c94abde8f6217b13e6fe39c8b9cc0a6'],
  8453: ['0xf708e11a7c94abde8f6217b13e6fe39c8b9cc0a6'],
};

// Creating a stagenet provisions infrastructure; the default request deadline is too short.
const CREATE_TIMEOUT_MS = 180_000;

interface WipeSchedule {
  intervalMs: number | null;
  preserveTokens: string[] | null;
  routers: string[] | null;
  onStartup: boolean;
  lastWipeAt: number | null;
}

function describeChain(stagenet: StagenetSummary): string {
  return stagenet.forkChainId ? `fork of ${FORK_CHAINS[stagenet.forkChainId]?.name ?? stagenet.forkChainId}` : 'no fork chain';
}

function resolveActive(payload: StagenetsPayload): StagenetSummary | undefined {
  const active = activeStagenetFor(payload.workspace?.id);
  if (!active) return undefined;
  return (
    payload.stagenets.find((s) => s.id === active.id) ??
    payload.stagenets.find((s) => s.name.toLowerCase() === active.name.toLowerCase())
  );
}

function pinActive(workspaceId: string | undefined, stagenet: { id: string; name: string }): void {
  const stored = loadCredentials();
  if (!stored || !workspaceId) return;
  saveCredentials({ ...stored, activeStagenets: { ...stored.activeStagenets, [workspaceId]: stagenet } });
}

function unpinIfActive(workspaceId: string | undefined, stagenetId: string): void {
  const stored = loadCredentials();
  if (!stored?.activeStagenets || !workspaceId || stored.activeStagenets[workspaceId]?.id !== stagenetId) return;
  const next = { ...stored.activeStagenets };
  delete next[workspaceId];
  saveCredentials({ ...stored, activeStagenets: next });
}

// "30m" / "6h" / "1d" → milliseconds.
export function parseDurationMs(raw: string): number {
  const m = /^(\d+)\s*(m|min|h|hr|d)$/i.exec(raw.trim());
  if (!m) throw new Error(`Give a duration like 6h, 12h or 1d (got: ${raw})`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000);
}

function describeInterval(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export async function stagenetsCommand(args: string[] = []): Promise<StagenetSummary[]> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return [];
  }
  const payload = await fetchStagenets();
  if (!payload.stagenets.length) {
    console.log('No stagenets in this workspace yet — create one with `contract-dev stagenet create <name> --chain <id|name>`.');
    return [];
  }
  const activeId = resolveActive(payload)?.id;
  for (const stagenet of payload.stagenets) {
    const marker = stagenet.id === activeId ? '*' : ' ';
    const offline = stagenet.rpcUrl ? '' : '  (offline)';
    console.log(`${marker} ${stagenet.name}  — ${describeChain(stagenet)}${offline}`);
  }
  return payload.stagenets;
}

export async function stagenetCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
      return await showActive();
    case 'use':
      return await useStagenet(rest);
    case 'list':
      return await stagenetsCommand(rest);
    case 'create':
      return await createStagenet(rest);
    case 'delete':
    case 'remove':
    case 'rm':
      return await deleteStagenet(rest);
    case 'reset':
      return await resetStagenet(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown stagenet subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function showActive(): Promise<StagenetSummary | void> {
  const payload = await fetchStagenets();
  const active = resolveActive(payload);
  if (!active) {
    const available = payload.stagenets.map((s) => s.name).join(', ') || 'none yet';
    console.log(`No active stagenet. Set one with \`contract-dev stagenet use <name>\`. Available: ${available}`);
    return;
  }
  console.log(`${active.name}  — ${describeChain(active)}${active.rpcUrl ? '' : '  (offline)'}`);
  if (active.rpcUrl) console.log(`  rpc: ${active.rpcUrl}`);
  return active;
}

async function useStagenet(args: string[]): Promise<StagenetSummary> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'stagenet (name or id)');

  const payload = await fetchStagenets();
  const target = matchStagenet(payload.stagenets, ref);
  const workspaceId = payload.workspace?.id;
  if (!workspaceId) throw new Error('Could not resolve the active workspace.');

  const stored = loadCredentials();
  if (!stored) {
    throw new Error(
      'Signed in via environment credentials — set CONTRACT_DEV_STAGENET instead of `stagenet use`.',
    );
  }
  pinActive(workspaceId, { id: target.id, name: target.name });
  console.log(`Active stagenet: ${target.name}  — ${describeChain(target)}${target.rpcUrl ? '' : '  (offline)'}`);
  return target;
}

// `stagenet create <name> --chain <id|name>` — the app's create flow (fork at latest), then
// the new stagenet becomes this workspace's active one so the next command targets it.
async function createStagenet(args: string[]): Promise<{ id: string; name: string; forkChainId: number; rpcUrl: string | null; status: string | null }> {
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'stagenet name');
  const chainRaw = flag(flags, 'chain');
  const chainList = FORK_CHAIN_ORDER.map((id) => FORK_CHAINS[id].slug).join(', ');
  if (!chainRaw) throw new Error(`--chain is required: the chain to fork (${chainList}).`);
  const forkChainId = parseChainId(chainRaw, '--chain');
  const fork = FORK_CHAINS[forkChainId];
  if (!fork) throw new Error(`Stagenets can fork ${chainList} — not chain ${forkChainId}.`);

  const auth = requireAuth();
  console.log(`Creating ${name} — fork of ${fork.name}…`);
  const created = await apiRequest<{ projectId?: string; id?: string; rpcKey?: string; status?: string }>(
    auth,
    'POST',
    '/api/stagenets',
    { name, forkBlock: 'latest', network: fork.slug, forkChainId },
    { timeoutMs: CREATE_TIMEOUT_MS },
  );
  const id = created.projectId ?? created.id;
  if (!id) throw new Error('The stagenet was not created — the app returned no id.');

  const payload = await fetchStagenets();
  const row = payload.stagenets.find((s) => s.id === id);
  if (loadCredentials()) pinActive(payload.workspace?.id, { id, name });

  console.log(`Created ${name} (${id}) — fork of ${fork.name}${created.status ? `, ${created.status}` : ''}. It is now the active stagenet.`);
  if (row?.rpcUrl) console.log(`  rpc: ${row.rpcUrl}`);
  else console.log('  rpc: not ready yet — `contract-dev stagenet` shows it once the stagenet is online.');
  return { id, name, forkChainId, rpcUrl: row?.rpcUrl ?? null, status: created.status ?? null };
}

async function deleteStagenet(args: string[]): Promise<{ ok: true; id: string; name: string }> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'stagenet (name or id)');
  if (flags.yes !== 'true') {
    throw new Error(`Deleting a stagenet destroys its state and cannot be undone. Re-run with --yes to delete "${ref}".`);
  }
  const auth = requireAuth();
  const payload = await fetchStagenets();
  const target = matchStagenet(payload.stagenets, ref);
  await apiRequest(auth, 'DELETE', `/api/stagenets?projectId=${encodeURIComponent(target.id)}`);
  unpinIfActive(payload.workspace?.id, target.id);
  console.log(`Deleted ${target.name} (${target.id}).`);
  return { ok: true, id: target.id, name: target.name };
}

function parseAddressList(raw: string): string[] {
  const out = raw.split(/[\s,]+/).filter(Boolean).map((a) => a.toLowerCase());
  if (out.some((a) => !/^0x[0-9a-f]{40}$/.test(a))) throw new Error('--routers must be a comma-separated list of 0x addresses');
  return out;
}

function printSchedule(schedule: WipeSchedule): void {
  if (schedule.intervalMs == null) console.log('Scheduled resets: off.');
  else console.log(`Scheduled resets: every ${describeInterval(schedule.intervalMs)}${schedule.onStartup ? ', and on startup' : ''}.`);
  if (schedule.routers?.length) console.log(`  approvals kept for: ${schedule.routers.join(', ')}`);
  console.log(`  last reset: ${schedule.lastWipeAt == null ? 'never' : new Date(schedule.lastWipeAt).toISOString()}`);
}

// `stagenet reset`: State Reset — every locally modified slot goes back to the live chain
// while your wallets' balances, nonces and approvals are carried across. Now, or on a
// schedule the stagenet keeps (`--every`).
async function resetStagenet(args: string[]): Promise<unknown> {
  const flags = parseFlags(args);
  const rpcUrl = await resolveStagenetRpcUrl();

  if (flags.show === 'true') {
    const schedule = await callRpc<WipeSchedule>(rpcUrl, 'mock_getWipeSchedule', []);
    printSchedule(schedule);
    return schedule;
  }

  const routersRaw = flag(flags, 'routers');
  const routers = routersRaw
    ? parseAddressList(routersRaw)
    : RESET_ROUTERS_BY_CHAIN[(await fetchStagenetInfo(rpcUrl)).forkChainId] ?? [];

  const every = flag(flags, 'every');
  if (every !== undefined) {
    if (every === 'true') throw new Error('--every needs a duration (6h, 12h, 1d) or off');
    if (every === 'off' || every === 'never' || every === '0') {
      const schedule = await callRpc<WipeSchedule>(rpcUrl, 'mock_setWipeSchedule', [{ intervalMs: null }]);
      printSchedule(schedule);
      return schedule;
    }
    const intervalMs = parseDurationMs(every);
    if (intervalMs < 5 * 60_000) throw new Error('--every must be at least 5m');
    const schedule = await callRpc<WipeSchedule>(rpcUrl, 'mock_setWipeSchedule', [{ intervalMs, onStartup: true, routers }]);
    printSchedule(schedule);
    return schedule;
  }

  const result = await callRpc<unknown>(rpcUrl, 'mock_wipeLocalState', [routers.length ? { routers } : {}]);
  console.log('Reset: local state returned to the live chain. Your wallets kept their balances, nonces and approvals.');
  return result ?? { ok: true };
}
