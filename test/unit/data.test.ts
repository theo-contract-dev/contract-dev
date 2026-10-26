import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const ok = (result: unknown) => ({ status: 200, payload: { ok: true, result } });

describe('data', () => {
    useEnvAuth();

    it('data list prints the event data, the tables and the built-in sets', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/list_data': () =>
                ok({
                    events: [{ name: 'DZap swaps', id: 'm1', kind: 'data', on: 'DZap Routers', events: ['DZapTokenSwapped'], rows: 4744, status: 'ready' }],
                    tables: [{ name: 'Withdrawal rounds', id: 't1', kind: 'table', rows: 12, done: 3, status: 'ready' }],
                    builtIn: [{ name: 'transactions', tool: 'query_transactions', what: 'The transactions that reached them' }],
                }),
        });
        await run(['data', 'list']);
        expect(calls[0].body).toEqual({ input: {} });
        const out = printed();
        expect(out[0]).toBe('Event data (1)');
        expect(out.join('\n')).toMatch(/DZap swaps +data +DZap Routers +DZapTokenSwapped +4,744 +ready/);
        expect(out.join('\n')).toMatch(/Tables \(1\)\n.*\n {2}Withdrawal rounds +12 +3 +ready/);
        expect(out.join('\n')).toMatch(/transactions +contract-dev query transactions/);
    });

    it('data define sends the definition to define_data, and refuses what makes a number', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/define_data': () => ok({ created: true, id: 'm1', url: 'http://x/metrics/custom/m1' }) });
        await run(['data', 'define', 'DZap swaps', '--group', 'DZap Routers', '--event', 'DZapTokenSwapped', '--field', 'vol=usd(swapInfo.fromAmount, swapInfo.fromToken)', '--keep', 'integrator', '--description', 'Every swap']);
        expect(calls[0].body.input).toEqual({ name: 'DZap swaps', group: 'DZap Routers', description: 'Every swap', events: ['DZapTokenSwapped'], fields: [{ name: 'vol', expr: 'usd(swapInfo.fromAmount, swapInfo.fromToken)' }], keep: ['integrator'] });
        await expect(run(['data', 'define', 'X', '--event', 'Swap', '--value', 'amount'])).rejects.toThrow(/--value makes a number/);
        await expect(run(['data', 'define', 'X', '--group', 'g'])).rejects.toThrow(/--event names what each row is/);
    });

    it('data query is query data', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_data': () => ok({ dataset: 'metric', columns: [], rows: [], matched: 0, returned: 0, more: 0 }) });
        await run(['data', 'query', 'DZap swaps', '--days', '7']);
        expect(calls[0].body.input).toEqual({ data: 'DZap swaps', days: 7 });
    });
});
