import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The installed package's version; `skills` stamps it on the skill it installs, so an upgrade can tell a stale copy. */
export function cliVersion(): string {
  try {
    // dist/cli/version.js and src/cli/version.ts both sit two levels under the package root.
    return String(JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version);
  } catch {
    return 'unknown';
  }
}
