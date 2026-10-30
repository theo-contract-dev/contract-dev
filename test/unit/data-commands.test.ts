import { run } from '../../src/cli/index';
import { CHAIN_NAMES } from '../../src/cli/commands/watch';
import { mockApi, useEnvAuth, printed, RecordedCall } from './_mockApi';

// The data commands read the routes the dashboard pages read. These tests pin what each one
// asks for (so the CLI and the app keep agreeing) and the lines a person sees.
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';

const accounts = () => ({
    payload: {
        accounts: [
            { id: 'a1', chainId: 1, chainIds: [1], address: STETH, accountType: 'contract', name: 'Lido: stETH' },
            { id: 'a2', chainId: 1, chainIds: [1], address: WSTETH, accountType: 'contract', name: 'Lido: wstETH' },
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
        // every chain the CLI knows, from the one list the explorer commands read (28 chains joined on 2026-10-27; a hand-kept list here drifted)
        expect(calls.map((c) => query(c).chainId).sort()).toEqual(Array.from(new Set(Object.values(CHAIN_NAMES))).map(String).sort());
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
        const calls = mockApi({ 'GET /api/mainnet/accounts': () => ({ status: 429, payload: { error: 'Too many requests from this API key. Retry in 39s.', code: 'RATE_LIMITED' } }) });
        await expect(run(['contracts', 'list'])).rejects.toThrow('Too many requests from this API key. Retry in 39s.');
        expect(calls).toHaveLength(1);
    });
});
