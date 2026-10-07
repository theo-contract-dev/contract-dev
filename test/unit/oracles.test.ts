import { run } from '../../src/cli/index';
import { fmtFeedValue, fmtHeartbeat, fmtSpan, oracleLines } from '../../src/cli/commands/oracles';
import { mockApi, useEnvAuth, printed, RecordedCall } from './_mockApi';

// The price feeds a contract reads (Dependencies › Oracles) and one feed on its own (the
// address page's panel): the rows the CLI prints, and the routes it asks for them.
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const ETH_USD = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
const USDC_USD = '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6';
const SEQUENCER = '0xfdb631f5ee196f0ed6faa767959853a9f217697d';
const query = (call: RecordedCall) => Object.fromEntries(new URLSearchParams(call.path.split('?')[1] ?? ''));

const accounts = () => ({
    payload: { accounts: [{ id: 'a1', chainId: 1, chainIds: [1], address: STETH, accountType: 'contract', name: 'Lido: stETH', valueUsd: 1 }] },
});

const feedRow = (now: number, over: Record<string, unknown>) => ({
    address: ETH_USD,
    role: 'proxy',
    name: 'ETH / USD',
    path: 'eth-usd',
    kind: 'price',
    base: 'ETH',
    quote: 'USD',
    decimals: 8,
    heartbeat: 3600,
    deviation: 0.5,
    tier: 'Low',
    marketHours: 'Crypto',
    shutdown: null,
    judged: true,
    value: 2412.18,
    updatedAt: now - 720_000,
    ageSec: 720,
    verdict: 'fresh',
    reads: 1204,
    reverted: 0,
    lastReadAt: now - 60_000,
    selector: '0xfeaf968c',
    stalestReadSec: 3480,
    stalestIsFloor: false,
    ...over,
});

describe('oracle formatting', () => {
    it('prints spans in hours up to two days, heartbeats as Chainlink states them, values in the feed\'s terms', () => {
        expect(fmtSpan(12)).toBe('12s');
        expect(fmtSpan(2340)).toBe('39m');
        expect(fmtSpan(24 * 3600 + 31 * 60)).toBe('24h 31m');
        expect(fmtSpan(3 * 86400 + 2 * 3600)).toBe('3d 2h');
        expect(fmtSpan(null)).toBe('—');
        expect(fmtHeartbeat(3600)).toBe('1h');
        expect(fmtHeartbeat(86400)).toBe('24h');
        expect(fmtHeartbeat(300)).toBe('5m');
        expect(fmtHeartbeat(null)).toBe('—');
        expect(fmtFeedValue(2412.18, { kind: 'price', quote: 'USD' })).toBe('$2,412.18');
        expect(fmtFeedValue(0.99991, { kind: 'price', quote: 'USD' })).toBe('$0.9999');
        expect(fmtFeedValue(0.0412, { kind: 'price', quote: 'ETH' })).toBe('0.0412 ETH');
        expect(fmtFeedValue(1.2096, { kind: 'rate', quote: 'stETH' })).toBe('1.2096');
        expect(fmtFeedValue(null, { kind: 'price', quote: 'USD' })).toBe('—');
    });

    it('says when a half of the read is missing, and prints nothing for no feeds', () => {
        expect(oracleLines({ feeds: [], readAt: 1, partial: null })).toEqual([]);
        const now = Date.now();
        const lines = oracleLines({ feeds: [feedRow(now, { value: null, ageSec: null, updatedAt: null, verdict: null })], readAt: now, partial: 'rpc' });
        expect(lines[0]).toBe('Price feeds it reads: 1 · read 0s ago');
        expect(lines[1]).toBe('Readings unavailable: the values and verdicts could not be read right now.');
        expect(lines[3]).toMatch(/^ {2}ETH \/ USD\s+—\s+—\s+1h\s+—\s+58m\s+1,204\s+0x5f4e/);
    });
});

describe('dependencies and address with Chainlink feeds', () => {
    useEnvAuth();

    it('dependencies prints the feeds it reads above the call list: value, age, heartbeat, verdict, stalest read, reads', async () => {
        const now = Date.now();
        const calls = mockApi({
            'GET /api/mainnet/accounts': accounts,
            'GET /api/mainnet/labels': () => ({ payload: { book: {} } }),
            'GET /api/mainnet/console/dependencies': () => ({
                payload: {
                    chainId: 1,
                    address: STETH,
                    range: '24h',
                    rows: [
                        { to: ETH_USD, selector: '0xfeaf968c', name: 'latestRoundData', callType: 'STATICCALL', calls: 1204, reverts: 0, lastAt: now - 60_000 },
                        { to: USDC_USD, selector: '0xfeaf968c', name: 'latestRoundData', callType: 'STATICCALL', calls: 312, reverts: 2, lastAt: now - 90_000 },
                        { to: SEQUENCER, selector: '0xfeaf968c', name: 'latestRoundData', callType: 'STATICCALL', calls: 12, reverts: 0, lastAt: now - 500_000 },
                    ],
                    totals: { calls: 1528, reverts: 2 },
                    oracles: {
                        feeds: [
                            feedRow(now, {}),
                            feedRow(now, {
                                address: USDC_USD,
                                name: 'USDC / USD',
                                base: 'USDC',
                                heartbeat: 86400,
                                value: 0.9999,
                                ageSec: 24 * 3600 + 31 * 60,
                                updatedAt: now - (24 * 3600 + 31 * 60) * 1000,
                                verdict: 'late',
                                reads: 310,
                                reverted: 2,
                                stalestReadSec: 24 * 3600 + 58 * 60,
                                stalestIsFloor: true,
                            }),
                            feedRow(now, {
                                address: SEQUENCER,
                                role: 'svrProxy',
                                name: 'Sequencer Uptime · SVR',
                                kind: 'sequencer',
                                base: null,
                                quote: null,
                                heartbeat: null,
                                deviation: null,
                                judged: false,
                                value: 1,
                                ageSec: 500,
                                updatedAt: now - 500_000,
                                verdict: null,
                                reads: 12,
                                stalestReadSec: null,
                            }),
                        ],
                        readAt: now - 12_000,
                        partial: null,
                    },
                },
            }),
        });
        await run(['dependencies', 'steth']);
        expect(query(calls.find((c) => c.path.startsWith('/api/mainnet/console/dependencies'))!)).toEqual({ chainId: '1', address: STETH, range: '24h' });
        const out = printed();
        expect(out[0]).toBe('Lido: stETH · Ethereum · what it calls · last 24h');
        const summary = out.findIndex((l) => l === 'Price feeds it reads: 3 · 1 late · read 12s ago');
        expect(summary).toBeGreaterThan(0);
        expect(out[summary + 1]).toMatch(/^ {2}Feed\s+Value\s+Updated\s+Heartbeat\s+Status\s+Stalest read\s+Reads\s+Address$/);
        expect(out[summary + 2]).toMatch(/^ {2}ETH \/ USD\s+\$2,412\.18\s+12m ago\s+1h\s+Fresh\s+58m\s+1,204\s+0x5f4e/);
        expect(out[summary + 3]).toMatch(/^ {2}USDC \/ USD\s+\$0\.9999\s+24h 31m ago\s+24h\s+Late\s+24h 58m\+\s+310 · 2 reverted\s+0x8fff/);
        expect(out[summary + 4]).toMatch(/^ {2}Sequencer Uptime · SVR \(SVR proxy\)\s+1\.00\s+8m ago\s+—\s+Not assessed\s+—\s+12\s+0xfdb6/);
        // the call list follows, as the tab orders them
        const calleesLine = out.findIndex((l) => l.startsWith('3 contracts · 1,528 calls · 2 reverts'));
        expect(calleesLine).toBeGreaterThan(summary);
    });

    it('address prints the feed panel the route carries: what it is, what it reads now, its terms, its addresses', async () => {
        const now = Date.now();
        mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'GET /api/mainnet/explorer/address': () => ({
                payload: {
                    address: ETH_USD,
                    balanceWei: '0',
                    nonce: 1,
                    isContract: true,
                    identity: { name: 'EACAggregatorProxy', verified: true, proxy: false, implementation: null, deployer: null, deployedAt: null },
                    feed: {
                        ...feedRow(now, { shutdown: '2099-01-31' }),
                        proxy: ETH_USD,
                        svrProxy: '0x1111111111111111111111111111111111111111',
                        svrLabel: 'SVR proxy',
                        aggregator: '0x2222222222222222222222222222222222222222',
                        readAt: now,
                    },
                    txs: [],
                },
            }),
        });
        await run(['address', ETH_USD]);
        const out = printed();
        expect(out[0]).toBe(`${ETH_USD} · Ethereum · contract`);
        expect(out.find((l) => l.startsWith('  Chainlink feed'))).toMatch(/^ {2}Chainlink feed\s+ETH \/ USD · price · proxy$/);
        expect(out.find((l) => l.startsWith('  Reading'))).toMatch(/^ {2}Reading\s+\$2,412\.18 · updated 12m ago \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\) · heartbeat 1h · Fresh$/);
        expect(out.find((l) => l.startsWith('  Terms'))).toMatch(/^ {2}Terms\s+deviation 0\.5% · tier Low · Crypto hours · shutdown announced for 2099-01-31$/);
        expect(out.find((l) => l.startsWith('  Addresses'))).toMatch(/^ {2}Addresses\s+proxy 0x5f4e.* · SVR proxy 0x1111.* · aggregator 0x2222.*$/);
    });

    it('address asks for the feed itself when the route ran out of time, and prints nothing for an address that is no feed', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'GET /api/mainnet/explorer/address': () => ({
                payload: { address: STETH, balanceWei: '0', nonce: 1, isContract: true, identity: null, txs: [] },
            }),
            'GET /api/mainnet/oracles/feed': () => ({ payload: { chainId: 1, address: STETH, feed: null } }),
        });
        await run(['address', STETH, '--chain', 'ethereum']);
        const feedCall = calls.find((c) => c.path.startsWith('/api/mainnet/oracles/feed'))!;
        expect(query(feedCall)).toEqual({ chainId: '1', address: STETH });
        expect(printed().some((l) => l.includes('Chainlink feed'))).toBe(false);
    });
});
