import { run } from '../../src/cli/index';
import { parseMeasure } from '../../src/cli/commands/query';
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
            'POST /api/mainnet/tools/query_data': () => ok({ dataset: 'table', data: { name: 'Withdrawal rounds', kind: 'table' }, columns: [], rows: [], matched: 0, returned: 0, more: 0, among: 'all' }),
            'POST /api/mainnet/tools/query_metric': () => ok({ dataset: 'metric', columns: [], rows: [{ day: '2026-10-17', value: 12.5, rows: 3 }], matched: 1, returned: 1, more: 0, grouped: { by: ['day'], measure: 'sum({value})' } }),
        });
        await run(['query', 'table', 'Withdrawal', 'rounds', '--among', 'all', '--where', '{Stage} == "Paying"']);
        await run(['query', 'metric', 'Deposits', '--days', '30', '--by', 'day', '--sum', '{value}']);
        expect(calls.map((c) => c.body.input)).toEqual([
            { where: '{Stage} == "Paying"', data: 'Withdrawal rounds', among: 'all' },
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

    it('help after the dataset is the help, never a metric or table called "help"', async () => {
        const calls = mockApi({});
        await run(['query', 'metric', 'help']);
        await run(['query', 'table', '--help']);
        expect(calls).toHaveLength(0);
        expect(printed().join('\n')).toMatch(/contract-dev query — ask one dataset a question/);
    });

    it('--breakdown splits each group again: sent with --by, its parts printed indented under each row', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_metric': () =>
                ok({
                    dataset: 'metric',
                    columns: [
                        { key: 'sender', label: 'Wallet', kind: 'text' },
                        { key: 'value', label: 'sum of Value', kind: 'number', unit: 'usd' },
                        { key: 'rows', label: 'Rows', kind: 'number', unit: 'count' },
                        { key: 'parts', label: 'Chains', kind: 'number', unit: 'count' },
                    ],
                    breakdown: { key: 'chain', label: 'Chain', kind: 'text' },
                    rows: [{ sender: '0xa', value: 530, rows: 4, chainId: 8453, parts: 2, breakdown: [{ chain: 'Base', value: 500, rows: 1, chainId: 8453 }, { chain: 'Ethereum', value: 30, rows: 3, chainId: 1 }] }],
                    matched: 1,
                    returned: 1,
                    more: 0,
                    grouped: { by: ['sender'], measure: 'sum({Value})' },
                }),
        });
        await run(['query', 'metric', 'Swap volume', '--by', 'wallet', '--sum', '{Value}', '--breakdown', 'chain']);
        expect(calls[0].body.input).toEqual({ by: ['wallet'], measure: { fn: 'sum', expr: '{Value}' }, breakdown: 'chain', metric: 'Swap volume' });
        const out = printed();
        const at = out.findIndex((l) => /^0xa /.test(l));
        expect(out[at]).toMatch(/^0xa +\$530\.00 +4 +2$/);
        expect(out[at + 1]).toMatch(/^ {2}Base +\$500\.00 +1$/);
        expect(out[at + 2]).toMatch(/^ {2}Ethereum +\$30\.00 +3$/);
        await expect(run(['query', 'metric', 'Swap volume', '--breakdown', 'chain'])).rejects.toThrow(/say --by/);
    });

    it('a dollar column prints as dollars, its totals too; a count stays a number', async () => {
        mockApi({
            'POST /api/mainnet/tools/query_metric': () =>
                ok({
                    dataset: 'metric',
                    columns: [{ key: 'sender', label: 'Wallet', kind: 'text' }, { key: 'value', label: 'sum of Value', kind: 'number', unit: 'usd' }, { key: 'rows', label: 'Rows', kind: 'number', unit: 'count' }],
                    rows: [{ sender: '0x3008', value: 436767.93603, rows: 27 }],
                    matched: 1,
                    returned: 1,
                    more: 0,
                    totals: { value: 436767.93603 },
                    grouped: { by: ['sender'], measure: 'sum({Value})' },
                }),
        });
        await run(['query', 'metric', 'Swap volume', '--by', 'sender', '--sum', '{Value}', '--total', 'value']);
        const out = printed().join('\n');
        expect(out).toMatch(/0x3008 +\$436,767\.94 +27/);
        expect(out).toMatch(/Totals: value \$436,767\.94/);
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
        // several at once go with confirmMany: the person named them all, so the tool's "more than 25" check is answered up front
        expect(calls.map((c) => c.body.input)).toEqual([{ contracts: ['Curve 3pool', 'Nope'], chainId: 1, confirmMany: true }]);
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

    it('a read carries its at; --series and --every go to the tool, and the answer prints the series and each read\'s block', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_contracts': () =>
                ok({
                    dataset: 'contracts',
                    columns: [{ key: 'name', label: 'Name', kind: 'text' }, { key: 'sp', label: 'sp', kind: 'number' }, { key: 'sp7', label: 'sp7', kind: 'number' }, { key: 'apr', label: 'apr', kind: 'number' }],
                    rows: [{ address: '0xa', name: 'USDC Vault', sp: 1.05, sp7: 1.04, apr: 0.5 }],
                    matched: 1,
                    returned: 1,
                    more: 0,
                    readAt: { sp7: { at: '2026-10-12T14:02:00Z', blocks: [{ chainId: 1, block: 23456789, time: '2026-10-12T14:01:47Z' }] } },
                }),
        });
        await run(['query', 'contracts', '--group', 'Vaults', '--read', 'sp=convertToAssets(1000000000000000000)', '--read', 'sp7=convertToAssets(1000000000000000000) in asset() as amount at 7d', '--show', 'apr=(sp - sp7) / sp7 * 52', '--sort', 'apr']);
        expect(calls[0].body.input).toEqual({
            show: [{ name: 'apr', expr: '(sp - sp7) / sp7 * 52' }],
            sort: 'apr',
            group: 'Vaults',
            reads: [
                { name: 'sp', call: 'convertToAssets(1000000000000000000)' },
                { name: 'sp7', call: 'convertToAssets(1000000000000000000)', token: 'asset()', show: 'amount', at: '7d' },
            ],
        });
        expect(printed().join('\n')).toMatch(/sp7: as of 2026-10-12 14:02 \(block 23,456,789\)/);
        await expect(run(['query', 'contracts', '--read', 'x=held - cov at 7d'])).rejects.toThrow(/go with a view/);
    });

    it('--series takes <from>[..<to>] with --every, and the rows print time first', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_contracts': () =>
                ok({
                    dataset: 'contracts',
                    series: { from: '2026-09-19T14:02:00Z', to: '2026-10-19T14:02:00Z', every: '1d', points: 31, chosen: 'asked' },
                    columns: [{ key: 'time', label: 'Time', kind: 'number', unit: 'time' }, { key: 'day', label: 'Day', kind: 'text' }, { key: 'name', label: 'Name', kind: 'text' }, { key: 'sp', label: 'sp', kind: 'number' }],
                    rows: [{ address: '0xa', time: 1_792_000_000, day: '2026-10-14', name: 'USDC Vault', sp: 1.05 }],
                    matched: 31,
                    returned: 1,
                    more: 30,
                }),
        });
        await run(['query', 'contracts', '--group', 'Vaults', '--read', 'sp=convertToAssets(1000000000000000000)', '--series', '30d', '--every', '1d']);
        expect(calls[0].body.input).toEqual({ group: 'Vaults', reads: [{ name: 'sp', call: 'convertToAssets(1000000000000000000)' }], series: { from: '30d', every: '1d' } });
        const out = printed().join('\n');
        expect(out).toMatch(/Series: every 1d · 31 points · 2026-09-19 14:02 → 2026-10-19 14:02/);
        expect(out).toMatch(/Time\s+Name/);
        await run(['query', 'contracts', '--read', 'sp=convertToAssets(1)', '--series', '2026-09-01..2026-10-01']);
        expect(calls[1].body.input.series).toEqual({ from: '2026-09-01', to: '2026-10-01' });
        await expect(run(['query', 'contracts', '--series', '30d'])).rejects.toThrow(/say what to read/);
        await expect(run(['query', 'contracts', '--read', 'sp=convertToAssets(1)', '--every', '1d'])).rejects.toThrow(/goes with --series/);
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

describe('query measures', () => {
    useEnvAuth();

    it('parseMeasure reads name=fn(expr) [where rule], an expression holding calls and quotes of its own', () => {
        expect(parseMeasure('swaps=count')).toEqual({ name: 'swaps', fn: 'count' });
        expect(parseMeasure('volume=sum({Value})')).toEqual({ name: 'volume', fn: 'sum', expr: '{Value}' });
        expect(parseMeasure('vol=sum(usd(amount, if(token == "x", t0, t1)))')).toEqual({ name: 'vol', fn: 'sum', expr: 'usd(amount, if(token == "x", t0, t1))' });
        expect(parseMeasure('bridges=count where {Event} == "BridgeStarted"')).toEqual({ name: 'bridges', fn: 'count', where: '{Event} == "BridgeStarted"' });
        expect(parseMeasure('big=sum({Value}) where {Value} > 10000')).toEqual({ name: 'big', fn: 'sum', expr: '{Value}', where: '{Value} > 10000' });
        expect(parseMeasure('chains=DISTINCT(chain)')).toEqual({ name: 'chains', fn: 'distinct', expr: 'chain' });
        expect(() => parseMeasure('sum({Value})')).toThrow(/name=/);
        expect(() => parseMeasure('x=median({Value})')).toThrow(/not a measure/);
        expect(() => parseMeasure('x=sum(({Value})')).toThrow(/never closes/);
        expect(() => parseMeasure('x=sum({Value}) when 1')).toThrow(/only "where <rule>"/);
    });

    it('--measure, --having and a group --sort go to the tool; query table names its table, with days or among', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_data': () => ok({ dataset: 'metric', data: { name: 'DZap swaps', kind: 'data' }, columns: [], rows: [], matched: 0, returned: 0, more: 0 }),
        });
        await run(['query', 'table', 'DZap', 'swaps', '--days', '90', '--by', 'wallet', '--measure', 'volume=sum(vol)', '--measure', 'swaps=count', '--having', 'volume > 10000', '--sort', 'swaps']);
        await run(['query', 'table', 'Withdrawal rounds', '--among', 'all', '--by', 'contract', '--count']);
        expect(calls.map((c) => c.body.input)).toEqual([
            { sort: 'swaps', by: ['wallet'], measures: [{ name: 'volume', fn: 'sum', expr: 'vol' }, { name: 'swaps', fn: 'count' }], having: 'volume > 10000', data: 'DZap swaps', days: 90 },
            { by: ['contract'], measure: { fn: 'count' }, data: 'Withdrawal rounds', among: 'all' },
        ]);
    });

    it('--column names the columns a listing shows, in order, repeated or as a comma list', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_data': () => ok({ dataset: 'metric', data: { name: 'DZap swaps', kind: 'rows' }, columns: [], rows: [], matched: 0, returned: 0, more: 0 }),
        });
        await run(['query', 'table', 'DZap swaps', '--column', 'time', '--column', 'tx,amountIn', '--column', ' dollars ']);
        expect(calls[0].body.input).toEqual({ data: 'DZap swaps', columns: ['time', 'tx', 'amountIn', 'dollars'] });
    });

    it('--status and --detail go to the tool: a category with its options and rules, the lines each row opens onto', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_data': () => ok({ dataset: 'metric', data: { name: 'Swaps', kind: 'rows' }, columns: [], rows: [], matched: 0, returned: 0, more: 0 }),
        });
        await run(['query', 'table', 'Swaps', '--status', 'Type: Batch={Event} == "DZapBatchTokenSwapped"; Single', '--column', 'time,Type', '--detail', 'fromToken', '--detail', 'amountIn']);
        expect(calls[0].body.input).toEqual({
            data: 'Swaps',
            status: [{ label: 'Type', options: [{ name: 'Batch', when: '{Event} == "DZapBatchTokenSwapped"' }, { name: 'Single' }] }],
            columns: ['time', 'Type'],
            detail: ['fromToken', 'amountIn'],
        });
    });

    it('a row that opens onto lines prints them under it, each amount with its symbol', async () => {
        mockApi({
            'POST /api/mainnet/tools/query_data': () =>
                ok({
                    dataset: 'metric',
                    columns: [{ key: 'tx', label: 'Tx' }, { key: 'Type', label: 'Type' }, { key: 'dollars', label: 'Dollars', unit: 'usd' }],
                    detail: { columns: [{ key: 'fromToken', label: 'From token' }, { key: 'amountIn', label: 'Amount in', symbolKey: 'amountInSymbol' }] },
                    rows: [
                        { tx: '0xaaa', Type: 'Batch', dollars: 30, lines: [{ fromToken: '0x1', amountIn: 10, amountInSymbol: 'USDC' }, { fromToken: '0x2', amountIn: 0.5, amountInSymbol: 'ETH' }] },
                        { tx: '0xbbb', Type: 'Single', dollars: 5, lines: [{ fromToken: '0x3', amountIn: 5, amountInSymbol: 'DAI' }] },
                    ],
                    matched: 2,
                    returned: 2,
                    more: 0,
                }),
        });
        await run(['query', 'table', 'Swaps', '--column', 'tx,Type,dollars', '--detail', 'fromToken,amountIn']);
        const out = printed();
        expect(out.some((l) => l.includes('0xaaa') && l.includes('Batch'))).toBe(true);
        expect(out.some((l) => l.startsWith('    ') && l.includes('From token') && l.includes('Amount in'))).toBe(true);
        expect(out.some((l) => l.startsWith('    ') && l.includes('0x2') && l.includes('0.5 ETH'))).toBe(true);
        expect(out.some((l) => l.includes('0xbbb') && l.includes('Single'))).toBe(true);
    });

    it('a table still indexing prints that it is, and none of the rows so far', async () => {
        mockApi({
            'POST /api/mainnet/tools/query_data': () => ok({ dataset: 'metric', filling: true, columns: [{ key: 'dollars', label: 'Dollars', kind: 'number' }], rows: [{ dollars: 5 }], matched: 1, returned: 1, more: 0 }),
        });
        await run(['query', 'table', 'DZap swaps']);
        const out = printed().join('\n');
        expect(out).toContain('Indexing: the rows show once every one is in.');
        expect(out).not.toContain('Dollars');
    });

    it('refuses a measure with no --by, two kinds of measure at once, and having with no --by', async () => {
        mockApi({});
        await expect(run(['query', 'table', 'x', '--measure', 'n=count'])).rejects.toThrow(/say --by/);
        await expect(run(['query', 'table', 'x', '--by', 'wallet', '--count', '--measure', 'n=count'])).rejects.toThrow(/not both/);
        await expect(run(['query', 'table', 'x', '--having', 'rows > 1'])).rejects.toThrow(/--having keeps groups/);
        await expect(run(['query', 'data'])).rejects.toThrow(/Name the data/);
    });

    it('a part line under a breakdown carries every measure of its row', async () => {
        mockApi({
            'POST /api/mainnet/tools/query_data': () =>
                ok({
                    dataset: 'metric',
                    columns: [
                        { key: 'sender', label: 'Wallet', kind: 'text' },
                        { key: 'volume', label: 'volume', kind: 'number', unit: 'usd' },
                        { key: 'swaps', label: 'swaps', kind: 'number', unit: 'count' },
                        { key: 'rows', label: 'Rows', kind: 'number', unit: 'count' },
                        { key: 'parts', label: 'Chains', kind: 'number', unit: 'count' },
                    ],
                    breakdown: { key: 'chain', label: 'Chain', kind: 'text' },
                    rows: [{ sender: '0xa', volume: 530, swaps: 4, rows: 4, parts: 1, breakdown: [{ chain: 'Base', volume: 530, swaps: 4, rows: 4 }] }],
                    matched: 1,
                    returned: 1,
                    more: 0,
                    grouped: { by: ['sender'], measure: 'volume=sum(vol), swaps=count' },
                }),
        });
        await run(['query', 'table', 'DZap swaps', '--by', 'wallet', '--measure', 'volume=sum(vol)', '--measure', 'swaps=count', '--breakdown', 'chain']);
        const out = printed();
        const at = out.findIndex((l) => /^0xa /.test(l));
        expect(out[at]).toMatch(/^0xa +\$530\.00 +4 +4 +1$/);
        expect(out[at + 1]).toMatch(/^ {2}Base +\$530\.00 +4 +4$/);
    });
});

describe('live tables and snapshots', () => {
    useEnvAuth();
    const saved = (kept: boolean) =>
        ok({ dataset: 'data', columns: [], rows: [{ wallet: '0xa', volume: 5 }], matched: 1, returned: 1, more: 0, saved: { id: 'q1', url: `http://app/${kept ? 'tables' : 'queries'}/q1`, as: 'table', title: 'Top wallets', asOf: '2026-10-26T00:00:00Z', ...(kept ? { kept } : {}) } });

    it('table create --from asks the question through query and keeps it as a live table named by the table', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_data': () => saved(true), 'POST /api/mainnet/tools/query_transfers': () => saved(true) });
        await run(['table', 'create', 'Top wallets', '--from', 'DZap activity', '--days', '1', '--by', 'wallet', '--measure', 'volume=sum(vol)']);
        await run(['table', 'create', 'Top wallets', '--from=transfers', '--group', 'DZap Routers', '--by', 'wallet', '--sum', '{USD}']);
        expect(calls.map((c) => [c.path, c.body.input])).toEqual([
            // one kind of kept answer since 2026-10-28: a live table; `as` and `keep` went with the snapshots
            ['/api/mainnet/tools/query_data', { by: ['wallet'], measures: [{ name: 'volume', fn: 'sum', expr: 'vol' }], data: 'DZap activity', days: 1, save: { title: 'Top wallets' } }],
            ['/api/mainnet/tools/query_transfers', { by: ['wallet'], measure: { fn: 'sum', expr: '{USD}' }, group: 'DZap Routers', save: { title: 'Top wallets' } }],
        ]);
        expect(printed().join('\n')).toMatch(/Live table under Tables · Top wallets: http:\/\/app\/tables\/q1/);
    });

    it('--save, --keep, --title and --draw are gone (the snapshots under Queries went 2026-10-28) and say what to use', async () => {
        const calls = mockApi({});
        for (const flag of ['--save', '--keep', '--title', '--draw'])
            await expect(run(['query', 'table', 'DZap activity', '--by', 'wallet', '--count', flag, ...(flag === '--title' || flag === '--draw' ? ['x'] : [])])).rejects.toThrow(/--save is gone: a table kept under Tables is contract-dev table create "<name>" --from <rows>/);
        expect(calls).toHaveLength(0);
    });

    it('a live table refuses an item table\'s flags and a snapshot\'s, and table create says which kind it needs', async () => {
        mockApi({});
        await expect(run(['table', 'create', 'X', '--from', 'transfers', '--opens', 'Foo'])).rejects.toThrow(/--opens is for a table that opens rows/);
        await expect(run(['table', 'create', 'X', '--from', 'transfers', '--by', 'wallet', '--count', '--save'])).rejects.toThrow(/--save is gone/);
        await expect(run(['table', 'create', 'X', '--group', 'G'])).rejects.toThrow(/--from events --event <Event> for a live table/);
    });

    it('table create --from events is one call: the rows kept as data of its own, off the lists, and the question over them kept as the table, with the title and the question carried in `table`', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/define_data': () => saved(true),
        });
        await run([
            'table', 'create', 'Top integrators', '--from', 'events', '--group', 'DZap Routers',
            '--event', 'DZapTokenSwapped', '--event', 'BridgeStarted', '--pair', 'DZapBridgeStarted on transactionId',
            '--field', 'vol=usd(amount, from) on BridgeStarted', '--keep', 'integrator',
            '--where', 'vol > 0', '--by', 'integrator', '--measure', 'volume=sum(vol)',
        ]);
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/tools/define_data']);
        expect(calls[0].body.input).toEqual({
            name: 'Top integrators',
            group: 'DZap Routers',
            events: ['DZapTokenSwapped', 'BridgeStarted'],
            pair: [{ event: 'DZapBridgeStarted', on: 'transactionId' }],
            fields: [{ name: 'vol', expr: 'usd(amount, from)', on: 'BridgeStarted' }],
            keep: ['integrator'],
            // the server fills the window from the rows' history when --days is not given
            table: { title: 'Top integrators', where: 'vol > 0', by: ['integrator'], measures: [{ name: 'volume', fn: 'sum', expr: 'vol' }] },
        });
        expect(printed().join('\n')).toMatch(/Live table under Tables · Top wallets: http:\/\/app\/tables\/q1/);
    });

    it('--days on a table from events reaches back over the rows kept and is the question\'s window; a question the server refuses leaves nothing behind (it deletes the rows itself, 2026-10-30)', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/define_data': () => ({ status: 400, payload: { error: 'No column is called nope.' } }),
        });
        await expect(run(['table', 'create', 'X', '--from=events', '--contract', 'Router', '--event', 'Swap', '--days', '30', '--sort', 'nope'])).rejects.toThrow(/nope/);
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/tools/define_data']);
        expect(calls[0].body.input).toEqual({ name: 'X', contract: 'Router', events: ['Swap'], history: 30, table: { title: 'X', days: 30, sort: 'nope' } });
        await expect(run(['table', 'create', 'X', '--from', 'events', '--group', 'G'])).rejects.toThrow(/--event names what each row is/);
        await expect(run(['table', 'create', 'X', '--from', 'events', '--event', 'Swap'])).rejects.toThrow(/--group <group> or --contract/);
    });
});
