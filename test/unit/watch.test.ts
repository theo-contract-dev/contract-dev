import { watchCommand, unwatchCommand, contractsCommand } from '../../src/cli/commands/watch';
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
            'GET /api/mainnet/accounts?accountType=contract',
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

    it('a wallet entry never matches, even if the API returned one', async () => {
        mockApi({
            'GET /api/mainnet/accounts': () => ({
                payload: { accounts: [{ id: 'w1', chainId: 1, chainIds: [1, 8453], address: '0xbbb', accountType: 'wallet', name: 'Deployer' }] },
            }),
        });
        await expect(unwatchCommand(['0xBBB'])).rejects.toThrow(/No watched contract found for 0xBBB/);
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
