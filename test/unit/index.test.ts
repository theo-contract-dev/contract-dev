import { run, cliVersion } from '../../src/cli/index';
import { mockApi, useEnvAuth } from './_mockApi';

describe('entrypoint', () => {
    useEnvAuth();

    it('--version reports the package version and returns it for --json', async () => {
        const version = cliVersion();
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
        expect(await run(['--version'])).toEqual({ version });
    });

    it('noun aliases route to the same commands', async () => {
        const calls = mockApi({
            'GET /api/mainnet/accounts': () => ({ payload: { accounts: [] } }),
            'GET /api/mainnet/tracked-metrics': () => ({ payload: { trackedMetrics: [] } }),
            'GET /api/mainnet/incidents': () => ({ payload: { incidents: [], days: 7 } }),
        });
        await run(['contracts', 'list']);
        await run(['metric', 'list']);
        await run(['incident']);
        expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/api/mainnet/accounts', '/api/mainnet/tracked-metrics', '/api/mainnet/incidents']);
    });
});
