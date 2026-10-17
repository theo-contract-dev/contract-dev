import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 40 } });
const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

describe('events --event: the query', () => {
    useEnvAuth();

    it('reads, a sort and a limit go to query_events; the rows print', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_events': () =>
                ok({ window: '7d', evaluated: 3, dollars: ['usd', 'value'], rows: [{ time: '2026-10-15T14:40:47Z', contract: 'USDC/WETH', tx: 'http://localhost:3000/activity/tx/1/0x7828bffb9e', event: 'Swap', fields: { usd: '973914.84' }, value: '973914.84' }] }),
        });
        await run(['events', POOL, '--event', 'Swap', '--read', 't0=token0()', '--fixed', 't0', '--sort', 'usd(abs(amount0), t0)', '--limit', '10']);
        expect(calls[0].path).toBe('/api/mainnet/tools/query_events');
        expect(calls[0].body.input).toMatchObject({ events: ['Swap'], contract: POOL, reads: [{ name: 't0', call: 'token0()', fixed: true }], sort: 'usd(abs(amount0), t0)', limit: 10 });
        const out = printed().join('\n');
        // one column per shown field, dollars where the formula prices them, the ranking value, a short tx
        expect(out).toMatch(/Time\s+Contract\s+usd\s+Value\s+Tx/);
        expect(out).toMatch(/2026-10-15 14:40\s+USDC\/WETH\s+\$973,915\s+\$973,915\s+0x7828bffb…/);
    });

    it('each listed event says who made it: the wallet, the signer it came via, a searcher; a sender group its name', async () => {
        mockApi({
            'POST /api/mainnet/tools/query_events': () =>
                ok({
                    rows: [
                        { time: '2026-10-16T12:22:11Z', contract: 'USDC/WETH', tx: 'http://x/tx/1/0x030ceb3dc0', event: 'Swap', wallet: { address: '0x654fae4aa229d104cabead47e56703f58b174be4', name: null }, signer: { address: '0x76f30e3f00000000000000000000000000000001', name: 'Bundler' }, searcher: true, fields: {} },
                        { time: '2026-10-16T14:02:23Z', contract: 'USDC/WETH', tx: 'http://x/tx/1/0xa25bcdac00', event: 'Swap', wallet: { address: '0xa25bcdac00000000000000000000000000000002', name: 'Wintermute' }, fields: {} },
                    ],
                }),
        });
        await run(['events', POOL, '--event', 'Swap']);
        const out = printed().join('\n');
        expect(out).toMatch(/Who\s+Tx/);
        expect(out).toContain('0x654f…4be4 via Bundler · searcher');
        expect(out).toMatch(/Wintermute\s+0xa25bcdac…/);
        mockApi({ 'POST /api/mainnet/tools/query_events': () => ok({ groups: [{ sender: '0xa25bcdac00000000000000000000000000000002', senderName: 'Wintermute', value: '3', events: 3 }, { sender: '0x654fae4aa229d104cabead47e56703f58b174be4', value: '1', events: 1 }] }) });
        await run(['events', POOL, '--event', 'Swap', '--by', 'sender', '--count']);
        expect(printed().join('\n')).toMatch(/Sender\s+SenderName\s+Value\s+Events/);
    });

    it('--by and one measure group the events; two measures are refused', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_events': () => ok({ groups: [] }) });
        await run(['events', '--group', 'Uniswap v3', '--event', 'Swap', '--by', 'contract', '--by', 'day', '--sum', 'usd(abs(amount0), t0)', '--window', '7d']);
        expect(calls[0].body.input).toEqual({ events: ['Swap'], group: 'Uniswap v3', by: ['contract', 'day'], measure: { fn: 'sum', expr: 'usd(abs(amount0), t0)' }, window: '7d' });
        await expect(run(['events', '--event', 'Swap', '--by', 'sender', '--sum', 'x', '--count'])).rejects.toThrow(/One measure per query/);
    });
});
