import { apiRequest, loadCredentials, requireAuth, setWorkspaceOverride } from './credentials';

export interface StagenetSummary {
  id: string;
  name: string;
  chainId: number | null;
  forkChainId: number | null;
  rpcUrl: string | null;
}

export interface StagenetsPayload {
  workspace: { id: string; name: string; slug?: string } | null;
  stagenets: StagenetSummary[];
}

// Per-invocation targeting overrides. The entrypoint strips --stagenet/--rpc-url/--workspace
// from argv before command dispatch, so subcommand parsers never see them.
let stagenetOverride: string | undefined;
let rpcUrlOverride: string | undefined;

export function extractTargetFlags(args: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const grab = (name: string): string | undefined => {
      if (arg === `--${name}`) {
        const value = args[i + 1];
        if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
        i++;
        return value;
      }
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      return undefined;
    };
    const stagenet = grab('stagenet');
    if (stagenet !== undefined) {
      stagenetOverride = stagenet;
      continue;
    }
    const rpcUrl = grab('rpc-url');
    if (rpcUrl !== undefined) {
      rpcUrlOverride = rpcUrl;
      continue;
    }
    const workspace = grab('workspace');
    if (workspace !== undefined) {
      setWorkspaceOverride(workspace);
      continue;
    }
    rest.push(arg);
  }
  return rest;
}

// Test hook — module state would otherwise leak between jest cases.
export function resetTargetOverrides(): void {
  stagenetOverride = undefined;
  rpcUrlOverride = undefined;
  setWorkspaceOverride(undefined);
}

export async function fetchStagenets(): Promise<StagenetsPayload> {
  const auth = requireAuth();
  return await apiRequest<StagenetsPayload>(auth, 'GET', '/api/cli/stagenets');
}

export function matchStagenet(list: StagenetSummary[], ref: string): StagenetSummary {
  const byId = list.find((s) => s.id === ref);
  if (byId) return byId;
  const lowered = ref.toLowerCase();
  const byName = list.filter((s) => s.name.toLowerCase() === lowered);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `Multiple stagenets are named "${ref}" — target by id instead: ${byName.map((s) => s.id).join(', ')}`,
    );
  }
  const available = list.map((s) => s.name).join(', ') || 'none';
  throw new Error(`No stagenet "${ref}" in this workspace. Available: ${available}`);
}

// Which stagenet is pinned for this workspace, if any (set via `stagenet use`).
export function activeStagenetFor(workspaceId: string | undefined): { id: string; name: string } | undefined {
  if (!workspaceId) return undefined;
  return loadCredentials()?.activeStagenets?.[workspaceId];
}

// Resolution order for every stagenet command:
//   1. --rpc-url / CONTRACT_DEV_RPC_URL — direct URL, works with no login at all
//   2. --stagenet / CONTRACT_DEV_STAGENET — name or id, resolved via the API
//   3. the workspace's active stagenet, set with `contract.dev stagenet use`
export async function resolveStagenetRpcUrl(): Promise<string> {
  const direct = rpcUrlOverride ?? process.env.CONTRACT_DEV_RPC_URL;
  if (direct) return direct;

  const requested = stagenetOverride ?? process.env.CONTRACT_DEV_STAGENET;
  const payload = await fetchStagenets();

  let target: StagenetSummary;
  if (requested) {
    target = matchStagenet(payload.stagenets, requested);
  } else {
    const active = activeStagenetFor(payload.workspace?.id);
    if (!active) {
      const available = payload.stagenets.map((s) => s.name).join(', ') || 'none yet';
      throw new Error(
        `No stagenet selected. Run \`contract.dev stagenet use <name>\` or pass --stagenet <name>. Available: ${available}`,
      );
    }
    // Prefer the pinned id (rename-proof); fall back to matching the stored name.
    target = payload.stagenets.find((s) => s.id === active.id) ?? matchStagenet(payload.stagenets, active.name);
  }

  if (!target.rpcUrl) {
    throw new Error(`Stagenet "${target.name}" has no RPC endpoint right now — is it offline?`);
  }
  return target.rpcUrl;
}
