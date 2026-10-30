import { aboutLine, agentRunning } from '../../src/cli/about';
import { run } from '../../src/cli/index';
import { mockApi, printed, useEnvAuth } from './_mockApi';

// A watch's line for the workspace's brief: an agent gives --about or says --no-about; a person at a terminal is asked nothing.
const FEE_ESCROW = '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e';
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 5 } });
const account = (name: string, address: string) => ({ id: 'w1', chainId: 4663, chainIds: [4663], address, accountType: 'contract', name });

/** Run as an agent: the mark Claude Code leaves in the environment, and no terminal. */
function asAgent(): void {
    beforeEach(() => {
        process.env.CLAUDECODE = '1';
        Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true, writable: true });
    });
    afterEach(() => {
        delete process.env.CLAUDECODE;
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
    });
}

describe('who is running the command', () => {
    it('an agent is its own mark in the environment, or no terminal on stdout', () => {
        const terminal = { isTTY: true };
        expect(agentRunning({ CLAUDECODE: '1' }, terminal)).toBe(true);
        expect(agentRunning({ AI_AGENT: 'claude-code_2-1-311_agent' }, terminal)).toBe(true);
        expect(agentRunning({}, {})).toBe(true);
        expect(agentRunning({}, { isTTY: false })).toBe(true);
        expect(agentRunning({}, terminal)).toBe(false);
        expect(agentRunning({ AI_AGENT: '  ', CLAUDECODE: '0' }, terminal)).toBe(false);
    });

    it('the line names what it is about unless the sentence already does', () => {
        expect(aboutLine(['V2 Fee Escrow'], 'Collects every launch fee.')).toBe('V2 Fee Escrow: Collects every launch fee.');
        expect(aboutLine(['V2 Fee Escrow'], 'The V2 Fee Escrow collects every launch fee.')).toBe('The V2 Fee Escrow collects every launch fee.');
    });
});

describe('watch: a person at a terminal', () => {
    useEnvAuth();

    it('watches as before, with nothing asked and nothing added to the brief', async () => {
        const calls = mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'contract', detectedName: null, hasAbi: true, contractType: null } }),
            'POST /api/mainnet/accounts': () => ({ payload: { account: account('V2 Fee Escrow', FEE_ESCROW), created: true } }),
        });
        await run(['watch', `${FEE_ESCROW}=V2 Fee Escrow`, '--chain', '4663']);
        expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/mainnet/accounts/detect', 'POST /api/mainnet/accounts']);
    });

    it('may give --about all the same: the line goes under the brief, named', async () => {
        const calls = mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'contract', detectedName: null, hasAbi: true, contractType: null } }),
            'POST /api/mainnet/accounts': () => ({ payload: { account: account('V2 Fee Escrow', FEE_ESCROW), created: true } }),
            'POST /api/mainnet/tools/set_workspace_brief': () => ok({ saved: true }),
        });
        const result = (await run(['watch', `${FEE_ESCROW}=V2 Fee Escrow`, '--chain', '4663', '--about', 'Collects every launch fee and pays it to the buyback vault.'])) as { brief?: unknown };
        expect(calls[2].body).toEqual({ input: { text: 'V2 Fee Escrow: Collects every launch fee and pays it to the buyback vault.', append: true } });
        expect(result.brief).toEqual({ added: true });
        expect(printed()).toContain("Added to the workspace's brief.");
    });
});

describe('watch: an agent', () => {
    useEnvAuth();
    asAgent();

    it('is refused before anything is watched when it gives neither --about nor --no-about', async () => {
        const calls = mockApi({});
        await expect(run(['watch', FEE_ESCROW, '--chain', '4663'])).rejects.toThrow(/Nothing was watched\. Say what this contract adds to the protocol: --about/);
        await expect(run(['watch', HOOK, FEE_ESCROW, '--chain', '4663'])).rejects.toThrow(/what these contracts adds|these contracts/);
        await expect(run(['watch', 'wallet', '0x263ed295dafae1d9aadd6e56c4b6f9f38ee019dd', '--chain', '4663'])).rejects.toThrow(/Say what this wallet adds/);
        await expect(run(['group', 'rule', 'add', 'PONS pools', '--factory', HOOK, '--event', 'PoolCreated', '--field', 'pool', '--chain', '4663'])).rejects.toThrow(/Say what the PONS pools group adds/);
        expect(calls).toEqual([]);
    });

    it('--no-about watches and adds nothing: a setup, which writes the whole brief at the end', async () => {
        const calls = mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'contract', detectedName: null, hasAbi: true, contractType: null } }),
            'POST /api/mainnet/accounts': () => ({ payload: { account: account('V2 Fee Escrow', FEE_ESCROW), created: true } }),
        });
        await run(['watch', FEE_ESCROW, '--chain', '4663', '--no-about']);
        expect(calls.map((c) => c.path)).toEqual(['/api/mainnet/accounts/detect', '/api/mainnet/accounts']);
    });

    it('several at once hand the line to the tool, which names them under the brief itself', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/watch_contracts': () => ok({ added: 2, alreadyWatched: 0, skipped: [], failed: [], group: null, chainId: 4663, brief: { added: true } }),
        });
        await run(['watch', `${HOOK}=V2 Meme Hook`, `${FEE_ESCROW}=V2 Fee Escrow`, '--chain', '4663', '--about', 'The hook every launched token trades through, and the escrow its fees land in.']);
        expect(calls[0].body.input).toEqual({
            chainId: 4663,
            addresses: [HOOK, FEE_ESCROW],
            names: ['V2 Meme Hook', 'V2 Fee Escrow'],
            about: 'The hook every launched token trades through, and the escrow its fees land in.',
        });
        expect(printed()).toContain("Added to the workspace's brief.");
    });

    it('a rule carries the group\'s line to the tool', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/create_watch_rule': () => ok({ group: 'PONS pools', rule: { id: 'r1', kind: 'factory', chainId: 4663, address: HOOK, event: 'PoolCreated', field: 'pool', history: true }, namePattern: null, sync: 'started', brief: { added: true } }),
        });
        await run(['group', 'rule', 'add', 'PONS pools', '--factory', HOOK, '--event', 'PoolCreated', '--field', 'pool', '--chain', '4663', '--about', 'Every pool trading PONS, against WETH or USDG.']);
        expect(calls[0].body.input).toMatchObject({ group: 'PONS pools', factory: HOOK, about: 'Every pool trading PONS, against WETH or USDG.' });
    });

    it('a brief that is full is said, and the watch stands', async () => {
        mockApi({
            'POST /api/mainnet/accounts/detect': () => ({ payload: { accountType: 'contract', detectedName: null, hasAbi: true, contractType: null } }),
            'POST /api/mainnet/accounts': () => ({ payload: { account: account('V2 Fee Escrow', FEE_ESCROW), created: true } }),
            'POST /api/mainnet/tools/set_workspace_brief': () => ({ status: 400, payload: { ok: false, error: 'The brief would be 16,120 characters; it holds 16,000 at most.', code: null } }),
        });
        const result = (await run(['watch', FEE_ESCROW, '--chain', '4663', '--about', 'Collects fees.'])) as { brief?: { added: boolean; error?: string } };
        expect(result.brief).toEqual({ added: false, error: 'The brief would be 16,120 characters; it holds 16,000 at most.' });
        expect(printed()).toContain("Watched, but not added to the workspace's brief: The brief would be 16,120 characters; it holds 16,000 at most.");
    });
});
