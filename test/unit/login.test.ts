import fs from 'fs';
import os from 'os';
import path from 'path';

import { loginCommand, logoutCommand, planLine, whoamiCommand } from '../../src/cli/commands/login';
import { mockApi, printed, useEnvAuth } from './_mockApi';

describe('whoami', () => {
    useEnvAuth();

    it('says the plan and what it has used, up front; an older server without a plan prints as before', async () => {
        const plan = {
            plan: 'free',
            label: 'Free',
            historyDays: 7,
            trialEndsAt: null,
            watchedAccounts: { used: 11, limit: 25 },
            monitors: { used: 29, limit: 50 },
            reports: { used: 3, limit: 3 },
            tables: { used: 0, limit: 2 },
            trackedValues: { used: 4, limit: -1 },
        };
        mockApi({ 'GET /api/cli/whoami': () => ({ payload: { email: 'theo@contract.dev', org: { id: 'o1', name: 'Personal' }, plan } }) });
        await whoamiCommand();
        expect(printed()[1]).toBe('Plan: Free · 7 days of history · contracts and wallets 11/25 · monitors 29/50 · reports 3/3 · tables 0/2 · tracked values 4');
        expect(planLine({ ...plan, label: 'Team', historyDays: 365, trialEndsAt: '2026-11-03T00:00:00.000Z' })).toMatch(/^Team \(trial until 2026-11-03\) · 365 days of history/);
        (console.log as jest.Mock).mockClear();
        mockApi({ 'GET /api/cli/whoami': () => ({ payload: { email: 'theo@contract.dev', org: { id: 'o1', name: 'Personal' } } }) });
        await whoamiCommand();
        expect(printed()[0]).toBe('theo@contract.dev (workspace: Personal)');
        expect(printed()[1]).toMatch(/^Auth: /);
    });
});

const API_URL = 'https://test.contract.dev';

// Route fetch by URL suffix; capture request bodies per endpoint.
function mockDeviceFlow(pollResponses: Array<Record<string, unknown>>) {
    const calls: Array<{ url: string; body: any }> = [];
    let pollIndex = 0;
    global.fetch = jest.fn(async (url: any, init: any) => {
        const u = String(url);
        const body = init?.body ? JSON.parse(init.body) : null;
        calls.push({ url: u, body });
        if (u.endsWith('/api/cli/device')) {
            return {
                ok: true,
                status: 201,
                json: async () => ({ deviceCode: 'dc-secret', userCode: 'FQZL-2917', expiresIn: 60, interval: 0 }),
            } as any;
        }
        if (u.endsWith('/api/cli/device/token')) {
            const response = pollResponses[Math.min(pollIndex++, pollResponses.length - 1)];
            return { ok: true, status: 200, json: async () => response } as any;
        }
        if (u.endsWith('/api/cli/whoami')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    email: 'theo@contract.dev',
                    org: { id: 'o1', name: 'Mockchain', slug: 'mockchain' },
                    workspaces: [{ id: 'o1', name: 'Mockchain', slug: 'mockchain' }],
                }),
            } as any;
        }
        throw new Error(`Unexpected fetch: ${u}`);
    }) as any;
    return calls;
}

describe('login (device-code flow)', () => {
    const realFetch = global.fetch;
    const originalHome = process.env.HOME;
    let tmpHome: string;

    beforeEach(() => {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dev-login-'));
        process.env.HOME = tmpHome;
    });

    afterEach(() => {
        global.fetch = realFetch;
        process.env.HOME = originalHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('polls until approved and saves credentials with 0600 perms', async () => {
        const calls = mockDeviceFlow([
            { status: 'pending' },
            { status: 'approved', key: 'k-123', email: 'theo@contract.dev', org: { id: 'o1', name: 'Mockchain' } },
        ]);

        await loginCommand(['--api-url', API_URL, '--no-browser']);

        const tokenCalls = calls.filter((c) => c.url.endsWith('/api/cli/device/token'));
        expect(tokenCalls.length).toBe(2);
        expect(tokenCalls[0].body).toEqual({ deviceCode: 'dc-secret' });

        const credsPath = path.join(tmpHome, '.contract.dev', 'credentials.json');
        const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        expect(creds).toEqual({
            apiKey: 'k-123',
            apiUrl: API_URL,
            email: 'theo@contract.dev',
            workspaceId: 'o1',
            workspaceName: 'Mockchain',
        });
        expect(fs.statSync(credsPath).mode & 0o777).toBe(0o600);
    });

    it('rejects when the request is denied in the browser', async () => {
        mockDeviceFlow([{ status: 'denied' }]);
        await expect(loginCommand(['--api-url', API_URL, '--no-browser'])).rejects.toThrow(/denied/);
        expect(fs.existsSync(path.join(tmpHome, '.contract.dev', 'credentials.json'))).toBe(false);
    });

    it('ends by pointing at the agent skill when there is no terminal to ask on, and installs it with --skill', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        mockDeviceFlow([{ status: 'approved', key: 'k', email: null, org: null }]);
        await loginCommand(['--api-url', API_URL, '--no-browser']);
        const lines = log.mock.calls.map((c) => c.join(' '));
        expect(lines[lines.length - 1]).toBe('Agent skill for Claude Code, Codex and Cursor: contract-dev skills install');
        expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills', 'contract-dev'))).toBe(false);

        mockDeviceFlow([{ status: 'approved', key: 'k', email: null, org: null }]);
        await loginCommand(['--api-url', API_URL, '--no-browser', '--skill']);
        expect(fs.existsSync(path.join(tmpHome, '.claude', 'skills', 'contract-dev', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(tmpHome, '.agents', 'skills', 'contract-dev', 'SKILL.md'))).toBe(true);
        log.mockRestore();
    });

    it('logout removes the saved credentials file', async () => {
        mockDeviceFlow([{ status: 'approved', key: 'k', email: null, org: null }]);
        await loginCommand(['--api-url', API_URL, '--no-browser']);
        const credsPath = path.join(tmpHome, '.contract.dev', 'credentials.json');
        expect(fs.existsSync(credsPath)).toBe(true);

        await logoutCommand();
        expect(fs.existsSync(credsPath)).toBe(false);
    });
});
