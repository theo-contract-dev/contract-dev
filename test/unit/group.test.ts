import { groupCommand, factoryCommand, fmtColumnValue, groupLines } from '../../src/cli/commands/group';
import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

// The group commands read and write through the platform's tools; each test pins the input the tool gets and the lines a person sees.
const FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
const POOL_A = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const POOL_B = '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8';
const POOL_C = '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36';
const TOPIC = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';

const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

describe('group show', () => {
    useEnvAuth();

    const described = {
        group: 'pools',
        contracts: 14,
        namePattern: '{token0().symbol()}/{token1().symbol()} pool',
        rules: [
            { id: 'r1', kind: 'factory', chainId: 1, address: FACTORY, topic0: TOPIC, field: { topic: 3 }, lastSyncAt: '2026-10-13T03:19:00.000Z' },
            { id: 'r2', kind: 'registry', chainId: 42161, address: POOL_C, function: 'getAllMarkets()', lastSyncAt: null },
        ],
        columns: [
            { key: 'tvl', label: 'TVL', read: 'totalAssets()', args: [], word: 0, decimals: 0, decimalsFrom: 'decimals()', unit: 'usd', kind: 'function' },
            { key: 'util', label: 'Utilisation', read: 'utilization(address)', args: [POOL_A], word: 0, decimals: 16, decimalsFrom: null, unit: 'pct', kind: 'function' },
        ],
        monitors: [
            { id: 'inv1', name: 'Pool draining', column: 'tvl', when: 'below', threshold: 1_000_000, otherColumn: null, warnPct: 10, contracts: 14, states: { ok: 12, warning: 1, breached: 1 } },
            { id: 'inv2', name: 'Over-utilised', column: 'util', when: 'above', threshold: null, otherColumn: 'cap', warnPct: null, contracts: 14, states: {} },
        ],
        members: [
            { chainId: 1, address: POOL_A, name: 'USDC/WETH pool', values: { tvl: 1_250_000, util: 95 } },
            { chainId: 1, address: POOL_B, name: 'WBTC/WETH pool', values: { tvl: 0, util: null } },
        ],
        membersMore: 12,
    };

    it('prints the header, the name pattern, then rules, columns, monitors and members with a column per table column', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/describe_group': () => ok(described) });
        const result = await run(['group', 'show', 'pools']);
        expect(calls[0].body).toEqual({ input: { group: 'pools' } });
        const out = printed();
        expect(out[0]).toBe('pools · 14 contracts');
        expect(out[1]).toBe('Name pattern: {token0().symbol()}/{token1().symbol()} pool');
        expect(out[2]).toBe('');
        expect(out[3]).toBe('Rules (2)');
        expect(out[4]).toMatch(/^ {2}Kind {2,}Chain {2,}Address {2,}Reads {2,}Last sync {2,}Filled$/);
        expect(out[5]).toMatch(new RegExp(`^ {2}factory {2,}Ethereum {2,}${FACTORY} {2,}0x783c…7118 · topic 3 {2,}2026-10-13 03:19 UTC {2,}—$`));
        expect(out[6]).toMatch(new RegExp(`^ {2}registry {2,}Arbitrum {2,}${POOL_C} {2,}getAllMarkets\\(\\) {2,}never {2,}—$`));
        expect(out[7]).toBe('');
        expect(out[8]).toBe('Columns (2)');
        expect(out[9]).toMatch(/^ {2}Key {2,}Label {2,}Read {2,}Unit {2,}Decimals$/);
        expect(out[10]).toMatch(/^ {2}tvl {2,}TVL {2,}totalAssets\(\) {2,}usd {2,}from decimals\(\)$/);
        expect(out[11]).toMatch(/^ {2}util {2,}Utilisation {2,}utilization\(address\) \(0x88e6.*… {2,}pct {2,}16$/);
        expect(out[12]).toBe('');
        expect(out[13]).toBe('Monitors (2)');
        expect(out[14]).toMatch(/^ {2}Name {2,}Column {2,}When {2,}Contracts {2,}States$/);
        expect(out[15]).toMatch(/^ {2}Pool draining {2,}tvl {2,}below 1\.00M \(warn 10% before\) {2,}14 {2,}ok 12 · warning 1 · breached 1$/);
        expect(out[16]).toMatch(/^ {2}Over-utilised {2,}util {2,}above cap {2,}14 {2,}—$/);
        expect(out[17]).toBe('');
        expect(out[18]).toBe('Members (2 of 14)');
        expect(out[19]).toMatch(/^ {2}Chain {2,}Name {2,}Address {2,}tvl {2,}util$/);
        expect(out[20]).toMatch(new RegExp(`^ {2}Ethereum {2,}USDC/WETH pool {2,}${POOL_A} {2,}\\$1\\.25M {2,}95%$`));
        expect(out[21]).toMatch(new RegExp(`^ {2}Ethereum {2,}WBTC/WETH pool {2,}${POOL_B} {2,}\\$0 {2,}—$`));
        expect(out).toHaveLength(22);
        expect(result).toEqual(described);
    });

    it('an empty group says so, one line per section; `group <name>` and `groups` read as show', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/describe_group': () => ok({ group: 'empty', contracts: 0, namePattern: null, rules: [], columns: [], monitors: [], members: [] }) });
        await run(['groups', 'empty']);
        expect(calls[0].body).toEqual({ input: { group: 'empty' } });
        expect(printed()).toEqual(['empty · 0 contracts', '', 'No rules.', '', 'No columns.', '', 'No monitors.', '', 'No members.']);
        await groupCommand(['show']);
        expect(printed().at(-1)).toMatch(/^contract-dev group — /);
        expect(calls).toHaveLength(1);
    });

    it("surfaces the tool's refusal verbatim", async () => {
        mockApi({ 'POST /api/mainnet/tools/describe_group': () => ({ status: 404, payload: { ok: false, error: 'No group is called "nope".', code: 'NOT_FOUND' } }) });
        await expect(groupCommand(['show', 'nope'])).rejects.toThrow('No group is called "nope".');
    });

    it('fmtColumnValue prints each unit its own way: dollars, a count, a percentage as sent, else compact; the dash is unknown', () => {
        expect(fmtColumnValue(1_250_000, 'usd')).toBe('$1.25M');
        expect(fmtColumnValue(12345, 'int')).toBe('12,345');
        expect(fmtColumnValue(95, 'pct')).toBe('95%');
        expect(fmtColumnValue(0, 'pct')).toBe('0%');
        expect(fmtColumnValue(86400, 'duration')).toBe('86.4K');
        expect(fmtColumnValue(0.0425, 'rate')).toBe('0.0425');
        expect(fmtColumnValue(null, 'usd')).toBe('—');
    });
});

describe('group rule add', () => {
    useEnvAuth();

    it('--preview sends preview and prints what it reads, the name pattern, the contracts found and the note; nothing saved', async () => {
        const previewed = {
            preview: true,
            group: 'pools',
            rule: { kind: 'factory', chainId: 1, address: FACTORY, event: 'PoolCreated', field: 'pool' },
            namePattern: '{token0().symbol()} pool',
            sample: [
                { address: POOL_A, name: 'USDC pool' },
                { address: POOL_B, name: null },
            ],
            note: 'The history was read through 2026-09-01; the rest syncs once saved.',
        };
        const calls = mockApi({ 'POST /api/mainnet/tools/create_watch_rule': () => ok(previewed) });
        const result = await run(['group', 'rule', 'add', 'pools', '--factory', FACTORY, '--event', 'PoolCreated', '--field', 'pool', '--chain', 'ethereum', '--name-pattern', '{token0().symbol()} pool', '--preview']);
        expect(calls[0].body).toEqual({ input: { group: 'pools', chainId: 1, factory: FACTORY, event: 'PoolCreated', field: 'pool', namePattern: '{token0().symbol()} pool', preview: true } });
        const out = printed();
        expect(out.slice(0, 5)).toEqual(['Preview: nothing saved.', `Factory ${FACTORY} on Ethereum · reads PoolCreated.pool`, 'Name pattern: {token0().symbol()} pool', '', 'Found (2)']);
        expect(out[5]).toMatch(/^ {2}Name {2,}Address$/);
        expect(out[6]).toMatch(new RegExp(`^ {2}USDC pool {2,}${POOL_A}$`));
        expect(out[7]).toMatch(new RegExp(`^ {2}— {2,}${POOL_B}$`));
        expect(out.slice(8)).toEqual(['', 'The history was read through 2026-09-01; the rest syncs once saved.']);
        expect(result).toEqual(previewed);
    });

    it('a registry rule is created with its function; the chain by name; the sync tally and each failed address print', async () => {
        const created = {
            group: 'markets',
            rule: { id: 'r7', kind: 'registry', chainId: 42161, address: POOL_C, function: 'getAllMarkets()' },
            namePattern: null,
            sample: [{ address: POOL_A, name: 'Market A' }],
            sync: { discovered: 3, tagged: 3, watched: 2, pending: 0, failed: [{ address: POOL_B, reason: 'no code at this address' }] },
        };
        const calls = mockApi({ 'POST /api/mainnet/tools/create_watch_rule': () => ok(created) });
        await groupCommand(['rule', 'add', 'markets', '--registry', POOL_C, '--function', 'getAllMarkets()', '--chain', 'arbitrum']);
        expect(calls[0].body).toEqual({ input: { group: 'markets', chainId: 42161, registry: POOL_C, function: 'getAllMarkets()' } });
        const out = printed();
        expect(out.slice(0, 4)).toEqual(['Rule r7 added to markets.', `Registry ${POOL_C} on Arbitrum · reads getAllMarkets()`, '', 'Found (1)']);
        expect(out[5]).toMatch(new RegExp(`^ {2}Market A {2,}${POOL_A}$`));
        expect(out.slice(6)).toEqual(['', 'Synced: 3 discovered · 3 tagged · 2 watched · 0 pending · 1 failed', `  failed ${POOL_B} — no code at this address`]);
    });

    it('a factory rule without --chain sends none (the server reads ethereum); without --event the server guesses', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_watch_rule': () => ok({ group: 'pools', rule: { id: 'r1', kind: 'factory', chainId: 1, address: FACTORY, event: 'PoolCreated', field: 'pool' }, namePattern: null, sample: [], sync: { discovered: 0, tagged: 0, watched: 0, pending: 0, failed: [] } }) });
        await groupCommand(['rule', 'add', 'pools', '--factory', FACTORY]);
        expect(calls[0].body).toEqual({ input: { group: 'pools', factory: FACTORY } });
        expect(printed()).toEqual(['Rule r1 added to pools.', `Factory ${FACTORY} on Ethereum · reads PoolCreated.pool`, '', 'Synced: 0 discovered · 0 tagged · 0 watched · 0 pending · 0 failed']);
    });

    it('refuses locally: both sources, neither, a registry without its function, --function on a factory', async () => {
        const calls = mockApi({});
        await expect(groupCommand(['rule', 'add', 'pools', '--factory', FACTORY, '--registry', POOL_C])).rejects.toThrow(/Pick one source: --factory <address> or --registry <address>, not both/);
        await expect(groupCommand(['rule', 'add', 'pools'])).rejects.toThrow(/Say where the contracts come from: --factory <address> or --registry <address>/);
        await expect(groupCommand(['rule', 'add', 'pools', '--registry', POOL_C])).rejects.toThrow(/--registry needs --function/);
        await expect(groupCommand(['rule', 'add', 'pools', '--factory', FACTORY, '--function', 'all()'])).rejects.toThrow(/--function goes with --registry/);
        await expect(groupCommand(['rule', 'add', 'pools', '--registry', POOL_C, '--function', 'all()', '--event', 'X'])).rejects.toThrow(/--event and --field go with --factory/);
        await expect(groupCommand(['rule', 'add', '--factory', FACTORY])).rejects.toThrow(/Missing required group/);
        expect(calls).toHaveLength(0);
    });
});

describe('group name-pattern', () => {
    useEnvAuth();

    it('sends the pattern and prints it, how many it named, and a sample', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/set_name_pattern': () => ok({ group: 'pools', pattern: '{token0().symbol()} pool', named: 12, sample: [{ address: POOL_A, name: 'USDC pool' }], contracts: 14 }) });
        await run(['group', 'name-pattern', 'pools', '{token0().symbol()} pool']);
        expect(calls[0].body).toEqual({ input: { group: 'pools', pattern: '{token0().symbol()} pool' } });
        const out = printed();
        expect(out.slice(0, 4)).toEqual(['Name pattern: {token0().symbol()} pool', 'Named 12 of 14 contracts.', '', 'Sample (1)']);
        expect(out[5]).toMatch(new RegExp(`^ {2}USDC pool {2,}${POOL_A}$`));
        expect(out).toHaveLength(6);
    });

    it('--clear sends an empty pattern; --preview saves nothing', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/set_name_pattern': () => ok({ preview: true, group: 'pools', pattern: null, sample: [], contracts: 14 }) });
        await groupCommand(['name-pattern', 'pools', '--clear', '--preview']);
        expect(calls[0].body).toEqual({ input: { group: 'pools', pattern: '', preview: true } });
        expect(printed()).toEqual(['Preview: nothing saved.', 'Name pattern: none — members keep their own names.']);
    });

    it('needs a pattern or --clear, not both or neither', async () => {
        const calls = mockApi({});
        await expect(groupCommand(['name-pattern', 'pools'])).rejects.toThrow(/Give the pattern in quotes/);
        await expect(groupCommand(['name-pattern', 'pools', 'x pool', '--clear'])).rejects.toThrow(/not both/);
        expect(calls).toHaveLength(0);
    });
});

describe('group column add', () => {
    useEnvAuth();

    it('--preview prints the column line, the first readings in the column\'s unit, and the note', async () => {
        const previewed = {
            preview: true,
            group: 'vaults',
            column: { key: 'assets', label: 'Assets', kind: 'function', signature: 'totalAssets()', args: [], word: 0, decimals: 0, unit: 'usd', decimalsFrom: 'decimals()' },
            sample: [
                { address: POOL_A, name: 'Vault A', value: 1_250_000 },
                { address: POOL_B, name: 'Vault B', value: null },
            ],
            contracts: 3,
            note: 'One vault did not answer.',
        };
        const calls = mockApi({ 'POST /api/mainnet/tools/add_table_column': () => ok(previewed) });
        const result = await run(['group', 'column', 'add', 'vaults', '--label', 'Assets', '--read', 'totalAssets()', '--decimals-from', 'decimals()', '--unit', 'usd', '--preview']);
        expect(calls[0].body).toEqual({ input: { group: 'vaults', label: 'Assets', read: 'totalAssets()', decimalsFrom: 'decimals()', unit: 'usd', preview: true } });
        const out = printed();
        expect(out.slice(0, 4)).toEqual(['Preview: nothing saved.', 'Column assets · Assets · reads totalAssets() · usd · decimals from decimals()', '', 'Readings (2)']);
        expect(out[4]).toMatch(/^ {2}Name {2,}Address {2,}Value$/);
        expect(out[5]).toMatch(new RegExp(`^ {2}Vault A {2,}${POOL_A} {2,}\\$1\\.25M$`));
        expect(out[6]).toMatch(new RegExp(`^ {2}Vault B {2,}${POOL_B} {2,}—$`));
        expect(out.slice(7)).toEqual(['', 'One vault did not answer.']);
        expect(result).toEqual(previewed);
    });

    it('every flag lands in the input: key, args split on commas, word and decimals as numbers, attribute, type', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_table_column': () => ok({ group: 'vaults', column: { key: 'owner', label: 'Owner', kind: 'attribute', signature: 'owner()', args: ['0xabc', '0xdef'], word: 1, decimals: 18, unit: 'raw' }, sample: [], contracts: 3 }) });
        await groupCommand(['column', 'add', 'vaults', '--label', 'Owner', '--read', 'owner()', '--attribute', '--type', 'address', '--key', 'owner', '--args', '0xabc, 0xdef', '--word', '1', '--decimals', '18']);
        expect(calls[0].body).toEqual({ input: { group: 'vaults', label: 'Owner', read: 'owner()', key: 'owner', args: ['0xabc', '0xdef'], word: 1, decimals: 18, attribute: true, type: 'address' } });
        expect(printed()).toEqual(['Added column "Owner" (owner) to vaults · 3 contracts.', 'Column owner · Owner · reads owner() with 0xabc, 0xdef · raw · decimals 18']);
    });

    it('refuses a missing label or read, an unknown unit or type, a word that is not a number', async () => {
        const calls = mockApi({});
        await expect(groupCommand(['column', 'add', 'vaults', '--read', 'totalAssets()'])).rejects.toThrow(/Missing required --label/);
        await expect(groupCommand(['column', 'add', 'vaults', '--label', 'x'])).rejects.toThrow(/Missing required --read/);
        await expect(groupCommand(['column', 'add', 'vaults', '--label', 'x', '--read', 'f()', '--unit', 'bananas'])).rejects.toThrow(/--unit must be one of usd, int, pct, duration, rate, raw/);
        await expect(groupCommand(['column', 'add', 'vaults', '--label', 'x', '--read', 'f()', '--type', 'bytes'])).rejects.toThrow(/--type must be one of address, uint, bool, string/);
        await expect(groupCommand(['column', 'add', 'vaults', '--label', 'x', '--read', 'f()', '--word', 'two'])).rejects.toThrow(/--word must be a number/);
        expect(calls).toHaveLength(0);
    });
});

describe('group monitor add', () => {
    useEnvAuth();

    it('--below sends when and the threshold; prints the sentence and how many contracts it covers', async () => {
        const words = 'Assets below $1.00M on any vault, warning 10% before';
        const calls = mockApi({ 'POST /api/mainnet/tools/add_group_monitor': () => ok({ group: 'vaults', monitor: { id: 'inv9', name: 'Vault draining', columnKey: 'assets', op: 'lt', threshold: 1_000_000, warnPct: 10, words, contracts: 3 }, contracts: 3 }) });
        await run(['group', 'monitor', 'add', 'vaults', '--name', 'Vault draining', '--column', 'assets', '--below', '1000000', '--warn-pct', '10']);
        expect(calls[0].body).toEqual({ input: { group: 'vaults', name: 'Vault draining', column: 'assets', when: 'below', threshold: 1_000_000, warnPct: 10 } });
        expect(printed()).toEqual(['Added monitor "Vault draining" (inv9) to vaults.', words, 'Covers 3 contracts.']);
    });

    it('--above-column compares with another column; --preview saves nothing', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/add_group_monitor': () => ok({ preview: true, group: 'vaults', monitor: { name: 'Over cap', columnKey: 'util', op: 'gt', otherColumnKey: 'cap', words: 'Utilisation above Cap on any vault' }, contracts: 3 }) });
        await groupCommand(['monitor', 'add', 'vaults', '--name', 'Over cap', '--column', 'util', '--above-column', 'cap', '--preview']);
        expect(calls[0].body).toEqual({ input: { group: 'vaults', name: 'Over cap', column: 'util', when: 'above', otherColumn: 'cap', preview: true } });
        expect(printed()).toEqual(['Preview: nothing saved.', 'Utilisation above Cap on any vault', 'Covers 3 contracts.']);
    });

    it('wants exactly one line, as a number', async () => {
        const calls = mockApi({});
        await expect(groupCommand(['monitor', 'add', 'vaults', '--name', 'x', '--column', 'assets'])).rejects.toThrow(/Draw one line: --above <n>, --below <n>, --above-column <key> or --below-column <key>/);
        await expect(groupCommand(['monitor', 'add', 'vaults', '--name', 'x', '--column', 'assets', '--above', '1', '--below', '0'])).rejects.toThrow(/Draw one line/);
        await expect(groupCommand(['monitor', 'add', 'vaults', '--name', 'x', '--column', 'assets', '--above', 'lots'])).rejects.toThrow(/--above must be a number/);
        await expect(groupCommand(['monitor', 'add', 'vaults', '--column', 'assets', '--above', '1'])).rejects.toThrow(/Missing required --name/);
        expect(calls).toHaveLength(0);
    });
});

describe('factory', () => {
    useEnvAuth();

    const deployed = (over: Record<string, unknown> = {}) => ({
        factory: FACTORY,
        chainId: 1,
        events: ['PoolCreated', 'OwnerChanged'],
        used: [{ event: 'PoolCreated', field: 'pool', by: 'heuristic' }],
        candidates: [
            { event: 'PoolCreated', addressArgs: ['token0', 'token1', 'pool'] },
            { event: 'OwnerChanged', addressArgs: ['oldOwner', 'newOwner'] },
        ],
        total: 3,
        complete: false,
        readBackTo: '2026-09-01',
        source: 'history',
        since: null,
        watched: 1,
        notWatched: 2,
        newest: [
            { address: POOL_A, name: 'USDC/WETH 0.05%', at: '2026-10-12', watched: true },
            { address: POOL_B, name: 'WBTC/WETH 0.3%', at: '2026-10-11', watched: false },
            { address: POOL_C, name: null, at: null, watched: false },
        ],
        notWatchedAddresses: [POOL_B, POOL_C],
        ...over,
    });

    it('without --event: says what it guessed, the totals and how far it read, the newest, then the other events so a person can pick', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/factory_contracts': () => ok(deployed()) });
        const result = await run(['factory', FACTORY, '--limit', '50']);
        expect(calls[0].body).toEqual({ input: { factory: FACTORY, limit: 50 } });
        const out = printed();
        expect(out[0]).toBe('Read PoolCreated.pool (guessed)');
        expect(out[1]).toBe('3 contracts · 1 watched · 2 not watched · the newest, back to 2026-09-01; older ones not read');
        expect(out[2]).toBe('');
        expect(out[3]).toMatch(/^Name {2,}Address {2,}Deployed {2,}Watched$/);
        expect(out[4]).toMatch(new RegExp(`^USDC/WETH 0\\.05% {2,}${POOL_A} {2,}2026-10-12 {2,}yes$`));
        expect(out[5]).toMatch(new RegExp(`^WBTC/WETH 0\\.3% {2,}${POOL_B} {2,}2026-10-11 {2,}no$`));
        expect(out[6]).toMatch(new RegExp(`^— {2,}${POOL_C} {2,}— {2,}no$`));
        expect(out[7]).toBe('');
        expect(out[8]).toBe('Guessed from the ABI. Events with an address argument: PoolCreated(token0, token1, pool), OwnerChanged(oldOwner, newOwner) — pass --event <Name> --field <arg> to pick.');
        expect(out).toHaveLength(9);
        expect(result).toEqual(deployed());
    });

    it('with --event and --field: your pick, no candidates line; a complete read over a window says since when', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/factory_contracts': () => ok(deployed({ used: [{ event: 'PoolCreated', field: 'pool', by: 'pick' }], complete: true, readBackTo: null, source: 'window', since: '2026-09-13' })) });
        await factoryCommand([FACTORY, '--chain', 'ethereum', '--event', 'PoolCreated', '--field', 'pool']);
        expect(calls[0].body).toEqual({ input: { factory: FACTORY, chainId: 1, event: 'PoolCreated', field: 'pool' } });
        const out = printed();
        expect(out[0]).toBe('Read PoolCreated.pool (your pick)');
        expect(out[1]).toBe('3 contracts · 1 watched · 2 not watched · the whole history · since 2026-09-13');
        expect(out).toHaveLength(7);
    });

    it('--watch --group watches the ones not watched, with the names the answer knows in the same order, and prints the tally', async () => {
        const watched = { added: 1, alreadyWatched: 0, skipped: [{ address: POOL_C, reason: 'no code at this address' }], failed: [], group: 'pools', chainId: 1 };
        const calls = mockApi({
            'POST /api/mainnet/tools/factory_contracts': () => ok(deployed()),
            'POST /api/mainnet/tools/watch_contracts': () => ok(watched),
        });
        const result = await run(['factory', FACTORY, '--watch', '--group', 'pools']);
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/tools/factory_contracts', '/api/mainnet/tools/watch_contracts']);
        expect(calls[1].body).toEqual({ input: { lookupNames: false, chainId: 1, addresses: [POOL_B, POOL_C], names: ['WBTC/WETH 0.3%', ''], group: 'pools' } });
        const out = printed();
        expect(out.slice(9)).toEqual(['', 'Watched 1 · already watched 0 · skipped 1 (not a contract) · failed 0', `  skipped ${POOL_C} — no code at this address`]);
        expect(result).toEqual({ ...deployed(), watch: watched });
    });

    it('more than 25 to watch go in one call with no --yes; confirmMany goes along', async () => {
        const many = Array.from({ length: 30 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
        const calls = mockApi({
            'POST /api/mainnet/tools/factory_contracts': () => ok(deployed({ total: 31, notWatched: 30, notWatchedAddresses: many, notWatchedMore: 10 })),
            'POST /api/mainnet/tools/watch_contracts': () => ok({ added: 30, alreadyWatched: 0, skipped: [], failed: [], group: 'pools', chainId: 1 }),
        });
        const result: any = await factoryCommand([FACTORY, '--watch', '--group', 'pools']);
        expect(calls).toHaveLength(2);
        expect(calls[1].body.input).toMatchObject({ chainId: 1, group: 'pools', confirmMany: true });
        expect(calls[1].body.input.addresses).toHaveLength(30);
        expect(result.watch.added).toBe(30);
        expect(printed().at(-1)).toBe('Watched 30 · already watched 0 · skipped 0 (not a contract) · failed 0');
    });

    it('nothing to watch says so and makes no second call', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/factory_contracts': () => ok(deployed({ notWatched: 0, notWatchedAddresses: [] })) });
        await factoryCommand([FACTORY, '--watch', '--group', 'pools']);
        expect(calls).toHaveLength(1);
        expect(printed().at(-1)).toBe('Every contract it deployed is watched already.');
    });

    it('--watch needs --group, --group needs --watch, --limit a whole number; help answers', async () => {
        const calls = mockApi({});
        await expect(factoryCommand([FACTORY, '--watch'])).rejects.toThrow(/--watch needs --group <name>/);
        await expect(factoryCommand([FACTORY, '--group', 'pools'])).rejects.toThrow(/--group goes with --watch/);
        await expect(factoryCommand([FACTORY, '--limit', '0'])).rejects.toThrow(/--limit must be a positive whole number/);
        await expect(factoryCommand(['--chain', '1'])).rejects.toThrow(/Missing required factory's address/);
        await factoryCommand(['help']);
        expect(printed()[0]).toMatch(/^contract-dev factory — /);
        expect(calls).toHaveLength(0);
    });
});


describe('history rules', () => {
    useEnvAuth();
    const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

    it('group show says how far a history rule has read; a finished one says complete', () => {
        const base = { id: 'r1', kind: 'factory' as const, chainId: 1, address: '0x1f98431c8ad98523631ae4a59f267346ea31f984', topic0: '0x783c', field: { topic: 3 as const }, lastSyncAt: null };
        const lines = (rule: any) => groupLines({ group: 'Uniswap v3 pools', contracts: 1200, namePattern: null, rules: [rule], columns: [], monitors: [], members: [] } as any);
        expect(lines({ ...base, history: true, readToBlock: 13_000_000, headBlock: 26_000_000, filling: true }).find((l) => l.includes('factory'))).toMatch(/50% of history$/);
        expect(lines({ ...base, history: true, readToBlock: 26_000_000, headBlock: 26_000_010, filling: false }).find((l) => l.includes('factory'))).toMatch(/complete$/);
    });

    it('rule add says a factory rule adds everything it ever made; --recent asks for the window only', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/create_watch_rule': (c) => ok({ group: 'Uniswap v3 pools', rule: { id: 'r1', kind: 'factory', chainId: 1, address: '0x1f98', event: 'PoolCreated', field: 'pool', history: c.body.input.history !== false }, namePattern: null, sample: [], sync: 'started' }) });
        await groupCommand(['rule', 'add', 'Uniswap v3 pools', '--factory', '0x1f98431c8ad98523631ae4a59f267346ea31f984', '--event', 'PoolCreated', '--field', 'pool']);
        expect(printed().at(-1)).toMatch(/^Saved\. It adds every contract the factory has ever made, in the background/);
        await groupCommand(['rule', 'add', 'Uniswap v3 pools', '--factory', '0x1f98431c8ad98523631ae4a59f267346ea31f984', '--event', 'PoolCreated', '--field', 'pool', '--recent']);
        expect(calls[1].body.input.history).toBe(false);
        expect(printed().at(-1)).toBe('Saved. It fills the group in the background, and keeps adding what comes next.');
    });
});
