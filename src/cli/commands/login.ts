import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { parseFlags, flag } from './_args';
import {
  DEFAULT_API_URL,
  apiRequest,
  clearCredentials,
  credentialsPath,
  loadCredentials,
  resolveAuth,
  saveCredentials,
} from '../credentials';

const HELP = `contract.dev login — connect the CLI to your contract.dev account

Usage:
  contract.dev login                    Device-code sign-in (opens the browser)
  contract.dev login --no-browser       Print the activation URL instead of opening it

The CLI shows a one-time code and opens the activation page. Approving there saves
credentials to ~/.contract.dev/credentials.json, bound to your account and to the
workspace that is active in the app at that moment. To act on another workspace,
make it the active one in the app and log in again (\`contract.dev workspace use\`).
`;

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  expiresIn?: number;
  interval?: number;
}

interface DevicePoll {
  status?: string;
  key?: string;
  email?: string | null;
  org?: { id: string; name: string; slug?: string } | null;
  error?: string;
}

export interface WhoamiPayload {
  email?: string | null;
  org?: { id: string; name: string; slug?: string } | null;
  workspaces?: Array<{ id: string; name: string; slug?: string }>;
  /** the API key this request authenticated with — what `logout` revokes */
  apiKeyId?: string | null;
}

function openBrowser(url: string): void {
  const [cmd, cmdArgs]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // browserless environment — the printed URL covers it
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function loginCommand(args: string[]): Promise<void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);
  const apiUrl = (flag(flags, 'api-url') ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const noBrowser = flags['no-browser'] === 'true';

  const existing = loadCredentials();
  if (existing) {
    console.log(`Already logged in${existing.email ? ` as ${existing.email}` : ''} — continuing replaces the saved credentials.`);
  }

  const startResponse = await fetch(`${apiUrl}/api/cli/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: hostname() }),
  });
  const start = (await startResponse.json().catch(() => null)) as (DeviceStart & { error?: string }) | null;
  if (!startResponse.ok || !start?.deviceCode || !start?.userCode) {
    throw new Error(start?.error || `Could not start login against ${apiUrl} (status ${startResponse.status})`);
  }

  const activateUrl = `${apiUrl}/activate?code=${encodeURIComponent(start.userCode)}`;
  console.log('');
  console.log(`  One-time code: ${start.userCode}`);
  console.log('');
  if (noBrowser) {
    console.log(`Approve the CLI at: ${activateUrl}`);
  } else {
    console.log(`Opening ${activateUrl}`);
    openBrowser(activateUrl);
  }
  console.log('Waiting for approval...');

  const intervalSeconds = Number(start.interval);
  const intervalMs = (Number.isFinite(intervalSeconds) && intervalSeconds >= 0 ? intervalSeconds : 5) * 1000;
  const deadline = Date.now() + (Number(start.expiresIn) > 0 ? Number(start.expiresIn) : 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const pollResponse = await fetch(`${apiUrl}/api/cli/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    const poll = (await pollResponse.json().catch(() => null)) as DevicePoll | null;
    if (!pollResponse.ok) {
      throw new Error(poll?.error || `Login failed (status ${pollResponse.status})`);
    }
    if (poll?.status === 'pending') continue;
    if (poll?.status === 'denied') throw new Error('Login request was denied in the browser.');
    if (poll?.status === 'expired') throw new Error('The code expired before approval. Re-run `contract.dev login`.');
    if (poll?.status === 'approved' && poll.key) {
      const credentials = { apiKey: poll.key, apiUrl, email: poll.email ?? undefined };
      saveCredentials(credentials);
      // Resolve the default active workspace (the server's fallback = personal).
      let who: WhoamiPayload | null = null;
      try {
        who = await apiRequest<WhoamiPayload>({ apiKey: poll.key, apiUrl, source: 'file' }, 'GET', '/api/cli/whoami');
        if (who.org) {
          saveCredentials({ ...credentials, workspaceId: who.org.id, workspaceName: who.org.name });
        }
      } catch {
        // workspace resolution is best-effort; the key alone is a working login
      }
      console.log(`Logged in${poll.email ? ` as ${poll.email}` : ''}`);
      if (who?.workspaces && who.workspaces.length > 1 && who.org) {
        console.log(
          `Credentials are bound to ${who.org.name}. You belong to ${who.workspaces.length} workspaces — \`contract.dev workspace use <name>\` logs in to another.`,
        );
      }
      return;
    }
    throw new Error('Unexpected response from the login endpoint.');
  }
  throw new Error('Timed out waiting for approval. Re-run `contract.dev login`.');
}

export async function whoamiCommand(args: string[] = []): Promise<WhoamiPayload | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const auth = resolveAuth();
  if (!auth) {
    console.error('Not logged in. Run `contract.dev login`.');
    process.exit(1);
  }
  const payload = await apiRequest<WhoamiPayload>(auth, 'GET', '/api/cli/whoami');
  console.log(`${payload.email ?? 'unknown user'}${payload.org?.name ? ` (workspace: ${payload.org.name})` : ''}`);
  console.log(`Auth: ${auth.source === 'env' ? 'environment credentials' : credentialsPath()} → ${auth.apiUrl}${payload.apiKeyId ? `  (key ${payload.apiKeyId})` : ''}`);
  return payload;
}

// Logging out revokes the key on the server first, so it does not outlive this machine —
// best-effort: an unreachable server still ends with the local file gone. Environment
// credentials are left alone (they may be a CI key shared beyond this shell).
export async function logoutCommand(args: string[] = []): Promise<{ removed: boolean; revoked: boolean } | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const stored = loadCredentials();
  let revoked = false;
  if (stored) {
    try {
      await apiRequest({ apiKey: stored.apiKey, apiUrl: stored.apiUrl, source: 'file' }, 'POST', '/api/cli/logout');
      revoked = true;
      console.log('Revoked the API key.');
    } catch (err) {
      console.log(`Could not revoke the API key (${err instanceof Error ? err.message : String(err)}). Revoke it under APIs in the app.`);
    }
  }
  const removed = clearCredentials();
  console.log(removed ? `Removed ${credentialsPath()}` : 'No saved credentials to remove.');
  if (process.env.CONTRACT_DEV_API_KEY) {
    console.log('Note: environment credentials are set in this shell and still authenticate.');
  }
  return { removed, revoked };
}
