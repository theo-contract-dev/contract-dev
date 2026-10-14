import { readFileSync } from 'node:fs';
import { parseFlags, flag, requirePositional } from './_args';
import { requireAuth } from '../credentials';
import { callTool, listTools, type ToolCatalogueEntry, type ToolEnvelope } from '../tools';
import { table } from '../view';

const HELP = `contract-dev tool — the platform's tools, the ones an agent calls, by name

Usage:
  contract-dev tool list                                   Every tool: name, scope, what it answers
  contract-dev tool show <name>                            A tool's description and its input schema
  contract-dev tool run <name> [--input '<json>' | --input @file.json]
                                                           Run one and print its result as JSON; no --input sends {}

\`tool run\` is for scripts and agents: the result is always JSON, and a refusal exits 1 with the
server's own sentence (--json wraps it as {"error": …}). The human-shaped commands — find,
describe, compare, activity query, monitor compile — read through the same tools and print tables.

Examples:
  contract-dev tool run find --input '{"query":"pools"}'
  contract-dev tool run compare_activity --input '{"scope":{"kind":"group","group":"pools"},"by":"events","event":"Swap"}'
  contract-dev tool run compile_monitor --input @monitor.json
`;

export async function toolCommand(args: string[] = []): Promise<unknown> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list':
      return await listSubcommand();
    case 'show':
      return await showSubcommand(rest);
    case 'run':
      return await runSubcommand(rest);
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    default:
      console.error(`Unknown tool subcommand: ${sub}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function listSubcommand(): Promise<{ tools: ToolCatalogueEntry[] }> {
  const tools = await listTools(requireAuth());
  if (!tools.length) {
    console.log('No tools.');
    return { tools };
  }
  for (const line of table(tools, [
    { header: 'Name', value: (t) => t.name },
    { header: 'Scope', value: (t) => t.scope },
    { header: 'Title', value: (t) => t.title },
  ])) {
    console.log(line);
  }
  return { tools };
}

// A tool by its name; `describe-contract` finds describe_contract, so a name typed the CLI way works.
function findTool(tools: ToolCatalogueEntry[], ref: string): ToolCatalogueEntry {
  const lower = ref.trim().toLowerCase().replace(/-/g, '_');
  const hit = tools.find((t) => t.name === ref) ?? tools.find((t) => t.name.toLowerCase() === lower);
  if (!hit) throw new Error(`No tool called "${ref}". Tools: ${tools.map((t) => t.name).join(', ')}.`);
  return hit;
}

async function showSubcommand(args: string[]): Promise<ToolCatalogueEntry> {
  const flags = parseFlags(args);
  const ref = requirePositional(flags._ as string[], 0, 'tool name (see `contract-dev tool list`)');
  const tool = findTool(await listTools(requireAuth()), ref);
  console.log(`${tool.name} — ${tool.title}  (${tool.scope})`);
  console.log(tool.description);
  console.log('');
  console.log('Input:');
  console.log(JSON.stringify(tool.input, null, 2));
  return tool;
}

/** `--input '<json>'` or `--input @file.json` → the tool's input object; nothing → {}. */
export function readInput(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  if (raw === 'true') throw new Error('--input needs JSON: --input \'{"query":"pools"}\' or --input @file.json');
  let text = raw;
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`--input must be JSON (got: ${text.length > 80 ? `${text.slice(0, 77)}…` : text})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--input must be a JSON object, like {"query":"pools"}');
  return parsed as Record<string, unknown>;
}

async function runSubcommand(args: string[]): Promise<ToolEnvelope> {
  const flags = parseFlags(args);
  const name = requirePositional(flags._ as string[], 0, 'tool name (see `contract-dev tool list`)');
  const input = readInput(flag(flags, 'input'));
  const envelope = await callTool(requireAuth(), name.trim().replace(/-/g, '_'), input);
  console.log(JSON.stringify(envelope.result, null, 2));
  return envelope;
}
