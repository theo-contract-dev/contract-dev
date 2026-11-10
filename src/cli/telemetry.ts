// After a command has printed, one request tells the server what was run (POST /api/telemetry/cli):
// the command, the argv with secrets taken out, whether it worked, the error the person read, how
// long it took and the requests it made (./credentials requestsMade). The command centre's
// Activity page reads it, so someone who hit an error or a long wait is seen without writing in.
//
// Never in the way of the command: it goes after the output, waits at most a moment, and every
// failure is swallowed. Nothing is sent when CONTRACT_DEV_NO_TELEMETRY=1 is set, when the CLI is
// not logged in, for the commands that touch no workspace (login, help, version), or for a command
// that worked without asking the server anything.
import { agentRunning } from './about';
import { requestsMade, resolveAuth } from './credentials';
import { cliVersion } from './version';

const DEADLINE_MS = 1_500;
const ARGV_MAX = 600;
const ERROR_MAX = 600;

/** Commands that say nothing about a workspace. */
const QUIET = new Set(['login', 'logout', 'help', '--help', '-h', 'version', '--version', '-v', '-V', 'skills', 'skill', undefined]);
/** Nouns whose next word is the subcommand (`metric add`), as the command's name reads. */
const NOUNS = new Set(['workspace', 'workspaces', 'metric', 'metrics', 'monitor', 'monitors', 'report', 'reports', 'group', 'table', 'channel', 'channels', 'alert', 'alerts', 'incident', 'incidents', 'contract', 'contracts', 'wallet', 'wallets', 'factory', 'tool']);
/** A flag whose value is a secret: the value goes out as •••. */
const SECRET_FLAG = /^--?(api-?key|token|secret|password|webhook(-url)?|bot-?token|key)$/i;
/** A value that is a secret on its own: an API key, a Telegram bot token, a Slack webhook. */
const SECRET_VALUE = /^([0-9a-f]{40,}|\d{6,}:[A-Za-z0-9_-]{20,}|https:\/\/hooks\.slack\.com\/\S+)$/i;

export interface CommandOutcome {
  ok: boolean;
  error?: string;
  code?: string;
  ms: number;
}

/** `metric add`, `watch`, `tx`: the command as the Activity page lists it. */
export function commandName(args: string[]): string {
  const [first, second] = args;
  if (!first) return '?';
  if (NOUNS.has(first) && second && /^[a-z][a-z-]*$/.test(second)) return `${first} ${second}`;
  return first;
}

/** The argv as typed, secrets replaced, quoted where an argument has spaces, cut to ARGV_MAX. */
export function redactArgv(args: string[]): string {
  const out: string[] = [];
  let hideNext = false;
  for (const raw of args) {
    let a = raw;
    if (hideNext) {
      a = '•••';
      hideNext = false;
    } else if (SECRET_FLAG.test(a)) {
      hideNext = true;
    } else if (a.startsWith('--') && a.includes('=') && SECRET_FLAG.test(a.slice(0, a.indexOf('=')))) {
      a = `${a.slice(0, a.indexOf('='))}=•••`;
    } else if (SECRET_VALUE.test(a)) {
      a = '•••';
    }
    out.push(/\s/.test(a) ? JSON.stringify(a) : a);
  }
  const s = out.join(' ');
  return s.length > ARGV_MAX ? `${s.slice(0, ARGV_MAX - 1)}…` : s;
}

/** Whether this command's outcome is worth a report. */
export function shouldReport(args: string[], outcome: CommandOutcome, env: NodeJS.ProcessEnv = process.env, requests = requestsMade()): boolean {
  if (env.CONTRACT_DEV_NO_TELEMETRY === '1' || env.CONTRACT_DEV_NO_TELEMETRY === 'true') return false;
  if (QUIET.has(args[0])) return false;
  // a command that worked without the server (local help, a parse) has nothing to say; one that failed does
  if (outcome.ok && requests.length === 0) return false;
  return true;
}

/** The report, as sent. */
export function commandReport(args: string[], raw: string[], outcome: CommandOutcome): Record<string, unknown> {
  return {
    command: commandName(args),
    argv: redactArgv(raw),
    version: cliVersion(),
    ok: outcome.ok,
    error: outcome.ok ? undefined : (outcome.error ?? 'failed').slice(0, ERROR_MAX),
    code: outcome.code,
    ms: Math.max(0, Math.round(outcome.ms)),
    agent: agentRunning(),
    requests: requestsMade(),
  };
}

/**
 * Send the report for a finished command. `args` is the command as run (the staff flags taken
 * out), `raw` the whole line as typed. Resolves once sent or given up on; never throws.
 */
export async function sendCommandReport(args: string[], raw: string[], outcome: CommandOutcome): Promise<void> {
  try {
    if (!shouldReport(args, outcome)) return;
    const auth = resolveAuth();
    if (!auth) return;
    await fetch(`${auth.apiUrl}/api/telemetry/cli`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.apiKey}` },
      body: JSON.stringify(commandReport(args, raw, outcome)),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch {
    // never the person's problem
  }
}
