import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { relPath } from './format';
import type { ProjectInfo } from './project';

export interface LocalContract {
  name: string;
  abi: string;
  bytecode: string;
  creationBytecode?: string;
  deployedBytecode?: string;
  sourcePath?: string;
  // Full Solidity source of the contract's own .sol file (not its imports),
  // read from disk at sourcePath. Left undefined if the file is missing or too large.
  source?: string;
  storageLayout?: unknown;
  bytecodeLinkReferences?: unknown;
  deployedBytecodeLinkReferences?: unknown;
}

// Cap inlined source at 1MB — matches the compiler package's MAX_INLINED_SOURCE_BYTES.
// Anything larger is almost certainly not a hand-authored contract; skip rather than
// bloat the push payload.
const MAX_SOURCE_BYTES = 1024 * 1024;

export interface ArtifactsResult {
  contracts: LocalContract[];
  // Names of artifacts we skipped (interfaces, libraries with empty bytecode, etc.).
  skipped: Array<{ name: string; reason: string }>;
}

export function loadArtifacts(project: ProjectInfo): ArtifactsResult {
  if (!existsSync(project.artifactsDir)) {
    throw new Error(buildMissingArtifactsError(project));
  }

  const contracts: LocalContract[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  const jsonFiles = walkJsonFiles(project.artifactsDir);

  // Hardhat keeps storage layout in build-info rather than per-contract artifacts,
  // so build a (sourceName:contractName -> layout) index once up front. Foundry
  // inlines it into each artifact, so there's nothing to pre-load.
  const hhStorageLayouts = project.type === 'hardhat' ? loadHardhatStorageLayouts(project) : null;

  for (const file of jsonFiles) {
    const parsed = parseArtifact(file, project, hhStorageLayouts);
    if (!parsed) continue;

    // Drop artifacts whose source isn't inside the user's source dir
    // (e.g. node_modules dependencies, OZ base contracts).
    // sourcePath is always relative to the project root for both HH and Foundry.
    if (parsed.sourcePath) {
      const absSource = resolve(project.root, parsed.sourcePath);
      const fromSourceDir = relative(project.sourceDir, absSource);
      if (fromSourceDir.startsWith('..')) {
        continue;
      }
    }

    // Skip interfaces / abstract contracts — they have no runtime bytecode to version.
    if (!parsed.bytecode || parsed.bytecode === '0x' || parsed.bytecode.length <= 2) {
      skipped.push({ name: parsed.name, reason: 'no bytecode (interface/abstract)' });
      continue;
    }

    contracts.push(parsed);
  }

  return { contracts, skipped };
}

function walkJsonFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkJsonFiles(full));
    } else if (entry.endsWith('.json') && !entry.endsWith('.dbg.json')) {
      out.push(full);
    }
  }
  return out;
}

function parseArtifact(
  file: string,
  project: ProjectInfo,
  hhStorageLayouts: Map<string, unknown> | null,
): LocalContract | null {
  let json: any;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }

  if (project.type === 'foundry') {
    // Foundry: { abi, bytecode: { object }, deployedBytecode: { object }, metadata: { settings: { compilationTarget } }, ... }
    // Skip Foundry build-info / cache files that don't look like contract artifacts.
    if (!json.abi || !json.bytecode) return null;

    const name = guessFoundryName(file, json);
    const creationBytecode = typeof json.bytecode?.object === 'string' ? json.bytecode.object : '';
    const deployedBytecode =
      typeof json.deployedBytecode?.object === 'string' ? json.deployedBytecode.object : '';

    const sourcePath = json.metadata?.settings?.compilationTarget
      ? Object.keys(json.metadata.settings.compilationTarget)[0]
      : undefined;

    return {
      name,
      abi: JSON.stringify(json.abi),
      bytecode: deployedBytecode || creationBytecode,
      creationBytecode: creationBytecode || undefined,
      deployedBytecode: deployedBytecode || undefined,
      sourcePath,
      source: tryReadSource(project, sourcePath),
      // Present only when the user enabled `extra_output = ["storageLayout"]` in
      // foundry.toml; left undefined otherwise.
      storageLayout: json.storageLayout,
      bytecodeLinkReferences: json.bytecode?.linkReferences,
      deployedBytecodeLinkReferences: json.deployedBytecode?.linkReferences,
    };
  }

  // Hardhat v2: _format = "hh-sol-artifact-1"
  // Hardhat v3: _format = "hh3-artifact-1" (same field layout, plus immutableReferences/inputSourceName/buildInfoId)
  if (json._format !== 'hh-sol-artifact-1' && json._format !== 'hh3-artifact-1') return null;
  if (!json.abi || !json.contractName) return null;

  const creationBytecode = typeof json.bytecode === 'string' ? json.bytecode : '';
  const deployedBytecode = typeof json.deployedBytecode === 'string' ? json.deployedBytecode : '';

  const sourceName: string | undefined = json.sourceName;
  // Hardhat v3 keys the solc output (and thus storage layout) by the *input* source
  // name — e.g. "project/contracts/Foo.sol" — which differs from the artifact's
  // user-facing `sourceName` ("contracts/Foo.sol"). v2 has no `inputSourceName` and
  // the two coincide, so falling back to `sourceName` keeps v2 working. Note: source
  // is still read from disk via `sourceName` (the real path); only the layout lookup
  // uses the input name to match the build-info index.
  const layoutKey: string | undefined = json.inputSourceName ?? sourceName;

  return {
    name: json.contractName,
    abi: JSON.stringify(json.abi),
    bytecode: deployedBytecode || creationBytecode,
    creationBytecode: creationBytecode || undefined,
    deployedBytecode: deployedBytecode || undefined,
    sourcePath: sourceName,
    source: tryReadSource(project, sourceName),
    // Pulled from build-info; present only when the user kept `storageLayout` in
    // their solc `outputSelection`. Undefined (left blank) otherwise.
    storageLayout: layoutKey
      ? hhStorageLayouts?.get(`${layoutKey}:${json.contractName}`)
      : undefined,
    bytecodeLinkReferences: json.linkReferences,
    deployedBytecodeLinkReferences: json.deployedLinkReferences,
  };
}

// Read a contract's own source file from disk. sourcePath is relative to the
// project root for both Hardhat (sourceName) and Foundry (compilationTarget key).
function tryReadSource(project: ProjectInfo, sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;
  const abs = resolve(project.root, sourcePath);
  try {
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return undefined;
    return readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

// Build a (sourceName:contractName -> storageLayout) index from Hardhat build-info.
// Hardhat records the full solc output (including storageLayout, when requested via
// outputSelection) in <artifactsBase>/build-info/*.json. The output shape is identical
// for HH v2 (hh-sol-build-info-1) and v3 (hh3-sol-build-info-1):
// output.contracts[sourceName][contractName].storageLayout. We never inject the
// outputSelection ourselves — if the user didn't ask solc for it, the index is empty
// and storageLayout is left blank.
function loadHardhatStorageLayouts(project: ProjectInfo): Map<string, unknown> {
  const index = new Map<string, unknown>();
  const buildInfoDir = findBuildInfoDir(project.artifactsDir, project.root);
  if (!buildInfoDir) return index;

  for (const entry of readdirSync(buildInfoDir)) {
    if (!entry.endsWith('.json')) continue;
    let buildInfo: any;
    try {
      buildInfo = JSON.parse(readFileSync(join(buildInfoDir, entry), 'utf8'));
    } catch {
      continue;
    }
    const outputContracts = buildInfo?.output?.contracts;
    if (!outputContracts || typeof outputContracts !== 'object') continue;
    for (const [sourceName, contracts] of Object.entries<any>(outputContracts)) {
      if (!contracts || typeof contracts !== 'object') continue;
      for (const [contractName, data] of Object.entries<any>(contracts)) {
        const layout = (data as any)?.storageLayout;
        if (layout && typeof layout === 'object') {
          index.set(`${sourceName}:${contractName}`, layout);
        }
      }
    }
  }
  return index;
}

// build-info lives directly under the artifacts base (e.g. artifacts/build-info),
// which is a parent of artifactsDir (artifacts/<sources-subpath>, or a custom path
// when `artifacts:` is overridden). Walk up from artifactsDir to the project root
// looking for a build-info directory.
function findBuildInfoDir(artifactsDir: string, root: string): string | null {
  let dir = artifactsDir;
  while (true) {
    const candidate = join(dir, 'build-info');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (dir === root) break;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Multi-line, source-aware error for the "artifacts dir doesn't exist" case.
// We tailor the advice based on whether the resolved paths came from
// --contracts/--artifacts flags, from a successful regex match on the project's
// config, or from a hard-coded default — each one calls for different remediation.
//
// For Hardhat in particular, `artifactsDir` is composed from BOTH `paths.sources`
// (subpath) and `paths.artifacts` (base), so a default fallback on either one
// can produce a wrong final path. We trigger the "dynamic paths" advice when
// either is on the default.
function buildMissingArtifactsError(project: ProjectInfo): string {
  const buildCmd = project.type === 'foundry' ? 'forge build' : 'npx hardhat compile';
  const lines: string[] = [`No artifacts found at ${relPath(project.artifactsDir)}.`];

  const anyOverride =
    project.sourceDirSource === 'override' || project.artifactsDirSource === 'override';
  const anyDefault =
    project.sourceDirSource === 'default' || project.artifactsDirSource === 'default';

  if (anyOverride) {
    // User explicitly passed --contracts and/or --artifacts. Either they pointed
    // at the wrong dir, or they haven't built yet.
    lines.push(
      `This path comes from the --${project.artifactsDirSource === 'override' ? 'artifacts' : 'contracts'} flag you passed.`,
      `Either fix it to point at where ${project.type === 'foundry' ? 'forge' : 'hardhat'} writes artifacts,`,
      `or run \`${buildCmd}\` first.`,
    );
  } else if (project.type === 'hardhat' && anyDefault) {
    // Hardhat config parser is regex-only — any computed/env-driven path in
    // hardhat.config shows up as "default" here even though the user set one.
    // Surface that ambiguity directly so the user doesn't have to guess why
    // the wrong dir was used.
    const which: string[] = [];
    if (project.sourceDirSource === 'default') which.push('`paths.sources`');
    if (project.artifactsDirSource === 'default') which.push('`paths.artifacts`');
    lines.push(
      `The CLI couldn't statically read ${which.join(' and ')} from your hardhat.config`,
      `(the parser only matches quoted string literals — computed values, env vars, and imports are invisible),`,
      `so it fell back to the Hardhat default${which.length > 1 ? 's' : ''}.`,
      ``,
      `If your hardhat.config sets ${which.join(' or ')} dynamically, pass the real paths explicitly:`,
      ``,
      `    contract-dev push-contracts --contracts src/protocol --artifacts build/artifacts/src/protocol`,
      ``,
      `Otherwise, run \`${buildCmd}\` first.`,
      `See https://docs.contract.dev/cli/push-contracts#source-and-artifact-directories`,
    );
  } else {
    // Foundry default, or every path came from the config and just needs a build.
    lines.push(`Run \`${buildCmd}\` first.`);
  }

  return lines.join('\n');
}

function guessFoundryName(file: string, json: any): string {
  // Foundry stores artifacts as out/<File.sol>/<ContractName>.json
  // Prefer the contract name from the path (filename without .json), but
  // fall back to compilationTarget value if needed.
  const base = file.split('/').pop()!.replace(/\.json$/, '');
  if (base && !base.includes('.')) return base;
  const target = json.metadata?.settings?.compilationTarget;
  if (target) {
    const first = Object.values(target)[0];
    if (typeof first === 'string') return first;
  }
  return base;
}
