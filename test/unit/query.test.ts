import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const ok = (result: unknown) => ({ status: 200, payload: { ok: true, result } });

describe('query', () => {
    useEnvAuth();

    it('builds the tool input from the clauses, names the dataset, and prints the rows with the totals', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_contracts': () =>
                ok({
                    dataset: 'contracts',
                    columns: [{ key: 'name', label: 'Name', kind: 'text' }, { key: 'headroom', label: 'headroom', kind: 'number' }],
                    rows: [{ address: '0xa', name: 'Kinto USDC', headroom: -1441621.7 }, { address: '0xb', name: 'Selini USDT', headroom: -4393.46 }],
                    matched: 8,
                    returned: 2,
                    more: 6,
                    totals: { headroom: -1735063.28 },
                }),
        });
        await run(['query', 'contracts', '--group', 'Wildcat markets', '--show', 'headroom={Held} - {Required}', '--where', 'headroom < 0', '--sort', 'headroom', '--asc', '--total', 'Supplied,headroom', '--limit', '2', '--chain', '1', '--kind', 'token']);
        expect(calls.map((c) => [c.path, c.body.input])).toEqual([
            [
                '/api/mainnet/tools/query_contracts',
                { where: 'headroom < 0', show: [{ name: 'headroom', expr: '{Held} - {Required}' }], sort: 'headroom', asc: true, total: ['Supplied', 'headroom'], limit: 2, group: 'Wildcat markets', chainId: 1, kind: 'token' },
            ],
        ]);
        const out = printed().join('\n');
        expect(out).toMatch(/8 rows matched · showing 2/);
        expect(out).toMatch(/Kinto USDC/);
        expect(out).toMatch(/Totals: headroom -1,735,063.28/);
    });

    it('a table or a metric is named by its positional words; measures fold with --by', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_table': () => ok({ dataset: 'table', columns: [], rows: [], matched: 0, returned: 0, more: 0, among: 'all' }),
            'POST /api/mainnet/tools/query_metric': () => ok({ dataset: 'metric', columns: [], rows: [{ day: '2026-10-17', value: 12.5, rows: 3 }], matched: 1, returned: 1, more: 0, grouped: { by: ['day'], measure: 'sum({value})' } }),
        });
        await run(['query', 'table', 'Withdrawal', 'rounds', '--among', 'all', '--where', '{Stage} == "Paying"']);
        await run(['query', 'metric', 'Deposits', '--days', '30', '--by', 'day', '--sum', '{value}']);
        expect(calls.map((c) => c.body.input)).toEqual([
            { where: '{Stage} == "Paying"', table: 'Withdrawal rounds', among: 'all' },
            { by: ['day'], measure: { fn: 'sum', expr: '{value}' }, metric: 'Deposits', days: 30 },
        ]);
        expect(printed().join('\n')).toMatch(/1 group by day · sum\(\{value\}\)/);
    });

    it('refuses what the server would: an unknown dataset, a measure with no --by, a --show with no name', async () => {
        mockApi({});
        await expect(run(['query', 'pools'])).rejects.toThrow(/Say which dataset/);
        await expect(run(['query', 'monitors', '--count'])).rejects.toThrow(/say --by/);
        await expect(run(['query', 'monitors', '--show', '{Held} - 1'])).rejects.toThrow(/name=expression/);
        await expect(run(['query', 'table'])).rejects.toThrow(/Name the table/);
    });
});

describe('unwatch several', () => {
    useEnvAuth();
    it('sends every name to the plural tool and prints what went with each', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/unwatch_contracts': () =>
                ok({ unwatched: [{ name: 'Curve 3pool', chainId: 1, address: '0xbebc', monitors: 2, trackedValues: 1 }], failed: [{ contract: 'Nope', error: 'No watched contract is called "Nope".' }] }),
        });
        await run(['unwatch', 'Curve 3pool', 'Nope', '--chain', '1']);
        expect(calls.map((c) => c.body.input)).toEqual([{ contracts: ['Curve 3pool', 'Nope'], chainId: 1 }]);
        const out = printed().join('\n');
        expect(out).toMatch(/Stopped watching Curve 3pool .*removed 2 monitors and 1 tracked value/);
        expect(out).toMatch(/Nope: No watched contract/);
    });
});

describe('query contracts --read', () => {
    useEnvAuth();
    it('a view with its token is a call read, an expression is an expr read, and they keep their order', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_contracts': () => ok({ dataset: 'contracts', columns: [], rows: [], matched: 0, returned: 0, more: 0 }) });
        await run(['query', 'contracts', '--group', 'Wildcat markets', '--read', 'cov=coverageLiquidity() in asset()', '--read', 'held=totalAssets() in asset() as amount', '--read', 'gap=held - cov', '--sort', 'gap', '--asc']);
        expect(calls[0].body.input).toEqual({
            sort: 'gap',
            asc: true,
            group: 'Wildcat markets',
            reads: [
                { name: 'cov', call: 'coverageLiquidity()', token: 'asset()' },
                { name: 'held', call: 'totalAssets()', token: 'asset()', show: 'amount' },
                { name: 'gap', expr: 'held - cov' },
            ],
        });
        await expect(run(['query', 'contracts', '--read', 'x=held - cov in asset()'])).rejects.toThrow(/go with a view/);
    });
});

describe('query transactions / transfers / wallets', () => {
    useEnvAuth();
    it('transactions: scope, window and filters go through; a unix time prints as a date', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_transactions': () =>
                ok({ dataset: 'transactions', columns: [{ key: 'time', label: 'Time', kind: 'number', unit: 'time' }, { key: 'contract', label: 'Contract', kind: 'text' }, { key: 'status', label: 'Status', kind: 'text' }], rows: [{ hash: '0xabc', time: 1_700_000_000, contract: 'Wintermute USDC', status: 'failed' }], matched: 1, returned: 1, more: 0, notes: ['History starts 2026-10-18 for the newest of these contracts; earlier activity is not counted (still being read).'] }),
        });
        await run(['query', 'transactions', '--group', 'Wildcat markets', '--days', '30', '--signer', '0x' + '1'.repeat(40), '--failed', '--routed', '--method', 'borrow', '--by', 'day', '--count']);
        const out = printed();
        expect(calls[0].body.input).toEqual({ by: ['day'], measure: { fn: 'count' }, group: 'Wildcat markets', signer: '0x' + '1'.repeat(40), failed: true, direct: false, method: 'borrow', days: 30 });
        expect(out.join('\n')).toContain('2023-11-14 22:13  Wintermute USDC  failed');
        expect(out.join('\n')).toContain('History starts 2026-10-18');
        await expect(run(['query', 'transactions', '--direct', '--routed'])).rejects.toThrow(/not both/);
    });
    it('transfers: direction, token and counterparty; wallets: the active and new line', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_transfers': () => ok({ dataset: 'transfers', columns: [], rows: [], matched: 0, returned: 0, more: 0 }),
            'POST /api/mainnet/tools/query_wallets': () => ok({ dataset: 'wallets', columns: [{ key: 'wallet', label: 'Wallet', kind: 'text' }], rows: [{ wallet: '0xabc' }], matched: 1, returned: 1, more: 0, active: { now: 26, before: 22 }, new: { now: 16, before: 15 } }),
        });
        await run(['query', 'transfers', '--contract', 'Wintermute USDC', '--out', '--token', 'USDC', '--counterparty', '0x' + '2'.repeat(40), '--by', 'counterparty', '--sum', '{USD}']);
        expect(calls[0].body.input).toEqual({ by: ['counterparty'], measure: { fn: 'sum', expr: '{USD}' }, contract: 'Wintermute USDC', direction: 'out', token: 'USDC', counterparty: '0x' + '2'.repeat(40) });
        await run(['query', 'transfers', '--before', '2026-10-01T00:00:00Z']);
        expect(calls[1].body.input).toEqual({ before: '2026-10-01T00:00:00Z' });
        await run(['query', 'wallets', '--days', '7']);
        const out = printed();
        expect(calls[2].body.input).toEqual({ days: 7 });
        expect(out).toContain('Active 26 (the window before: 22) · New 16 (before: 15)');
        await expect(run(['query', 'transfers', '--in', '--out'])).rejects.toThrow(/not both/);
    });
});
