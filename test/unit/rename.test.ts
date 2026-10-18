import { renameCommand } from '../../src/cli/commands/watch';
import { mockApi, useEnvAuth, printed } from './_mockApi';

describe('rename (watched account)', () => {
    useEnvAuth();

    const accounts = [
        { id: 'c1', chainId: 1, chainIds: [1], address: '0xaaa', accountType: 'contract', name: 'Old' },
        { id: 'c2', chainId: 8453, chainIds: [8453], address: '0xaaa', accountType: 'contract', name: null },
        { id: 'w1', chainId: 1, chainIds: [1, 8453], address: '0xbbb', accountType: 'wallet', name: null },
    ];

    it('resolves the id from the list and PATCHes the name', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts } }),
            'PATCH /api/mainnet/accounts/c2': (call) => ({
                payload: { account: { ...accounts[1], name: call.body.name } },
            }),
        });

        await renameCommand(['0xAAA', 'Base', 'Treasury', '--chain', '8453']);

        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/mainnet/accounts', 'PATCH /api/mainnet/accounts/c2']);
        expect(calls[1].auth).toBe('Bearer env-key');
        expect(calls[1].body).toEqual({ name: 'Base Treasury' }); // positional words are joined
        expect(printed()[0]).toBe('Renamed 0xaaa to "Base Treasury".');
    });

    it('a watched wallet renames like a contract (one table since 2026-10-18)', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts } }),
            'PATCH /api/mainnet/accounts/w1': (call) => ({ payload: { account: { ...accounts[2], name: call.body.name } } }),
        });
        await renameCommand(['0xBBB', 'Deployer']);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/mainnet/accounts', 'PATCH /api/mainnet/accounts/w1']);
        expect(printed()[0]).toBe('Renamed 0xbbb to "Deployer".');
    });

    it('an address nobody watches is refused', async () => {
        mockApi({ 'GET /api/mainnet/accounts': () => ({ payload: { accounts } }) });
        await expect(renameCommand(['0xCCC', 'Deployer'])).rejects.toThrow(/No watched contract or wallet found/);
    });

    it('an empty name clears it', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts } }),
            'PATCH /api/mainnet/accounts/c1': () => ({ payload: { account: { ...accounts[0], name: null } } }),
        });
        await renameCommand(['0xaaa', '', '--chain', '1']);
        expect(calls[1].body).toEqual({ name: '' });
        expect(printed()[0]).toMatch(/Cleared the name/);
    });

    it('demands --chain when the contract is watched on several chains', async () => {
        mockApi({ 'GET /api/mainnet/accounts': () => ({ payload: { accounts } }) });
        await expect(renameCommand(['0xaaa', 'X'])).rejects.toThrow(/--chain/);
    });

    it('refuses a missing name', async () => {
        mockApi({});
        await expect(renameCommand(['0xaaa'])).rejects.toThrow(/name/);
    });
});
