// The agent skill: the instructions that let Claude Code, Codex, Cursor and other coding
// agents drive this CLI. It ships inside the package; `skills install` copies it to the
// folders the agents read. Two folders cover them all: `.claude/skills` (Claude Code; Cursor
// and Copilot read it too) and `.agents/skills`, the shared one (Codex, Cursor, Gemini CLI,
// Copilot). Each copy carries a marker with the CLI version that wrote it, so an upgrade can
// refresh it and nothing that is not ours is ever overwritten.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseFlags } from './_args';
import { cliVersion } from '../version';
import { apiRequest, resolveAuth } from '../credentials';

const SKILL = 'contract-dev';
const MARKER = '.contract-dev-skill.json';

const HELP = `contract-dev skills — the agent skill for Claude Code, Codex, Cursor and other coding agents

Usage:
  contract-dev skills install [--project] [--force]   Install it, or refresh it to this CLI's version
  contract-dev skills status [--project]              Where it is installed and which version
  contract-dev skills uninstall [--project]           Remove it (run this before npm uninstall)

The skill teaches an agent this CLI: how to find, read and set things up in your workspace,
including setting up a protocol. It goes to two folders, which every major agent reads:
  ~/.claude/skills/contract-dev   Claude Code (Cursor and GitHub Copilot read it too)
  ~/.agents/skills/contract-dev   Codex, Cursor, Gemini CLI, GitHub Copilot

--project   This repository instead of your home folder (.claude/skills and .agents/skills at
            the repository root), so it can be committed for the whole team.
--force     Replace a contract-dev skill this CLI did not install (one copied or linked by hand).

After an upgrade, the next command refreshes the installed copies to the new version.
`;

const HELP_WORDS = ['help', '-h', '--help'];

export type SkillState = 'missing' | 'installed' | 'linked' | 'other';

export interface SkillTarget {
  /** The skill's folder: <root>/.claude/skills/contract-dev or <root>/.agents/skills/contract-dev. */
  path: string;
  agents: string;
  state: SkillState;
  /** The CLI version that wrote it, for an installed copy. */
  version: string | null;
}

export interface SkillOutcome {
  path: string;
  agents: string;
  result: 'installed' | 'updated' | 'unchanged' | 'linked' | 'skipped' | 'removed' | 'absent';
  reason?: string;
}

function homeDir(): string {
  return process.env.HOME || homedir();
}

/** The skill folder this package ships: <package>/skills/contract-dev. */
export function packagedSkillDir(): string {
  // dist/cli/commands/skills.js and src/cli/commands/skills.ts sit three levels under the package root.
  return join(__dirname, '..', '..', '..', 'skills', SKILL);
}

/** The repository the shell is in (the nearest folder holding .git), else the current folder. */
export function projectRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(from);
    dir = up;
  }
}

const FOLDERS: { sub: string[]; agents: string }[] = [
  { sub: ['.claude', 'skills'], agents: 'Claude Code' },
  { sub: ['.agents', 'skills'], agents: 'Codex, Cursor, Gemini CLI, GitHub Copilot' },
];

const sameDir = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

interface Marker {
  version: string;
  installedAt?: string;
  /** The server guide written into SKILL.md, and when it was last checked for a newer one. */
  guideVersion?: string | null;
  guideCheckedAt?: string | null;
}

function readMarkerFile(path: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(join(path, MARKER), 'utf8'));
    return typeof m?.version === 'string' ? m : null;
  } catch {
    return null;
  }
}

function readMarker(path: string): string | null {
  return readMarkerFile(path)?.version ?? null;
}

/* ── the server's guide ────────────────────────────────────────────────────── */

/**
 * The guide the platform serves: which command answers which question, how to answer, the
 * starter pack — the same one its Slack and Telegram assistant reads. Written into the skill
 * between these markers, so a tool the server adds reaches the agent without a new CLI.
 */
export interface Guide {
  version: string;
  markdown: string;
}

const GUIDE_START = /<!-- contract-dev:guide:start[^>]*-->/;
const GUIDE_END = '<!-- contract-dev:guide:end -->';

/** The guide, from the server the CLI is logged in to; null without a login, on an older server, or past the timeout. */
export async function fetchGuide(timeoutMs = 3_000): Promise<Guide | null> {
  const auth = resolveAuth();
  if (!auth) return null;
  try {
    const g = await apiRequest<Guide>(auth, 'GET', '/api/mainnet/tools/guide', undefined, { timeoutMs });
    return typeof g?.version === 'string' && typeof g.markdown === 'string' && g.markdown.trim() ? g : null;
  } catch {
    return null;
  }
}

/** SKILL.md with its guide block replaced by this guide; unchanged when the file has no block. */
export function withGuide(skill: string, guide: Guide): string {
  const start = GUIDE_START.exec(skill);
  const end = skill.indexOf(GUIDE_END);
  if (!start || end < start.index) return skill;
  const head = skill.slice(0, start.index);
  const tail = skill.slice(end + GUIDE_END.length);
  const comment = "<!-- Written by `contract-dev skills install` from the server: the same guide the Slack and Telegram assistant reads. Edit it in the server's lib/agent/guide.ts, not here. -->";
  return `${head}<!-- contract-dev:guide:start version=${guide.version} -->\n${comment}\n\n${guide.markdown.trim()}\n\n${GUIDE_END}${tail}`;
}

/** Write the guide (when there is one) and, when the server was asked, stamp the check. */
function writeGuide(path: string, guide: Guide | null, now: string, asked = guide != null): void {
  const file = join(path, 'SKILL.md');
  if (guide) {
    try {
      writeFileSync(file, withGuide(readFileSync(file, 'utf8'), guide));
    } catch {
      // a skill without the file keeps what it had
    }
  }
  const marker = readMarkerFile(path);
  if (marker && (guide || asked)) writeFileSync(join(path, MARKER), JSON.stringify({ ...marker, ...(guide ? { guideVersion: guide.version } : {}), ...(asked ? { guideCheckedAt: now } : {}) }, null, 2) + '\n');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Once a day, bring the installed copies' guide up to the server's: a tool the platform added
 * since reaches the agent without a new CLI. Quiet and best-effort, a short timeout, never in the
 * way of the command; skipped without a login.
 */
export async function refreshGuideIfStale(timeoutMs = 2_000): Promise<boolean> {
  const stale = [...skillTargets(false), ...safeTargets(true)].filter((t) => {
    if (t.state !== 'installed') return false;
    const checked = Date.parse(readMarkerFile(t.path)?.guideCheckedAt ?? '');
    return !Number.isFinite(checked) || Date.now() - checked > DAY_MS;
  });
  if (!stale.length || !resolveAuth()) return false;
  const guide = await fetchGuide(timeoutMs);
  const now = new Date().toISOString();
  // asked either way: an offline machine is not asked again for a day, so commands stay quick
  for (const t of stale) {
    const had = readMarkerFile(t.path)?.guideVersion ?? null;
    writeGuide(t.path, guide && guide.version !== had ? guide : null, now, true);
  }
  return !!guide;
}

function safeTargets(project: boolean): SkillTarget[] {
  try {
    return skillTargets(project);
  } catch {
    return [];
  }
}

export function inspect(path: string, agents: string): SkillTarget {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { path, agents, state: 'missing', version: null };
  }
  // a link to this package's own skill is always current: leave it be
  if (stat.isSymbolicLink()) return { path, agents, state: sameDir(path, packagedSkillDir()) ? 'linked' : 'other', version: null };
  const version = readMarker(path);
  return { path, agents, state: version ? 'installed' : 'other', version };
}

export function skillTargets(project = false): SkillTarget[] {
  const root = project ? projectRoot() : homeDir();
  return FOLDERS.map((f) => inspect(join(root, ...f.sub, SKILL), f.agents));
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function remove(path: string): void {
  // a link goes, never what it points at
  if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
  else rmSync(path, { recursive: true, force: true });
}

/** Write this CLI's skill into one folder, replacing an older copy of ours (and, with force, anyone's). */
export function installInto(target: SkillTarget, force = false, guide: Guide | null = null): SkillOutcome {
  const base = { path: target.path, agents: target.agents };
  const version = cliVersion();
  if (target.state === 'linked') return { ...base, result: 'linked', reason: 'linked to this CLI, always current' };
  if (target.state === 'other' && !force) return { ...base, result: 'skipped', reason: 'a contract-dev skill this CLI did not install is there; --force replaces it' };
  if (target.state === 'installed' && target.version === version && !force) {
    // the CLI's copy is current; the server's guide may still be newer
    if (guide && readMarkerFile(target.path)?.guideVersion !== guide.version) {
      writeGuide(target.path, guide, new Date().toISOString());
      return { ...base, result: 'updated', reason: `guide ${guide.version}` };
    }
    return { ...base, result: 'unchanged' };
  }
  const src = packagedSkillDir();
  if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`This install of contract-dev has no skill at ${src}. Reinstall the CLI: npm i -g @contract-dev/cli`);
  if (target.state !== 'missing') remove(target.path);
  copyDir(src, target.path);
  const now = new Date().toISOString();
  writeFileSync(join(target.path, MARKER), JSON.stringify({ version, installedAt: now }, null, 2) + '\n');
  // the packaged guide is the fallback; the server's, when it answers, replaces it
  writeGuide(target.path, guide, now);
  return { ...base, result: target.state === 'missing' ? 'installed' : 'updated' };
}

const tilde = (p: string): string => {
  const home = homeDir();
  return p.startsWith(home + '/') || p.startsWith(home + '\\') ? '~' + p.slice(home.length) : p;
};

const RESULT_WORDS: Record<SkillOutcome['result'], string> = {
  installed: 'Installed',
  updated: 'Updated',
  unchanged: 'Up to date',
  linked: 'Linked',
  skipped: 'Skipped',
  removed: 'Removed',
  absent: 'Not installed',
};

function printOutcomes(outcomes: SkillOutcome[]): void {
  for (const o of outcomes) console.log(`${RESULT_WORDS[o.result].padEnd(13)} ${tilde(o.path)}  (${o.agents})${o.reason ? ` · ${o.reason}` : ''}`);
}

/** Install for the whole machine (or the repository); what each folder ended as. */
export function installSkill(opts: { project?: boolean; force?: boolean; guide?: Guide | null } = {}): SkillOutcome[] {
  return skillTargets(opts.project).map((t) => installInto(t, opts.force, opts.guide ?? null));
}

/**
 * After an upgrade, bring the copies this CLI installed up to its version: the home folders and
 * the repository the shell is in. Quiet, best-effort, never in the way of the command: one line
 * on stderr per folder it refreshed.
 */
export function refreshInstalledSkills(): SkillOutcome[] {
  const version = cliVersion();
  if (version === 'unknown') return [];
  const out: SkillOutcome[] = [];
  const seen = new Set<string>();
  for (const project of [false, true]) {
    let targets: SkillTarget[];
    try {
      targets = skillTargets(project);
    } catch {
      continue;
    }
    for (const t of targets) {
      if (seen.has(t.path) || t.state !== 'installed' || t.version === version) continue;
      seen.add(t.path);
      try {
        const o = installInto(t);
        out.push(o);
        console.error(`Updated the contract-dev agent skill in ${tilde(t.path)} to ${version}.`);
      } catch {
        // a read-only folder or a vanished package: the old copy keeps working
      }
    }
  }
  return out;
}

/* ── offered at login ──────────────────────────────────────────────────────── */

function preferencesPath(): string {
  return join(homeDir(), '.contract.dev', 'preferences.json');
}

function readPreferences(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(preferencesPath(), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function writePreference(key: string, value: unknown): void {
  const prefs = { ...readPreferences(), [key]: value };
  mkdirSync(dirname(preferencesPath()), { recursive: true, mode: 0o700 });
  writeFileSync(preferencesPath(), JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 });
}

export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise((done) => rl.question(question, done));
    return !/^\s*n/i.test(answer);
  } finally {
    rl.close();
  }
}

/**
 * Login's last step: offer the skill once. `--skill` installs without asking, `--no-skill`
 * skips; with no terminal to ask on, or once someone said no, it says how and moves on.
 */
export async function offerSkillAfterLogin(opts: { install?: boolean; skip?: boolean; interactive: boolean; ask?: (q: string) => Promise<boolean> }): Promise<SkillOutcome[] | null> {
  if (opts.skip) return null;
  const targets = skillTargets(false);
  if (!opts.install && targets.some((t) => t.state === 'installed' || t.state === 'linked')) return null;
  let yes = !!opts.install;
  if (!yes) {
    if (!opts.interactive || readPreferences().skillDeclined === true) {
      console.log('Agent skill for Claude Code, Codex and Cursor: contract-dev skills install');
      return null;
    }
    yes = await (opts.ask ?? askYesNo)('Install the agent skill for Claude Code, Codex, Cursor and other agents? (Y/n) ');
  }
  if (!yes) {
    writePreference('skillDeclined', true);
    console.log('Skipped. Install it any time with: contract-dev skills install');
    return null;
  }
  const guide = await fetchGuide();
  const outcomes = targets.map((t) => installInto(t, false, guide));
  printOutcomes(outcomes);
  return outcomes;
}

/* ── the command ───────────────────────────────────────────────────────────── */

export async function skillsCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  if (!sub || HELP_WORDS.includes(sub) || HELP_WORDS.includes(rest[0] ?? '')) {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(rest);
  const project = flags.project === 'true';
  const force = flags.force === 'true';
  const version = cliVersion();
  if (sub === 'install' || sub === 'update') {
    const outcomes = installSkill({ project, force, guide: await fetchGuide() });
    printOutcomes(outcomes);
    if (outcomes.some((o) => o.result === 'installed' || o.result === 'updated')) {
      console.log('');
      console.log(project ? 'Commit both folders so the team gets it. Agents load it in their next session.' : 'Agents load it in their next session: ask one to "set up our protocol on contract.dev".');
    }
    return { version, project, targets: outcomes };
  }
  if (sub === 'status') {
    const targets = skillTargets(project);
    for (const t of targets) {
      const state =
        t.state === 'installed' ? (t.version === version ? `Up to date (${t.version})` : `Installed (${t.version}, CLI is ${version})`) : t.state === 'linked' ? 'Linked to this CLI' : t.state === 'other' ? 'Someone else\'s copy' : 'Not installed';
      console.log(`${state.padEnd(30)} ${tilde(t.path)}  (${t.agents})`);
    }
    if (targets.every((t) => t.state === 'missing')) {
      console.log('');
      console.log(`Install it with: contract-dev skills install${project ? ' --project' : ''}`);
    }
    return { version, project, targets };
  }
  if (sub === 'uninstall' || sub === 'remove') {
    const outcomes: SkillOutcome[] = skillTargets(project).map((t) => {
      const base = { path: t.path, agents: t.agents };
      if (t.state === 'missing') return { ...base, result: 'absent' };
      if (t.state === 'other' && !force) return { ...base, result: 'skipped', reason: 'not installed by this CLI; --force removes it' };
      remove(t.path);
      return { ...base, result: 'removed' };
    });
    printOutcomes(outcomes);
    return { version, project, targets: outcomes };
  }
  throw new Error(`Unknown skills command: ${sub}. Try: contract-dev skills help`);
}
