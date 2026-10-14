import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

// The table and history commands send the tools their input and print the answer; each test pins the input and a few lines.
const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

describe('table', () => {
    useEnvAuth();

    test('create sends the events, the columns and the hidden flag as the tool takes them', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/create_table': () =>
                ok({ created: true, table: { id: 't1', name: 'Withdrawal rounds', listed: false, scope: 'Wildcat markets (87 contracts)', opens: 'WithdrawalBatchCreated', closes: 'WithdrawalBatchClosed' }, sync: { status: 'ready', steps: 3, rows: { open: 16, closed: 1646 } }, note: 'Ready: 16 rows open, 1646 closed.' }),
        });
        await run(['table', 'create', 'Withdrawal rounds', '--group', 'Wildcat markets', '--opens', 'WithdrawalBatchCreated', '--closes', 'WithdrawalBatchClosed', '--count', 'WithdrawalQueued:Queued', '--sum', 'WithdrawalQueued.normalizedAmount', '--hidden']);
        expect(calls[0].body).toEqual({
            input: {
                name: 'Withdrawal rounds',
                opens: 'WithdrawalBatchCreated',
                group: 'Wildcat markets',
                closes: 'WithdrawalBatchClosed',
                columns: [
                    { label: 'Queued', event: 'WithdrawalQueued', fold: 'count' },
                    { label: 'normalizedAmount', event: 'WithdrawalQueued', field: 'normalizedAmount', fold: 'sum' },
                ],
                listed: false,
            },
        });
        const out = printed();
        expect(out).toContain('Created: yes');
        expect(out).toContain('Note: Ready: 16 rows open, 1646 closed.');
    });

    test('show passes its options through, and a bare name reads as show', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/describe_table': () => ok({ table: 'Withdrawal rounds', rows: { open: 16, closed: 1646 }, timeline: { by: 'week', columns: ['period', 'opened', 'closed'], rows: [['2026-10-05', 4, 5]] } }) });
        await run(['table', 'show', 'Withdrawal rounds', '--by', 'week', '--among', 'closed', '--limit', '3']);
        expect(calls[0].body).toEqual({ input: { table: 'Withdrawal rounds', by: 'week', among: 'done', limit: 3 } });
        const out = printed();
        expect(out).toContain('Table: Withdrawal rounds');
        expect(out.some((l) => /^ {2}Period {2,}Opened {2,}Closed$/.test(l))).toBe(true);
        expect(out.some((l) => /^ {2}2026-10-05 {2,}4 {2,}5$/.test(l))).toBe(true);
        const again = mockApi({ 'POST /api/mainnet/tools/describe_table': () => ok({ table: 'Withdrawal rounds' }) });
        await run(['table', 'Withdrawal rounds']);
        expect(again[0].body).toEqual({ input: { table: 'Withdrawal rounds' } });
    });

    test('create sends status columns, formulas and the finished rule as the tool takes them', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_table': () => ok({ created: true, table: { id: 't2', name: 'Withdrawal rounds' } }) });
        await run([
            'table', 'create', 'Withdrawal rounds', '--group', 'Wildcat markets', '--opens', 'WithdrawalBatchCreated',
            '--formula', 'Outstanding={Requested} - {Paid}',
            '--status', 'Stage: Expired=latest(WithdrawalBatchExpired); Paying=seen(WithdrawalBatchPayment); Queued',
            '--status', 'Health: Overdue={Stage} == "Expired" and timeIn({Stage}) > 24h; Healthy',
            '--finished', '{Stage} == "Expired" and {Outstanding} == 0',
        ]);
        expect(calls[0].body).toEqual({
            input: {
                name: 'Withdrawal rounds',
                opens: 'WithdrawalBatchCreated',
                group: 'Wildcat markets',
                finished: '{Stage} == "Expired" and {Outstanding} == 0',
                statuses: [
                    { label: 'Stage', options: [{ name: 'Expired', when: 'latest(WithdrawalBatchExpired)' }, { name: 'Paying', when: 'seen(WithdrawalBatchPayment)' }, { name: 'Queued' }] },
                    { label: 'Health', options: [{ name: 'Overdue', when: '{Stage} == "Expired" and timeIn({Stage}) > 24h' }, { name: 'Healthy' }] },
                ],
                formulas: [{ label: 'Outstanding', expr: '{Requested} - {Paid}' }],
            },
        });
        await expect(run(['table', 'create', 'X', '--opens', 'A', '--status', 'nonsense'])).rejects.toThrow(/--status takes/);
        await expect(run(['table', 'create', 'X', '--opens', 'A', '--formula', 'nonsense'])).rejects.toThrow(/--formula takes/);
    });

    test('update sets when rows finish, or that they never do', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/update_table': () => ok({ table: { id: 't1', name: 'Withdrawal rounds', listed: true } }) });
        await run(['table', 'update', 'Withdrawal rounds', '--finished', '{Stage} == "Closed"']);
        expect(calls[0].body).toEqual({ input: { table: 'Withdrawal rounds', finished: '{Stage} == "Closed"' } });
        await run(['table', 'update', 'Withdrawal rounds', '--never-finishes']);
        expect(calls[1].body).toEqual({ input: { table: 'Withdrawal rounds', finished: '' } });
        await run(['table', 'update', 'Withdrawal rounds', '--status', 'Health: Overdue={Stage} == "Expired" and timeIn({Stage}) > 24h; Fine', '--formula', 'Outstanding={Requested} - {Paid}']);
        expect(calls[2].body).toEqual({
            input: {
                table: 'Withdrawal rounds',
                statuses: [{ label: 'Health', options: [{ name: 'Overdue', when: '{Stage} == "Expired" and timeIn({Stage}) > 24h' }, { name: 'Fine' }] }],
                formulas: [{ label: 'Outstanding', expr: '{Requested} - {Paid}' }],
            },
        });
    });

    test('update puts a hidden table on the page', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/update_table': () => ok({ table: { id: 't1', name: 'Withdrawal rounds', listed: true } }) });
        await run(['table', 'update', 'Withdrawal rounds', '--show']);
        expect(calls[0].body).toEqual({ input: { table: 'Withdrawal rounds', listed: true } });
        await expect(run(['table', 'update', 'Withdrawal rounds'])).rejects.toThrow(/Nothing to change/);
    });
});

describe('history', () => {
    useEnvAuth();

    test('flags map to the tool input, and a read that can go further is asked again', async () => {
        let n = 0;
        const calls = mockApi({
            'POST /api/mainnet/tools/event_history': () => {
                n++;
                return ok(n === 1 ? { complete: false, resume: true, from: '2026-02-11T00:00:00Z', total: 1708 } : { complete: true, from: '2023-12-19T23:13:59Z', total: 3512, byEvent: [{ event: 'WithdrawalQueued', fired: 3512, sized: 3512, usd: 851000000 }] });
            },
        });
        await run(['history', '--group', 'Wildcat markets', '--event', 'WithdrawalQueued', '--by', 'week', '--tz', 'Australia/Sydney']);
        expect(calls).toHaveLength(2);
        expect(calls[0].body).toEqual({ input: { events: ['WithdrawalQueued'], scope: { kind: 'group', group: 'Wildcat markets' }, by: 'week', timezone: 'Australia/Sydney' } });
        const out = printed();
        expect(out).toContain('Total: 3,512');
        expect(out.some((l) => /^ {2}Event {2,}Fired {2,}Sized {2,}Usd$/.test(l))).toBe(true);
    });

    test('--once stops after one call, and a contract is the scope', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/event_history': () => ok({ complete: false, resume: true, total: 10 }) });
        await run(['history', '0x5ab22e9c360807f16dfa34ad5c589055d2871a5b', '--event', 'WithdrawalQueued,WithdrawalExecuted', '--once']);
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toEqual({ input: { events: ['WithdrawalQueued', 'WithdrawalExecuted'], scope: { kind: 'contract', contract: '0x5ab22e9c360807f16dfa34ad5c589055d2871a5b' } } });
        await expect(run(['history', '--group', 'x'])).rejects.toThrow(/Name the events/);
    });
});

describe('--sum decimals', () => {
    it('takes a trailing "decimals <n>" as the column scale, label kept', () => {
        const { columnsFrom } = require('../../src/cli/commands/table');
        const { parseFlags } = require('../../src/cli/commands/_args');
        const cols = columnsFrom(parseFlags(['--sum', 'WithdrawalRequested.amountOfStETH:Requested decimals 18', '--sum', 'WithdrawalQueued.normalizedAmount']));
        expect(cols).toEqual([
            { label: 'Requested', event: 'WithdrawalRequested', field: 'amountOfStETH', fold: 'sum', decimals: 18 },
            { label: 'normalizedAmount', event: 'WithdrawalQueued', field: 'normalizedAmount', fold: 'sum' },
        ]);
    });
});

describe('stated tokens', () => {
    useEnvAuth();
    const { columnsFrom, formulasFrom } = require('../../src/cli/commands/table');
    const { parseFlags } = require('../../src/cli/commands/_args');

    it('reads "token <token> [show usd]" at the end of a --sum, and nothing when it is left out', () => {
        const cols = columnsFrom(parseFlags(['--sum', 'WithdrawalQueued.normalizedAmount:Requested token asset() show usd', '--sum', 'WithdrawalRequested.amountOfStETH:Requested stETH token 0xae7ab96520de3a18e5e111b5eaab095312d7fe84', '--sum', 'Swap.amount0:Token amount']));
        expect(cols).toEqual([
            { label: 'Requested', event: 'WithdrawalQueued', field: 'normalizedAmount', fold: 'sum', token: 'asset()', show: 'usd' },
            { label: 'Requested stETH', event: 'WithdrawalRequested', field: 'amountOfStETH', fold: 'sum', token: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84' },
            // a label that happens to say Token is a label: the keywords are lower case
            { label: 'Token amount', event: 'Swap', field: 'amount0', fold: 'sum' },
        ]);
    });

    it('refuses a token that is not an address, self or a view, a token beside decimals, and show without a token', () => {
        expect(() => columnsFrom(parseFlags(['--sum', 'Swap.amount0:In token USDC']))).toThrow(/0x address, self/);
        expect(() => columnsFrom(parseFlags(['--sum', 'Swap.amount0:In token asset() decimals 6']))).toThrow(/brings its own decimals/);
        expect(() => columnsFrom(parseFlags(['--sum', 'Swap.amount0:In show usd']))).toThrow(/show needs a token/);
    });

    it('reads "; token …; show …" after a formula', () => {
        expect(formulasFrom(parseFlags(['--formula', 'Outstanding=max({Requested} - {Paid}, 0); token asset(); show usd', '--formula', 'Share={Paid} / {Requested}; unit pct']))).toEqual([
            { label: 'Outstanding', expr: 'max({Requested} - {Paid}, 0)', token: 'asset()', show: 'usd' },
            { label: 'Share', expr: '{Paid} / {Requested}', unit: 'pct' },
        ]);
        expect(() => formulasFrom(parseFlags(['--formula', 'X={A}; colour red']))).toThrow(/after the expression/);
    });

    it('update --token sets a column\'s token, and an empty one clears it', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/update_table': () => ok({ table: { id: 't1', name: 'Withdrawal rounds', columns: [] } }) });
        await run(['table', 'update', 'Withdrawal rounds', '--token', 'Requested=asset() show usd', '--token', 'Paid=']);
        expect(calls[0].body).toEqual({ input: { table: 'Withdrawal rounds', tokens: [{ column: 'Requested', token: 'asset()', show: 'usd' }, { column: 'Paid', token: '' }] } });
    });
});

