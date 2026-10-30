import { readFileSync } from 'node:fs';
import { flag, parseFlags, requirePositional } from './_args';
import { apiRequest, loadCredentials, requireAuth, saveCredentials } from '../credentials';
import { runTool } from '../tools';
import { loginCommand, planLine, WhoamiPayload } from './login';

const HELP = `contract-dev workspace — the workspace the CLI acts on, and its brief on its protocol

Usage:
  contract-dev workspace                 The workspace the credentials are bound to, its plan, its brief on the
                                         protocol (what it is, each group's role, its mechanism, its tokens, what
                                         the metrics mean) and what it holds. Read it before anything else.
  contract-dev workspace brief "<text>" | --file <path> [--append]
                                         Write the brief, in plain words, from what was read (the source's own
                                         notes, the group names, the docs), a page or two at most. Without --append the
                                         text replaces the whole brief: a setup, or a rewrite the person asked
                                         for. --append adds a paragraph under it and leaves the rest as it is (a
                                         watch adds its own line with --about). No text: print the brief.
  contract-dev workspace list            List the workspaces you belong to
  contract-dev workspace use <ref>       Switch to another workspace (ref = slug, id, or name)

Credentials are bound to ONE workspace: the one that was active in the app when you
approved the login. \`workspace use\` therefore runs the login again — make the workspace
you want the active one in the app before approving. \`--no-browser\` prints the
activation URL instead of opening it.
`;

type Workspace = { id: string; name: string; slug?: string };

/** The workspace's brief on its protocol, as describe_workspace returns it. */
export interface WorkspaceBrief {
  text: string;
  writtenAt: string;
  by: string | null;
  origin: 'user' | 'cli' | 'agent' | null;
  /** `Written Oct 28 by Tae Lee. Not in it: 1 contract watched since, in no group (…).` */
  provenance: string;
  notCovered: { contracts: string[]; contractsCount: number; groups: string[] };
}

interface WorkspaceDescription {
  brief: WorkspaceBrief | null;
  /** What the workspace holds: contracts by chain, groups, kinds, metrics, monitors, reports, destinations, plan. */
  holds: string;
}

const describe = (w: Workspace) => `${w.name}${w.slug ? ` (${w.slug})` : ''}`;

/** The brief under its heading, or the one line that says there is none yet. */
export function briefLines(brief: WorkspaceBrief | null): string[] {
  if (!brief) return ['No brief on the protocol yet. A setup ends with one; `contract-dev workspace brief "<text>"` writes it.'];
  return [`Brief on this protocol, in the workspace's own words (${brief.provenance})`, ...brief.text.split('\n')];
}

export async function workspaceCommand(args: string[]): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
      return await showActive();
    case 'brief':
      return await briefCommand(rest);
    case 'list':
      return await listWorkspaces();
    case 'use':
      return await useWorkspace(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown workspace subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

// The session's first command: who the CLI acts as, then the protocol in the workspace's own
// words, then what it holds — so an agent answers in the protocol's terms from its first question.
async function showActive(): Promise<unknown> {
  const auth = requireAuth();
  const [who, ws] = await Promise.all([apiRequest<WhoamiPayload>(auth, 'GET', '/api/cli/whoami'), runTool<WorkspaceDescription>(auth, 'describe_workspace')]);
  if (!who.org) {
    console.log('No active workspace resolved.');
    return;
  }
  console.log(describe(who.org));
  if (who.plan) console.log(`Plan: ${planLine(who.plan)}`);
  console.log('');
  for (const line of briefLines(ws.brief)) console.log(line);
  console.log('');
  console.log(ws.holds);
  return { ...who.org, plan: who.plan ?? null, brief: ws.brief, holds: ws.holds };
}

async function briefCommand(args: string[]): Promise<unknown> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const file = flag(flags, 'file');
  const text = (file ? readFileSync(file, 'utf8') : (flags._ as string[]).join(' ')).trim();
  const auth = requireAuth();
  if (!text) {
    const ws = await runTool<WorkspaceDescription>(auth, 'describe_workspace');
    for (const line of briefLines(ws.brief)) console.log(line);
    return ws.brief;
  }
  const append = flag(flags, 'append') !== undefined;
  const r = await runTool<{ saved: true; brief: WorkspaceBrief }>(auth, 'set_workspace_brief', { text, ...(append ? { append: true } : {}) });
  console.log(`${append ? 'Added to' : 'Saved'} the brief (${r.brief.text.length} characters). ${r.brief.provenance}`);
  return r.brief;
}

async function listWorkspaces(): Promise<void> {
  const auth = requireAuth();
  const who = await apiRequest<WhoamiPayload>(auth, 'GET', '/api/cli/whoami');
  const workspaces = who.workspaces ?? [];
  if (!workspaces.length) {
    console.log('No workspaces found for this account.');
    return;
  }
  for (const workspace of workspaces) {
    const active = workspace.id === who.org?.id ? '*' : ' ';
    console.log(`${active} ${workspace.name}${workspace.slug ? `  (${workspace.slug})` : ''}`);
  }
  if (workspaces.length > 1) {
    console.log('');
    console.log('The credentials are bound to the starred workspace; `contract-dev workspace use <name>` logs in to another.');
  }
}

function findWorkspace(who: WhoamiPayload, ref: string): Workspace {
  const workspaces = who.workspaces ?? [];
  const lowered = ref.toLowerCase();
  const match =
    workspaces.find((w) => w.slug === ref || w.id === ref) ??
    workspaces.find((w) => w.name.toLowerCase() === lowered);
  if (!match) {
    const available = workspaces.map((w) => w.slug ?? w.name).join(', ') || 'none';
    throw new Error(`No workspace matches "${ref}". Available: ${available}`);
  }
  return match;
}

// A key acts as exactly the workspace it was minted for (the server refuses a workspace
// header naming any other), so switching means getting a new key: run the login again with
// the target workspace active in the app. Naming the bound workspace is a no-op.
async function useWorkspace(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'workspace (slug, id, or name)');

  const auth = requireAuth();
  const who = await apiRequest<WhoamiPayload>(auth, 'GET', '/api/cli/whoami');
  const target = findWorkspace(who, ref);

  if (who.org && target.id === who.org.id) {
    const stored = loadCredentials();
    if (stored) saveCredentials({ ...stored, workspaceId: target.id, workspaceName: target.name });
    console.log(`Already acting on ${describe(target)}.`);
    return;
  }

  const bound = who.org?.name ?? 'another workspace';
  if (auth.source === 'env') {
    throw new Error(
      `These credentials are bound to ${bound}. Log in with ${target.name} active in the app to get credentials for it.`,
    );
  }

  console.log(`Credentials are bound to ${bound}. To act on ${target.name}, make it the active workspace in the app, then approve the login.`);
  await loginCommand(['--api-url', auth.apiUrl, ...(flags['no-browser'] === 'true' ? ['--no-browser'] : [])]);

  const after = loadCredentials();
  if (after?.workspaceId && after.workspaceId !== target.id) {
    console.log(
      `These credentials are bound to ${after.workspaceName ?? 'a different workspace'}, not ${target.name} — make ${target.name} the active workspace in the app and run \`contract-dev workspace use ${ref}\` again.`,
    );
    return;
  }
  console.log(`Active workspace: ${describe(target)}`);
}
