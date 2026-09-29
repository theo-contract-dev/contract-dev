import { Interface } from 'ethers';
import { trackCommand, untrackCommand, metricsCommand, expandScientific, encodeBalanceOf } from '../../src/cli/commands/metrics';
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
        expect(calls[1].body).toEqual({ chainId: 1, address: VAULT, kind: 'nativeBalance', label: 'Treasury · Native balance' });
        expect(printed()[0]).toMatch(/Tracking Treasury · Native balance on chain 1 \(id: m1\)/);
    });

    it('a repeat track answers with the existing metric', async () => {
        mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => ({ status: 200, payload: { trackedMetric: { id: 'm1', chainId: 1, address: c.body.address, kind: c.body.kind, label: c.body.label ?? null, params: null, enabled: true }, created: false } }),
        });
        await trackCommand([VAULT, 'native-balance', '--label', 'Bal']);
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
        await trackCommand([VAULT, 'total-supply', '--chain', '8453']);
        expect(calls[1].body.label).toBe('0x1111…1111 · Total supply');
        expect(calls[1].body.chainId).toBe(8453);

        await trackCommand([VAULT, 'total-supply', '--label', 'Supply']);
        expect(calls[2].body).toEqual({ chainId: 1, address: VAULT, kind: 'totalSupply', label: 'Supply' }); // no accounts lookup
    });

    it('erc20-balance needs --token', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await expect(trackCommand([VAULT, 'erc20-balance'])).rejects.toThrow(/--token/);
        await trackCommand([VAULT, 'erc20-balance', '--token', TOKEN]);
        expect(calls.at(-1)!.body.kind).toBe('tokenBalance');
        expect(calls.at(-1)!.body.params).toEqual({ token: TOKEN });
    });

    it('balance-of submits as a functionResult carrying balanceOf(holder), like the app', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand([TOKEN, 'balance-of', '--holder', HOLDER]);
        expect(calls[1].body.kind).toBe('functionResult');
        expect(calls[1].body.params).toEqual({
            calldata: '0x70a08231' + HOLDER.slice(2).padStart(64, '0'),
            signature: 'balanceOf(address) → uint256',
        });
        expect(calls[1].body.label).toBe('0x2222…2222 · Balance of 0x3333…3333');
    });

    it('function encodes a human-readable signature + args with ethers', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand([VAULT, 'function', '--function', 'convertToAssets(uint256) returns (uint256)', '--args', '1e18', '--decimals', '18']);
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
        await expect(trackCommand([VAULT, 'function', '--function', sig])).rejects.toThrow(/--word/);
        await trackCommand([VAULT, 'function', '--function', sig, '--word', '1']);
        expect(calls.at(-1)!.body.params.wordIndex).toBe(1);
        expect(calls.at(-1)!.body.params.signed).toBeUndefined();
        expect(calls.at(-1)!.body.label).toBe('0x1111…1111.getReserves #1');

        await trackCommand([VAULT, 'function', '--function', 'latestAnswer() returns (int256)']);
        expect(calls.at(-1)!.body.params.signed).toBe(true);
    });

    it('function: raw --calldata is accepted as-is', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'POST /api/mainnet/tracked-metrics': (c) => created(c.body),
        });
        await trackCommand([VAULT, 'function', '--calldata', '0x18160DDD', '--signed']);
        expect(calls[1].body.params).toEqual({ calldata: '0x18160ddd', signed: true });
        await expect(trackCommand([VAULT, 'function', '--calldata', '0x1234'])).rejects.toThrow(/--calldata/);
        await expect(trackCommand([VAULT, 'function', '--calldata', '0x18160ddd', '--function', 'x()'])).rejects.toThrow(/not both/);
    });

    it('argument count mismatches are caught before the request', async () => {
        mockApi({ 'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }) });
        await expect(trackCommand([VAULT, 'function', '--function', 'balanceOf(address)'])).rejects.toThrow(/takes 1 argument, got 0/);
    });

    it('tvl sends no label or params — the server names the built-in', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tracked-metrics': (c) => ({ status: 200, payload: { trackedMetric: { id: 'm9', chainId: 1, address: VAULT, kind: 'tvlUsd', label: 'Treasury · TVL' }, created: false } }) });
        await trackCommand([VAULT, 'tvl']);
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toEqual({ chainId: 1, address: VAULT, kind: 'tvlUsd' });
        expect(printed()[0]).toMatch(/Already tracking Treasury · TVL/);
    });

    it('trace kinds: a signature becomes its selector, windows are validated, callers filter', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tracked-metrics': (c) => created(c.body) });
        await trackCommand([VAULT, 'calls', '--method', 'transfer(address,uint256)', '--window', '15m', '--except', `${HOLDER},${TOKEN}`]);
        expect(calls[0].body.kind).toBe('callCount');
        expect(calls[0].body.params).toEqual({
            selector: '0xa9059cbb',
            signature: 'transfer(address,uint256)',
            windowSec: 900,
            callers: { mode: 'except', addresses: [HOLDER.toLowerCase(), TOKEN.toLowerCase()] },
        });
        expect(calls[0].body.label).toBeUndefined();

        await trackCommand([VAULT, 'revert-rate', '--method', '0xA9059CBB']);
        expect(calls[1].body.kind).toBe('revertRate');
        expect(calls[1].body.params).toEqual({ selector: '0xa9059cbb', windowSec: 3600 });

        await expect(trackCommand([VAULT, 'gas-p95', '--window', '2h'])).rejects.toThrow(/--window must be one of/);
        await expect(trackCommand([VAULT, 'callers', '--only', HOLDER, '--except', TOKEN])).rejects.toThrow(/not both/);
    });

    it('rejects a bad address or kind before any request', async () => {
        mockApi({});
        await expect(trackCommand(['0xnope', 'native-balance'])).rejects.toThrow(/address must be a 0x address/);
        await expect(trackCommand([VAULT, 'balance'])).rejects.toThrow(/Unknown kind "balance"/);
    });

    it('expandScientific / encodeBalanceOf', () => {
        expect(expandScientific('1e18')).toBe('1000000000000000000');
        expect(expandScientific('2.5e3')).toBe('2500');
        expect(expandScientific('123')).toBe('123');
        expect(() => expandScientific('1.5e0')).toThrow(/not an integer/);
        expect(encodeBalanceOf(HOLDER)).toBe('0x70a08231' + HOLDER.slice(2).padStart(64, '0'));
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
