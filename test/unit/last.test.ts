import { run } from '../../src/cli/index';
import { lastDays, lastWindow, parseLast, EVENT_WINDOWS } from '../../src/cli/last';
import { mockApi, useEnvAuth } from './_mockApi';

const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 40 } });

describe('--last <duration>: how far back, one word for every question and table (5.0.0)', () => {
    useEnvAuth();

    it('a duration is a number and h, d or w; anything else is refused with an example', () => {
        expect(parseLast('1h')).toBe(1);
        expect(parseLast('7d')).toBe(168);
        expect(parseLast('2w')).toBe(336);
        expect(parseLast('24h')).toBe(24);
        for (const bad of ['7', '7days', '1.5d', '0d', '-1d', 'd', '1m'])
            expect(() => parseLast(bad)).toThrow(/--last takes a number and h, d or w: --last 1h, --last 7d/);
    });

    it('events read the tool\'s own windows exactly; a length it does not have is refused with the ones it has, never rounded', () => {
        expect(lastWindow('1h', EVENT_WINDOWS, 'events')).toBe('1h');
        expect(lastWindow('1d', EVENT_WINDOWS, 'events')).toBe('24h');
        expect(lastWindow('1w', EVENT_WINDOWS, 'events')).toBe('7d');
        expect(lastWindow('365d', EVENT_WINDOWS, 'events')).toBe('365d');
        expect(() => lastWindow('2h', EVENT_WINDOWS, 'events')).toThrow('--last on events takes 1h, 24h (1d), 7d (1w), 30d, 90d, 365d (got: 2h).');
    });

    it('every other set of rows counts in whole days: 2w is 14, an hour is refused naming the rows', () => {
        expect(lastDays('2w', 'Transactions')).toBe(14);
        expect(lastDays('48h', 'Transactions')).toBe(2);
        expect(() => lastDays('1h', 'Transactions')).toThrow('Transactions count in whole days: --last 1d and up (got: 1h).');
    });

    it('query events --last 1h asks the events tool for its 1h window; with --since the two together are refused', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_events': () => ok({ window: '1h', evaluated: 0, rows: [] }) });
        await run(['query', 'events', '--on', 'Voter incentives', '--each', 'Bribed', '--last', '1h']);
        expect(calls[0].body.input).toMatchObject({ events: ['Bribed'], contract: 'Voter incentives', window: '1h' });
        await expect(run(['query', 'events', '--each', 'Bribed', '--last', '7d', '--since', 'launch'])).rejects.toThrow(/Give --last \(a recent window\) or --since/);
    });

    it('an hour on rows that count in days is refused before anything is asked', async () => {
        const calls = mockApi({});
        await expect(run(['query', 'transactions', '--on', 'FABLES', '--last', '1h'])).rejects.toThrow('Transactions count in whole days: --last 1d and up (got: 1h).');
        await expect(run(['query', 'table', 'Pools', '--last', '6h'])).rejects.toThrow("A table's rows count in whole days");
        expect(calls).toHaveLength(0);
    });

    it('--days is gone everywhere, with the word that replaces it', async () => {
        await expect(run(['query', 'transfers', '--days', '7'])).rejects.toThrow('--days is gone: say --last <n>d (contract-dev query help).');
        await expect(run(['query', 'events', '--each', 'Swap', '--days', '7'])).rejects.toThrow('--days is gone: say --last <n>d (contract-dev query help).');
        await expect(run(['table', 'create', 'X', '--on', 'Router', '--each', 'Swap', '--days', '30'])).rejects.toThrow('--days is gone: say --last <n>d (contract-dev table help).');
        await expect(run(['table', 'create', 'X', '--rows', 'transfers', '--days', '1'])).rejects.toThrow('--days is gone: say --last <n>d (contract-dev table help).');
    });

    it('table create --last 30d reaches back 30 days over the rows it keeps, and over kept rows asks the last 30 days', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/define_data': () => ok({ name: 'X' }),
            'POST /api/mainnet/tools/query_transfers': () => ok({ rows: [], matched: 0, returned: 0, saved: { id: 'q1' } }),
        });
        await run(['table', 'create', 'X', '--on', 'Router', '--each', 'Swap', '--last', '30d']);
        expect(calls[0].body.input).toMatchObject({ name: 'X', contract: 'Router', events: ['Swap'], history: 30, table: { title: 'X', days: 30 } });
        await run(['table', 'create', 'Top wallets', '--rows', 'transfers', '--on', 'tag:pools', '--last', '1w', '--by', 'wallet', '--sum', '{USD}']);
        expect(calls[1].body.input).toMatchObject({ group: 'pools', days: 7, save: { title: 'Top wallets' } });
    });
});
