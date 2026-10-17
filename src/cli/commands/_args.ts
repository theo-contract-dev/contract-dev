// Tiny shared arg-parsing helpers used by every subcommand-style CLI module
// (function-override, balance, state, impersonate, …).

export interface ParsedFlags {
  _: string[];
  [key: string]: string | string[] | undefined;
}

// Tiny flag parser. Supports --key=value and --key value. Booleans (--flag with
// no value) come back as 'true'. Anything not preceded by --flag is positional.
// A flag given twice keeps both values, in order (`--row a --row b`); `flag` reads
// the last one, `flagAll` every one.
export function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { _: [] };
  const set = (key: string, value: string) => {
    const prev = out[key];
    out[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          set(a.slice(2), next);
          i++;
        } else {
          set(a.slice(2), 'true');
        }
      }
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

export function flag(flags: ParsedFlags, name: string): string | undefined {
  const v = flags[name];
  if (Array.isArray(v)) return v[v.length - 1];
  return typeof v === 'string' ? v : undefined;
}

/** Every value of a repeated flag, in order; `[]` when it was not passed. */
export function flagAll(flags: ParsedFlags, name: string): string[] {
  const v = flags[name];
  if (Array.isArray(v)) return v;
  return typeof v === 'string' ? [v] : [];
}

/**
 * Refuse a flag the command does not take, naming the ones it does: a flag dropped silently
 * changes what the command means (an alert condition left out fires on everything).
 */
export function onlyFlags(flags: ParsedFlags, command: string, takes: readonly string[]): void {
  const unknown = Object.keys(flags).filter((k) => k !== '_' && !takes.includes(k));
  if (unknown.length) throw new Error(`Unknown flag --${unknown[0]} for ${command}. It takes ${takes.map((f) => `--${f}`).join(', ')}.`);
}

export function requirePositional(positional: string[], idx: number, label: string): string {
  const v = positional[idx];
  if (!v) throw new Error(`Missing required ${label}`);
  return v;
}

export function requireFlag(flags: ParsedFlags, name: string): string {
  const v = flag(flags, name);
  if (v === undefined || v.length === 0 || v === 'true') {
    throw new Error(`Missing required --${name}`);
  }
  return v;
}

export function parseJsonStringArray(raw: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be a JSON array (got: ${raw})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array (got: ${raw})`);
  }
  return parsed.map((v) => (typeof v === 'string' ? v : String(v)));
}

// Accept an amount as decimal ("1000"), 0x-hex ("0x3e8"), or with a `wei`/`ether`
// unit suffix ("1 ether"). Returns the value as a decimal string (BigInt fits).
// Negative values are rejected — every caller currently maps to a non-negative.
export function parseAmount(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`Missing required ${label}`);

  // Inline unit suffix: "1 ether", "1000000 wei"
  const unitMatch = trimmed.match(/^(\S+)\s+(wei|ether)$/i);
  if (unitMatch) {
    const num = parseAmount(unitMatch[1], label);
    if (unitMatch[2].toLowerCase() === 'ether') {
      return (BigInt(num) * BigInt(10) ** BigInt(18)).toString();
    }
    return num;
  }

  let value: bigint;
  try {
    value = BigInt(trimmed);
  } catch {
    throw new Error(`${label} must be a non-negative integer (decimal or 0x-hex). Got: ${raw}`);
  }
  if (value < BigInt(0)) {
    throw new Error(`${label} must be non-negative. Got: ${raw}`);
  }
  return value.toString();
}
