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

    it('flows on an ERC-20 adds the token\'s own senders and receivers, holder to holder', async () => {
        const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
        const now = Date.now();
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({
                payload: { accounts: [{ id: 'a3', chainId: 1, chainIds: [1], address: USDC, accountType: 'contract', name: 'USDC', valueUsd: 0, standards: ['erc20'] }] },
            }),
            'GET /api/mainnet/console/flows': () => ({ payload: { range: '24h', totals: { inUsd: 0, outUsd: 0, transfers: 0, counterparties: 0 }, tokens: [], rows: [], buckets: [] } }),
            'GET /api/mainnet/contract/token-parties': () => ({
                payload: {
                    flow: {
                        inUsd: 812_000_000,
                        outUsd: 812_000_000,
                        inN: 48_210,
                        outN: 48_210,
                        unpricedN: 0,
                        peers: 0,
                        calls: 0,
                        reverts: 0,
                        top: {
                            in: [{ address: '0x28c6c06298d514db089934071355e5743bf21d60', label: 'Binance 14', role: 'exchange', usd: 120_000_000, n: 900, unpriced: 0, reverts: 0, lastTs: now - 60_000 }],
                            out: [{ address: '0x9fb6c242fffd11a5594ac58ab97b9eaa52a8eefe', label: null, role: 'unknown', usd: 50_000_000, n: 40, unpriced: 0, reverts: 0, lastTs: now - 120_000 }],
                        },
                    },
                    unavailable: null,
                },
            }),
        });
        await run(['flows', 'usdc']);
        expect(query(calls.find((c) => c.path.startsWith('/api/mainnet/contract/token-parties'))!)).toEqual({ chainId: '1', address: USDC });
        const out = printed();
        expect(out).toContain('\nThe token itself, holder to holder · last 24h');
        expect(out).toContain('  $812.00M moved in 48,210 transfers');
        const senders = out.indexOf('\n  Top senders');
        const receivers = out.indexOf('\n  Top receivers');
        expect(senders).toBeGreaterThan(0);
        expect(receivers).toBeGreaterThan(senders);
        expect(out[senders + 2]).toMatch(/^ {4}1\s+Binance 14\s+exchange\s+\$120\.00M\s+900\s+1m\s+0x28c6/);
        expect(out[receivers + 2]).toMatch(/^ {4}1\s+0x9fb6…eefe\s+unknown\s+\$50\.00M\s+40\s+2m\s+0x9fb6/);
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

    it('events reads the Events tab for a contract and lists what never fired', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/console/events': () => ({
                payload: {
                    range: '24h',
                    rows: [
                        { topic0: '0xaa', name: 'Transfer', signature: 'Transfer(address,address,uint256)', dormant: false, fired: 632, txs: 400, firstAt: null, lastAt: Date.now() - 120_000, spark: [1, 2, 3], prev: { fired: 600 }, contracts: [{ chainId: 1, address: STETH }], contractCount: 1 },
                        { topic0: '0xbb', name: 'Paused', signature: 'Paused()', dormant: true, fired: 0, txs: 0, firstAt: null, lastAt: null, spark: [], prev: null, contracts: [], contractCount: 0 },
                    ],
                    totals: { fired: 632, events: 1, txs: 400, contracts: 1 },
                    buckets: [1, 2, 3],
                    prevTotals: { fired: 600 },
                    abiResolved: true,
                },
            }),
        });
        await run(['events', 'steth']);
        expect(query(calls[1])).toEqual({ range: '24h', chainId: '1', address: STETH });
        const out = printed();
        expect(out[0]).toBe('Lido: stETH · Ethereum · events · last 24h');
        expect(out[1]).toBe('632 events fired (+5.3% on the previous 24h) · 1 kind · in 400 transactions');
        expect(out.some((l) => /^Transfer\(address,address,uint256\)\s+632\s+\+5\.3%\s+400\s+2m/.test(l))).toBe(true);
        expect(out.at(-1)).toBe('\nDeclared but not fired: Paused');
    });

    it('a rate-limited key gets the server\'s words, with no retry', async () => {
        const calls = mockApi({ 'GET /api/mainnet/console/flows': () => ({ status: 429, payload: { error: 'Too many requests from this API key. Retry in 39s.', code: 'RATE_LIMITED' } }) });
        await expect(run(['flows'])).rejects.toThrow('Too many requests from this API key. Retry in 39s.');
        expect(calls).toHaveLength(1);
    });
});
