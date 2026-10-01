import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed, RecordedCall } from './_mockApi';

// The data commands read the routes the dashboard pages read. These tests pin what each one
// asks for (so the CLI and the app keep agreeing) and the lines a person sees.
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';

const accounts = () => ({
    payload: {
        accounts: [
            { id: 'a1', chainId: 1, chainIds: [1], address: STETH, accountType: 'contract', name: 'Lido: stETH', valueUsd: 9_500_000 },
            { id: 'a2', chainId: 1, chainIds: [1], address: WSTETH, accountType: 'contract', name: 'Lido: wstETH', valueUsd: 12_400_000_000 },
        ],
    },
});
const labels = (book: Record<string, string>) => () => ({
    payload: { book: Object.fromEntries(Object.entries(book).map(([k, name]) => [k, { name, category: 'contract' }])) },
});
const query = (call: RecordedCall) => Object.fromEntries(new URLSearchParams(call.path.split('?')[1] ?? ''));

const feed = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
    payload: {
        params: { tab: 'transactions', range: '24h', lens: 'writes', route: 'any', status: 'all', chainId: 1, contract: STETH },
        buckets: [
            { t: 0, total: 2, failed: 0 },
            { t: 1, total: 8, failed: 1 },
        ],
        stepMs: 3_600_000,
        total: 10,
        failed: 1,
        counts: { transactions: 1867, transactionsFailed: 13, calls: 3642, callsReverted: 13, events: 7362, transfers: 288, transfersIn: 277, transfersOut: 11 },
        rows,
        scope: { watched: 2, inScope: 1, collected: 1, notCollected: 0, coverageStartMs: null },
        unavailable: null,
        ...extra,
    },
});

describe('data commands', () => {
    useEnvAuth();

    it('activity names a contract by a word of its name and asks for its failed transactions', async () => {
        const now = Date.now();
        const calls = mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/activity/feed': () =>
                feed([
                    { kind: 'tx', chainId: 1, txHash: `0x${'a'.repeat(64)}`, blockNumber: 1, tsMs: now - 5 * 3_600_000, from: '0xd6ad03f7d331750a4cca95203e5a1b43c2d2cfac', to: STETH, method: 'transfer', selector: '0xa9059cbb', status: 'failed', contract: STETH, via: false, callReverted: true },
                ]),
            'GET /api/mainnet/labels': labels({}),
        });
        await run(['activity', 'steth', '--failed']);
        const feedCall = calls.find((c) => c.path.startsWith('/api/mainnet/activity/feed'))!;
        expect(query(feedCall)).toEqual({ range: '24h', status: 'failed', chain: '1', contract: STETH });
        const out = printed();
        expect(out[0]).toBe('Lido: stETH · Ethereum · last 24h · state-changing · failed only');
        expect(out[1]).toBe('1,867 transactions (13 failed) · 3,642 calls (13 reverted) · 7,362 events · 288 transfers (277 in · 11 out)');
        expect(out.find((l) => /^\s*5h\s/.test(l))).toMatch(/^\s*5h\s+transfer\s+0xd6ad…cfac\s+direct\s+failed\s+0xa{64}$/);
    });

    it('activity maps --calls, --reads and --routed onto the feed\'s view, reading and route', async () => {
        const calls = mockApi({ 'GET /api/mainnet/activity/feed': () => feed([]), 'GET /api/mainnet/labels': labels({}) });
        await run(['activity', '--calls', '--reads', '--routed', '--range', '7d', '--chain', 'avalanche']);
        expect(query(calls[0])).toEqual({ view: 'calls', range: '7d', reading: 'reads', route: 'routed', chain: '43114' });
        expect(printed()).toContain('No activity in the window.');
    });

    it('activity says when the plan served a shorter window, and when the data is unavailable', async () => {
        mockApi({ 'GET /api/mainnet/activity/feed': () => feed([], { unavailable: 'store' }) });
        await run(['activity', '--range', '7d']);
        const out = printed();
        expect(out[0]).toBe('All contracts · last 24h · state-changing');
        expect(out[1]).toBe("Showing 24h: this workspace's plan keeps 24h of history.");
        expect(out[2]).toBe('Data unavailable. Retry in a moment.');
    });

    it('methods <contract> <name> finds the selector among the verified functions and reads that method', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/contract/facts': () => ({ payload: { functions: [{ selector: '0xa9059cbb', name: 'transfer', signature: 'transfer(address,uint256)' }] } }),
            'GET /api/mainnet/console/method': () => ({
                payload: {
                    name: 'transfer',
                    signature: 'transfer(address,uint256)',
                    selector: '0xa9059cbb',
                    kind: 'write',
                    range: '24h',
                    stats: { calls: 1126, direct: 193, routed: 933, reverts: 13, callers: 314, txs: 844, gasP50: 22149, gasP95: 67305, gasMax: 84405, depthAvg: 3.5, firstAt: null, lastAt: Date.now() - 60_000 },
                    callers: [{ address: WSTETH, calls: 161, reverts: 0, viaContract: true, lastAt: Date.now() - 180_000 }],
                    reverts: { total: 13, sampled: 13, reasons: [{ reason: 'No revert data', n: 13, where: 'this', example: { txHash: '0xabc' } }] },
                    args: [],
                    recent: [],
                },
            }),
            'GET /api/mainnet/labels': labels({ [`1:${WSTETH}`]: 'Lido: wstETH' }),
        });
        await run(['methods', 'steth', 'transfer']);
        const methodCall = calls.find((c) => c.path.startsWith('/api/mainnet/console/method?'))!;
        expect(query(methodCall)).toEqual({ chainId: '1', address: STETH, selector: '0xa9059cbb', range: '24h' });
        const out = printed();
        expect(out[0]).toBe('Lido: stETH · transfer(address,uint256) · 0xa9059cbb · last 24h');
        expect(out[1]).toBe('1,126 calls (193 direct · 933 routed) · 13 reverts · 314 callers · 844 transactions');
        expect(out.some((l) => /Lido: wstETH\s+contract\s+161\s+0\s+3m/.test(l))).toBe(true);
        expect(out.some((l) => /No revert data\s+13\s+in this method\s+0xabc/.test(l))).toBe(true);
    });

    it('methods refuses an overloaded name and asks for the signature', async () => {
        mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/contract/facts': () => ({
                payload: {
                    functions: [
                        { selector: '0x11111111', name: 'deposit', signature: 'deposit()' },
                        { selector: '0x22222222', name: 'deposit', signature: 'deposit(uint256)' },
                    ],
                },
            }),
        });
        await expect(run(['methods', 'steth', 'deposit'])).rejects.toThrow(/overloaded: deposit\(\) \(0x11111111\), deposit\(uint256\) \(0x22222222\)/);
    });

    it('flows --in pages through the counterparties into the contract', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/console/flows/counterparties': () => ({
                payload: {
                    direction: 'in',
                    rows: [{ address: '0x9fb6c242fffd11a5594ac58ab97b9eaa52a8eefe', label: null, role: 'wallet', inUsd: 5_290_612, outUsd: 0, transfers: 1, lastAt: null }],
                    total: 191,
                    sumUsd: 19_541_711,
                    nextOffset: 60,
                },
            }),
        });
        await run(['flows', STETH, '--in', '--offset', '50', '--limit', '10']);
        expect(query(calls[1])).toEqual({ range: '24h', chainId: '1', address: STETH, direction: 'in', offset: '50', limit: '10' });
        const out = printed();
        expect(out[0]).toBe('Lido: stETH · Ethereum · into your contracts · last 24h');
        expect(out[1]).toBe('$19.54M from 191 counterparties\n');
        expect(out.some((l) => /^51\s+0x9fb6…eefe\s+wallet\s+\$5\.29M\s+\$0\s+1/.test(l))).toBe(true);
        expect(out.at(-1)).toBe('… more from --offset 60');
    });

    it('users reads the totals, the routes in and the busiest wallets at once', async () => {
        const calls = mockApi({
            'GET /api/mainnet/console/users': () => ({ payload: { range: '24h', buckets: [], totals: { active: 1359, txs: 3104, prevActive: 1361 } } }),
            'GET /api/mainnet/console/users/arrival': () => ({ payload: { range: '24h', walletTxs: 0, walletCount: 0, totals: { txs: 0, directTxs: 0, routedTxs: 0, doors: 0 }, routes: [] } }),
            'GET /api/mainnet/console/users/arrival/wallets': () => ({ payload: { rows: [], total: 0, nextOffset: null } }),
            'GET /api/mainnet/labels': labels({}),
        });
        const result: any = await run(['users']);
        expect(calls.map((c) => c.path.split('?')[0]).sort()).toEqual(['/api/mainnet/console/users', '/api/mainnet/console/users/arrival', '/api/mainnet/console/users/arrival/wallets']);
        expect(Object.keys(result)).toEqual(['users', 'arrival', 'wallets']);
        expect(printed()[1]).toBe('1,359 active wallets (-0.1% on the previous 24h) · 3,104 transactions');
    });

    it('tvl gives the value now and its change since the start of the window', async () => {
        mockApi({
            'GET /api/mainnet/console/tvl': () => ({
                payload: {
                    range: '24h',
                    slots: [0, 1],
                    stepSec: 900,
                    chains: [{ chainId: 1, contracts: 2, values: [100_000_000, 110_000_000], liveUsd: 110_000_000 }],
                    holdings: [{ chainId: 1, token: STETH, symbol: 'stETH', usd: 110_000_000, amount: 41_000, priceUsd: 2682.02, holders: [{ address: WSTETH, usd: 110_000_000 }] }],
                    totalUsd: 110_000_000,
                    otherUsd: 0,
                    unattributedUsd: 0,
                    holdingsSampledAt: null,
                },
            }),
        });
        await run(['tvl']);
        const out = printed();
        expect(out[1]).toBe('$110.00M now · +$10.00M (+10%) over 24h');
        expect(out.some((l) => /stETH\s+Ethereum\s+41\.0K\s+\$2,682\.02\s+\$110\.00M\s+100\.0%\s+0x7f39…2ca0/.test(l))).toBe(true);
    });

    it('tx looks on every supported chain and reports the one that has it', async () => {
        const hash = `0x${'b'.repeat(64)}`;
        const calls = mockApi({
            'GET /api/mainnet/explorer/tx': (call) =>
                query(call).chainId === '43114'
                    ? {
                          payload: {
                              hash,
                              status: true,
                              blockNumber: 96_499_667,
                              confirmations: 12,
                              timestamp: Math.floor(Date.now() / 1000) - 60,
                              from: '0x1111111111111111111111111111111111111111',
                              to: '0x2222222222222222222222222222222222222222',
                              fromName: null,
                              toName: 'WAVAX',
                              contractCreated: null,
                              valueWei: '2000000000000000000',
                              selector: '0xd0e30db0',
                              methodName: 'deposit',
                              nonce: 7,
                              gasUsed: 45_000,
                              gasLimit: 60_000,
                              effectiveGasPriceGwei: 1.5,
                              feeWei: '67500000000000',
                              call: { method: 'deposit', signature: 'deposit()', args: [] },
                              transfers: [],
                              logs: [],
                          },
                      }
                    : { status: 404, payload: { error: 'Transaction not found' } },
        });
        const result: any = await run(['tx', hash]);
        expect(calls.map((c) => query(c).chainId).sort()).toEqual(['1', '11155111', '42161', '43114']);
        expect(result.chainId).toBe(43114);
        const out = printed();
        expect(out[0]).toBe(`${hash} · Avalanche · success`);
        expect(out).toContain('  Value  2 AVAX');
        expect(out).toContain('  Call   deposit()');
    });

    it('tx with --chain asks that chain only and says plainly when it is not there', async () => {
        const calls = mockApi({ 'GET /api/mainnet/explorer/tx': () => ({ status: 404, payload: { error: 'Transaction not found' } }) });
        await expect(run(['tx', `0x${'c'.repeat(64)}`, '--chain', 'arbitrum'])).rejects.toThrow(`No transaction 0x${'c'.repeat(64)} on Arbitrum.`);
        expect(calls).toHaveLength(1);
    });

    it('a rate-limited key gets the server\'s words, with no retry', async () => {
        const calls = mockApi({ 'GET /api/mainnet/console/flows': () => ({ status: 429, payload: { error: 'Too many requests from this API key. Retry in 39s.', code: 'RATE_LIMITED' } }) });
        await expect(run(['flows'])).rejects.toThrow('Too many requests from this API key. Retry in 39s.');
        expect(calls).toHaveLength(1);
    });
});
