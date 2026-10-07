import { run } from '../../src/cli/index';
import { matchPosition } from '../../src/cli/commands/tvl';
import { mockApi, useEnvAuth, printed, RecordedCall } from './_mockApi';

// One position in full — the Positions tab's drill-down: how the CLI names it, what it asks
// for, and the facts, series and timeline it prints.
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const VAULT_A = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
const VAULT_B = '0x2371e134e3455e0593363cbf89d3b6cf53740618';
const query = (call: RecordedCall) => Object.fromEntries(new URLSearchParams(call.path.split('?')[1] ?? ''));

const accounts = () => ({
    payload: { accounts: [{ id: 'a1', chainId: 1, chainIds: [1], address: STETH, accountType: 'contract', name: 'Lido: stETH', valueUsd: 1 }] },
});

const groups = [
    {
        id: 'g1',
        family: 'morpho',
        kind: 'vault',
        title: 'Morpho vaults',
        chainId: 1,
        health: null,
        rows: [
            { detail: `vault:${VAULT_A}`, name: 'Steakhouse USDC', side: 'supplied', symbol: 'USDC', token: USDC, amount: 1_204_000, usd: 1_204_000, rateNow: null, realized7d: 0.0421 },
            { detail: `vault:${VAULT_B}`, name: 'Gauntlet WETH Prime', side: 'supplied', symbol: 'WETH', token: null, amount: 12.5, usd: 30_000, rateNow: null, realized7d: null },
        ],
    },
    {
        id: 'g2',
        family: 'aave',
        kind: 'lending',
        title: 'Aave v3 · Core',
        chainId: 1,
        health: 1.84,
        rows: [
            { detail: 'aave:core', name: 'USDC', side: 'borrowed', symbol: 'USDC', token: USDC, amount: 2_000_000, usd: 2_000_000, rateNow: 0.0512, realized7d: null },
            { detail: 'aave:core', name: 'WETH', side: 'supplied', symbol: 'WETH', token: null, amount: 1500, usd: 4_100_000, rateNow: 0.019, realized7d: 0.02 },
        ],
    },
];
const list = (now: number) => () => ({ payload: { chainId: 1, address: STETH, groups, readAt: now - 120_000 } });

describe('matchPosition', () => {
    it('finds a position by its key, a vault address, a market key, a name, a word of it, or a part — and refuses two', () => {
        expect(matchPosition(groups as any, `vault:${VAULT_A}`).key).toBe(`vault:${VAULT_A}`);
        expect(matchPosition(groups as any, VAULT_B.toUpperCase()).title).toBe('Morpho vaults · Gauntlet WETH Prime');
        expect(matchPosition(groups as any, 'core')).toEqual({ key: 'aave:core', title: 'Aave v3 · Core' });
        expect(matchPosition(groups as any, 'Aave v3 · Core').key).toBe('aave:core');
        expect(matchPosition(groups as any, 'steakhouse').key).toBe(`vault:${VAULT_A}`);
        expect(matchPosition(groups as any, 'gauntl').key).toBe(`vault:${VAULT_B}`);
        expect(() => matchPosition(groups as any, 'usdc')).toThrow(/matches 2 positions: Morpho vaults · Steakhouse USDC \(vault:0xbeef/);
        expect(() => matchPosition(groups as any, 'nothing')).toThrow(/No position matches "nothing"\. Here: Morpho vaults · Steakhouse USDC/);
        expect(() => matchPosition([], 'x')).toThrow('No position here opens in full.');
    });
});

describe('positions <contract> <position>', () => {
    useEnvAuth();

    it('the list says how to open one', async () => {
        mockApi({ 'GET /api/mainnet/accounts': accounts, 'GET /api/mainnet/console/positions': list(Date.now()) });
        await run(['positions', 'steth']);
        expect(printed().at(-1)).toMatch(/^\nOne in full: contract[.-]dev positions "Lido: stETH" <vault or market> \[--range 7d\]$/);
    });

    it('a vault holding: facts, the series as lines, the timeline newest first, where the history begins', async () => {
        const now = Date.now();
        const calls = mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/console/positions': list(now),
            'GET /api/mainnet/console/positions/detail': () => ({
                payload: {
                    range: '7d',
                    detail: {
                        kind: 'vault',
                        chainId: 1,
                        address: STETH,
                        position: `vault:${VAULT_A}`,
                        family: 'morpho',
                        vault: { address: VAULT_A, name: 'Steakhouse USDC', symbol: 'steakUSDC', decimals: 18, asset: USDC, assetSymbol: 'USDC', assetDecimals: 6, curator: 'Steakhouse Financial', verified: true },
                        holding: { shares: 1_150_210, assets: 1_204_000, usd: 1_204_000, shareOfVault: 0.031, withdrawable: 1_204_000, vaultSize: 38_900_000, sharePrice: 1.0468, realized7d: 0.0421, readAt: now - 120_000 },
                        series: {
                            sharePrice: [{ at: '2026-09-28T00:00:00Z', value: 1.0461 }, { at: '2026-10-05T00:00:00Z', value: 1.0468 }],
                            value: [{ at: '2026-09-28T00:00:00Z', value: 1_180_000 }, { at: '2026-10-05T00:00:00Z', value: 1_204_000 }],
                            valueUsd: null,
                            vaultSize: [{ at: '2026-09-28T00:00:00Z', value: 38_900_000 }, { at: '2026-10-05T00:00:00Z', value: 38_900_000 }],
                        },
                        usdPricing: null,
                        timeline: [
                            { at: '2026-10-04T10:00:00Z', blockNumber: 23_000_000, txHash: `0x${'ab'.repeat(32)}`, kind: 'deposit', amount: 50_000, symbol: 'USDC' },
                            { at: '2026-10-05T06:00:00Z', blockNumber: 23_005_000, txHash: null, kind: 'withdraw', amount: 26_000, symbol: 'USDC' },
                        ],
                        history: { fromMs: Date.parse('2026-09-28T08:00:00Z'), storeFromMs: Date.parse('2026-09-01T00:00:00Z'), recordedFromMs: Date.parse('2026-10-01T00:00:00Z') },
                    },
                },
            }),
        });
        await run(['positions', 'steth', 'steakhouse', '--range', '7d']);
        const detail = calls.find((c) => c.path.startsWith('/api/mainnet/console/positions/detail'))!;
        expect(query(detail)).toEqual({ chainId: '1', address: STETH, position: `vault:${VAULT_A}`, range: '7d' });
        const out = printed();
        expect(out[0]).toBe('Morpho vaults · Steakhouse USDC · Lido: stETH · Ethereum · last 7d');
        expect(out.find((l) => l.startsWith('  Value'))).toMatch(/^ {2}Value\s+1,204,000 USDC \(\$1\.20M\) · 1,150,210 steakUSDC · 3\.10% of the vault$/);
        expect(out.find((l) => l.startsWith('  Withdrawable now'))).toMatch(/1,204,000 USDC$/);
        expect(out.find((l) => l.startsWith('  Share price  '))).toMatch(/1\.0468 USDC · realised 7d 4\.21%$/);
        expect(out.find((l) => l.startsWith('  Vault size  '))).toMatch(/38,900,000 USDC$/);
        expect(out.find((l) => l.startsWith('  Vault  '))).toMatch(/Steakhouse USDC · 0xbeef.* · curator Steakhouse Financial$/);
        expect(out.some((l) => /^ {2}Share price\s+[▁-█]+\s+1\.0461 → 1\.0468$/.test(l))).toBe(true);
        expect(out.some((l) => /^ {2}Vault size\s+unchanged at 38,900,000 USDC$/.test(l))).toBe(true);
        const withdraw = out.findIndex((l) => /Withdraw\s+26,000 USDC\s+23,005,000\s+—$/.test(l));
        const deposit = out.findIndex((l) => /Deposit\s+50,000 USDC\s+23,000,000\s+0xabab/.test(l));
        expect(withdraw).toBeGreaterThan(0);
        expect(deposit).toBe(withdraw + 1);
        expect(out.at(-1)).toBe('\nHistory from 2026-09-28 (recorded from 2026-10-01)');
    });

    it('a lending account: health, collateral, debt, net, the borrow rates; the plan\'s window when it is shorter', async () => {
        const now = Date.now();
        mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/console/positions': list(now),
            'GET /api/mainnet/console/positions/detail': () => ({
                payload: {
                    range: '24h',
                    detail: {
                        kind: 'lending',
                        chainId: 1,
                        address: STETH,
                        position: 'aave:core',
                        family: 'aave',
                        market: { key: 'core', title: 'Aave v3 · Core', pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' },
                        account: { healthFactor: 1.84, collateralUsd: 4_100_000, debtUsd: 2_000_000, readAt: now - 60_000 },
                        series: {
                            health: [{ at: '2026-10-04T08:00:00Z', value: 1.79 }, { at: '2026-10-05T08:00:00Z', value: 1.84 }],
                            collateralUsd: [{ at: '2026-10-04T08:00:00Z', value: 4_000_000 }, { at: '2026-10-05T08:00:00Z', value: 4_100_000 }],
                            debtUsd: [{ at: '2026-10-04T08:00:00Z', value: 2_000_000 }],
                            borrowRates: [{ asset: USDC, symbol: 'USDC', points: [{ at: '2026-10-04T08:00:00Z', value: 0.05 }, { at: '2026-10-05T08:00:00Z', value: 0.0512 }] }],
                        },
                        timeline: [],
                        history: { fromMs: now - 86_400_000, storeFromMs: null, recordedFromMs: null },
                    },
                },
            }),
        });
        await run(['positions', 'steth', 'core', '--range', '30d']);
        const out = printed();
        expect(out[0]).toBe('Aave v3 · Core · Lido: stETH · Ethereum · last 24h');
        expect(out[1]).toBe("Showing 24h: this workspace's plan keeps 24h of history.");
        expect(out.find((l) => l.startsWith('  Health factor  '))).toMatch(/1\.84$/);
        expect(out.find((l) => l.startsWith('  Net'))).toMatch(/\$2\.10M$/);
        expect(out.find((l) => l.startsWith('  Market'))).toMatch(/Aave v3 · Core · pool 0x8787/);
        expect(out.some((l) => /^ {2}Health factor\s+[▁-█]+\s+1\.79 → 1\.84$/.test(l))).toBe(true);
        expect(out.some((l) => /^ {2}Borrow rate USDC\s+[▁-█]+\s+5\.00% → 5\.12%$/.test(l))).toBe(true);
        expect(out.some((l) => l.startsWith('  Debt   ') && /[▁-█]/.test(l))).toBe(false); // one point is no line
        expect(out.indexOf('  Nothing moved in the window.')).toBeGreaterThan(out.indexOf('\nTimeline'));
        expect(out.at(-1)).toMatch(/^\nHistory from \d{4}-\d{2}-\d{2} · chain not collected$/);
    });
});
