import { resolveStagenetRpcUrl } from '../target';
import { callRpc } from '../rpc';

// Mirrors the function-override schema returned by the Stagenet backend.
interface FunctionOverride {
  id: string;
  contractAddress: string;
  functionAbi: string;
  inputParams: string[] | null;
  returnValues: string[];
  enabled: boolean;
  createdAt: string;
}

const HELP = `contract-dev function-override — override the return value of a contract function

Usage:
  contract-dev function-override add <address> --abi <abi> --returns <json> [--input-params <json>]
  contract-dev function-override list [--contract <address>]
  contract-dev function-override update <id> --returns <json>
  contract-dev function-override enable <id>
  contract-dev function-override disable <id>
  contract-dev function-override remove <id>

Options:
  --abi <abi>             JSON ABI fragment or human-readable signature
                          e.g. 'function getCount() view returns (uint256)'
  --returns <json>        JSON array of return values matching the fragment's outputs
                          e.g. '["42"]' or '["0xabc...", "1000"]'
  --input-params <json>   JSON array of input params to scope the override to a specific
                          call. Omit for a wildcard match across every call to the selector.
  --contract <address>    On 'list', filter to overrides for a single contract.

Notes:
  Exact-input overrides take precedence over wildcard overrides on the same selector.
  See https://docs.contract.dev/cli/function-override
`;

export async function functionOverrideCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  switch (sub) {
    case 'add':
      await addSubcommand(rest);
      return;
    case 'list':
    case 'ls':
      await listSubcommand(rest);
      return;
    case 'update':
      await updateSubcommand(rest);
      return;
    case 'enable':
      await toggleSubcommand(rest, 'enable');
      return;
    case 'disable':
      await toggleSubcommand(rest, 'disable');
      return;
    case 'remove':
    case 'rm':
      await removeSubcommand(rest);
      return;
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown function-override subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

// --- ADD ---

async function addSubcommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const address = requirePositional(flags._, 0, 'contract address');
  const abi = requireFlag(flags, 'abi');
  const returnValues = parseJsonStringArray(requireFlag(flags, 'returns'), '--returns');
  const inputParamsRaw = flag(flags, 'input-params');
  const inputParams = inputParamsRaw ? parseJsonStringArray(inputParamsRaw, '--input-params') : undefined;

  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<FunctionOverride>(rpcUrl, 'dev_addFunctionOverride', [
    {
      contractAddress: address,
      functionAbi: abi,
      returnValues,
      ...(inputParams ? { inputParams } : {}),
    },
  ]);

  console.log(`Created function override ${result.id}`);
  console.log(`  contract: ${result.contractAddress}`);
  console.log(`  enabled:  ${result.enabled}`);
  console.log(`  returns:  ${JSON.stringify(result.returnValues)}`);
  if (result.inputParams && result.inputParams.length) {
    console.log(`  inputs:   ${JSON.stringify(result.inputParams)}`);
  }
}

// --- LIST ---

async function listSubcommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const contract = flag(flags, 'contract');

  const rpcUrl = await resolveStagenetRpcUrl();
  const items = contract
    ? await callRpc<FunctionOverride[]>(rpcUrl, 'dev_getFunctionOverridesByContract', [contract])
    : await callRpc<FunctionOverride[]>(rpcUrl, 'dev_getFunctionOverrides', []);

  if (items.length === 0) {
    console.log('No function overrides.');
    return;
  }

  for (const it of items) {
    const state = it.enabled ? 'enabled ' : 'disabled';
    const inputs = it.inputParams && it.inputParams.length ? ` inputs=${JSON.stringify(it.inputParams)}` : '';
    console.log(`${it.id}  ${it.contractAddress}  ${state}  returns=${JSON.stringify(it.returnValues)}${inputs}`);
  }
}

// --- UPDATE ---

async function updateSubcommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const id = requirePositional(flags._, 0, 'override id');
  const returnValues = parseJsonStringArray(requireFlag(flags, 'returns'), '--returns');

  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<FunctionOverride>(rpcUrl, 'dev_updateFunctionOverride', [id, returnValues]);

  console.log(`Updated override ${result.id}`);
  console.log(`  returns: ${JSON.stringify(result.returnValues)}`);
}

// --- ENABLE / DISABLE ---

async function toggleSubcommand(args: string[], action: 'enable' | 'disable'): Promise<void> {
  const flags = parseFlags(args);
  const id = requirePositional(flags._, 0, 'override id');

  const method = action === 'enable' ? 'dev_enableFunctionOverride' : 'dev_disableFunctionOverride';
  const rpcUrl = await resolveStagenetRpcUrl();
  const result = await callRpc<FunctionOverride>(rpcUrl, method, [id]);

  console.log(`${action === 'enable' ? 'Enabled' : 'Disabled'} override ${result.id} (enabled=${result.enabled})`);
}

// --- REMOVE ---

async function removeSubcommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const id = requirePositional(flags._, 0, 'override id');

  const rpcUrl = await resolveStagenetRpcUrl();
  await callRpc<{ id: string; removed: boolean }>(rpcUrl, 'dev_removeFunctionOverride', [id]);
  console.log(`Removed override ${id}`);
}

// --- helpers ---

interface ParsedFlags {
  _: string[];
  [key: string]: string | string[] | undefined;
}

function flag(flags: ParsedFlags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

// Tiny flag parser. Supports --key=value and --key value. Booleans (--flag with
// no value) come back as 'true'. Anything not preceded by --flag is positional.
function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = 'true';
        }
      }
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

function requirePositional(positional: string[], idx: number, label: string): string {
  const v = positional[idx];
  if (!v) throw new Error(`Missing required ${label}`);
  return v;
}

function requireFlag(flags: ParsedFlags, name: string): string {
  const v = flags[name];
  if (typeof v !== 'string' || v.length === 0 || v === 'true') {
    throw new Error(`Missing required --${name}`);
  }
  return v;
}

function parseJsonStringArray(raw: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} must be a JSON array (got: ${raw})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array (got: ${raw})`);
  }
  return parsed.map((v) => (typeof v === 'string' ? v : String(v)));
}
