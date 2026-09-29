import fs from 'fs';
import os from 'os';
import path from 'path';

import { workspaceCommand } from '../../src/cli/commands/workspace';
import { watchCommand } from '../../src/cli/commands/watch';

const API_URL = 'https://test.contract.dev';

const PERSONAL = { id: 'o1', name: 'Personal', slug: 'personal' };
const DZAP = { id: 'o2', name: 'DZap', slug: 'dzap' };
const whoamiFor = (org: typeof PERSONAL) => ({ email: 'theo@contract.dev', org, workspaces: [PERSONAL, DZAP] });

describe('workspace (credentials are bound to one workspace)', () => {
    const realFetch = global.fetch;
    const originalHome = process.env.HOME;
    let tmpHome: string;
    const credsPath = () => path.join(tmpHome, '.contract.dev', 'credentials.json');

    beforeEach(() => {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dev-ws-'));
        process.env.HOME = tmpHome;
        delete process.env.CONTRACT_DEV_API_KEY;
        delete process.env.CONTRACT_DEV_API_URL;
        delete process.env.CONTRACT_DEV_WORKSPACE;
        fs.mkdirSync(path.join(tmpHome, '.contract.dev'), { recursive: true });
        fs.writeFileSync(credsPath(), JSON.stringify({ apiKey: 'file-key', apiUrl: API_URL, workspaceId: 'o1', workspaceName: 'Personal' }));
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        global.fetch = realFetch;
        process.env.HOME = originalHome;
        fs.rmSync(tmpHome, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    const printed = () => (console.log as jest.Mock).mock.calls.map((c: unknown[]) => c.join(' '));

    // The key decides the workspace: whoami answers for whichever key is presented.
    const whoamiByKey = (init: any) => (init?.headers?.Authorization === 'Bearer k-dzap' ? whoamiFor(DZAP) : whoamiFor(PERSONAL));

    it('use on another workspace re-runs the login and saves the new credentials; later calls carry the new key + header', async () => {
        const urls: string[] = [];
        let accountsInit: any = null;
        global.fetch = jest.fn(async (url: any, init: any) => {
            const u = String(url);
            urls.push(u);
            if (u.endsWith('/api/cli/whoami')) return { ok: true, status: 200, json: async () => whoamiByKey(init) } as any;
            if (u.endsWith('/api/cli/device')) {
                return { ok: true, status: 201, json: async () => ({ deviceCode: 'dc', userCode: 'ABCD-1234', expiresIn: 60, interval: 0 }) } as any;
            }
            if (u.endsWith('/api/cli/device/token')) {
                return { ok: true, status: 200, json: async () => ({ status: 'approved', key: 'k-dzap', email: 'theo@contract.dev', org: DZAP }) } as any;
            }
            if (u.startsWith(API_URL + '/api/mainnet/accounts')) {
                accountsInit = init;
                return { ok: true, status: 200, json: async () => ({ accounts: [] }) } as any;
            }
            throw new Error(`Unexpected fetch: ${u}`);
        }) as any;

        await workspaceCommand(['use', 'dzap', '--no-browser']);

        expect(urls.some((u) => u.endsWith('/api/cli/device'))).toBe(true);
        const creds = JSON.parse(fs.readFileSync(credsPath(), 'utf8'));
        expect(creds.apiKey).toBe('k-dzap');
        expect(creds.workspaceId).toBe('o2');
        expect(creds.workspaceName).toBe('DZap');
        expect(printed().some((l) => l.startsWith('Active workspace: DZap'))).toBe(true);

        await watchCommand(['list']);
        expect(accountsInit.headers.Authorization).toBe('Bearer k-dzap');
        expect(accountsInit.headers['X-Contract-Dev-Workspace']).toBeUndefined();
    });

    it('use on the bound workspace is a no-op that confirms, without a login', async () => {
        const urls: string[] = [];
        global.fetch = jest.fn(async (url: any, init: any) => {
            const u = String(url);
            urls.push(u);
            if (u.endsWith('/api/cli/whoami')) return { ok: true, status: 200, json: async () => whoamiByKey(init) } as any;
            throw new Error(`Unexpected fetch: ${u}`);
        }) as any;

        await workspaceCommand(['use', 'personal']);
        expect(urls.filter((u) => u.includes('/device'))).toHaveLength(0);
        expect(printed()[0]).toBe('Already acting on Personal (personal).');
        expect(JSON.parse(fs.readFileSync(credsPath(), 'utf8')).apiKey).toBe('file-key');
    });

    it('says so when the approval landed on a workspace other than the requested one', async () => {
        global.fetch = jest.fn(async (url: any, init: any) => {
            const u = String(url);
            if (u.endsWith('/api/cli/whoami')) return { ok: true, status: 200, json: async () => whoamiByKey(init) } as any;
            if (u.endsWith('/api/cli/device')) {
                return { ok: true, status: 201, json: async () => ({ deviceCode: 'dc', userCode: 'ABCD-1234', expiresIn: 60, interval: 0 }) } as any;
            }
            if (u.endsWith('/api/cli/device/token')) {
                // approved while Personal was still the active workspace in the app
                return { ok: true, status: 200, json: async () => ({ status: 'approved', key: 'k-personal-2', email: 'theo@contract.dev', org: PERSONAL }) } as any;
            }
            throw new Error(`Unexpected fetch: ${u}`);
        }) as any;

        await workspaceCommand(['use', 'dzap', '--no-browser']);
        expect(printed().some((l) => l.includes('bound to Personal, not DZap'))).toBe(true);
        expect(JSON.parse(fs.readFileSync(credsPath(), 'utf8')).workspaceId).toBe('o1');
    });

    it('rejects a workspace the account does not belong to', async () => {
        global.fetch = jest.fn(async (url: any, init: any) => {
            if (String(url).endsWith('/api/cli/whoami')) return { ok: true, status: 200, json: async () => whoamiByKey(init) } as any;
            throw new Error('Unexpected fetch');
        }) as any;

        await expect(workspaceCommand(['use', 'not-mine'])).rejects.toThrow(/No workspace matches "not-mine"/);
    });

    it('with environment credentials, use on another workspace explains instead of logging in', async () => {
        process.env.CONTRACT_DEV_API_KEY = 'env-key';
        process.env.CONTRACT_DEV_API_URL = API_URL;
        global.fetch = jest.fn(async (url: any, init: any) => {
            if (String(url).endsWith('/api/cli/whoami')) return { ok: true, status: 200, json: async () => whoamiByKey(init) } as any;
            throw new Error('Unexpected fetch');
        }) as any;

        await expect(workspaceCommand(['use', 'dzap'])).rejects.toThrow(/bound to Personal/);
    });

});
