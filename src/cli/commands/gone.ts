// The question commands folded into `query` in 5.0.0: `events` and `history` are refused with the `query events` line
// that asks the same thing, built from what was typed (a contract, --group, --event, --window, the rest as they were).

/** A flag's value as it would be typed again: quoted when it holds a space or a shell character. */
const quoted = (v: string): string => (/^[A-Za-z0-9_.:@/+-]+$/.test(v) ? v : `"${v.replace(/(["\\$`])/g, '\\$1')}"`);

/** The windows the old commands took, as the --last or the start the new one takes. */
const WINDOW: Record<string, string[]> = { '1h': ['--last', '1h'], '24h': ['--last', '24h'], '7d': ['--last', '7d'], '30d': ['--last', '30d'], '90d': ['--last', '90d'], '365d': ['--last', '365d'], '1y': ['--since', 'launch'], all: ['--since', 'launch'] };

/** `contract-dev events …` or `contract-dev history …` as its `contract-dev query events …` line, with why. */
export function goneQuestion(cmd: string, args: string[]): string {
  const history = cmd === 'history';
  const out: string[] = ['contract-dev', 'query', 'events'];
  const rest: string[] = [];
  let windowSet = false;
  let on: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') && a.includes('=') ? a.indexOf('=') : -1;
    const name = a.startsWith('--') ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    const value = (): string => (eq > 0 ? a.slice(eq + 1) : (args[++i] ?? ''));
    if (name === null) {
      if (!on && !['help', '-h'].includes(a)) on = a;
      continue;
    }
    if (name === 'group') on = `tag:${value()}`;
    else if (name === 'contract') on = value();
    else if (name === 'event') rest.push('--each', quoted(value()));
    else if (name === 'window' || name === 'range') {
      const w = WINDOW[value().trim().toLowerCase()];
      if (w) {
        rest.push(...w);
        windowSet = true;
      }
    } else if (name === 'since') {
      rest.push('--since', quoted(value()));
      windowSet = true;
    } else {
      // a flag with a value keeps it; a switch (--asc, --count, --once) stands alone
      const next = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      const takes = eq > 0 || (next !== undefined && !next.startsWith('--'));
      rest.push(`--${name}`, ...(takes ? [quoted(value())] : []));
    }
  }
  if (on) out.push('--on', quoted(on));
  // a history read the whole life by default
  if (history && !windowSet) rest.push('--since', 'launch');
  const line = [...out, ...rest].join(' ');
  return `contract-dev ${cmd} is gone (5.0.0): every question is contract-dev query. Say: ${line}  (contract-dev query help).`;
}

/**
 * Flags gone in 5.0.0, refused where a person types them with the word that replaced them:
 * `--group is gone: say --on tag:<group> (contract-dev metric help).` `gone` maps a flag to what to say instead.
 */
export function refuseGoneFlags(args: string[], gone: Record<string, string>, help: string): void {
  for (const a of args) {
    if (!a.startsWith('--')) continue;
    const name = a.slice(2).split('=')[0];
    if (Object.prototype.hasOwnProperty.call(gone, name)) throw new Error(`--${name} is gone: say ${gone[name]} (contract-dev ${help} help).`);
  }
}

/** The scope and window words every metric command left behind (5.0.0). */
export const METRIC_GONE: Record<string, string> = {
  group: '--on tag:<group>',
  contract: '--on <contract>',
  event: '--each <Event>',
  table: '--on table:"<table>"',
  history: '--last <n>d',
  days: '--last <n>d',
  range: '--last <n>d, or --since launch for all of it',
};
