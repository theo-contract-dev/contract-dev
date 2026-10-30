import fs from 'fs';
import os from 'os';
import path from 'path';

import { briefLines, workspaceCommand } from '../../src/cli/commands/workspace';
import { mockApi, printed, useEnvAuth } from './_mockApi';

// The workspace's brief on its protocol: `workspace` prints it first thing, `workspace brief` writes it.
const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 5 } });
const WHO = { email: 'tae.lee@contract.dev', org: { id: 'o1', name: 'PONS', slug: 'tae-lee' }, workspaces: [], plan: { plan: 'team', label: 'Team', historyDays: 365, monitors: { used: 45, limit: -1 }, contracts: { used: 30, limit: -1 } } };
const BRIEF = {
    text: 'PONS is a memecoin launchpad on Robinhood Chain.\nLaunched tokens trade through the V2 Meme Hook until they graduate to a pool.',
    writtenAt: '2026-10-28T05:00:00.000Z',
    by: 'Tae Lee',
    origin: 'cli',
    provenance: 'Written Oct 28 by Tae Lee. Not in it: 1 contract watched since, in no group (V2 Fee Escrow).',
    notCovered: { contracts: ['V2 Fee Escrow'], contractsCount: 1, groups: [] },
};
const HOLDS = 'What this workspace holds (when this conversation started; figures come from tools)\n- 30 watched contracts. Chains: Robinhood Chain (4663) 30.';

describe('workspace: the brief on the protocol', () => {
    useEnvAuth();

    it('prints the workspace, its plan, the brief under its provenance, then what the workspace holds', async () => {
        const calls = mockApi({ 'GET /api/cli/whoami': () => ({ payload: WHO }), 'POST /api/mainnet/tools/describe_workspace': () => ok({ brief: BRIEF, holds: HOLDS }) });
        const result = (await workspaceCommand([])) as { brief: unknown };
        expect(calls.find((c) => c.path.endsWith('/describe_workspace'))?.body).toEqual({ input: {} });
        const out = printed();
        expect(out[0]).toBe('PONS (tae-lee)');
        expect(out[1]).toMatch(/^Plan: Team/);
        expect(out[3]).toBe("Brief on this protocol, in the workspace's own words (Written Oct 28 by Tae Lee. Not in it: 1 contract watched since, in no group (V2 Fee Escrow).)");
        expect(out[4]).toBe('PONS is a memecoin launchpad on Robinhood Chain.');
        expect(out[5]).toBe('Launched tokens trade through the V2 Meme Hook until they graduate to a pool.');
        expect(out[7]).toBe(HOLDS);
        expect(result.brief).toEqual(BRIEF);
    });

    it('says there is none yet, and how one is written', () => {
        expect(briefLines(null)).toEqual(['No brief on the protocol yet. A setup ends with one; `contract-dev workspace brief "<text>"` writes it.']);
    });

    it('brief with text replaces it; --append adds a paragraph', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/set_workspace_brief': (c) => ok({ saved: true, brief: { ...BRIEF, text: c.body.input.text } }) });
        await workspaceCommand(['brief', 'PONS is a memecoin launchpad.']);
        expect(calls[0].body).toEqual({ input: { text: 'PONS is a memecoin launchpad.' } });
        expect(printed()[0]).toBe('Saved the brief (29 characters). Written Oct 28 by Tae Lee. Not in it: 1 contract watched since, in no group (V2 Fee Escrow).');

        await workspaceCommand(['brief', 'V2 Fee Escrow: collects launch fees and funds buybacks.', '--append']);
        expect(calls[1].body).toEqual({ input: { text: 'V2 Fee Escrow: collects launch fees and funds buybacks.', append: true } });
        expect(printed()[1]).toMatch(/^Added to the brief/);
    });

    it('brief --file reads it from a file, and brief alone prints it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dev-brief-'));
        const file = path.join(dir, 'brief.md');
        fs.writeFileSync(file, 'From a file.\n');
        const calls = mockApi({
            'POST /api/mainnet/tools/set_workspace_brief': (c) => ok({ saved: true, brief: { ...BRIEF, text: c.body.input.text } }),
            'POST /api/mainnet/tools/describe_workspace': () => ok({ brief: BRIEF, holds: HOLDS }),
        });
        await workspaceCommand(['brief', '--file', file]);
        expect(calls[0].body).toEqual({ input: { text: 'From a file.' } });

        await workspaceCommand(['brief']);
        expect(calls[1].path).toBe('/api/mainnet/tools/describe_workspace');
        expect(printed()[1]).toMatch(/^Brief on this protocol/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
