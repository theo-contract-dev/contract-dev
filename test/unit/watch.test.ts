import { watchCommand, unwatchCommand, contractsCommand, splitNamed } from '../../src/cli/commands/watch';
import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('watch / unwatch (mainnet contracts)', () => {
    useEnvAuth();

    it('detects first, then adds with the detected type + name as hints (one classification)', async () => {
        const calls = mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'contract', detectedName: 'USD Coin', contractType: 'ERC20' } }),
            'POST /api/mainnet/accounts': (c) => ({
                status: 201,
                payload: { created: true, account: { id: 'wc1', chainId: 8453, chainIds: [8453], address: USDC.toLowerCase(), accountType: 'contract', name: c.body.name } },
            }),
        });

        await watchCommand([USDC, '--chain', '8453']);

        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/mainnet/accounts/detect', 'POST /api/mainnet/accounts']);
        expect(calls[0].auth).toBe('Bearer env-key');
        expect(calls[0].body).toEqual({ chainId: 8453, address: USDC });
        expect(calls[1].body).toEqual({ chainId: 8453, address: USDC, accountType: 'contract', contractType: 'ERC20', name: 'USD Coin' });
        expect(printed()[0]).toBe(`Watching USD Coin (${USDC.toLowerCase()}) on chain 8453`);
    });

    it("prefers the app's own name for the address over the detected one, as the modal does", async () => {
        const calls = mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'contract', detectedName: 'FiatTokenProxy', labelName: 'Circle · USDC', contractType: 'ERC20', hasAbi: true } }),
            'POST /api/mainnet/accounts': (c) => ({
                status: 201,
                payload: { created: true, account: { id: 'wc1', chainId: 1, chainIds: [1], address: USDC.toLowerCase(), accountType: 'contract', name: c.body.name } },
            }),
        });
        await watchCommand([USDC]);
        expect(calls[1].body.name).toBe('Circle · USDC');
    });

    it('--name overrides the detected name; no detected name means no label', async () => {
        const calls = mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'contract', detectedName: null, contractType: null } }),
            'POST /api/mainnet/accounts': (c) => ({
                status: 200,
                payload: { created: false, account: { id: 'wc1', chainId: 1, chainIds: [1], address: '0xabc', accountType: 'contract', name: c.body.name ?? null } },
            }),
        });
        await watchCommand(['0xAbC', '--name', 'Treasury']);
        expect(calls[1].body).toEqual({ chainId: 1, address: '0xAbC', accountType: 'contract', name: 'Treasury' });
        expect(printed()[0]).toBe('Updated Treasury (0xabc) on chain 1');

        await watchCommand(['0xAbC']);
        expect(calls[3].body).toEqual({ chainId: 1, address: '0xAbC', accountType: 'contract' });
    });

    it('refuses a wallet before any row is created', async () => {
        const calls = mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'wallet', detectedName: 'vitalik.eth', contractType: null, activeChains: [1] } }),
        });
        await expect(watchCommand(['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'])).rejects.toThrow(/it's a wallet/);
        expect(calls).toHaveLength(1);
    });

    it('surfaces a detect failure (unsupported chain, RPC down) verbatim', async () => {
        mockApi({ 'POST /api/mainnet/accounts/detect': () => ({ status: 400, payload: { error: 'Unsupported chainId' } }) });
        await expect(watchCommand(['0xAbC', '--chain', '999999'])).rejects.toThrow('Unsupported chainId');
    });

    it('list asks for contracts only and prints chain, address, name, TVL (dash = unknown, … = not read yet)', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({
                payload: {
                    accounts: [
                        { id: 'a1', chainId: 1, chainIds: [1], address: '0xaaa', accountType: 'contract', name: 'USDC', valueUsd: 1234567 },
                        { id: 'a2', chainId: 42161, chainIds: [42161], address: '0xbbb', accountType: 'contract', name: null, valueUsd: null },
                        { id: 'a3', chainId: 42161, chainIds: [42161], address: '0xccc', accountType: 'contract', name: 'New', valueUsd: null, valueLoading: true },
                    ],
                },
            }),
        });
        await watchCommand(['list', '--chain', 'arbitrum']);
        expect(calls[0].path).toBe('/api/mainnet/accounts?accountType=contract&chainId=42161');
        expect(printed()).toEqual([
            `1        0xaaa  ${'USDC'.padEnd(28)} $1.23M`,
            `42161    0xbbb  ${''.padEnd(28)} —`,
            `42161    0xccc  ${'New'.padEnd(28)} …`,
        ]);
    });

    it('the contracts noun routes to the same commands', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
        });
        await contractsCommand(['list']);
        expect(calls[0].path).toBe('/api/mainnet/accounts?accountType=contract');
        expect(printed()[0]).toBe('No watched contracts.');
    });

    it('unwatch resolves the id from the list and deletes it', async () => {
        const accounts = [
            { id: 'a1', chainId: 1, chainIds: [1], address: '0xaaa', accountType: 'contract', name: 'Old' },
            { id: 'a2', chainId: 8453, chainIds: [8453], address: '0xaaa', accountType: 'contract', name: 'New' },
        ];
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts } }),
            'DELETE /api/mainnet/accounts/a2': () => ({ payload: { ok: true } }),
        });

        await unwatchCommand(['0xAAA', '--chain', '8453']);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
            'GET /api/mainnet/accounts',
            'DELETE /api/mainnet/accounts/a2',
        ]);
        expect(printed()[0]).toBe('Stopped watching New (0xaaa).');
    });

    it('unwatch demands --chain when the contract is watched on several chains', async () => {
        const accounts = [
            { id: 'a1', chainId: 1, chainIds: [1], address: '0xaaa', accountType: 'contract', name: null },
            { id: 'a2', chainId: 8453, chainIds: [8453], address: '0xaaa', accountType: 'contract', name: null },
        ];
        mockApi({ 'GET /api/mainnet/accounts': () => ({ payload: { accounts } }) });
        await expect(unwatchCommand(['0xAAA'])).rejects.toThrow(/watched on chains 1, 8453.*--chain/);
    });

    it('a watched wallet unwatches like a contract (one table since 2026-10-18)', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({
                payload: { accounts: [{ id: 'w1', chainId: 1, chainIds: [1], address: '0xbbb', accountType: 'wallet', name: 'Deployer' }] },
            }),
            'DELETE /api/mainnet/accounts/w1': () => ({ payload: { ok: true } }),
        });
        await unwatchCommand(['0xBBB']);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/mainnet/accounts', 'DELETE /api/mainnet/accounts/w1']);
        expect(printed()[0]).toBe('Stopped watching Deployer (0xbbb).');
    });

    it('several addresses go through the watch_contracts tool in one call: the tally, then each skipped and failed address on its own line', async () => {
        const result = { added: 2, alreadyWatched: 1, skipped: [{ address: '0xccc', reason: 'no code at this address' }], failed: [{ address: '0xddd', error: 'RPC timed out' }], group: 'pools', chainId: 42161 };
        const calls = mockApi({ 'POST /api/mainnet/tools/watch_contracts': () => ({ payload: { ok: true, result, ms: 9 } }) });
        const got = await watchCommand(['0xaaa', '0xbbb', '0xccc', '0xddd', '--chain', 'arbitrum', '--group', 'pools']);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/mainnet/tools/watch_contracts']);
        expect(calls[0].body).toEqual({ input: { chainId: 42161, addresses: ['0xaaa', '0xbbb', '0xccc', '0xddd'], group: 'pools' } });
        expect(printed()).toEqual([
            'Watched 2 · already watched 1 · skipped 1 (not a contract) · failed 1',
            '  skipped 0xccc — no code at this address',
            '  failed 0xddd — RPC timed out',
        ]);
        expect(got).toEqual(result);
    });

    it('one address with --group takes the same path, --name as its name, the chain defaulting to 1', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/watch_contracts': () => ({ payload: { ok: true, result: { added: 1, alreadyWatched: 0, skipped: [], failed: [], group: 'pools', chainId: 1 }, ms: 9 } }) });
        await watchCommand(['0xaaa', '--group', 'pools', '--name', 'Treasury']);
        expect(calls[0].body).toEqual({ input: { chainId: 1, addresses: ['0xaaa'], names: ['Treasury'], group: 'pools' } });
        expect(printed()).toEqual(['Watched 1 · already watched 0 · skipped 0 (not a contract) · failed 0']);
    });

    it('more than 25 addresses go in one call with no --yes (the CLI acts on purpose); --name and --abi name one contract only', async () => {
        const many = Array.from({ length: 26 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
        const calls = mockApi({ 'POST /api/mainnet/tools/watch_contracts': () => ({ payload: { ok: true, result: { added: 26, alreadyWatched: 0, skipped: [], failed: [], group: null, chainId: 1 }, ms: 9 } }) });
        await watchCommand(many);
        expect(calls[0].body).toEqual({ input: { chainId: 1, addresses: many, confirmMany: true } });
        await expect(watchCommand(['0xaaa', '0xbbb', '--name', 'x'])).rejects.toThrow(/--name names one contract/);
        await expect(watchCommand(['0xaaa', '--group', 'pools', '--abi', 'out/X.json'])).rejects.toThrow(/--abi goes with one address/);
        await expect(watchCommand(['0xaaa', '--group'])).rejects.toThrow(/--group needs a name/);
        expect(calls).toHaveLength(1);
    });

    it('fails with a login hint when no credential is available', async () => {
        const originalHome = process.env.HOME;
        delete process.env.CONTRACT_DEV_API_KEY;
        process.env.HOME = '/nonexistent-home-for-test';
        try {
            await expect(watchCommand(['0xAbC'])).rejects.toThrow(/contract-dev login/);
        } finally {
            process.env.HOME = originalHome;
        }
    });
});

describe('watch with names', () => {
    useEnvAuth();
    const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });
    const A = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
    const B = '0x889edc2edab5f40e902b864ad4d7ade8e412f9b1';

    it('splitNamed reads address=Name, keeps spaces, and leaves a bare address unnamed', () => {
        expect(splitNamed(`${A}=stETH`)).toEqual({ address: A, name: 'stETH' });
        expect(splitNamed(`${B}=Withdrawal Queue`)).toEqual({ address: B, name: 'Withdrawal Queue' });
        expect(splitNamed(A)).toEqual({ address: A, name: '' });
    });

    it('sends each name aligned with its address in the one bulk call; unnamed ones go as empty', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/watch_contracts': () => ok({ added: 3, alreadyWatched: 0, skipped: [], failed: [], group: 'Lido', chainId: 1 }) });
        await run(['watch', `${A}=stETH`, `${B}=Withdrawal Queue`, '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', '--group', 'Lido']);
        expect(calls[0].body.input).toEqual({ chainId: 1, addresses: [A, B, '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'], names: ['stETH', 'Withdrawal Queue', ''], group: 'Lido' });
    });

    it('with no names given, sends none', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/watch_contracts': () => ok({ added: 2, alreadyWatched: 0, skipped: [], failed: [], group: null, chainId: 1 }) });
        await run(['watch', A, B]);
        expect(calls[0].body.input.names).toBeUndefined();
    });
});
