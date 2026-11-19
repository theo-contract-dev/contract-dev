import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';
import { parseFlags } from '../../src/cli/commands/_args';
import { columnsFrom, readColumnsFrom } from '../../src/cli/commands/table';

// The table and history commands send the tools their input and print the answer; each test pins the input and a few lines.
const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

describe('table', () => {
    useEnvAuth();

    test('create sends the events, the columns and the hidden flag as the tool takes them', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/create_table': () =>
                ok({ created: true, table: { id: 't1', name: 'Withdrawal rounds', listed: false, scope: 'Wildcat markets (87 contracts)', opens: 'WithdrawalBatchCreated', closes: 'WithdrawalBatchClosed' }, sync: { status: 'ready', steps: 3, rows: { open: 16, closed: 1646 } }, note: 'Ready: 16 rows open, 1646 closed.' }),
        });
        await run(['table', 'create', 'Withdrawal rounds', '--on', 'tag:Wildcat markets', '--each', 'WithdrawalBatchCreated', '--closes', 'WithdrawalBatchClosed', '--count', 'WithdrawalQueued:Queued', '--sum', 'WithdrawalQueued.normalizedAmount', '--hidden']);
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
        // a name no table over kept rows has is a table of things'
        const noLive = { 'GET /api/mainnet/queries': () => ({ payload: { queries: [] } }) };
        const calls = mockApi({ ...noLive, 'POST /api/mainnet/tools/describe_table': () => ok({ table: 'Withdrawal rounds', rows: { open: 16, closed: 1646 }, timeline: { by: 'week', columns: ['period', 'opened', 'closed'], rows: [['2026-10-05', 4, 5]] } }) });
        await run(['table', 'show', 'Withdrawal rounds', '--by', 'week', '--among', 'closed', '--limit', '3']);
        expect(calls[0].path).toBe('/api/mainnet/queries?kept=1');
        expect(calls[1].body).toEqual({ input: { table: 'Withdrawal rounds', by: 'week', among: 'done', limit: 3 } });
        const out = printed();
        expect(out).toContain('Table: Withdrawal rounds');
        expect(out.some((l) => /^ {2}Period {2,}Opened {2,}Closed$/.test(l))).toBe(true);
        expect(out.some((l) => /^ {2}2026-10-05 {2,}4 {2,}5$/.test(l))).toBe(true);
        const again = mockApi({ ...noLive, 'POST /api/mainnet/tools/describe_table': () => ok({ table: 'Withdrawal rounds' }) });
        await run(['table', 'Withdrawal rounds']);
        expect(again[1].body).toEqual({ input: { table: 'Withdrawal rounds' } });
    });

    test('create sends status columns, formulas and the finished rule as the tool takes them', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_table': () => ok({ created: true, table: { id: 't2', name: 'Withdrawal rounds' } }) });
        await run([
            'table', 'create', 'Withdrawal rounds', '--on', 'tag:Wildcat markets', '--each', 'WithdrawalBatchCreated',
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
        await expect(run(['table', 'create', 'X', '--each', 'A', '--id', 'a', '--status', 'nonsense'])).rejects.toThrow(/--status takes/);
        await expect(run(['table', 'create', 'X', '--each', 'A', '--formula', 'nonsense'])).rejects.toThrow(/--formula takes/);
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

describe('the row id field, stated', () => {
    it('--count and --sum take a trailing "on <field>": the event field that holds the row id', () => {
        const flags = parseFlags(['--count', 'WithdrawalQueued:Queued on expiry', '--sum', 'WithdrawalQueued.normalizedAmount:Requested on expiry token asset() show usd', '--count', 'WithdrawalExecuted']);
        expect(columnsFrom(flags)).toEqual([
            { label: 'Queued', event: 'WithdrawalQueued', fold: 'count', on: 'expiry' },
            { label: 'WithdrawalExecuted count', event: 'WithdrawalExecuted', fold: 'count' },
            { label: 'Requested', event: 'WithdrawalQueued', field: 'normalizedAmount', fold: 'sum', on: 'expiry', token: 'asset()', show: 'usd' },
        ]);
    });
});

describe('query events --since (the history, 5.0.0)', () => {
    useEnvAuth();

    test('flags map to the tool input, and a read that can go further is asked again', async () => {
        let n = 0;
        const calls = mockApi({
            'POST /api/mainnet/tools/event_history': () => {
                n++;
                return ok(n === 1 ? { complete: false, resume: true, from: '2026-02-11T00:00:00Z', total: 1708 } : { complete: true, from: '2023-12-19T23:13:59Z', total: 3512, byEvent: [{ event: 'WithdrawalQueued', fired: 3512, value: 851000000 }] });
            },
        });
        await run(['query', 'events', '--on', 'tag:Wildcat markets', '--each', 'WithdrawalQueued', '--since', 'launch', '--by', 'week', '--tz', 'Australia/Sydney', '--who', 'account', '--read', 'a=asset()', '--value', 'usd(normalizedAmount, a)']);
        expect(calls).toHaveLength(2);
        expect(calls[0].body).toEqual({
            input: { events: ['WithdrawalQueued'], scope: { kind: 'group', group: 'Wildcat markets' }, window: 'all', by: 'week', timezone: 'Australia/Sydney', who: 'account', reads: [{ name: 'a', call: 'asset()' }], value: 'usd(normalizedAmount, a)' },
        });
        const out = printed();
        expect(out).toContain('Total: 3,512');
        expect(out.some((l) => /^ {2}Event {2,}Fired {2,}Value$/.test(l))).toBe(true);
    });

    test('--once stops after one call, and a contract is the scope', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/event_history': () => ok({ complete: false, resume: true, total: 10 }) });
        await run(['query', 'events', '--on', '0x5ab22e9c360807f16dfa34ad5c589055d2871a5b', '--each', 'WithdrawalQueued,WithdrawalExecuted', '--since', 'launch', '--once']);
        expect(calls).toHaveLength(1);
        expect(calls[0].body).toEqual({ input: { events: ['WithdrawalQueued', 'WithdrawalExecuted'], scope: { kind: 'contract', contract: '0x5ab22e9c360807f16dfa34ad5c589055d2871a5b' }, window: 'all' } });
        await expect(run(['query', 'events', '--on', 'tag:x', '--since', 'launch'])).rejects.toThrow(/Name the events/);
        await expect(run(['query', 'events', '--on', 'tag:x', '--each', 'Deposit', '--since', 'launch', '--read', 'asset()'])).rejects.toThrow(/name=/);
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

    it('refuses a token that is not an address, self, a view or a field of the event, a token beside decimals, and show without a token', () => {
        expect(() => columnsFrom(parseFlags(['--sum', 'Swap.amount0:In token 12abc']))).toThrow(/0x address, self.*one of the event's own fields/);
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


describe('descriptions', () => {
    useEnvAuth();
    const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });
    const noItems = { 'POST /api/mainnet/tools/list_tables': () => ok({ rows: [] }) };
    const live = { id: 'q1', title: 'Integrators', rows: 6, url: 'http://localhost:3000/tables/q1' };

    it('create sends a table of things its description', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_table': () => ok({ created: true, table: { id: 't1', name: 'Withdrawal rounds' } }) });
        await run(['table', 'create', 'Withdrawal rounds', '--on', 'tag:Wildcat markets', '--each', 'WithdrawalBatchCreated', '--id', 'expiry', '--description', ' Every withdrawal round, open until paid ']);
        expect(calls[0].body).toEqual({ input: { name: 'Withdrawal rounds', opens: 'WithdrawalBatchCreated', group: 'Wildcat markets', id: 'expiry', description: 'Every withdrawal round, open until paid' } });
    });

    it('a table built on another keeps the description in the save, out of the question', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_data': () => ok({ matched: 1, returned: 1, rows: [{ app: '0x1', volume: 1 }], columns: [{ key: 'app', label: 'app' }, { key: 'volume', label: 'volume' }], saved: { id: 'q1', url: 'u', kept: true, title: 'Integrators' } }) });
        await run(['table', 'create', 'Integrators', '--on', 'table:DZap activity', '--description', 'Volume per integrator', '--by', 'app', '--last', '90d']);
        const input = (calls[0].body as { input: Record<string, unknown> }).input;
        // one kind of kept answer since 2026-10-28: a table; `as` and `keep` went with the snapshots
        expect(input.save).toEqual({ title: 'Integrators', description: 'Volume per integrator' });
        expect(input.description).toBeUndefined();
        expect(input.data).toBe('DZap activity');
    });

    it('update describes a table over kept rows through its own route, and "" removes it', async () => {
        const calls = mockApi({
            ...noItems,
            'GET /api/mainnet/queries': () => ({ payload: { queries: [live] } }),
            'PATCH /api/mainnet/queries/q1': () => ({ payload: { query: { ...live, description: 'Volume per integrator' } } }),
        });
        await run(['table', 'update', 'Integrators', '--description', 'Volume per integrator']);
        const patch = calls.find((c) => c.method === 'PATCH');
        expect(patch?.path).toBe('/api/mainnet/queries/q1');
        expect(patch?.body).toEqual({ description: 'Volume per integrator' });
        expect(printed().some((l) => l.includes('Updated table "Integrators" (q1): Volume per integrator'))).toBe(true);
        const again = mockApi({ ...noItems, 'GET /api/mainnet/queries': () => ({ payload: { queries: [live] } }), 'PATCH /api/mainnet/queries/q1': () => ({ payload: { query: { ...live, description: null } } }) });
        await run(['table', 'update', 'Integrators', '--description', '']);
        expect(again.find((c) => c.method === 'PATCH')?.body).toEqual({ description: '' });
    });

    it('update describes a table of things through update_table', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/list_tables': () => ok({ rows: [{ id: 't1', name: 'Withdrawal rounds' }] }),
            'POST /api/mainnet/tools/update_table': () => ok({ table: { id: 't1', name: 'Withdrawal rounds', description: 'Rounds' } }),
        });
        await run(['table', 'update', 'Withdrawal rounds', '--description', 'Rounds']);
        expect(calls.find((c) => c.path.endsWith('/update_table'))?.body).toEqual({ input: { table: 'Withdrawal rounds', description: 'Rounds' } });
    });

    it('a bare --description is refused', async () => {
        mockApi({});
        await expect(run(['table', 'update', 'Withdrawal rounds', '--description'])).rejects.toThrow(/--description takes a sentence/);
    });
});

describe('table create: --column on a state table is a read on each open row (2026-11-08)', () => {
    test('Label=view(args): id() is the row id, {Label} a cell, then .output and ; on / token / decimals', () => {
        expect(readColumnsFrom(parseFlags(['--column', 'Owed=accountDebt(id())']))).toEqual([{ label: 'Owed', read: 'accountDebt', args: [':id'] }]);
        expect(readColumnsFrom(parseFlags(['--column', 'Objections=getMotion(id()).objectionsAmount; decimals 18']))).toEqual([{ label: 'Objections', read: 'getMotion', args: [':id'], output: 'objectionsAmount', decimals: 18 }]);
        expect(readColumnsFrom(parseFlags(['--column', 'Owner stETH=balanceOf({Owner}); on 0xAE7ab96520DE3A18E5e111B5EaAb095312D7fE84; token self']))).toEqual([{ label: 'Owner stETH', read: 'balanceOf', args: ['{Owner}'], target: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', token: 'self' }]);
        expect(readColumnsFrom(parseFlags(['--column', 'Pos=getPosition({Trader}, id(), 0)']))).toEqual([{ label: 'Pos', read: 'getPosition', args: ['{Trader}', ':id', '0'] }]);
        expect(() => readColumnsFrom(parseFlags(['--column', 'Amount=amountOfStETH']))).toThrow(/a view read on each open row/);
        expect(() => readColumnsFrom(parseFlags(['--column', 'X=f(id()); on steth']))).toThrow(/0x address/);
    });
});

describe('one grammar (5.0.0): the older flags are refused with the word that replaced them', () => {
    useEnvAuth();

    it('table create refuses --opens, --from, --group and --contract, each with its pointer, before anything is sent', async () => {
        const calls = mockApi({});
        await expect(run(['table', 'create', 'X', '--opens', 'LoanOpened'])).rejects.toThrow(/--opens is gone: say --each <Event> --id <field>/);
        await expect(run(['table', 'create', 'X', '--from', 'transfers'])).rejects.toThrow(/--from is gone: say --on table:"<name>" for another table's rows, or --each <Event>/);
        await expect(run(['table', 'create', 'X', '--from=events', '--each', 'Swap'])).rejects.toThrow(/--from is gone/);
        await expect(run(['table', 'create', 'X', '--group', 'Pools', '--each', 'Swap'])).rejects.toThrow(/--group is gone: say --on tag:<group>/);
        await expect(run(['table', 'create', 'X', '--contract', 'Router', '--each', 'Swap'])).rejects.toThrow(/--contract is gone: say --on <contract>/);
        expect(calls).toHaveLength(0);
    });

    it('table list and table show take --on, and refuse --group and --contract', async () => {
        const noKept = { 'GET /api/mainnet/queries': () => ({ payload: { queries: [] } }) };
        const calls = mockApi({ ...noKept, 'POST /api/mainnet/tools/list_tables': () => ok({ rows: [] }), 'POST /api/mainnet/tools/describe_table': () => ok({ table: 'Loans' }) });
        await run(['table', 'list', '--on', 'tag:Wildcat markets']);
        expect(calls[0].body).toEqual({ input: { group: 'Wildcat markets' } });
        await run(['table', 'list', '--on', '0x5ab22e9c360807f16dfa34ad5c589055d2871a5b', '--chain', '1']);
        expect(calls[1].body).toEqual({ input: { contract: '0x5ab22e9c360807f16dfa34ad5c589055d2871a5b', chainId: 1 } });
        await run(['table', 'show', 'Loans', '--on', 'Market A', '--by', 'week']);
        expect(calls.find((c) => c.path.endsWith('/describe_table'))?.body).toEqual({ input: { table: 'Loans', contract: 'Market A', by: 'week' } });
        await expect(run(['table', 'list', '--group', 'Wildcat markets'])).rejects.toThrow(/--group is gone: say --on tag:<group>/);
        await expect(run(['table', 'show', 'Loans', '--contract', 'Market A'])).rejects.toThrow(/--contract is gone: say --on <contract>/);
        await expect(run(['table', 'show', 'Loans', '--on', 'tag:Wildcat markets'])).rejects.toThrow(/table show takes --on <contract>/);
    });

    it('the list names no kinds of table', async () => {
        mockApi({
            'GET /api/mainnet/queries': () => ({ payload: { queries: [{ id: 'q1', title: 'Top wallets', rows: 6, url: 'http://app/tables/q1' }] } }),
            'POST /api/mainnet/tools/list_tables': () => ok({ rows: [] }),
        });
        await run(['table', 'list']);
        const out = printed().join('\n');
        expect(out).toContain('Tables over rows the workspace keeps (1)');
        expect(out).toContain('Tables of things inside contracts');
        expect(out).not.toMatch(/live table|item table/i);
    });

    it('--rows is gone (a table is made from events, 2026-11-18), and --each on another table is refused', async () => {
        const calls = mockApi({});
        await expect(run(['table', 'create', 'X', '--rows', 'transfers'])).rejects.toThrow(/--rows is gone: a table is made from events \(--each <Event>\), or built on a table that is/);
        await expect(run(['table', 'create', 'X', '--rows=wallets', '--on', 'tag:pools', '--by', 'wallet', '--count'])).rejects.toThrow(/asked with contract-dev query/);
        expect(calls).toHaveLength(0);
        await expect(run(['table', 'create', 'X', '--on', 'table:Big swaps', '--each', 'Swap'])).rejects.toThrow(/takes its rows from it/);
    });
});

describe('event columns: from another contract, split by a field, in the token the event names (5.0.0)', () => {
    useEnvAuth();
    const { columnsFrom, columnClauses } = require('../../src/cli/commands/table');
    const { parseFlags } = require('../../src/cli/commands/_args');

    it('reads on, from, by, token, show and decimals after Event[.field][:Label], in any order, from the last keyword backwards', () => {
        expect(columnsFrom(parseFlags(['--count', 'Bribed:Incentives on poolId from Voter incentives']))).toEqual([{ label: 'Incentives', event: 'Bribed', fold: 'count', on: 'poolId', from: 'Voter incentives' }]);
        expect(columnsFrom(parseFlags(['--sum', 'Bribed.amount:Paid on poolId from 0x325532108660C1445e723d6205Ce89462ef61836']))).toEqual([
            { label: 'Paid', event: 'Bribed', field: 'amount', fold: 'sum', on: 'poolId', from: '0x325532108660C1445e723d6205Ce89462ef61836' },
        ]);
        // a name of several words, then more clauses after it; and the clauses in another order
        expect(columnsFrom(parseFlags(['--sum', 'Bribed.amount:Incentives on poolId from Voter incentives token token']))).toEqual([
            { label: 'Incentives', event: 'Bribed', field: 'amount', fold: 'sum', on: 'poolId', from: 'Voter incentives', token: 'token' },
        ]);
        expect(columnsFrom(parseFlags(['--sum', 'Bribed.amount:Incentives from Voter incentives by token on poolId']))).toEqual([
            { label: 'Incentives', event: 'Bribed', field: 'amount', fold: 'sum', on: 'poolId', from: 'Voter incentives', by: 'token' },
        ]);
        expect(columnsFrom(parseFlags(['--count', 'Bribed:Posts by from on poolId']))).toEqual([{ label: 'Posts', event: 'Bribed', fold: 'count', on: 'poolId', by: 'from' }]);
    });

    it('a token may be one of the event\'s own fields, sent as typed; self, a view and an address stay what they were', () => {
        const token = (t: string) => columnsFrom(parseFlags(['--sum', `Bribed.amount:Paid token ${t}`]))[0].token;
        expect(token('token')).toBe('token');
        expect(token('swapInfo.fromToken')).toBe('swapInfo.fromToken');
        expect(token('self')).toBe('self');
        expect(token('asset()')).toBe('asset()');
        expect(token('0xae7ab96520de3a18e5e111b5eaab095312d7fe84')).toBe('0xae7ab96520de3a18e5e111b5eaab095312d7fe84');
    });

    it('a name that holds a clause word goes in quotes; a clause is said once; one word follows on, by and token', () => {
        expect(columnClauses('Fee.amount:Fees on id from "Fee on transfer" by token', '--sum')).toEqual({ rest: 'Fee.amount:Fees', on: 'id', from: 'Fee on transfer', by: 'token' });
        expect(() => columnClauses('Bribed:Posts on poolId on epoch', '--count', ['on', 'from', 'by'])).toThrow(/"on" is said once/);
        expect(() => columnClauses('Bribed:Posts on pool id', '--count', ['on', 'from', 'by'])).toThrow(/after "on" comes one word/);
        // --count takes no token: the word stays in the label
        expect(columnsFrom(parseFlags(['--count', 'Bribed:Posts token token']))).toEqual([{ label: 'Posts token token', event: 'Bribed', fold: 'count' }]);
    });

    it('create sends from, by and the token field on the column, and a watched event from another contract as typed', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_table': () => ok({ created: true, table: { id: 't9', name: 'Pools' } }) });
        await run([
            'table', 'create', 'Pools', '--on', 'Pool registry', '--each', 'PoolRegistered', '--id', 'id',
            '--sum', 'Bribed.amount:Incentives on poolId from Voter incentives token token',
            '--count', 'Bribed:Posts on poolId from Voter incentives by from',
            '--event', 'Bribed.poolId from Voter incentives',
        ]);
        expect(calls[0].body).toEqual({
            input: {
                name: 'Pools',
                opens: 'PoolRegistered',
                contract: 'Pool registry',
                id: 'id',
                events: ['Bribed.poolId from Voter incentives'],
                columns: [
                    { label: 'Posts', event: 'Bribed', fold: 'count', on: 'poolId', from: 'Voter incentives', by: 'from' },
                    { label: 'Incentives', event: 'Bribed', field: 'amount', fold: 'sum', on: 'poolId', from: 'Voter incentives', token: 'token' },
                ],
            },
        });
    });
});

describe('by over several fields', () => {
    const { columnsFrom } = require('../../src/cli/commands/table');
    const { parseFlags } = require('../../src/cli/commands/_args');
    it('joins fields with commas, from a contract named in several words', () => {
        const cols = columnsFrom(parseFlags(['--sum', 'ModifyLiquidity.liquidityDelta:Liquidity on id from Uniswap v4 PoolManager by tickLower,tickUpper']));
        expect(cols).toEqual([{ label: 'Liquidity', event: 'ModifyLiquidity', field: 'liquidityDelta', fold: 'sum', on: 'id', from: 'Uniswap v4 PoolManager', by: 'tickLower,tickUpper' }]);
    });
    it('refuses a space after the comma, and more than four fields', () => {
        expect(() => columnsFrom(parseFlags(['--sum', 'ModifyLiquidity.liquidityDelta:Liquidity by tickLower, tickUpper']))).toThrow(/one word/);
        expect(() => columnsFrom(parseFlags(['--sum', 'E.v:L by a,b,c,d,e']))).toThrow(/up to four/);
    });
});

// A table's row opens its own page (2026-11-18): --detail names the columns shown there and not in the table.
describe('--detail: the columns kept for a row\'s page', () => {
    useEnvAuth();

    it('create sends the names as a list, from one comma list or several flags', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_table': () => ok({ created: true, table: { id: 't1', name: 'Pools' } }) });
        await run(['table', 'create', 'Pools', '--on', 'PoolRegistry', '--each', 'PoolRegistered', '--id', 'id', '--count', 'Bribed:Posts', '--detail', 'Hook, Token 0', '--detail', 'Registered']);
        expect(calls[0].body.input).toMatchObject({ name: 'Pools', opens: 'PoolRegistered', detail: ['Hook', 'Token 0', 'Registered'] });
    });

    it('update replaces the list, and an empty one puts every column back in the table', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/update_table': () => ok({ table: { id: 't1', name: 'Pools' } }) });
        await run(['table', 'update', 'Pools', '--detail', 'Hook, Emission share %']);
        expect(calls[0].body.input).toEqual({ table: 'Pools', detail: ['Hook', 'Emission share %'] });
        await run(['table', 'update', 'Pools', '--detail', '']);
        expect(calls[1].body.input).toEqual({ table: 'Pools', detail: [] });
    });

    it('a bare --detail is refused with what it takes', async () => {
        const calls = mockApi({});
        await expect(run(['table', 'update', 'Pools', '--detail'])).rejects.toThrow(/--detail names columns by label/);
        expect(calls).toHaveLength(0);
    });
});

// A count or a sum over a window (last 7d), over a contract's events or a table of events' rows, and a read that goes
// to an address the row holds (2026-11-19).
describe('windowed columns and reads on the row\'s own address', () => {
    useEnvAuth();

    it('last <window> rides on a --count or --sum as the tool\'s last', () => {
        expect(columnsFrom(parseFlags(['--sum', 'Bribed.amount:Incentives 30d on poolId from Voter incentives token token last 30d']))).toEqual([
            { label: 'Incentives 30d', event: 'Bribed', field: 'amount', fold: 'sum', on: 'poolId', from: 'Voter incentives', last: '30d', token: 'token' },
        ]);
        expect(columnsFrom(parseFlags(['--count', 'Swap:Swaps 24h last 24h']))).toEqual([{ label: 'Swaps 24h', event: 'Swap', fold: 'count', last: '24h' }]);
        expect(() => columnsFrom(parseFlags(['--count', 'Swap:Swaps last week']))).toThrow(/after "last" comes one word|last takes a window like 24h, 7d or 2w/);
        expect(() => columnsFrom(parseFlags(['--count', 'Bribed:Posts by from last 7d']))).toThrow(/takes no by or where/);
    });

    it('from table: adds up a table of events\' rows: one of its columns for a sum, the label alone for a count', () => {
        expect(columnsFrom(parseFlags(['--sum', 'feeusd:Fees 7d from table:"Swaps" last 7d']))).toEqual([{ label: 'Fees 7d', field: 'feeusd', fold: 'sum', from: 'table:"Swaps"', last: '7d' }]);
        expect(columnsFrom(parseFlags(['--count', 'Swaps 7d from table:"Big swaps" on id last 7d']))).toEqual([{ label: 'Swaps 7d', fold: 'count', from: 'table:"Big swaps"', last: '7d', on: 'id' }]);
        expect(() => columnsFrom(parseFlags(['--sum', 'feeusd:Fees from table:"Swaps"']))).toThrow(/say last 7d/);
        expect(() => columnsFrom(parseFlags(['--sum', 'Swap.feeusd:Fees from table:"Swaps" last 7d']))).toThrow(/takes one of its columns/);
    });

    it('--column reads on a fixed address, on a column of the row, or on the row\'s id', () => {
        expect(readColumnsFrom(parseFlags(['--column', 'Fee=currentFee(id(), true); on {Hook}']))).toEqual([{ label: 'Fee', read: 'currentFee', args: [':id', 'true'], target: '{Hook}' }]);
        expect(readColumnsFrom(parseFlags(['--column', 'Reserve=balanceOf(self); on {Token 0}']))).toEqual([{ label: 'Reserve', read: 'balanceOf', args: ['self'], target: '{Token 0}' }]);
        expect(readColumnsFrom(parseFlags(['--column', 'Liquidity=liquidity(); on id()']))).toEqual([{ label: 'Liquidity', read: 'liquidity', target: 'id()' }]);
        expect(readColumnsFrom(parseFlags(['--column', 'Share=emissionShareOf(id()); on 0x71570B34D9200FFE5C3066f5A204f91229E7338E']))).toEqual([{ label: 'Share', read: 'emissionShareOf', args: [':id'], target: '0x71570b34d9200ffe5c3066f5a204f91229e7338e' }]);
        expect(() => readColumnsFrom(parseFlags(['--column', 'Fee=currentFee(); on hook']))).toThrow(/on takes a contract's 0x address, a column of the row in braces/);
    });

    it('table update adds a read column', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/update_table': () => ok({ table: { id: 't1', name: 'Pools' } }) });
        await run(['table', 'update', 'Pools', '--column', 'Fee=currentFee(id(), true); on {Hook}']);
        expect(calls[0].body.input).toEqual({ table: 'Pools', columns: [{ label: 'Fee', read: 'currentFee', args: [':id', 'true'], target: '{Hook}' }] });
    });
});
