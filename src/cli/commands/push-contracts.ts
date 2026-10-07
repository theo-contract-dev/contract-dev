import { resolveStagenetRpcUrl } from '../target';
import { detectProject } from '../project';
import { loadArtifacts } from '../artifacts';
import { relPath } from '../format';
import { callRpc } from '../rpc';
import { parseFlags, flag } from './_args';

interface PushContractsResult {
  contracts: Array<{
    name: string;
    projectContractId: string;
    projectContractVersionId: string;
    status: 'created' | 'new_version' | 'unchanged';
  }>;
  // Contracts already deployed on the stagenet whose on-chain bytecode matched a
  // pushed artifact and were linked to it (absent on older engine builds).
  linkedDeployments?: Array<{ name: string; address: string; backfilledCalls: number }>;
}

const HELP = `contract-dev push-contracts — push this directory's compiled contracts to your stagenet

Usage:
  contract-dev push-contracts [--contracts <dir>] [--artifacts <dir>]

Run it from your Foundry/Hardhat project root after \`forge build\` /
\`npx hardhat compile\`. Paths are auto-detected from foundry.toml /
hardhat.config; the flags override them for configs that compute paths
dynamically.

Contracts already deployed on the stagenet are matched by bytecode and
linked to the pushed artifacts, so their ABIs and decoded calls show up
on the dashboard without a manual "Manage contract" step.
`;

export async function pushContractsCommand(args: string[] = []): Promise<PushContractsResult | void> {
  if (args[0] === 'help' || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }
  const flags = parseFlags(args);

  // Rooted at the directory the command runs in — no config file involved.
  const projectRoot = process.cwd();

  const project = detectProject(projectRoot, flag(flags, 'contracts'), flag(flags, 'artifacts'));
  const typeLabel = project.type === 'foundry' ? 'Foundry' : 'Hardhat';
  console.log(`Detected ${typeLabel} project`);

  const { contracts } = loadArtifacts(project);
  if (contracts.length === 0) {
    console.error(
      `No deployable contracts found in ${relPath(project.artifactsDir)}. ` +
        `Every artifact was either an interface/abstract contract or sourced from outside ${relPath(project.sourceDir)}.`,
    );
    process.exit(1);
  }

  const rpcUrl = await resolveStagenetRpcUrl();

  const result = await callRpc<PushContractsResult>(rpcUrl, 'dev_importContracts', [{ contracts }]);

  console.log(`${result.contracts.length} contract${result.contracts.length === 1 ? '' : 's'} pushed:`);
  for (const r of result.contracts) {
    console.log(`- ${r.name}`);
  }

  const linked = result.linkedDeployments ?? [];
  if (linked.length > 0) {
    console.log('');
    console.log(`ABI added to ${linked.length} contract${linked.length === 1 ? '' : 's'} on your Stagenet:`);
    for (const l of linked) {
      console.log(`- ${l.name} @ ${l.address}`);
    }
  }

  return result;
}
