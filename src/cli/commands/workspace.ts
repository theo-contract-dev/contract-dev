import { parseFlags, requirePositional } from './_args';
import { apiRequest, loadCredentials, requireAuth, saveCredentials } from '../credentials';
import { loginCommand, WhoamiPayload } from './login';

const HELP = `contract.dev workspace — the workspace the CLI acts on

Usage:
  contract.dev workspace                 Show the workspace the credentials are bound to
  contract.dev workspace list            List the workspaces you belong to
  contract.dev workspace use <ref>       Switch to another workspace (ref = slug, id, or name)

Credentials are bound to ONE workspace: the one that was active in the app when you
approved the login. \`workspace use\` therefore runs the login again — make the workspace
you want the active one in the app before approving. \`--no-browser\` prints the
activation URL instead of opening it.
`;

type Workspace = { id: string; name: string; slug?: string };

const describe = (w: Workspace) => `${w.name}${w.slug ? ` (${w.slug})` : ''}`;

export async function workspaceCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
      return await showActive();
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

async function showActive(): Promise<void> {
  const auth = requireAuth();
  const who = await apiRequest<WhoamiPayload>(auth, 'GET', '/api/cli/whoami');
  if (!who.org) {
    console.log('No active workspace resolved.');
    return;
  }
  console.log(describe(who.org));
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
    console.log('The credentials are bound to the starred workspace; `contract.dev workspace use <name>` logs in to another.');
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
      `These credentials are bound to ${after.workspaceName ?? 'a different workspace'}, not ${target.name} — make ${target.name} the active workspace in the app and run \`contract.dev workspace use ${ref}\` again.`,
    );
    return;
  }
  console.log(`Active workspace: ${describe(target)}`);
}
