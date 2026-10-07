import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://app.contract.dev';

// Saved by `contract-dev login`, per-user per-machine (never in the repo). The key is
// ORG-SCOPED: it acts as exactly the workspace that was active in the app when the login
// was approved. workspaceId/Name record that workspace for display and for keying the
// per-workspace active stagenet; switching workspaces means a new login (`workspace use`).
export interface StoredCredentials {
  apiKey: string;
  apiUrl: string;
  email?: string;
  workspaceId?: string;
  workspaceName?: string;
  // Active stagenet per workspace id (set via `contract-dev stagenet use`), so a login into
  // another workspace can never silently target the previous one's fork.
  activeStagenets?: Record<string, { id: string; name: string }>;
}

// $HOME first (the conventional CLI override; also what tests point at a tmp dir —
// os.homedir() alone reads the C-level environ, which sandboxed test envs don't touch),
// falling back to os.homedir() where HOME is unset (e.g. Windows).
function homeDir(): string {
  return process.env.HOME || homedir();
}

export function credentialsPath(): string {
  return join(homeDir(), '.contract.dev', 'credentials.json');
}

export function loadCredentials(): StoredCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    if (typeof parsed?.apiKey !== 'string' || !parsed.apiKey) return null;
    return {
      apiKey: parsed.apiKey,
      apiUrl: typeof parsed.apiUrl === 'string' && parsed.apiUrl ? parsed.apiUrl : DEFAULT_API_URL,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : undefined,
      workspaceName: typeof parsed.workspaceName === 'string' ? parsed.workspaceName : undefined,
      activeStagenets:
        parsed.activeStagenets && typeof parsed.activeStagenets === 'object' ? parsed.activeStagenets : undefined,
    };
  } catch {
    // missing or corrupt file = logged out
    return null;
  }
}

export function saveCredentials(credentials: StoredCredentials): string {
  const path = credentialsPath();
  mkdirSync(join(homeDir(), '.contract.dev'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  return path;
}

export function clearCredentials(): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export interface ResolvedAuth {
  apiKey: string;
  apiUrl: string;
  source: 'env' | 'file';
}

// Env wins over the saved file so CI and one-off overrides behave predictably.
export function resolveAuth(): ResolvedAuth | null {
  const envKey = process.env.CONTRACT_DEV_API_KEY;
  if (envKey) {
    return { apiKey: envKey, apiUrl: process.env.CONTRACT_DEV_API_URL || DEFAULT_API_URL, source: 'env' };
  }
  const stored = loadCredentials();
  if (!stored) return null;
  return { apiKey: stored.apiKey, apiUrl: process.env.CONTRACT_DEV_API_URL || stored.apiUrl, source: 'file' };
}

// A workspace named for this invocation (--workspace <id|slug>, or CONTRACT_DEV_WORKSPACE):
// every request asks the server to act on it instead of the workspace the key is bound to.
// The server honours that for contract.dev staff and refuses any other key, so for everyone
// else the key alone still decides the workspace.
let workspaceOverride: string | undefined;

export function setWorkspaceOverride(ref: string | undefined): void {
  workspaceOverride = ref?.trim() || undefined;
}

export function workspaceOverrideRef(): string | undefined {
  return workspaceOverride ?? (process.env.CONTRACT_DEV_WORKSPACE?.trim() || undefined);
}

export function requireAuth(): ResolvedAuth {
  const auth = resolveAuth();
  if (!auth) {
    throw new Error('Not logged in. Run `contract-dev login`.');
  }
  return auth;
}

// A request that hangs must not hang the CLI: every call carries a deadline. Reads retry
// once (a socket that died, a 5xx); writes never do — a POST may have reached the server
// before the failure, and retrying it could create a second monitor or metric.
export const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RequestOptions {
  /** Deadline for this call, when the default is too short (creating a stagenet provisions infrastructure). */
  timeoutMs?: number;
}

function describeFailure(err: unknown, apiUrl: string, timeoutMs: number): Error {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`No response from ${apiUrl} within ${Math.round(timeoutMs / 1000)}s.`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Could not reach ${apiUrl}: ${message}`);
}

// Authenticated call against the contract.dev app API.
export async function apiRequest<T>(
  auth: ResolvedAuth,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const workspace = workspaceOverrideRef();
  const attempt = () =>
    fetch(`${auth.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.apiKey}`,
        ...(workspace ? { 'X-Contract-Dev-Workspace': workspace } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  let response: Response;
  try {
    response = await attempt();
    if (method === 'GET' && response.status >= 500) {
      await sleep(RETRY_DELAY_MS);
      response = await attempt();
    }
  } catch (err) {
    if (method !== 'GET') throw describeFailure(err, auth.apiUrl, timeoutMs);
    await sleep(RETRY_DELAY_MS);
    try {
      response = await attempt();
    } catch (again) {
      throw describeFailure(again, auth.apiUrl, timeoutMs);
    }
  }

  const payload: any = await response.json().catch(() => null);
  if (response.status === 401) {
    if (workspace) {
      throw new Error(
        `These credentials cannot act on workspace "${workspace}". Log in with it active in the app instead (\`contract-dev workspace use ${workspace}\`).`,
      );
    }
    throw new Error('API key was rejected. Run `contract-dev login` again.');
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }
  return payload as T;
}
