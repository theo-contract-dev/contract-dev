import { apiRequest, forgetRequests, requestsMade } from '../../src/cli/credentials';
import { commandName, commandReport, redactArgv, sendCommandReport, shouldReport } from '../../src/cli/telemetry';
import { API_URL, mockApi, useEnvAuth } from './_mockApi';

describe('command telemetry', () => {
    useEnvAuth();

    beforeEach(() => {
        forgetRequests();
        delete process.env.CONTRACT_DEV_NO_TELEMETRY;
    });

    it('names a command by its noun and verb, and a bare command by itself', () => {
        expect(commandName(['metric', 'add', 'Swaps', '--group', 'pools'])).toBe('metric add');
        expect(commandName(['watch', '0x1234567890123456789012345678901234567890'])).toBe('watch');
        expect(commandName(['events', 'Transfer'])).toBe('events');
        expect(commandName([])).toBe('?');
    });

    it('takes secrets out of the argv and quotes arguments with spaces', () => {
        expect(redactArgv(['channels', 'add', 'telegram', '--token', '123456:ABCDEFghijklmnopqrstuvwxyz', '--name', 'Ops room'])).toBe(
            'channels add telegram --token ••• --name "Ops room"',
        );
        expect(redactArgv(['x', '--api-key=abcdef', '0123456789abcdef0123456789abcdef0123456789abcdef'])).toBe('x --api-key=••• •••');
        expect(redactArgv(['channels', 'add', 'webhook', 'https://hooks.slack.com/services/T0/B0/xyz'])).toBe('channels add webhook •••');
    });

    it('reports a failure, a command that asked the server, and nothing else', () => {
        const ok = { ok: true, ms: 10 };
        expect(shouldReport(['status'], ok, {}, [])).toBe(false);
        expect(shouldReport(['status'], ok, {}, [{ method: 'GET', path: '/api/mainnet/vitals', status: 200, ms: 5 }])).toBe(true);
        expect(shouldReport(['status'], { ok: false, error: 'bad flag', ms: 1 }, {}, [])).toBe(true);
        expect(shouldReport(['login'], { ok: false, error: 'x', ms: 1 }, {}, [])).toBe(false);
        expect(shouldReport(['help'], ok, {}, [{ method: 'GET', path: '/x', status: 200, ms: 1 }])).toBe(false);
        expect(shouldReport(['status'], ok, { CONTRACT_DEV_NO_TELEMETRY: '1' }, [{ method: 'GET', path: '/x', status: 200, ms: 1 }])).toBe(false);
    });

    it('sends what the command did, with the requests it made, after the command', async () => {
        const calls = mockApi({
            'GET /api/mainnet/vitals': () => ({ payload: { ok: true } }),
            'POST /api/mainnet/accounts': () => ({ status: 503, payload: { error: 'A data source did not answer.' } }),
            'POST /api/telemetry/cli': () => ({ status: 204, payload: null }),
        });
        const auth = { apiKey: 'k', apiUrl: API_URL, source: 'env' as const };
        await apiRequest(auth, 'GET', '/api/mainnet/vitals?range=24h');
        await expect(apiRequest(auth, 'POST', '/api/mainnet/accounts', { address: '0x1' })).rejects.toThrow('A data source did not answer.');
        expect(requestsMade().map((r) => `${r.method} ${r.path} ${r.status}`)).toEqual(['GET /api/mainnet/vitals 200', 'POST /api/mainnet/accounts 503']);

        const report = commandReport(['watch', '0x1'], ['watch', '0x1', '--json'], { ok: false, error: 'A data source did not answer.', code: 'UNAVAILABLE', ms: 1234 });
        expect(report).toMatchObject({ command: 'watch', argv: 'watch 0x1 --json', ok: false, error: 'A data source did not answer.', code: 'UNAVAILABLE', ms: 1234, agent: false });
        expect((report.requests as unknown[]).length).toBe(2);

        await sendCommandReport(['watch', '0x1'], ['watch', '0x1', '--json'], { ok: false, error: 'A data source did not answer.', code: 'UNAVAILABLE', ms: 1234 });
        const sent = calls.find((c) => c.path === '/api/telemetry/cli');
        expect(sent?.method).toBe('POST');
        expect(sent?.auth).toBe('Bearer ' + process.env.CONTRACT_DEV_API_KEY);
        expect(sent?.body.command).toBe('watch');
        expect(sent?.body.requests[1]).toMatchObject({ method: 'POST', path: '/api/mainnet/accounts', status: 503 });
    });

    it('never lets a report failure reach the command', async () => {
        mockApi({});
        await expect(sendCommandReport(['status'], ['status'], { ok: false, error: 'x', ms: 1 })).resolves.toBeUndefined();
    });
});
