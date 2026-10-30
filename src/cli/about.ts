// A watch's line for the workspace's brief (2026-10-28): `--about "<role>"` on `watch`, `watch wallet`
// and `group rule add`, added under the brief once the watch is saved, so the next conversation
// knows what was added. An agent must give it or say it is skipping (`--no-about`, a setup that
// ends by writing the whole brief); a person typing at a terminal is asked nothing.
import { flag, type ParsedFlags } from './commands/_args';
import { type ResolvedAuth } from './credentials';
import { runTool } from './tools';

/**
 * Whether an agent is running the command rather than a person at a terminal: an agent's own mark in
 * the environment (Claude Code sets CLAUDECODE=1; AI_AGENT names the agent), else no terminal on
 * stdout, which is how an agent reads a command's output. A person who pipes a watch into another
 * command reads as one too, and adds --no-about.
 */
export function agentRunning(env: NodeJS.ProcessEnv = process.env, stdout: { isTTY?: boolean } = process.stdout): boolean {
  if (env.CLAUDECODE === '1' || (env.AI_AGENT ?? '').trim() !== '') return true;
  return !stdout.isTTY;
}

/** The line to add, or undefined: refuses an agent's watch that neither gives one nor skips it, before anything is watched. */
export function aboutFlag(flags: ParsedFlags, what: string): string | undefined {
  const about = flag(flags, 'about');
  const skip = flag(flags, 'no-about') !== undefined;
  if (about === 'true' || (about !== undefined && !about.trim())) throw new Error('--about needs the sentence, in quotes.');
  if (about !== undefined && skip) throw new Error('Give --about or --no-about, not both.');
  if (about === undefined && !skip && agentRunning()) {
    throw new Error(
      `Nothing was watched. Say what ${what} adds to the protocol: --about "<one or two sentences on its role>", read from its source (contract-dev source <contract>), never from its name; it is added to the workspace's brief. In a setup, which ends by writing the whole brief (contract-dev workspace brief), pass --no-about.`,
    );
  }
  return about?.trim();
}

/** `V2 Fee Escrow: Collects every launch fee…`: the line names what it is about, unless the sentence already does (the server's aboutLine). */
export function aboutLine(names: string[], about: string): string {
  const text = about.trim();
  const said = text.toLowerCase();
  const unnamed = Array.from(new Set(names.map((n) => n.trim()).filter((n) => n && !said.includes(n.toLowerCase()))));
  return unnamed.length > 0 ? `${unnamed.join(', ')}: ${text}` : text;
}

export interface BriefAdded {
  added: boolean;
  error?: string;
}

/** Adds the line once the watch is saved; a refusal (the brief is full) is said, never undoes the watch. */
export async function addToBrief(auth: ResolvedAuth, names: string[], about: string | undefined): Promise<BriefAdded | null> {
  if (!about) return null;
  try {
    await runTool(auth, 'set_workspace_brief', { text: aboutLine(names, about), append: true });
    console.log("Added to the workspace's brief.");
    return { added: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Watched, but not added to the workspace's brief: ${error}`);
    return { added: false, error };
  }
}

/** The tools add the line themselves when given `about` (watch_contracts, watch_wallet, create_watch_rule): say what they answered. */
export function sayBrief(brief: BriefAdded | undefined | null): void {
  if (!brief) return;
  console.log(brief.added ? "Added to the workspace's brief." : `Watched, but not added to the workspace's brief: ${brief.error ?? 'refused'}`);
}
