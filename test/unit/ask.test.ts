import { findCommand, describeCommand, fmtByUnit, fmtChangePct, scopeFromFlags } from '../../src/cli/commands/ask';
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

