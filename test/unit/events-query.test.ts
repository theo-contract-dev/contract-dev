import { run } from '../../src/cli/index';
import { goneQuestion } from '../../src/cli/commands/gone';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 40 } });
const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';

describe('query events over a recent window (--last): the events tool', () => {
    useEnvAuth();

    it('reads, a sort and a limit go to query_events; the rows print', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_events': () =>
                ok({ window: '7d', evaluated: 3, dollars: ['usd', 'value'], rows: [{ time: '2026-10-15T14:40:47Z', contract: 'USDC/WETH', tx: 'http://localhost:3000/activity/tx/1/0x7828bffb9e', event: 'Swap', fields: { usd: '973914.84' }, value: '973914.84' }] }),
        });
        await run(['query', 'events', '--on', POOL, '--each', 'Swap', '--read', 't0=token0()', '--fixed', 't0', '--sort', 'usd(abs(amount0), t0)', '--limit', '10']);
        expect(calls[0].path).toBe('/api/mainnet/tools/query_events');
        expect(calls[0].body.input).toMatchObject({ events: ['Swap'], contract: POOL, reads: [{ name: 't0', call: 'token0()', fixed: true }], sort: 'usd(abs(amount0), t0)', limit: 10 });
        const out = printed().join('\n');
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
        await run(['query', 'events', '--on', POOL, '--each', 'Swap']);
        const out = printed().join('\n');
        expect(out).toMatch(/Who\s+Tx/);
        expect(out).toContain('0x654f…4be4 via Bundler · searcher');
        expect(out).toMatch(/Wintermute\s+0xa25bcdac…/);
        mockApi({ 'POST /api/mainnet/tools/query_events': () => ok({ groups: [{ sender: '0xa25bcdac00000000000000000000000000000002', senderName: 'Wintermute', value: '3', events: 3 }, { sender: '0x654fae4aa229d104cabead47e56703f58b174be4', value: '1', events: 1 }] }) });
        await run(['query', 'events', '--on', POOL, '--each', 'Swap', '--by', 'sender', '--count']);
        expect(printed().join('\n')).toMatch(/Sender\s+SenderName\s+Value\s+Events/);
    });

    it('--on tag: is the group, --last the window; --by and one measure group the events; two measures are refused', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_events': () => ok({ groups: [] }) });
        await run(['query', 'events', '--on', 'tag:Uniswap v3', '--each', 'Swap', '--by', 'contract', '--by', 'day', '--sum', 'usd(abs(amount0), t0)', '--last', '7d']);
        expect(calls[0].body.input).toEqual({ events: ['Swap'], group: 'Uniswap v3', by: ['contract', 'day'], measure: { fn: 'sum', expr: 'usd(abs(amount0), t0)' }, window: '7d' });
        await run(['query', 'events', '--each', 'Swap', '--last', '365d', '--chain', '1']);
        expect(calls[1].body.input).toEqual({ events: ['Swap'], chainId: 1, window: '365d' });
        await expect(run(['query', 'events', '--each', 'Swap', '--by', 'sender', '--sum', 'x', '--count'])).rejects.toThrow(/One measure per query/);
        await expect(run(['query', 'events', '--each', 'Swap', '--last', '14d'])).rejects.toThrow(/--last on events takes 1h, 24h \(1d\), 7d \(1w\), 30d, 90d, 365d \(got: 14d\)/);
        await expect(run(['query', 'events', '--each', 'Swap', '--by', 'sender', '--measure', 'n=count'])).rejects.toThrow(/one measure/);
    });

    it('a contract nobody watches by --address and --chain, never beside --on', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_events': () => ok({ rows: [] }) });
        await run(['query', 'events', '--address', POOL, '--chain', '1', '--each', 'Transfer', '--where', 'to == 0x1', '--last', '7d']);
        expect(calls[0].body.input).toEqual({ events: ['Transfer'], address: POOL, chainId: 1, where: 'to == 0x1', window: '7d' });
        await expect(run(['query', 'events', '--address', POOL, '--on', 'pools', '--each', 'Swap'])).rejects.toThrow(/--address .* or --on, not both/);
    });

    it('the history\'s words without --since, and --since beside --last, are refused with what to say', async () => {
        await expect(run(['query', 'events', '--each', 'Swap', '--who', 'account'])).rejects.toThrow(/--who goes with the whole history: add --since launch/);
        await expect(run(['query', 'events', '--each', 'Swap', '--last', '7d', '--since', 'launch'])).rejects.toThrow(/not both/);
    });
});

describe('query events over the whole history (--since): the history tool', () => {
    useEnvAuth();

    it('--since launch reads every firing; --by week, --who, --value and its reads are carried', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/event_history': () => ok({ complete: true, events: 4 }) });
        await run(['query', 'events', '--on', 'tag:Wildcat markets', '--each', 'WithdrawalQueued', '--since', 'launch', '--read', 'a=asset()', '--value', 'usd(normalizedAmount, a)', '--who', 'account', '--by', 'week', '--tz', 'Australia/Sydney']);
        expect(calls).toHaveLength(1);
        expect(calls[0].path).toBe('/api/mainnet/tools/event_history');
        expect(calls[0].body.input).toEqual({
            events: ['WithdrawalQueued'],
            scope: { kind: 'group', group: 'Wildcat markets' },
            window: 'all',
            by: 'week',
            timezone: 'Australia/Sydney',
            who: 'account',
            reads: [{ name: 'a', call: 'asset()' }],
            value: 'usd(normalizedAmount, a)',
        });
    });

    it('--since a date starts there; a contract is its scope; --by wallet keeps the default period (the wallets are always there)', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/event_history': () => ok({ complete: true }) });
        await run(['query', 'events', '--on', 'Treasury', '--chain', '1', '--each', 'Transfer', '--since', '2026-10-01', '--until', '2026-11-01', '--by', 'wallet']);
        expect(calls[0].body.input).toEqual({ events: ['Transfer'], scope: { kind: 'contract', contract: 'Treasury', chainId: 1 }, since: '2026-10-01', until: '2026-11-01' });
    });

    it('a read too long for one answer is asked again, up to twice, unless --once', async () => {
        let n = 0;
        const calls = mockApi({ 'POST /api/mainnet/tools/event_history': () => ok({ complete: ++n >= 3, resume: true, from: '2026-01-01' }) });
        await run(['query', 'events', '--on', 'pools', '--each', 'Swap', '--since', 'launch']);
        expect(calls).toHaveLength(3);
        const once = mockApi({ 'POST /api/mainnet/tools/event_history': () => ok({ complete: false, resume: true, from: '2026-01-01' }) });
        await run(['query', 'events', '--on', 'pools', '--each', 'Swap', '--since', 'launch', '--once']);
        expect(once).toHaveLength(1);
    });

    it('a recent window\'s words with --since are refused: the history answers in its own way', async () => {
        await expect(run(['query', 'events', '--each', 'Swap', '--since', 'launch', '--sort', 'amount'])).rejects.toThrow(/--sort goes with a recent window \(--last\)/);
        await expect(run(['query', 'events', '--each', 'Swap', '--since', 'launch', '--by', 'sender'])).rejects.toThrow(/--by takes day, week, month or wallet/);
        await expect(run(['query', 'events', '--each', 'Swap', '--since', 'yesterday'])).rejects.toThrow(/--since takes launch or a UTC date/);
    });
});

describe('the old question commands and flags (5.0.0)', () => {
    useEnvAuth();

    it('events and history are refused with the query events line that asks the same', async () => {
        await expect(run(['events', POOL, '--event', 'Swap', '--sort', 'usd(abs(amount0), t0)', '--window', '7d'])).rejects.toThrow(
            `contract-dev events is gone (5.0.0): every question is contract-dev query. Say: contract-dev query events --on ${POOL} --each Swap --sort "usd(abs(amount0), t0)" --last 7d`,
        );
        expect(goneQuestion('history', ['--group', 'Wildcat markets', '--event', 'WithdrawalQueued', '--who', 'account', '--by', 'week'])).toContain(
            'contract-dev query events --on "tag:Wildcat markets" --each WithdrawalQueued --who account --by week --since launch',
        );
        expect(goneQuestion('history', ['steth', '--event', 'Submitted', '--since', '2026-10-01'])).toContain('query events --on steth --each Submitted --since 2026-10-01');
        expect(goneQuestion('events', ['--group', 'pools', '--event', 'Swap', '--count', '--by', 'day'])).toContain('query events --on tag:pools --each Swap --count --by day');
        await expect(run(['history', 'steth', '--event', 'Submitted'])).rejects.toThrow(/query events --on steth --each Submitted --since launch/);
    });

    it('--group, --contract, --event and --window on query are refused with the word that replaces each', async () => {
        await expect(run(['query', 'transactions', '--group', 'pools'])).rejects.toThrow('--group is gone: say --on tag:<group>');
        await expect(run(['query', 'transfers', '--contract', 'Treasury'])).rejects.toThrow('--contract is gone: say --on <contract or wallet>');
        await expect(run(['query', 'contracts', '--group', 'Vaults'])).rejects.toThrow('--group is gone');
        await expect(run(['query', 'events', '--event', 'Swap'])).rejects.toThrow('--event is gone: say --each <Event>');
        await expect(run(['query', 'events', '--each', 'Swap', '--window', '7d'])).rejects.toThrow(/--window is gone: say --last/);
    });

    it('--on reads as table create reads it: a contract or wallet, tag:<group>, workspace; a table is asked by name', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_transactions': () => ok({ rows: [], matched: 0, returned: 0 }),
            'POST /api/mainnet/tools/query_transfers': () => ok({ rows: [], matched: 0, returned: 0 }),
            'POST /api/mainnet/tools/query_wallets': () => ok({ rows: [], matched: 0, returned: 0 }),
            'POST /api/mainnet/tools/query_contracts': () => ok({ rows: [], matched: 0, returned: 0 }),
        });
        await run(['query', 'transactions', '--on', 'tag:pools', '--last', '7d']);
        await run(['query', 'transfers', '--on', 'Treasury', '--out']);
        await run(['query', 'wallets', '--on', 'workspace', '--last', '1w']);
        await run(['query', 'contracts', '--on', 'tag:Vaults']);
        expect(calls.map((c) => c.body.input)).toEqual([{ group: 'pools', days: 7 }, { contract: 'Treasury', direction: 'out' }, { days: 7 }, { group: 'Vaults' }]);
        await expect(run(['query', 'contracts', '--on', 'Treasury'])).rejects.toThrow(/query contracts --on takes tag:<group> or workspace/);
        await expect(run(['query', 'transactions', '--on', 'table:Pools'])).rejects.toThrow('To ask a table, say contract-dev query table "Pools".');
        await expect(run(['query', 'alerts', '--on', 'tag:pools'])).rejects.toThrow(/query alerts takes no --on/);
    });
});
