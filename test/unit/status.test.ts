import { statusCommand } from '../../src/cli/commands/status';
import { mockApi, useEnvAuth, printed } from './_mockApi';

describe('status', () => {
    useEnvAuth();

    it('composes the workspace figures, degrading the vitals to a dash when they do not answer', async () => {
        mockApi({
            'GET /api/cli/whoami': () => ({ payload: { email: 'theo@contract.dev', org: { id: 'o1', name: 'Acme', slug: 'acme' }, workspaces: [] } }),
            'GET /api/mainnet/accounts': () => ({
                payload: {
                    accounts: [
                        { id: 'a1', chainId: 1, chainIds: [1], address: '0xaaa', accountType: 'contract', name: 'USDC', valueUsd: 2_000_000 },
                        { id: 'a2', chainId: 42161, chainIds: [42161], address: '0xbbb', accountType: 'contract', name: null, valueUsd: 500_000 },
                    ],
                },
            }),
            'GET /api/mainnet/vitals': () => ({ payload: { org: { contracts: 2, chains: 2, tvlUsd: 2_500_000, txTotal: 1234, txFailed: 12 } } }),
            'GET /api/mainnet/invariants': () => ({
                payload: {
                    // the server's words: ok, breached, warning, warming, stale; an enabled flag for paused ones
                    invariants: [
                        { id: 'i1', name: 'A', enabled: true, status: 'ok' },
                        { id: 'i2', name: 'B', enabled: true, status: 'breached' },
                        { id: 'i3', name: 'C', enabled: false, status: 'ok' },
                        { id: 'i4', name: 'D', enabled: true, status: 'warming' },
                        { id: 'i5', name: 'E', enabled: true, status: 'stale' },
                    ],
                },
            }),
            'GET /api/mainnet/incidents': () => ({
                payload: { days: 1, incidents: [{ id: 'inc1', name: 'B', exprText: 'b >= 1', level: 'alert', openedAt: '2026-09-27T09:00:00Z', resolvedAt: null, chainId: 1, address: '0xaaa' }] },
            }),
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [{}, {}, {}] } }),
            'GET /api/cli/stagenets': () => ({ payload: { workspace: { id: 'o1', name: 'Acme' }, stagenets: [{ id: 's1', name: 'avax-fork', chainId: 1, forkChainId: 43114, rpcUrl: 'https://rpc.local/s1' }] } }),
        });
        const report = (await statusCommand([]))!;
        expect(report).toMatchObject({ contracts: 2, chains: 2, tvlUsd: 2_500_000, tx24h: 1234, failed24h: 12, metrics: 3 });
        expect(report.monitors).toEqual({ total: 5, healthy: 2, warning: 0, alerting: 1, warming: 1, disabled: 1 });
        expect(report.openAlerts).toHaveLength(1);
        const out = printed();
        expect(out[0]).toBe('Workspace:     Acme (acme)');
        expect(out[1]).toBe('Contracts:     2 on 2 chains · TVL $2.50M');
        expect(out[2]).toBe('Transactions:  1,234 in 24h · 12 failed');
        expect(out.at(-1)).toBe('Stagenets:     1 · avax-fork');
    });

    it('falls back to the rows\' TVL and a dash for transactions when the vitals route fails', async () => {
        mockApi({
            'GET /api/cli/whoami': () => ({ payload: { email: null, org: null, workspaces: [] } }),
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [{ id: 'a1', chainId: 1, chainIds: [1], address: '0xaaa', accountType: 'contract', name: null, valueUsd: 100 }] } }),
            'GET /api/mainnet/vitals': () => ({ status: 503, payload: { error: 'Data unavailable' } }),
            'GET /api/mainnet/invariants': () => ({ payload: { invariants: [] } }),
            'GET /api/mainnet/incidents': () => ({ payload: { days: 1, incidents: [] } }),
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [] } }),
            'GET /api/cli/stagenets': () => ({ status: 500, payload: { error: 'nope' } }),
        });
        const report = (await statusCommand([]))!;
        expect(report.tvlUsd).toBe(100);
        expect(report.tx24h).toBeNull();
        expect(printed()[2]).toBe('Transactions:  — in 24h · — failed');
        expect(printed().at(-1)).toBe('Stagenets:     —');
    });
});
