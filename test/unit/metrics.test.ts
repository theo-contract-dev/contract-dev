import { Interface } from 'ethers';
import { trackCommand, untrackCommand, metricsCommand, expandScientific } from '../../src/cli/commands/metrics';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const VAULT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const HOLDER = '0x3333333333333333333333333333333333333333';

const created = (body: any, id = 'm1') => ({
    status: 201,
    payload: { trackedMetric: { id, chainId: body.chainId, address: body.address, kind: body.kind, label: body.label ?? null, params: body.params ?? null, enabled: true }, created: true },
});

describe('track', () => {
    useEnvAuth();

    it('native-balance names the metric after the watched account, like the app', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({
                payload: { accounts: [{ id: 'c1', chainId: 1, chainIds: [1], address: VAULT, accountType: 'contract', name: 'Treasury' }] },
            }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand([VAULT, 'native-balance']);
        expect(calls[0].path).toBe('/api/mainnet/accounts?accountType=contract');
        expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ chainId: 1, address: VAULT, kind: 'nativeBalance', label: 'Treasury · Native balance' });
        expect(printed()[0]).toMatch(/Tracking Treasury · Native balance on chain 1 \(id: m1\)/);
    });

    it('takes a watched contract by name, for the contract and for --token', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({
                payload: { accounts: [
                    { id: 'c1', chainId: 1, chainIds: [1], address: VAULT, accountType: 'contract', name: 'Treasury' },
                    { id: 'c2', chainId: 1, chainIds: [1], address: TOKEN, accountType: 'contract', name: 'eETH' },
                ] },
            }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand(['Treasury', 'erc20-balance', '--token', 'eETH', '--label', 'Treasury eETH']);
        const post = calls.find((c) => c.method === 'POST')!;
        expect(post.body).toMatchObject({ chainId: 1, address: VAULT, kind: 'tokenBalance', params: { token: TOKEN }, label: 'Treasury eETH' });
        await expect(trackCommand(['0x12', 'native-balance'])).rejects.toThrow(/0x address or a watched contract's name/);
    });

    it('a repeat track answers with the existing metric', async () => {
        mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => ({ status: 200, payload: { trackedMetric: { id: 'm1', chainId: 1, address: c.body.address, kind: c.body.kind, label: c.body.label ?? null, params: null, enabled: true }, created: false } }),
        });
        await trackCommand([VAULT, 'native-balance', '--chain', '1', '--label', 'Bal']);
        expect(printed()[0]).toMatch(/^Already tracking Bal on chain 1 \(id: m1\)/);
    });

    it('export prints the history as csv, or the payload as json', async () => {
        const metric = { id: 'm1', chainId: 1, address: VAULT, kind: 'nativeBalance', label: 'Bal', params: null, enabled: true, lastValue: 2 };
        mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [metric] } }),
            'GET /api/mainnet/tracked-metrics/m1/series': () => ({
                payload: { trackedMetric: metric, points: [{ at: '2026-09-27T09:00:00Z', value: 1.5, blockNumber: 10, txHash: '0xabc' }, { at: '2026-09-27T10:00:00Z', value: 2 }], prev: null },
            }),
        });
        await metricsCommand(['export', 'Bal', '--range', '7d']);
        expect(printed()).toEqual(['at,value,block,tx', '2026-09-27T09:00:00Z,1.5,10,0xabc', '2026-09-27T10:00:00Z,2,,']);
        await expect(metricsCommand(['export', 'Bal', '--format', 'xml'])).rejects.toThrow(/--format/);
    });

    it('falls back to short hex when the subject is not watched; --label wins outright', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand([VAULT, 'native-balance', '--chain', '8453']);
        expect(calls[1].body.label).toBe('0x1111…1111 · Native balance');
        expect(calls[1].body.chainId).toBe(8453);

        await trackCommand([VAULT, 'native-balance', '--chain', '1', '--label', 'Treasury']);
        expect(calls[2].body).toEqual({ chainId: 1, address: VAULT, kind: 'nativeBalance', label: 'Treasury' }); // no accounts lookup

        // not watched and no --chain: asked for, never assumed (2026-10-23)
        await expect(trackCommand([VAULT, 'native-balance'])).rejects.toThrow(`Say which chain ${VAULT} is on`);
        expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    });

    it('erc20-balance needs --token', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await expect(trackCommand([VAULT, 'erc20-balance', '--chain', '1'])).rejects.toThrow(/--token/);
        await trackCommand([VAULT, 'erc20-balance', '--chain', '1', '--token', TOKEN]);
        expect(calls.at(-1)!.body.kind).toBe('tokenBalance');
        expect(calls.at(-1)!.body.params).toEqual({ token: TOKEN });
    });

    it('total-supply and balance-of are no longer kinds (2026-10-14): both are `function` on the token', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await expect(trackCommand([TOKEN, 'total-supply'])).rejects.toThrow(/Unknown kind "total-supply"/);
        await expect(trackCommand([TOKEN, 'balance-of', '--holder', HOLDER])).rejects.toThrow(/Unknown kind "balance-of"/);
        expect(calls).toHaveLength(0);
        // the same read, spelled as a function call with the holder as its argument
        await trackCommand([TOKEN, 'function', '--chain', '1', '--function', 'balanceOf(address) returns (uint256)', '--args', HOLDER]);
        expect(calls.at(-1)!.body.kind).toBe('functionResult');
        expect(calls.at(-1)!.body.params.calldata).toBe('0x70a08231' + HOLDER.slice(2).toLowerCase().padStart(64, '0'));
    });

    it('function encodes a human-readable signature + args with ethers', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand([VAULT, 'function', '--chain', '1', '--function', 'convertToAssets(uint256) returns (uint256)', '--args', '1e18', '--decimals', '18']);
        const expected = new Interface(['function convertToAssets(uint256)']).encodeFunctionData('convertToAssets', ['1000000000000000000']);
        expect(calls[1].body.params).toEqual({ calldata: expected, signature: 'convertToAssets(uint256) → uint256', decimals: 18 });
        expect(calls[1].body.label).toBe('0x1111…1111.convertToAssets');
    });

    it('function: a multi-value return must pick a word; signed outputs are flagged', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        const sig = 'getReserves() returns (uint112,uint112,uint32)';
        await expect(trackCommand([VAULT, 'function', '--chain', '1', '--function', sig])).rejects.toThrow(/--word/);
        await trackCommand([VAULT, 'function', '--chain', '1', '--function', sig, '--word', '1']);
        expect(calls.at(-1)!.body.params.wordIndex).toBe(1);
        expect(calls.at(-1)!.body.params.signed).toBeUndefined();
        expect(calls.at(-1)!.body.label).toBe('0x1111…1111.getReserves #1');

        await trackCommand([VAULT, 'function', '--chain', '1', '--function', 'latestAnswer() returns (int256)']);
        expect(calls.at(-1)!.body.params.signed).toBe(true);
    });

    it('function: raw --calldata is accepted as-is', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand([VAULT, 'function', '--chain', '1', '--calldata', '0x18160DDD', '--signed']);
        expect(calls[1].body.params).toEqual({ calldata: '0x18160ddd', signed: true });
        await expect(trackCommand([VAULT, 'function', '--chain', '1', '--calldata', '0x1234'])).rejects.toThrow(/--calldata/);
        await expect(trackCommand([VAULT, 'function', '--chain', '1', '--calldata', '0x18160ddd', '--function', 'x()'])).rejects.toThrow(/not both/);
    });

    it('argument count mismatches are caught before the request', async () => {
        mockApi({ 'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }) });
        await expect(trackCommand([VAULT, 'function', '--chain', '1', '--function', 'balanceOf(address)'])).rejects.toThrow(/takes 1 argument, got 0/);
    });

    it('tvl is no longer a kind: refused before anything is sent', async () => {
        const calls = mockApi({});
        await expect(trackCommand([VAULT, 'tvl'])).rejects.toThrow(/Unknown kind "tvl"/);
        expect(calls).toHaveLength(0);
    });

    it('trace kinds: a signature becomes its selector, windows are validated, callers filter', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tracked-metrics': (c) => created(c.body) });
        await trackCommand([VAULT, 'calls', '--chain', '1', '--method', 'transfer(address,uint256)', '--window', '15m', '--except', `${HOLDER},${TOKEN}`]);
        expect(calls[0].body.kind).toBe('callCount');
        expect(calls[0].body.params).toEqual({
            selector: '0xa9059cbb',
            signature: 'transfer(address,uint256)',
            windowSec: 900,
            callers: { mode: 'except', addresses: [HOLDER.toLowerCase(), TOKEN.toLowerCase()] },
        });
        expect(calls[0].body.label).toBeUndefined();

        await trackCommand([VAULT, 'revert-rate', '--chain', '1', '--method', '0xA9059CBB']);
        expect(calls[1].body.kind).toBe('revertRate');
        expect(calls[1].body.params).toEqual({ selector: '0xa9059cbb', windowSec: 3600 });

        await expect(trackCommand([VAULT, 'callers', '--chain', '1', '--window', '2h'])).rejects.toThrow(/--window must be one of/);
        await expect(trackCommand([VAULT, 'callers', '--chain', '1', '--only', HOLDER, '--except', TOKEN])).rejects.toThrow(/not both/);
        // gas-p95 was retired 2026-10-14: no longer a kind the CLI knows, so nothing is posted.
        await expect(trackCommand([VAULT, 'gas-p95'])).rejects.toThrow(/Unknown kind "gas-p95"/);
        expect(calls).toHaveLength(2);
    });

    it('rejects a bad address or kind before any request', async () => {
        mockApi({});
        await expect(trackCommand(['0xnope', 'native-balance'])).rejects.toThrow(/address must be a 0x address/);
        await expect(trackCommand([VAULT, 'balance'])).rejects.toThrow(/Unknown kind "balance"/);
    });

    it('expandScientific', () => {
        expect(expandScientific('1e18')).toBe('1000000000000000000');
        expect(expandScientific('2.5e3')).toBe('2500');
        expect(expandScientific('123')).toBe('123');
        expect(() => expandScientific('1.5e0')).toThrow(/not an integer/);
    });
});

describe('metrics / untrack', () => {
    useEnvAuth();

    const metrics = [
        { id: 'm1', chainId: 1, address: VAULT, kind: 'nativeBalance', label: 'Treasury · Native balance', params: null, enabled: true, lastValue: 12.5, liveValue: 13 },
        { id: 'm2', chainId: 8453, address: TOKEN, kind: 'totalSupply', label: 'Supply', params: { decimals: 6 }, enabled: false, lastValue: 1000000, liveValue: null },
        { id: 'm3', chainId: 1, address: TOKEN, kind: 'totalSupply', label: 'Supply', params: null, enabled: true, lastValue: null },
    ];

    it('list passes filters through and prints the live value over the stored one', async () => {
        const calls = mockApi({ 'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }) });
        await metricsCommand(['--address', VAULT, '--chain', '1']);
        expect(calls[0].path).toBe(`/api/mainnet/tracked-metrics?address=${VAULT}&chainId=1`);
        const out = printed();
        expect(out[0]).toMatch(/^m1 {2}nativeBalance/);
        expect(out[0]).toMatch(/ 13$/);
        expect(out[1]).toMatch(/1,000,000 {2}\(paused\)$/);
        expect(out[2]).toMatch(/—$/); // no reading yet = unknown, not zero
        expect(calls).toHaveLength(1); // a narrowed list is tracked values only
    });

    it('list without filters adds the event, table and group metrics, each with its kind', async () => {
        const listed = [
            { id: 'e1', name: 'Swap fees', kind: 'event', scope: 'Uniswap v3', status: 'ready', records: 1204 },
            { id: 'e2', name: 'Outstanding', kind: 'item', scope: 'Wildcat markets', status: 'ready' },
            { id: 'e3', name: 'Deposits', kind: 'event', scope: 'Vault', status: 'reading its history', records: 12 },
        ];
        const calls = mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics.slice(0, 1) } }),
            'POST /api/mainnet/tools/describe_metric': () => ({ payload: { ok: true, result: { metrics: listed }, ms: 1 } }),
        });
        const r = (await metricsCommand([])) as unknown[];
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/tracked-metrics', '/api/mainnet/tools/describe_metric']);
        const out = printed();
        expect(out[0]).toMatch(/^m1 {2}nativeBalance/);
        expect(out.slice(1, 3)).toEqual(['', 'Event, table and group metrics']);
        expect(out[3]).toMatch(/^e1 {2}event {10}Swap fees {28}Uniswap v3 {19}1,204 records$/);
        expect(out[4]).toMatch(/^e2 {2}table .*Wildcat markets +ready$/);
        expect(out[5]).toMatch(/reading its history$/);
        expect(r).toHaveLength(4);
    });

    it('show resolves by label and fetches the series', async () => {
        const calls = mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }),
            'GET /api/mainnet/tracked-metrics/m1/series': () => ({
                payload: { trackedMetric: metrics[0], points: [{ at: '2026-09-15T00:00:00Z', value: 12.5, blockNumber: 100 }], prev: null },
            }),
        });
        await metricsCommand(['show', 'treasury · native balance', '--range', '7d']);
        expect(calls[1].path).toBe('/api/mainnet/tracked-metrics/m1/series?range=7d');
        expect(printed().join('\n')).toMatch(/2026-09-15T00:00:00Z {2}.*12\.5 {2}block 100/);
        await expect(metricsCommand(['show', 'm1', '--range', '2d'])).rejects.toThrow(/--range/);
    });

    it('an ambiguous label demands an id', async () => {
        mockApi({ 'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }) });
        await expect(metricsCommand(['pause', 'Supply'])).rejects.toThrow(/2 metrics are labelled "Supply".*m2, m3/);
        await expect(metricsCommand(['pause', 'nope'])).rejects.toThrow(/No tracked metric matches/);
    });

    it('rename / pause / resume / decimals PATCH the right fields', async () => {
        const calls = mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }),
            'PATCH /api/mainnet/tracked-metrics/m2': (c) => ({ payload: { trackedMetric: { ...metrics[1], ...c.body, params: c.body.decimals !== undefined ? { decimals: c.body.decimals } : metrics[1].params } } }),
        });
        await metricsCommand(['rename', 'm2', 'USDC', 'supply']);
        await metricsCommand(['resume', 'm2']);
        await metricsCommand(['pause', 'm2']);
        await metricsCommand(['decimals', 'm2', '6']);
        await metricsCommand(['decimals', 'm2', 'clear']);
        expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
            { label: 'USDC supply' },
            { enabled: true },
            { enabled: false },
            { decimals: 6 },
            { decimals: null },
        ]);
        await expect(metricsCommand(['decimals', 'm2', '40'])).rejects.toThrow(/between 0 and 36/);
    });

    it('untrack takes several refs and DELETEs each', async () => {
        const calls = mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: metrics } }),
            'DELETE /api/mainnet/tracked-metrics/m1': () => ({ payload: { ok: true } }),
            'DELETE /api/mainnet/tracked-metrics/m3': () => ({ payload: { ok: true } }),
        });
        await untrackCommand(['m1', 'm3']);
        expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
            '/api/mainnet/tracked-metrics/m1',
            '/api/mainnet/tracked-metrics/m3',
        ]);
        expect(printed()[0]).toMatch(/monitors reading it are gone/);
    });
});

describe('metric pin', () => {
    useEnvAuth();
    const tracked = { id: 'm1', chainId: 1, address: VAULT, kind: 'nativeBalance', label: 'Bal', params: null, enabled: true, lastValue: 2 };
    const tool = () => ({ payload: { ok: true, result: { metrics: [{ id: 'cm1', name: 'Swap fees', kind: 'event' }] } } });

    it('pins a tracked value by its label through its own route', async () => {
        const calls = mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [tracked] } }),
            'PATCH /api/mainnet/tracked-metrics/m1': (c) => ({ payload: { trackedMetric: { ...tracked, pinnedAt: c.body.pinned ? '2026-10-26T12:00:00Z' : null } } }),
        });
        await metricsCommand(['pin', 'Bal']);
        const patch = calls.find((c) => c.method === 'PATCH')!;
        expect(patch.path).toBe('/api/mainnet/tracked-metrics/m1');
        expect(patch.body).toEqual({ pinned: true });
        expect(printed()[0]).toBe("Pinned Bal to the overview's header.");
        await metricsCommand(['unpin', 'm1']);
        expect(calls.filter((c) => c.method === 'PATCH')[1].body).toEqual({ pinned: false });
        expect(printed()[1]).toBe('Unpinned Bal.');
    });

    it('a name no tracked value has is looked up among the event, table and group metrics', async () => {
        const calls = mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [tracked] } }),
            'POST /api/mainnet/tools/describe_metric': tool,
            'PATCH /api/mainnet/custom-metrics/cm1': (c) => ({ payload: { metric: { id: 'cm1', name: 'Swap fees', pinnedAt: c.body.pinned ? '2026-10-26T12:00:00Z' : null } } }),
        });
        await metricsCommand(['pin', 'swap fees']);
        const patch = calls.find((c) => c.method === 'PATCH')!;
        expect(patch.path).toBe('/api/mainnet/custom-metrics/cm1');
        expect(patch.body).toEqual({ pinned: true });
        expect(printed()[0]).toBe("Pinned Swap fees to the overview's header.");
        await expect(metricsCommand(['pin', 'Nothing here'])).rejects.toThrow(/No metric matches "Nothing here"/);
    });

    it('a pin past the header\'s room repeats the server\'s reason', async () => {
        mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [tracked] } }),
            'PATCH /api/mainnet/tracked-metrics/m1': () => ({ status: 409, payload: { error: 'The overview holds 5 pinned metrics. Unpin one first.' } }),
        });
        await expect(metricsCommand(['pin', 'Bal'])).rejects.toThrow(/Unpin one first/);
    });

    it('lists the pinned ones', async () => {
        mockApi({
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [{ ...tracked, pinnedAt: '2026-10-26T12:00:00Z' }] } }),
            'POST /api/mainnet/tools/describe_metric': () => ({ payload: { ok: true, result: { metrics: [{ id: 'cm1', name: 'Swap fees', kind: 'event', status: 'ready', records: 12, pinned: true }] } } }),
        });
        await metricsCommand([]);
        expect(printed()[0]).toMatch(/Bal.*\(pinned\)$/);
        expect(printed().some((l) => /Swap fees.*12 records  \(pinned\)$/.test(l))).toBe(true);
    });
});
