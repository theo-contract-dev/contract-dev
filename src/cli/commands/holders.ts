import { parseFlags } from './_args';
import { requireAuth, apiRequest } from '../credentials';
import { chainFlag, limitFlag, resolveContract } from '../data';
import { DASH, chainLabel, fmtCompact, fmtInt, fmtUsd, nameOr, shortAddr, table } from '../view';

// `holders`: a token's holders. It lived beside `tvl` until holdings and TVL were removed
// (2026-10-22); the holder counts come from their own route, which stays.
const HELP = `contract-dev holders — a token's holders

Usage:
  contract-dev holders <contract> [flags]   How many hold it, the largest, how concentrated

Flags:
  --chain <id|name>        The chain, when the name is watched on several
  --limit <n>              Holder rows to print (default 15, at most 25)

<contract> is an address or a watched contract's name. Add --json for everything.
`;

interface HoldersPayload {
  covered: boolean;
  isToken: boolean;
  totalHolders: number | null;
  change: Partial<Record<'1h' | '24h' | '3d' | '7d' | '30d', { change: number | null; pct: number | null }>>;
  supplyPct: Partial<Record<'top10' | 'top25' | 'top50' | 'top100', number>>;
  acquisition: { swap: number; transfer: number; airdrop: number } | null;
  distribution: Array<{ bucket: string; count: number }>;
  topHolders: Array<{ address: string; label: string | null; isContract: boolean; balanceFormatted: string | null; usd: number | null; pctOfSupply: number | null }>;
}

const help = (args: string[]) => !args.length || ['help', '-h', '--help'].includes(args[0]);

export async function holdersCommand(args: string[]): Promise<HoldersPayload | void> {
  if (help(args)) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const limit = limitFlag(flags, 15, 25);
  const auth = requireAuth();
  const contract = await resolveContract(auth, flags._[0], chainFlag(flags));
  const h = await apiRequest<HoldersPayload>(auth, 'GET', `/api/mainnet/contracts/${contract.address.toLowerCase()}/holders?chainId=${contract.chainId}`, undefined, {
    timeoutMs: 60_000,
  });
  console.log(`${contract.name ?? shortAddr(contract.address)} · ${chainLabel(contract.chainId)} · holders`);
  if (!h.covered) {
    console.log(`Holder data is not available on ${chainLabel(contract.chainId)}.`);
    return h;
  }
  if (!h.isToken || h.totalHolders == null) {
    console.log('No holder data for this contract.');
    return h;
  }
  const changes = (['24h', '7d', '30d'] as const)
    .map((w) => (h.change[w]?.change != null ? `${h.change[w]!.change! > 0 ? '+' : ''}${fmtInt(h.change[w]!.change)} in ${w}` : null))
    .filter(Boolean);
  console.log(`${fmtInt(h.totalHolders)} holders${changes.length ? ` · ${changes.join(' · ')}` : ''}`);
  const conc = (['top10', 'top25', 'top100'] as const).filter((k) => h.supplyPct[k] != null).map((k) => `${k.replace('top', 'top ')} hold ${h.supplyPct[k]!.toFixed(1)}%`);
  if (conc.length) console.log(`Concentration: ${conc.join(' · ')}`);
  if (h.topHolders?.length) {
    console.log('\nLargest holders');
    for (const line of table(h.topHolders.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 })), [
      { header: '#', value: (r) => String(r.rank), align: 'right' },
      { header: 'Holder', value: (r) => `${nameOr(r.label, r.address)}${r.isContract ? ' (contract)' : ''}`, max: 32 },
      { header: 'Balance', value: (r) => (r.balanceFormatted == null ? DASH : fmtCompact(Number(r.balanceFormatted))), align: 'right' },
      { header: 'Value', value: (r) => fmtUsd(r.usd), align: 'right' },
      { header: 'Of supply', value: (r) => (r.pctOfSupply == null ? DASH : `${r.pctOfSupply.toFixed(2)}%`), align: 'right' },
      { header: 'Address', value: (r) => r.address },
    ], '  ')) {
      console.log(line);
    }
  }
  if (h.distribution?.length) console.log(`\nBy size: ${h.distribution.map((d) => `${d.bucket} ${fmtInt(d.count)}`).join(' · ')}`);
  return h;
}
