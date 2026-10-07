import { followCommand, unfollowCommand } from '../../src/cli/commands/follow';

const RPC_URL = 'https://rpc.contract.dev/test-key';

// Capture JSON-RPC requests; respond with a canned result per method.
function mockFetch(results: Record<string, unknown>) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    global.fetch = jest.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        calls.push({ method: body.method, params: body.params });
        return {
            ok: true,
            json: async () => ({ jsonrpc: '2.0', id: body.id, result: results[body.method] ?? {} }),
        } as any;
    }) as any;
    return calls;
}

describe('mainnet follow', () => {
    const realFetch = global.fetch;
    afterEach(() => {
        global.fetch = realFetch;
    });

    describe('CLI', () => {
        beforeEach(() => {
            process.env.CONTRACT_DEV_RPC_URL = RPC_URL;
        });

        afterEach(() => {
            delete process.env.CONTRACT_DEV_RPC_URL;
        });

        it('follow <address> → dev_followAccount', async () => {
            const calls = mockFetch({ dev_followAccount: { address: '0xpool', followed: true, residueCleared: 0 } });
            await followCommand(['0xPool']);
            expect(calls).toEqual([{ method: 'dev_followAccount', params: ['0xPool'] }]);
        });

        it('follow <token> --balance-of <holder> → dev_followTokenBalance', async () => {
            const calls = mockFetch({
                dev_followTokenBalance: { token: '0xtoken', holder: '0xmaker', slot: '0xslot', residueCleared: 1 },
            });
            await followCommand(['0xToken', '--balance-of', '0xMaker']);
            expect(calls).toEqual([{ method: 'dev_followTokenBalance', params: ['0xToken', '0xMaker'] }]);
        });

        it('follow <address> --slots a,b → dev_followSlots', async () => {
            const calls = mockFetch({ dev_followSlots: { address: '0xtoken', followedSlots: [], residueCleared: 0 } });
            await followCommand(['0xToken', '--slots', '0xaa,0xbb']);
            expect(calls).toEqual([{ method: 'dev_followSlots', params: ['0xToken', ['0xaa', '0xbb']] }]);
        });

        it('--slots accepts decimal slot numbers and normalizes them to hex', async () => {
            const calls = mockFetch({ dev_followSlots: { address: '0xtoken', followedSlots: [], residueCleared: 0 } });
            await followCommand(['0xToken', '--slots', '1,2,10,0xaa']);
            expect(calls).toEqual([
                {
                    method: 'dev_followSlots',
                    params: [
                        '0xToken',
                        [
                            '0x' + '1'.padStart(64, '0'),
                            '0x' + '2'.padStart(64, '0'),
                            '0x' + 'a'.padStart(64, '0'), // "10" is slot ten, not 0x10
                            '0xaa',
                        ],
                    ],
                },
            ]);
        });

        it('unfollow mirrors the flags onto the unfollow methods', async () => {
            const calls = mockFetch({
                dev_unfollowAccount: { address: '0xpool', removed: true, residueCleared: 0 },
                dev_unfollowTokenBalance: { token: '0xtoken', holder: '0xmaker', slot: '0xslot', removed: 1 },
                dev_unfollowSlots: { address: '0xtoken', removed: 1, residueCleared: 1 },
            });
            await unfollowCommand(['0xPool']);
            await unfollowCommand(['0xToken', '--balance-of', '0xMaker']);
            await unfollowCommand(['0xToken', '--slots', '0xaa']);
            expect(calls.map((c) => c.method)).toEqual([
                'dev_unfollowAccount',
                'dev_unfollowTokenBalance',
                'dev_unfollowSlots',
            ]);
        });

        it('the old `follow stop` spelling points at unfollow', async () => {
            mockFetch({});
            await expect(followCommand(['stop', '0xPool'])).rejects.toThrow(/contract-dev unfollow/);
        });

        it('follow list → dev_getFollowed', async () => {
            const calls = mockFetch({
                dev_getFollowed: { accounts: ['0xpool'], slots: { '0xtoken': ['0xslot'] } },
            });
            const res = (await followCommand(['list'])) as any;
            expect(calls[0].method).toBe('dev_getFollowed');
            expect(res.accounts).toEqual(['0xpool']);
        });

        it('rejects --balance-of together with --slots', async () => {
            mockFetch({});
            await expect(followCommand(['0xToken', '--balance-of', '0xM', '--slots', '0xaa'])).rejects.toThrow(
                /not both/,
            );
        });
    });
});
