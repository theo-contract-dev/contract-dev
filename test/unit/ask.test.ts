import { findCommand, describeCommand, compareCommand, activityQueryCommand, fmtByUnit, fmtChangePct, pivotLines, scopeFromFlags } from '../../src/cli/commands/ask';
import { activityCommand } from '../../src/cli/commands/activity';
import { parseFlags } from '../../src/cli/commands/_args';
import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

// The ask commands read the platform's tools; each test pins the input the tool gets and the lines a person sees.
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const POOL = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const POOL_B = '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8';
const ORACLE = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';

const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

describe('find', () => {
    useEnvAuth();

    const found = {
        contracts: [
            { chainId: 1, address: STETH, name: 'Lido: stETH', groups: ['lido'], kinds: ['token', 'proxy'], standards: ['erc20'], tvlUsd: 12_400_000_000 },
            { chainId: 42161, address: POOL, name: 'ETH/USDC pool', groups: [], kinds: ['pool'], standards: [], tvlUsd: null },
        ],
        groups: [{ group: 'lido', contracts: 2 }],
        metrics: [{ id: 'm1', label: 'stETH supply', kind: 'totalSupply', chainId: 1, address: STETH }],
        monitors: [
            { id: 'inv1', name: 'Transfer on Lido: stETH', kind: 'eventFired', status: 'ok' },
            { id: 'inv2', name: 'Treasury floor', kind: null, status: 'breached' },
        ],
        reports: [],
        destinations: [{ id: 'ch2', kind: 'discord_bot', label: '#alerts', target: 'Acme' }],
    };

    it('prints one table per non-empty section, with its count; the query is the positional words', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/find': () => ok(found) });
        const result = await run(['find', 'lido', '--limit', '20']);
        expect(calls[0].body).toEqual({ input: { query: 'lido', limit: 20 } });
        const out = printed();
        expect(out[0]).toBe('Contracts (2)');
        expect(out[1]).toMatch(/^ {2}Chain {2,}Name {2,}Address {2,}Kinds {2,}Groups {2,}TVL$/);
        expect(out[2]).toMatch(new RegExp(`^ {2}Ethereum {2,}Lido: stETH {2,}${STETH} {2,}token, proxy {2,}lido {2,}\\$12\\.40B$`));
        expect(out[3]).toMatch(new RegExp(`^ {2}Arbitrum {2,}ETH/USDC pool {2,}${POOL} {2,}pool {2,}—$`));
        expect(out[4]).toBe('');
        expect(out[5]).toBe('Groups (1)');
        expect(out[7]).toMatch(/^ {2}lido {2,}2$/);
        expect(out[9]).toBe('Metrics (1)');
        expect(out[11]).toMatch(new RegExp(`^ {2}m1 {2,}stETH supply {2,}totalSupply {2,}Ethereum {2,}${STETH}$`));
        expect(out[13]).toBe('Monitors (2)');
        expect(out[15]).toMatch(/^ {2}inv1 {2,}Transfer on Lido: stETH {2,}eventFired {2,}ok$/);
        expect(out[16]).toMatch(/^ {2}inv2 {2,}Treasury floor {2,}custom {2,}breached$/);
        // no Reports block: the section was empty
        expect(out[18]).toBe('Destinations (1)');
        expect(out[20]).toMatch(/^ {2}ch2 {2,}discord_bot {2,}#alerts {2,}Acme$/);
        expect(out).toHaveLength(21);
        expect(result).toEqual(found);
    });

    it('says so when nothing matches, and needs a query', async () => {
        mockApi({ 'POST /api/mainnet/tools/find': () => ok({ contracts: [], groups: [], metrics: [], monitors: [], reports: [], destinations: [] }) });
        await findCommand(['nothing', 'here']);
        expect(printed()).toEqual(['Nothing in this workspace matches "nothing here".']);
        await expect(findCommand(['--limit', '5'])).rejects.toThrow(/Say what to find/);
    });
});

describe('describe', () => {
    useEnvAuth();

    const described = {
        chainId: 1,
        address: STETH,
        name: 'Lido: stETH',
        kinds: ['token', 'proxy'],
        standards: ['erc20', 'eip1967'],
        groups: ['lido', 'core'],
        tvlUsd: 12_400_000_000,
        owner: '0x2e59a20f205bb85a89c53f1936454680651e618e',
        implementation: '0x17144556fd3424edc8fc8a4c940b2d04936d17eb',
        token: { symbol: 'stETH', decimals: 18 },
        events: [
            { name: 'Transfer', signature: 'Transfer(address,address,uint256)', fields: ['from:address', 'to:address', 'value:uint256 (stETH)'] },
            { name: 'Submitted', signature: 'Submitted(address,uint256,address)', fields: ['sender:address', 'amount:uint256 (ETH)', 'referral:address'] },
        ],
        functions: Array.from({ length: 25 }, (_, i) => `fn${i}(uint256)`),
        calls: {
            rows: [{ to: ORACLE, selector: '0xfeaf968c', name: 'latestRoundData', callType: 'STATICCALL', calls: 1204, reverts: 2, lastAt: Date.now() - 3_600_000 }],
            totals: { calls: 1204, reverts: 2 },
            oracles: null,
        },
    };

    it('prints the facts, the events with their fields, the first 20 write functions, and what it calls, named from the address book', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/describe_contract': () => ok(described),
            'GET /api/mainnet/labels': () => ({ payload: { book: { [`1:${ORACLE}`]: { name: 'Chainlink: ETH/USD', category: 'contract' } } } }),
        });
        const result = await run(['describe', 'steth', '--chain', 'ethereum']);
        expect(calls[0].body).toEqual({ input: { contract: 'steth', chainId: 1 } });
        const out = printed();
        expect(out.slice(0, 11)).toEqual([
            'Lido: stETH',
            '  Chain           Ethereum',
            `  Address         ${STETH}`,
            '  Kinds           token, proxy',
            '  Standards       ERC-20, EIP-1967 proxy',
            '  Groups          lido, core',
            '  TVL             $12.40B',
            '  Owner           0x2e59a20f205bb85a89c53f1936454680651e618e',
            '  Implementation  0x17144556fd3424edc8fc8a4c940b2d04936d17eb',
            '  Token           stETH · 18 decimals',
            '',
        ]);
        expect(out[11]).toBe('Events (2)');
        expect(out[12]).toMatch(/^ {2}Name {2,}Fields$/);
        expect(out[13]).toMatch(/^ {2}Transfer {2,}from:address, to:address, value:uint256 \(stETH\)$/);
        expect(out[14]).toMatch(/^ {2}Submitted {2,}sender:address, amount:uint256 \(ETH\), referral:address$/);
        expect(out[16]).toBe('Write functions (20 of 25)');
        expect(out[17]).toBe('  fn0(uint256)');
        expect(out[36]).toBe('  fn19(uint256)');
        expect(out[38]).toBe('Calls (last 7d): 1 contract · 1,204 calls · 2 reverts');
        expect(out[39]).toMatch(/^ {2}Calls into {2,}Method {2,}Type {2,}Calls {2,}Reverts {2,}Last {2,}Address$/);
        expect(out[40]).toMatch(new RegExp(`^ {2}Chainlink: ETH/USD {2,}latestRoundData {2,}staticcall {2,}1,204 {2,}2 {2,}1h {2,}${ORACLE}$`));
        expect(out).toHaveLength(41);
        expect(result).toEqual(described);
    });

    it('a contract without an ABI says so in the facts and has no events or functions block; a dash for an unknown owner', async () => {
        mockApi({ 'POST /api/mainnet/tools/describe_contract': () => ok({ ...described, standards: [], groups: [], tvlUsd: 0, owner: null, implementation: null, token: null, events: null, functions: null, calls: null }) });
        await describeCommand([STETH]);
        const out = printed();
        expect(out.slice(1)).toEqual([
            '  Chain      Ethereum',
            `  Address    ${STETH}`,
            '  Kinds      token, proxy',
            '  Standards  none detected',
            '  Groups     none',
            '  TVL        $0',
            '  Owner      —',
            `  ABI        none known (add one with contract-dev contracts set-abi ${STETH} --abi <file>)`,
        ]);
    });

    it("surfaces the tool's refusal verbatim", async () => {
        mockApi({ 'POST /api/mainnet/tools/describe_contract': () => ({ status: 404, payload: { ok: false, error: 'No watched contract is called "nope".', code: 'NOT_FOUND' } }) });
        await expect(describeCommand(['nope'])).rejects.toThrow('No watched contract is called "nope".');
    });
});

describe('compare', () => {
    useEnvAuth();

    const ranking = (over: Record<string, unknown>) => ({
        scope: 'pools',
        window: '7d',
        by: 'volumeInUsd',
        event: null,
        unit: 'usd',
        rows: [
            { chainId: 1, address: POOL, name: 'Pool A', value: 1_250_000, prev: 1_000_000, changePct: 25 },
            { chainId: 1, address: POOL_B, name: 'Pool B', value: 0, prev: null, changePct: null },
        ],
        ...over,
    });

    it('--group scopes the ranking; dollars print as dollars, a measured zero as $0 and no base as a dash', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/compare_activity': () => ok(ranking({})) });
        const result = await run(['compare', '--group', 'pools', '--by', 'volumeInUsd', '--window', '7d', '--limit', '10']);
        expect(calls[0].body).toEqual({ input: { scope: { kind: 'group', group: 'pools' }, window: '7d', by: 'volumeInUsd', limit: 10 } });
        const out = printed();
        expect(out[0]).toBe('pools · by volumeInUsd · last 7d');
        expect(out[1]).toBe('');
        expect(out[2]).toMatch(/^Name {2,}Value {2,}Previous {2,}Change$/);
        expect(out[3]).toMatch(/^Pool A {2,}\$1\.25M {2,}\$1\.00M {2,}\+25%$/);
        expect(out[4]).toMatch(/^Pool B {2,}\$0 {2,}— {2,}—$/);
        expect(result).toEqual(ranking({}));
    });

    it('a share prints as a percentage, a count with its thousands; --by events sends the event; the whole workspace is the default scope', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/compare_activity': (c) =>
                ok(
                    c.body.input.by === 'revertedShare'
                        ? ranking({ scope: 'workspace', by: 'revertedShare', unit: 'share', rows: [{ chainId: 1, address: POOL, name: 'Pool A', value: 0.07, prev: 0.05, changePct: 40 }] })
                        : ranking({ scope: 'workspace', by: 'events', event: 'Swap', unit: 'count', rows: [{ chainId: 1, address: POOL, name: 'Pool A', value: 1234, prev: 1180, changePct: 4.5762 }] }),
                ),
        });
        await compareCommand(['--by', 'revertedShare']);
        expect(calls[0].body).toEqual({ input: { window: '7d', by: 'revertedShare' } });
        expect(printed()[0]).toBe('Workspace · by revertedShare · last 7d');
        expect(printed()[3]).toMatch(/^Pool A {2,}7\.0% {2,}5\.0% {2,}\+40%$/);
        await compareCommand(['--by', 'events', '--event', 'Swap', '--chain', 'arbitrum']);
        expect(calls[1].body).toEqual({ input: { scope: { kind: 'workspace', chainId: 42161 }, window: '7d', by: 'events', event: 'Swap' } });
        expect(printed()[4]).toBe('Workspace · by events Swap · last 7d');
        expect(printed()[7]).toMatch(/^Pool A {2,}1,234 {2,}1,180 {2,}\+4\.6%$/);
    });

    it('says when the plan served a shorter window than asked, and when the scope holds nothing', async () => {
        mockApi({ 'POST /api/mainnet/tools/compare_activity': () => ok(ranking({ scope: 'Lido: stETH', window: '24h', rows: [] })) });
        await compareCommand(['--contract', 'steth', '--window', '30d']);
        expect(printed()).toEqual(['Lido: stETH · by volumeInUsd · last 24h', "Showing 24h: this workspace's plan keeps 24h of history.", 'No contracts in scope.']);
    });

    it('refuses a bad measure or window, events without the event, and two scopes', async () => {
        const calls = mockApi({});
        await expect(compareCommand(['--by', 'trades'])).rejects.toThrow(/--by must be one of transactions, activeWallets/);
        await expect(compareCommand(['--window', '2d'])).rejects.toThrow(/--window must be one of 1h, 24h, 7d, 30d, 90d/);
        await expect(compareCommand(['--by', 'events'])).rejects.toThrow(/--by events needs --event <name>/);
        await expect(compareCommand(['--event', 'Swap'])).rejects.toThrow(/--event goes with --by events/);
        await expect(compareCommand(['--group', 'pools', '--contract', 'steth'])).rejects.toThrow(/Pick one of --group or --contract/);
        expect(calls).toHaveLength(0);
    });

    it('fmtByUnit / fmtChangePct / scopeFromFlags', () => {
        expect(fmtByUnit(1500, 'usd')).toBe('$1.5K');
        expect(fmtByUnit(0.125, 'share')).toBe('12.5%');
        expect(fmtByUnit(12345, 'count')).toBe('12,345');
        expect(fmtByUnit(null, 'count')).toBe('—');
        expect(fmtChangePct(4.56)).toBe('+4.6%');
        expect(fmtChangePct(-12.4)).toBe('-12%');
        expect(fmtChangePct(0)).toBe('0%');
        expect(fmtChangePct(null)).toBe('—');
        expect(scopeFromFlags(parseFlags([]))).toBeUndefined();
        expect(scopeFromFlags(parseFlags(['--contract', STETH, '--chain', '1']))).toEqual({ kind: 'contract', contract: STETH, chainId: 1 });
        expect(scopeFromFlags(parseFlags(['--group', 'pools']))).toEqual({ kind: 'group', group: 'pools' });
    });
});

describe('activity query', () => {
    useEnvAuth();

    const counts = (over: Record<string, unknown>) => ({
        scope: 'pools',
        window: '7d',
        measure: 'events',
        groupBy: ['contract', 'day'],
        unknownEvents: [],
        unavailable: null,
        rows: [
            { chainId: 1, address: POOL, name: 'Pool A', day: '2026-10-11', value: 10 },
            { chainId: 1, address: POOL, name: 'Pool A', day: '2026-10-12', value: 15 },
            { chainId: 1, address: POOL_B, name: 'Pool B', day: '2026-10-12', value: 40 },
        ],
        ...over,
    });

    it('grouped by contract and day prints a pivot: a row per contract, a column per day, a total; a day with nothing is 0', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/query_activity': () => ok(counts({})) });
        const result = await run(['activity', 'query', '--measure', 'events', '--event', 'Swap', '--group', 'pools', '--by', 'contract,day', '--tz', 'UTC']);
        expect(calls[0].body).toEqual({ input: { scope: { kind: 'group', group: 'pools' }, measure: 'events', window: '7d', timezone: 'UTC', events: ['Swap'], groupBy: ['contract', 'day'] } });
        const out = printed();
        expect(out[0]).toBe('pools · events Swap · last 7d · by contract, day · days in UTC');
        expect(out[1]).toBe('');
        expect(out[2]).toMatch(/^Contract {2,}2026-10-11 {2,}2026-10-12 {2,}Total$/);
        expect(out[3]).toMatch(/^Pool B {2,}0 {2,}40 {2,}40$/);
        expect(out[4]).toMatch(/^Pool A {2,}10 {2,}15 {2,}25$/);
        expect(out).toHaveLength(5);
        expect(result).toEqual(counts({}));
    });

    it('wallets do not add up across days, so their pivot has no total; grouped by event, a plain table; repeated and comma --event', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/query_activity': (c) =>
                ok(
                    c.body.input.measure === 'wallets'
                        ? counts({ scope: 'workspace', measure: 'wallets', rows: [{ chainId: 1, address: POOL, name: 'Pool A', day: '2026-10-12', value: 3 }] })
                        : counts({ scope: 'Pool A', groupBy: ['event'], rows: [{ event: 'Swap', value: 120 }, { event: 'Mint', value: 4 }] }),
                ),
        });
        await activityCommand(['query', '--measure', 'wallets', '--tz', 'UTC']);
        expect(calls[0].body).toEqual({ input: { measure: 'wallets', window: '7d', timezone: 'UTC' } });
        expect(printed()[0]).toBe('Workspace · wallets · last 7d · by contract, day · days in UTC');
        expect(printed()[2]).toMatch(/^Contract {2,}2026-10-12$/);
        expect(printed()[3]).toMatch(/^Pool A {2,}3$/);

        await activityQueryCommand(['--measure', 'events', '--event', 'Swap,Mint', '--event', 'Burn', '--contract', 'pool a', '--by', 'event', '--window', '30d', '--tz', 'UTC']);
        expect(calls[1].body).toEqual({ input: { scope: { kind: 'contract', contract: 'pool a' }, measure: 'events', window: '30d', timezone: 'UTC', events: ['Swap', 'Mint', 'Burn'], groupBy: ['event'] } });
        const out = printed().slice(4);
        expect(out[0]).toBe('Pool A · events Swap, Mint, Burn · last 7d · by event');
        expect(out[1]).toBe("Showing 7d: this workspace's plan keeps 7d of history.");
        expect(out[3]).toMatch(/^Event {2,}Events$/);
        expect(out[4]).toMatch(/^Swap {2,}120$/);
        expect(out[5]).toMatch(/^Mint {2,}4$/);
    });

    it('names the events nobody declares, says when the store is unavailable or the window is empty', async () => {
        mockApi({ 'POST /api/mainnet/tools/query_activity': (c) => ok(c.body.input.events?.[0] === 'Nope' ? counts({ unknownEvents: ['Nope'], rows: [] }) : counts({ unavailable: 'store', rows: [] })) });
        await activityQueryCommand(['--measure', 'events', '--event', 'Nope', '--tz', 'UTC']);
        expect(printed().slice(1)).toEqual(['No contract in scope declares "Nope".', 'No events in the window.']);
        await activityQueryCommand(['--measure', 'transactions', '--tz', 'UTC']);
        expect(printed().slice(4)).toEqual(['Data unavailable. Retry in a moment.']);
    });

    it('refuses a missing or unknown measure, --event off events, an unknown dimension, a bad zone', async () => {
        const calls = mockApi({});
        await expect(activityQueryCommand([])).rejects.toThrow(/--measure is required: one of events, transactions, wallets/);
        await expect(activityQueryCommand(['--measure', 'swaps'])).rejects.toThrow(/--measure must be one of/);
        await expect(activityQueryCommand(['--measure', 'transactions', '--event', 'Swap'])).rejects.toThrow(/--event goes with --measure events/);
        await expect(activityQueryCommand(['--measure', 'events', '--by', 'contract,hour'])).rejects.toThrow(/--by must name contract, day, event \(got: hour\)/);
        await expect(activityQueryCommand(['--measure', 'events', '--tz', 'Mars/Olympus'])).rejects.toThrow(/--tz must be an IANA zone name/);
        expect(calls).toHaveLength(0);
    });

    it('pivotLines keys a contract by its event too when grouped by event', () => {
        const lines = pivotLines(
            [
                { chainId: 1, address: POOL, name: 'Pool A', day: '2026-10-11', event: 'Swap', value: 2 },
                { chainId: 1, address: POOL, name: 'Pool A', day: '2026-10-11', event: 'Mint', value: 1 },
            ],
            'events',
        );
        expect(lines[0]).toMatch(/^Contract · Event {2,}2026-10-11 {2,}Total$/);
        expect(lines[1]).toMatch(/^Pool A · Swap {2,}2 {2,}2$/);
        expect(lines[2]).toMatch(/^Pool A · Mint {2,}1 {2,}1$/);
    });
});
