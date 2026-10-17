import fs from 'fs';
import os from 'os';
import path from 'path';

import { installSkill, refreshGuideIfStale, withGuide, packagedSkillDir } from '../../src/cli/commands/skills';
import { run } from '../../src/cli/index';
import { mockApi, useEnvAuth, printed } from './_mockApi';

const ok = (result: unknown) => ({ payload: { ok: true, result, ms: 7 } });

describe('the server guide in the skill', () => {
    useEnvAuth();
    const originalHome = process.env.HOME;
    let home: string;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dev-guide-'));
        process.env.HOME = home;
    });
    afterEach(() => {
        process.env.HOME = originalHome;
        fs.rmSync(home, { recursive: true, force: true });
    });
    const skill = () => fs.readFileSync(path.join(home, '.claude', 'skills', 'contract-dev', 'SKILL.md'), 'utf8');
    const marker = () => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'skills', 'contract-dev', '.contract-dev-skill.json'), 'utf8'));

    it('the packaged skill carries a guide block to replace', () => {
        const packaged = fs.readFileSync(path.join(packagedSkillDir(), 'SKILL.md'), 'utf8');
        expect(packaged).toMatch(/<!-- contract-dev:guide:start version=[^>]+ -->/);
        expect(packaged).toContain('<!-- contract-dev:guide:end -->');
        expect(packaged).toContain('## Which command answers which question');
    });

    it('withGuide swaps only the block, and leaves a file without one alone', () => {
        const before = 'head\n<!-- contract-dev:guide:start version=1 -->\nold\n<!-- contract-dev:guide:end -->\ntail';
        const after = withGuide(before, { version: '2', markdown: '## New\n- line' });
        expect(after).toMatch(/^head\n<!-- contract-dev:guide:start version=2 -->\n<!-- Written by/);
        expect(after).toContain('## New\n- line\n\n<!-- contract-dev:guide:end -->\ntail');
        expect(after).not.toContain('old');
        expect(withGuide('no block here', { version: '2', markdown: 'x' })).toBe('no block here');
    });

    it('skills install writes the server guide when it answers, and keeps the packaged one when it does not', async () => {
        mockApi({ 'GET /api/mainnet/tools/guide': () => ({ payload: { version: 'srv-9', markdown: '## How to answer\n\n- From the server.' } }) });
        await run(['skills', 'install']);
        expect(skill()).toContain('- From the server.');
        expect(marker().guideVersion).toBe('srv-9');

        fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
        fs.rmSync(path.join(home, '.agents'), { recursive: true, force: true });
        mockApi({ 'GET /api/mainnet/tools/guide': () => ({ status: 404, payload: { error: 'Not found' } }) });
        installSkill({ guide: null });
        expect(skill()).toBe(fs.readFileSync(path.join(packagedSkillDir(), 'SKILL.md'), 'utf8'));
    });

    it('once a day, a newer server guide reaches the installed skill; a fresh check asks nothing', async () => {
        installSkill({ guide: { version: 'srv-1', markdown: '- one' } });
        const calls = mockApi({ 'GET /api/mainnet/tools/guide': () => ({ payload: { version: 'srv-2', markdown: '- two' } }) });
        // just written: checked now, so nothing is asked
        expect(await refreshGuideIfStale()).toBe(false);
        expect(calls).toHaveLength(0);
        // a day later
        const m = marker();
        fs.writeFileSync(path.join(home, '.claude', 'skills', 'contract-dev', '.contract-dev-skill.json'), JSON.stringify({ ...m, guideCheckedAt: '2020-01-01T00:00:00.000Z' }));
        fs.writeFileSync(path.join(home, '.agents', 'skills', 'contract-dev', '.contract-dev-skill.json'), JSON.stringify({ ...m, guideCheckedAt: '2020-01-01T00:00:00.000Z' }));
        expect(await refreshGuideIfStale()).toBe(true);
        expect(skill()).toContain('- two');
        expect(marker().guideVersion).toBe('srv-2');
    });
});

describe('question shortcuts', () => {
    useEnvAuth();

    it('who: an address, ENS or name; --activity and --holdings pick the tool', async () => {
        const calls = mockApi({
            'POST /api/mainnet/tools/describe_address': () => ok({ who: 'Wintermute' }),
            'POST /api/mainnet/tools/address_activity': () => ok({ who: 'Wintermute' }),
            'POST /api/mainnet/tools/address_holdings': () => ok({ who: 'Wintermute' }),
        });
        await run(['who', 'Wintermute', '--chain', '1']);
        await run(['who', 'vitalik.eth', '--activity']);
        await run(['who', '0xabc', '--holdings']);
        expect(calls.map((c) => [c.path, c.body.input])).toEqual([
            ['/api/mainnet/tools/describe_address', { who: 'Wintermute', chainId: 1 }],
            ['/api/mainnet/tools/address_activity', { who: 'vitalik.eth' }],
            ['/api/mainnet/tools/address_holdings', { who: '0xabc' }],
        ]);
        await expect(run(['who', 'x', '--activity', '--holdings'])).rejects.toThrow(/Pick one/);
    });

    it('read: one call with its arguments and scale, now or at a past time', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/read_contract': () => ok({ results: [{ value: 7250.3 }] }) });
        await run(['read', 'Withdrawal Queue', 'unfinalizedStETH', '--decimals', '18', '--at', '2026-10-01']);
        await run(['read', 'stETH', 'balanceOf', '0x3e40d73eb977dc6a537af587d48316fee66e9c8c', '--block', '21000000']);
        expect(calls.map((c) => c.body.input)).toEqual([
            { contract: 'Withdrawal Queue', calls: [{ function: 'unfinalizedStETH', decimals: 18 }], at: '2026-10-01' },
            { contract: 'stETH', calls: [{ function: 'balanceOf', args: ['0x3e40d73eb977dc6a537af587d48316fee66e9c8c'] }], block: 21000000 },
        ]);
        await expect(run(['read', 'stETH'])).rejects.toThrow(/Say what to read/);
    });

    it('compare takes the past hour', async () => {
        const calls = mockApi({ 'POST /api/mainnet/tools/compare_activity': () => ok({ scope: 'pools', window: '1h', by: 'activeWallets', unit: 'count', rows: [] }) });
        await run(['compare', '--group', 'pools', '--by', 'activeWallets', '--window', '1h']);
        expect(calls[0].body.input).toMatchObject({ by: 'activeWallets', window: '1h' });
    });
});
