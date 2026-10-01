// Shared by the data commands (activity, methods, flows, users, tvl, …): the window flag,
// naming a watched contract by address or by name, and the app's address book. Each command
// reads the same routes the dashboard pages do, so the CLI and the app always agree.
import { apiRequest, ResolvedAuth } from './credentials';
import { flag, ParsedFlags } from './commands/_args';
import { parseChainId, WatchedAccount } from './commands/watch';
import { chainLabel } from './view';

/** The windows the dashboard offers. Free workspaces keep 24 hours of history; the server clamps longer asks. */
export const RANGES = ['24h', '7d', '30d', '90d'] as const;
export type Range = (typeof RANGES)[number];

export function parseRange<T extends string>(flags: ParsedFlags, allowed: readonly T[], fallback: T): T {
  const raw = flag(flags, 'range');
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`--range must be one of ${allowed.join(', ')} (got: ${raw})`);
  }
  return v as T;
}

/** A line saying the server answered for a shorter window than asked — the plan's limit — or nothing. */
export function servedRangeNote(requested: string, served: string | null | undefined): string | null {
  if (!served || served === requested) return null;
  return `Showing ${served}: this workspace's plan keeps ${served} of history.`;
}

export function chainFlag(flags: ParsedFlags): number | undefined {
  const raw = flag(flags, 'chain');
  return raw === undefined ? undefined : parseChainId(raw, '--chain');
}

/** --limit, a positive whole number up to `max`. */
export function limitFlag(flags: ParsedFlags, fallback: number, max = 500): number {
  const raw = flag(flags, 'limit');
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit must be a positive whole number (got: ${raw})`);
  return Math.min(n, max);
}

export async function workspaceContracts(auth: ResolvedAuth): Promise<WatchedAccount[]> {
  const { accounts } = await apiRequest<{ accounts: WatchedAccount[] }>(auth, 'GET', '/api/mainnet/accounts?accountType=contract');
  return (accounts ?? []).filter((a) => a.accountType === 'contract');
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s: string | null | undefined): boolean => !!s && ADDRESS.test(s);

const describe = (a: WatchedAccount) => `${a.name ?? a.address} (${chainLabel(a.chainId)} ${a.address})`;

/**
 * One watched contract from what a person would type: its address, or its name as the
 * workspace shows it ("Lido: stETH", or any unambiguous part of it, "steth"). --chain picks
 * between the same address on two chains.
 */
export function matchContract(contracts: WatchedAccount[], ref: string, chainId?: number): WatchedAccount {
  const onChain = contracts.filter((c) => chainId === undefined || c.chainId === chainId);
  const pick = (found: WatchedAccount[], how: string): WatchedAccount | null => {
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(
        `${how} matches ${found.length} watched contracts: ${found.map(describe).join('; ')}. Use the address${chainId === undefined ? ', or --chain' : ''}.`,
      );
    }
    return null;
  };

  if (isAddress(ref)) {
    const lower = ref.toLowerCase();
    const hit = pick(onChain.filter((c) => c.address.toLowerCase() === lower), ref);
    if (hit) return hit;
    throw new Error(`${ref} is not watched in this workspace${chainId !== undefined ? ` on ${chainLabel(chainId)}` : ''}. Watch it with \`contract.dev watch ${ref}\`.`);
  }

  const q = ref.trim().toLowerCase();
  if (!q) throw new Error('Name a contract: its address or its name in the workspace.');
  const named = onChain.filter((c) => c.name);
  // Exact name first, then a whole word of it ("steth" is Lido: stETH, not Lido: wstETH), then any part.
  const word = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
  const hit =
    pick(named.filter((c) => c.name!.toLowerCase() === q), `"${ref}"`) ??
    pick(named.filter((c) => word.test(c.name!.toLowerCase())), `"${ref}"`) ??
    pick(named.filter((c) => c.name!.toLowerCase().includes(q)), `"${ref}"`);
  if (hit) return hit;
  throw new Error(`No watched contract is called "${ref}". \`contract.dev contracts\` lists them.`);
}

export async function resolveContract(auth: ResolvedAuth, ref: string, chainId?: number): Promise<WatchedAccount> {
  return matchContract(await workspaceContracts(auth), ref, chainId);
}

// ── the app's address book ────────────────────────────────────────────────

const LABEL_BATCH = 200; // GET /api/mainnet/labels takes up to 200 items

/**
 * Names for addresses, from the same book the app labels its tables with (watched contracts,
 * your renames, well-known protocols). Keys are `chainId:address`, lower-case. A failed lookup
 * leaves the addresses unnamed rather than failing the command.
 */
export async function lookupNames(
  auth: ResolvedAuth,
  items: Array<{ chainId: number; address: string | null | undefined }>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const keys = Array.from(
    new Set(items.filter((i) => isAddress(i.address)).map((i) => `${i.chainId}:${i.address!.toLowerCase()}`)),
  );
  for (let i = 0; i < keys.length; i += LABEL_BATCH) {
    const batch = keys.slice(i, i + LABEL_BATCH);
    try {
      const res = await apiRequest<{ book?: Record<string, { name: string | null }> }>(
        auth,
        'GET',
        `/api/mainnet/labels?items=${batch.join(',')}`,
      );
      for (const [key, entry] of Object.entries(res.book ?? {})) if (entry?.name) names.set(key.toLowerCase(), entry.name);
    } catch {
      // unnamed is fine
    }
  }
  return names;
}

export const nameKey = (chainId: number, address: string | null | undefined): string => `${chainId}:${(address ?? '').toLowerCase()}`;
