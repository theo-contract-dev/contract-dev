import fs from 'fs';
import os from 'os';
import path from 'path';

import { installSkill, offerSkillAfterLogin, packagedSkillDir, projectRoot, refreshInstalledSkills, skillsCommand, skillTargets } from '../../src/cli/commands/skills';
import { cliVersion } from '../../src/cli/version';
import { run } from '../../src/cli/index';

// Every test gets its own home folder and repository, so nothing touches the real ~/.claude or ~/.agents.
describe('agent skill', () => {
    const originalHome = process.env.HOME;
    const originalCwd = process.cwd();
    let home: string;
    let repo: string;
    let log: jest.SpyInstance;
    let err: jest.SpyInstance;

    const claude = () => path.join(home, '.claude', 'skills', 'contract-dev');
    const agents = () => path.join(home, '.agents', 'skills', 'contract-dev');
    const marker = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.contract-dev-skill.json'), 'utf8'));
    const lines = () => log.mock.calls.map((c: unknown[]) => c.join(' '));

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dev-skill-home-'));
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dev-skill-repo-'));
        fs.mkdirSync(path.join(repo, '.git'));
        fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
        process.env.HOME = home;
        process.chdir(path.join(repo, 'packages', 'app'));
        log = jest.spyOn(console, 'log').mockImplementation(() => {});
        err = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        process.chdir(originalCwd);
        process.env.HOME = originalHome;
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it('ships a skill whose header parses: name and a quoted description', () => {
        const text = fs.readFileSync(path.join(packagedSkillDir(), 'SKILL.md'), 'utf8');
        const header = text.split('---')[1];
        expect(header).toMatch(/^name: contract-dev$/m);
        expect(header).toMatch(/^description: ".+"$/m);
    });

    it('installs into both folders the agents read, stamped with the CLI version, and says so', async () => {
        const result: any = await run(['skills', 'install']);
        for (const dir of [claude(), agents()]) {
            expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe(fs.readFileSync(path.join(packagedSkillDir(), 'SKILL.md'), 'utf8'));
            expect(marker(dir).version).toBe(cliVersion());
        }
        expect(result.targets.map((t: any) => t.result)).toEqual(['installed', 'installed']);
        const out = lines();
        expect(out[0]).toMatch(/^Installed {5}~\/\.claude\/skills\/contract-dev {2}\(Claude Code\)$/);
        expect(out[1]).toMatch(/^Installed {5}~\/\.agents\/skills\/contract-dev {2}\(Codex, Cursor, Gemini CLI, GitHub Copilot\)$/);
        expect(out[3]).toMatch(/set up our protocol on contract\.dev/);
    });

    it('is idempotent: a second install leaves an up-to-date copy alone', () => {
        installSkill();
        expect(installSkill().map((o) => o.result)).toEqual(['unchanged', 'unchanged']);
    });

    it('never overwrites a contract-dev skill it did not install, unless forced', () => {
        fs.mkdirSync(claude(), { recursive: true });
        fs.writeFileSync(path.join(claude(), 'SKILL.md'), 'my own notes');
        const first = installSkill();
        expect(first[0]).toMatchObject({ result: 'skipped' });
        expect(fs.readFileSync(path.join(claude(), 'SKILL.md'), 'utf8')).toBe('my own notes');
        expect(first[1]).toMatchObject({ result: 'installed' });
        expect(installSkill({ force: true })[0]).toMatchObject({ result: 'updated' });
        expect(marker(claude()).version).toBe(cliVersion());
    });

    it('leaves a link to this package\'s own skill in place: it is always current', () => {
        fs.mkdirSync(path.dirname(claude()), { recursive: true });
        fs.symlinkSync(packagedSkillDir(), claude());
        expect(skillTargets()[0].state).toBe('linked');
        expect(installSkill()[0]).toMatchObject({ result: 'linked' });
        expect(fs.lstatSync(claude()).isSymbolicLink()).toBe(true);
    });

    it('removing a linked copy removes the link, never what it points at', async () => {
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-dev-skill-elsewhere-'));
        fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), 'kept');
        fs.mkdirSync(path.dirname(claude()), { recursive: true });
        fs.symlinkSync(elsewhere, claude());
        const skipped: any = await skillsCommand(['uninstall']);
        expect(skipped.targets[0]).toMatchObject({ result: 'skipped' });
        const removed: any = await skillsCommand(['uninstall', '--force']);
        expect(removed.targets[0]).toMatchObject({ result: 'removed' });
        expect(fs.existsSync(claude())).toBe(false);
        expect(fs.readFileSync(path.join(elsewhere, 'SKILL.md'), 'utf8')).toBe('kept');
        fs.rmSync(elsewhere, { recursive: true, force: true });
    });

    it('--project installs at the repository root, not the folder the shell is in', async () => {
        expect(projectRoot()).toBe(fs.realpathSync(repo));
        await run(['skills', 'install', '--project']);
        expect(fs.existsSync(path.join(repo, '.claude', 'skills', 'contract-dev', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.join(repo, '.agents', 'skills', 'contract-dev', 'SKILL.md'))).toBe(true);
        expect(fs.existsSync(claude())).toBe(false);
        expect(lines().pop()).toBe('Commit both folders so the team gets it. Agents load it in their next session.');
    });

    it('after an upgrade, refreshes the copies it installed (home and repository) and says so on stderr', () => {
        installSkill();
        installSkill({ project: true });
        const stale = path.join(repo, '.agents', 'skills', 'contract-dev');
        for (const dir of [claude(), stale]) {
            fs.writeFileSync(path.join(dir, '.contract-dev-skill.json'), JSON.stringify({ version: '1.0.0' }));
            fs.writeFileSync(path.join(dir, 'SKILL.md'), 'old');
        }
        const refreshed = refreshInstalledSkills();
        expect(refreshed.map((o) => o.result)).toEqual(['updated', 'updated']);
        for (const dir of [claude(), stale]) {
            expect(marker(dir).version).toBe(cliVersion());
            expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).not.toBe('old');
        }
        expect(err.mock.calls.map((c: unknown[]) => c.join(' '))).toEqual([
            `Updated the contract-dev agent skill in ~/.claude/skills/contract-dev to ${cliVersion()}.`,
            `Updated the contract-dev agent skill in ${path.join(fs.realpathSync(repo), '.agents', 'skills', 'contract-dev')} to ${cliVersion()}.`,
        ]);
        expect(refreshInstalledSkills()).toEqual([]);
    });

    it('status names each folder, its agents and its version', async () => {
        await skillsCommand(['status']);
        expect(lines()[0]).toMatch(/^Not installed {2,}~\/\.claude\/skills\/contract-dev {2}\(Claude Code\)$/);
        expect(lines()[3]).toBe('Install it with: contract-dev skills install');
        log.mockClear();
        installSkill();
        await skillsCommand(['status']);
        expect(lines()[0]).toMatch(new RegExp(`^Up to date \\(${cliVersion().replace(/\./g, '\\.')}\\) {2,}~/\\.claude/skills/contract-dev`));
    });

    it('uninstall removes what it installed', async () => {
        installSkill();
        const result: any = await skillsCommand(['uninstall']);
        expect(result.targets.map((t: any) => t.result)).toEqual(['removed', 'removed']);
        expect(fs.existsSync(claude())).toBe(false);
        expect(fs.existsSync(agents())).toBe(false);
    });

    describe('offered at login', () => {
        it('asks at a terminal and installs on yes', async () => {
            const ask = jest.fn(async () => true);
            const outcomes = await offerSkillAfterLogin({ interactive: true, ask });
            expect(ask).toHaveBeenCalledWith('Install the agent skill for Claude Code, Codex, Cursor and other agents? (Y/n) ');
            expect(outcomes?.map((o) => o.result)).toEqual(['installed', 'installed']);
        });

        it('remembers a no, and from then on only says how', async () => {
            expect(await offerSkillAfterLogin({ interactive: true, ask: async () => false })).toBeNull();
            expect(lines().pop()).toBe('Skipped. Install it any time with: contract-dev skills install');
            const ask = jest.fn(async () => true);
            expect(await offerSkillAfterLogin({ interactive: true, ask })).toBeNull();
            expect(ask).not.toHaveBeenCalled();
            expect(fs.existsSync(claude())).toBe(false);
        });

        it('does not ask again once it is installed, and --no-skill never asks', async () => {
            installSkill();
            const ask = jest.fn(async () => true);
            expect(await offerSkillAfterLogin({ interactive: true, ask })).toBeNull();
            expect(await offerSkillAfterLogin({ interactive: true, skip: true, ask })).toBeNull();
            expect(ask).not.toHaveBeenCalled();
        });
    });
});
