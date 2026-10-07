import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type ProjectType = 'foundry' | 'hardhat';

// Where a resolved path came from. Used to tailor error messages: when an
// auto-detected path doesn't exist, we want to point the user at the
// --contracts/--artifacts flags rather than re-explain that paths in
// hardhat.config can be computed and we couldn't read them.
export type PathSource = 'override' | 'config' | 'default';

export interface ProjectInfo {
  type: ProjectType;
  // Absolute path to project root (where foundry.toml or hardhat.config.* live).
  root: string;
  // Absolute path to where user-authored contracts live (e.g. src/ or contracts/).
  sourceDir: string;
  sourceDirSource: PathSource;
  // Absolute path to where compiled artifacts live (e.g. out/ or artifacts/contracts/).
  artifactsDir: string;
  artifactsDirSource: PathSource;
}

const HH_CONFIG_NAMES = [
  'hardhat.config.ts',
  'hardhat.config.js',
  'hardhat.config.cjs',
  'hardhat.config.mjs',
];

export function detectProject(
  projectRoot: string,
  sourceOverride?: string,
  artifactsOverride?: string,
): ProjectInfo {
  const root = resolve(projectRoot);

  if (existsSync(join(root, 'foundry.toml'))) {
    const { src, out } = parseFoundryToml(join(root, 'foundry.toml'));
    return {
      type: 'foundry',
      root,
      sourceDir: resolve(root, sourceOverride ?? src ?? 'src'),
      sourceDirSource: sourceOverride ? 'override' : src ? 'config' : 'default',
      artifactsDir: resolve(root, artifactsOverride ?? out ?? 'out'),
      artifactsDirSource: artifactsOverride ? 'override' : out ? 'config' : 'default',
    };
  }

  const hhConfigPath = HH_CONFIG_NAMES.map((n) => join(root, n)).find((p) => existsSync(p));
  if (hhConfigPath) {
    const { sources, artifacts } = parseHardhatConfig(hhConfigPath);
    const sourcesRel = sourceOverride ?? sources ?? 'contracts';
    // Hardhat lays artifacts out as <paths.artifacts>/<sources-relative-to-root>/.
    // For defaults (sources=contracts, artifacts=artifacts) → artifacts/contracts/.
    // When sources is overridden (e.g. "src") → artifacts/src/.
    // The manual `artifacts:` override takes the literal path as-is.
    const artifactsBase = artifacts ?? 'artifacts';
    return {
      type: 'hardhat',
      root,
      sourceDir: resolve(root, sourcesRel),
      sourceDirSource: sourceOverride ? 'override' : sources ? 'config' : 'default',
      artifactsDir: artifactsOverride
        ? resolve(root, artifactsOverride)
        : resolve(root, artifactsBase, sourcesRel),
      artifactsDirSource: artifactsOverride
        ? 'override'
        : artifacts
        ? 'config'
        : 'default',
    };
  }

  throw new Error(
    `No Foundry (foundry.toml) or Hardhat (hardhat.config.{ts,js,cjs,mjs}) project detected in ${root}`,
  );
}

// Minimal foundry.toml parser — we only need src and out. Full TOML is
// unnecessary and adds a dep; this handles the keys we care about.
//
// Honors FOUNDRY_PROFILE the same way `forge` does: keys from the named
// profile override [profile.default], everything else inherits. So
// FOUNDRY_PROFILE=production forge build && contract-dev push-contracts
// reads from [profile.production] first and falls back to [profile.default]
// for anything that profile doesn't set.
function parseFoundryToml(path: string): { src?: string; out?: string } {
  const raw = readFileSync(path, 'utf8');
  const profile = process.env.FOUNDRY_PROFILE?.trim() || 'default';

  const defaults = readFoundryProfile(raw, 'default');
  if (profile === 'default') return defaults;

  const overlay = readFoundryProfile(raw, profile);
  // Spread defaults first so any key set in the named profile wins.
  return { ...defaults, ...overlay };
}

function readFoundryProfile(
  raw: string,
  profileName: string,
): { src?: string; out?: string } {
  // [profile.default] is the canonical form; bare [default] is the legacy alias
  // and is only valid for the default profile.
  const aliases =
    profileName === 'default'
      ? new Set(['profile.default', 'default'])
      : new Set([`profile.${profileName}`]);

  let inProfile = false;
  let src: string | undefined;
  let out: string | undefined;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[(.+?)\]$/);
    if (sectionMatch) {
      inProfile = aliases.has(sectionMatch[1].trim());
      continue;
    }

    if (!inProfile) continue;

    const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim().replace(/^["']|["']$/g, '');

    if (key === 'src') src = value;
    if (key === 'out') out = value;
  }

  // Only include keys that were actually set in this profile. Returning
  // explicit `{ src: undefined }` would clobber the default profile's `src`
  // when this object is spread on top of it.
  const result: { src?: string; out?: string } = {};
  if (src !== undefined) result.src = src;
  if (out !== undefined) result.out = out;
  return result;
}

// Best-effort parse of hardhat.config.{ts,js,cjs,mjs} for `paths.sources` and
// `paths.artifacts`. Avoids actually requiring the config (which would pull in
// hardhat + ts-node + plugins). Strips line/block comments first so commented-out
// settings don't trigger false matches. For configs that compute paths dynamically
// the user passes --contracts / --artifacts to push-contracts.
function parseHardhatConfig(configPath: string): { sources?: string; artifacts?: string } {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }

  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const sourcesMatch = stripped.match(/\bsources\s*:\s*['"]([^'"]+)['"]/);
  const artifactsMatch = stripped.match(/\bartifacts\s*:\s*['"]([^'"]+)['"]/);
  return {
    sources: sourcesMatch?.[1],
    artifacts: artifactsMatch?.[1],
  };
}
