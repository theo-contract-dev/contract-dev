import { run } from '../../src/cli/index';
import { extractTargetFlags, resetTargetOverrides } from '../../src/cli/target';
import { mockApi, useEnvAuth } from './_mockApi';

// --workspace / CONTRACT_DEV_WORKSPACE name the workspace a request acts on. The server
// decides whether the key may (contract.dev staff only); the CLI only carries the name.
describe('--workspace', () => {
    useEnvAuth();
    afterEach(() => {
        resetTargetOverrides();
        delete process.env.CONTRACT_DEV_WORKSPACE;
    });

    const accounts = () => ({ payload: { accounts: [] } });
    // What the entrypoint does with a command line: strip the targeting flags, then dispatch.
    const cli = (line: string[]) => run(extractTargetFlags(line));

    it('sends the named workspace on every request and leaves the command line intact', async () => {
        const calls = mockApi({ 'GET /api/mainnet/accounts': accounts, 'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [] } }) });
        await cli(['watch', 'list', '--workspace', 'benqi']);
        await cli(['--workspace=benqi', 'metrics']);
        expect(calls.map((c) => c.workspace)).toEqual(['benqi', 'benqi']);
        expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/api/mainnet/accounts', '/api/mainnet/tracked-metrics']);
    });

    it('reads CONTRACT_DEV_WORKSPACE, and the flag wins over it', async () => {
        process.env.CONTRACT_DEV_WORKSPACE = 'from-env';
        const calls = mockApi({ 'GET /api/mainnet/accounts': accounts });
        await cli(['watch', 'list']);
        await cli(['watch', 'list', '--workspace', 'from-flag']);
        expect(calls.map((c) => c.workspace)).toEqual(['from-env', 'from-flag']);
    });

    it('sends no workspace when none is named', async () => {
        const calls = mockApi({ 'GET /api/mainnet/accounts': accounts });
        await cli(['watch', 'list']);
        expect(calls[0].workspace).toBeUndefined();
    });

    it('says which workspace was refused when the server rejects the key for it', async () => {
        mockApi({ 'GET /api/mainnet/accounts': () => ({ status: 401, payload: { error: 'Unauthorized' } }) });
        await expect(cli(['watch', 'list', '--workspace', 'someone-elses'])).rejects.toThrow(/cannot act on workspace "someone-elses"/);
    });

    it('--workspace needs a value', () => {
        expect(() => extractTargetFlags(['watch', 'list', '--workspace'])).toThrow(/--workspace requires a value/);
    });
});
