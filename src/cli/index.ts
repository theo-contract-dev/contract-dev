#!/usr/bin/env node
import { cliVersion } from './version';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login';
import { workspaceCommand } from './commands/workspace';
import { watchCommand, unwatchCommand, renameCommand, contractsCommand } from './commands/watch';
import { metricsCommand, trackCommand, untrackCommand } from './commands/metrics';
import { monitorCommand, monitorsCommand, channelsCommand } from './commands/monitor';
import { incidentsCommand } from './commands/incidents';
import { reportCommand } from './commands/report';
import { statusCommand } from './commands/status';
import { eventsCommand } from './commands/events';
import { holdersCommand } from './commands/holders';
import { txCommand, addressCommand, blockCommand, walletCommand, sourceCommand } from './commands/explorer';
import { findCommand, describeCommand } from './commands/ask';
import { whoCommand, readCommand } from './commands/questions';
import { queryCommand } from './commands/query';
import { groupCommand, factoryCommand } from './commands/group';
import { walletsCommand } from './commands/wallets';
import { tableCommand } from './commands/table';
import { historyCommand } from './commands/history';
import { toolCommand } from './commands/tool';
import { refreshGuideIfStale, refreshInstalledSkills, skillsCommand } from './commands/skills';
import { extractTargetFlags } from './target';

const HELP = `contract.dev — your contracts, from the command line

Account:
  contract-dev login                      Connect the CLI to your contract.dev account (try: login help)
  contract-dev whoami                     Show which account + workspace the CLI acts as
  contract-dev workspace [<sub>]          The workspace the CLI acts on: its brief on the protocol and what it holds;
                                          brief writes the brief, use switches workspace (try: workspace help)
  contract-dev logout                     Revoke the key and delete the saved credentials
  contract-dev status                     The workspace at a glance: contracts, transactions, alerts

Watch contracts:
  contract-dev watch <address>            Watch a mainnet contract (try: watch help)
  contract-dev watch <address> <address>… [--group <name>]   Watch several at once, tagged into a group
  contract-dev watch list                 List watched contracts
  contract-dev watch wallet <address> [--chain <id>] [--group <name>]   Watch a wallet (an address with no code); wallets list · rename · remove (try: wallets help)
  contract-dev rename <address> <name>    Rename a watched contract or wallet
  contract-dev contracts set-abi <address> --abi <file>   Name an unverified contract's methods and events
  contract-dev unwatch <address> [<address>…]   Stop watching one or several contracts
  contract-dev factory <address>          The contracts a factory deployed; --watch --group <name> watches the new ones (try: factory help)

Groups:
  contract-dev group show <group>         A group's rules, table columns, monitors and members (try: group help)
  contract-dev group add <group> <address|name>…   Put watched contracts in a group; group remove takes them out, still watched
  contract-dev group rule add <group> --factory <addr> | --registry <addr> --function "…"
                                          Keep the group filled: every contract the factory deploys or the registry lists
  contract-dev group name-pattern <group> "<pattern>"   Name every member from its own reads: "{token0().symbol()} pool"
  contract-dev group column add <group> --label "…" --read "totalAssets()"   A column on its table, read on every member
  contract-dev group monitor add <group> --name "…" --column <key> --when "value < <n>"   One monitor on every member

Tables (rows kept current, and the things inside contracts: withdrawal rounds, loans, requests):
  contract-dev table list                 Every table: the live tables, then the item tables, hidden ones too (try: table help)
  contract-dev table create "<name>" --from events --group <g> --event <Event> [--field "vol=usd(…)"] [--by … --measure …]
                                          A live table straight from events, one step: the events kept underneath, the
                                          question asked of them and asked again while the table is open
  contract-dev table create "<name>" --from "<table>"|transactions|transfers|wallets|contracts [the query's flags]
                                          A live table over rows the workspace already keeps: another table's rows (its
                                          own --where carried in), a metric's records, the ledger
  contract-dev table show <table>         A live table's rows now; an item table's openings and closings, how long rows stay open
  contract-dev table create "<name>" --opens <Event> [--closes <Event>] [--group <g>] [--count <Event>] [--hidden]
                                          An item table from the contracts' events, its whole history read

Metrics:
  contract-dev metrics                    List tracked metrics (try: metrics help)
  contract-dev metric define "<name>" …   A metric added up from events, each read at its own transaction (try: metrics help)
  contract-dev metric group "<name>" --group <g> --column <key>   A group's column rolled up into one metric across its contracts
  contract-dev metrics export <id|label>  A metric's history as CSV or JSON
  contract-dev metric pin <name>          Show a metric in the overview's header, after Contracts and Activity (five at most; unpin takes it off)
  contract-dev track <address> <kind>     Track a balance, supply, call result or method telemetry (try: track help)
  contract-dev untrack <id|label>         Stop tracking

Data (<contract> is an address or a watched contract's name):
  contract-dev events [<contract>]        Events emitted, event by event, and the ones declared but never fired
  contract-dev events <contract> --event <Name> --sort "<expr>"   The events themselves through formulas: sort, filter, group (try: events help)
  contract-dev history [<contract>] --event <Name>   Every firing since launch: by week, sizes, top wallets, when (try: history help)
  contract-dev contracts show <contract>  One contract at a glance (its Overview tab)
  contract-dev holders <contract>         A token's holders (try: holders help)

Ask (questions over the workspace; scope is --group <name>, --contract <ref> or --chain <id>, else everything):
  contract-dev find <query>               What a name points at: contracts (by name, address or kind: pools, vaults,
                                          tokens), groups, metrics, monitors, reports, destinations
  contract-dev describe <contract>        What a contract is: kinds, standards, owner, its events and write
                                          functions
  contract-dev query <contracts|table|metric|transactions|transfers|wallets|monitors|alerts|reports> …
                                          One dataset, asked in the table language: --where, --show, --sort, --by with
                                          --sum, --count or several --measure, --having, --breakdown, --total (try: query help)
  contract-dev who <address|ENS|name>     Who it is
  contract-dev read <contract> <function> [<arg>…]   Call a view function, now or --at a past time (try: read help)

Explorer (any address on a supported chain):
  contract-dev tx <hash>                  A transaction: outcome, decoded call, fees, transfers, logs
  contract-dev address <0x…>              Balance, identity and recent transactions; a Chainlink feed's reading
  contract-dev block <number>             A block and its transactions
  contract-dev wallet <0x…>               Tokens; --approvals, --txs
  contract-dev source <contract>          Verified source; --out <dir> writes the files

Monitoring:
  contract-dev monitors                   List monitors
  contract-dev monitor add <value> --when "<formula>"   Alert when a tracked value crosses a line (try: monitor help)
  contract-dev monitor set <id|name> --when "<formula>"  Change its rule; --warn "<formula>" or --no-warn its warning
  contract-dev monitor add --on <contract> --event <Name> [--when "<formula>"] [--to <dest>]
                                          An event monitor from a sentence; --silence --event <Name> [--for 24h]
                                          for a contract going quiet
  contract-dev monitor show <id|name>     Rule, inputs, episodes; a silence monitor's sightings and quiet stretches
  contract-dev monitor sightings <id|name> Every sighting a silence monitor counts, newest first
  contract-dev monitor exclude <default> <address>   Leave a contract out of a default monitor
  contract-dev alerts                     What fired (try: alerts help)
  contract-dev channels                   Alert destinations (try: channels help)

Reports:
  contract-dev report list                Scheduled reports: scope, cadence, destinations, next send, last run
  contract-dev report create …            A table of your metrics, sent on a schedule: --template daily|weekly --to <dest> (try: report help)
  contract-dev report show <id|name>      Settings, the latest table, every run and where it went
  contract-dev report run <id|name>       Send it now · report pause / resume / delete <id|name>

Agents:
  contract-dev tool list                  The platform's tools, the ones an agent calls: name, scope, title
  contract-dev tool show <name>           A tool's description and its input schema
  contract-dev tool run <name> --input '<json>'   Run one; the result as JSON, a refusal exits 1 (try: tool help)
  contract-dev skills install             Teach Claude Code, Codex, Cursor and other agents this CLI (try: skills help)
  contract-dev skills status              Where the agent skill is installed, and its version

Nouns work too: contracts list|add|rename|remove · wallets list|add|rename|remove · metrics track|untrack · monitor list · alerts list · reports.

Global flags:
  --json                                  Print the command's result as JSON instead of text
  --workspace <id|slug>                   Act on a named workspace instead of the one the login is bound to (contract.dev staff)
  --version                               Print the CLI version
  contract-dev help                       Show this help
`;

export { cliVersion };

// Dispatch one invocation; returns whatever the command returns (what --json prints).
export async function run(args: string[]): Promise<unknown> {
  const [cmd, ...rest] = args;

  switch (cmd) {
    case 'login':
      return await loginCommand(rest);
    case 'logout':
      return await logoutCommand(rest);
    case 'whoami':
      return await whoamiCommand(rest);
    case 'workspace':
    case 'workspaces':
      return await workspaceCommand(rest);
    case 'status':
      return await statusCommand(rest);
    case 'watch':
      return await watchCommand(rest);
    case 'contracts':
    case 'contract':
      return await contractsCommand(rest);
    case 'wallets':
      return await walletsCommand(rest);
    case 'unwatch':
      return await unwatchCommand(rest);
    case 'rename':
      return await renameCommand(rest);
    case 'metrics':
    case 'metric':
      return await metricsCommand(rest);
    case 'track':
      return await trackCommand(rest);
    case 'untrack':
      return await untrackCommand(rest);
    case 'monitors':
      return await monitorsCommand(rest);
    case 'monitor':
      return await monitorCommand(rest);
    case 'alerts':
    case 'alert':
    // the old name, kept for scripts
    case 'incidents':
    case 'incident':
      return await incidentsCommand(rest);
    case 'channels':
    case 'channel':
      return await channelsCommand(rest);
    case 'report':
    case 'reports':
      return await reportCommand(rest);
    case 'events':
    case 'event':
      return await eventsCommand(rest);
    case 'holders':
      return await holdersCommand(rest);
    case 'tx':
      return await txCommand(rest);
    case 'address':
      return await addressCommand(rest);
    case 'block':
      return await blockCommand(rest);
    case 'wallet':
      return await walletCommand(rest);
    case 'source':
      return await sourceCommand(rest);
    case 'find':
      return await findCommand(rest);
    case 'describe':
      return await describeCommand(rest);
    case 'group':
    case 'groups':
      return await groupCommand(rest);
    case 'table':
    case 'tables':
      return await tableCommand(rest);
    case 'history':
      return await historyCommand(rest);
    case 'factory':
      return await factoryCommand(rest);
    case 'tool':
    case 'tools':
      return await toolCommand(rest);
    case 'who':
      return await whoCommand(rest);
    case 'query':
      return await queryCommand(rest);
    case 'read':
      return await readCommand(rest);
    case 'skills':
    case 'skill':
      return await skillsCommand(rest);
    case 'version':
    case '--version':
    case '-v':
    case '-V': {
      const version = cliVersion();
      console.log(`contract-dev ${version}`);
      return { version };
    }
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

async function main() {
  const raw = process.argv.slice(2);
  // --json anywhere on the line: the command runs silently and its result prints as JSON.
  const json = raw.includes('--json');
  const noJson = raw.filter((a) => a !== '--json');
  // `channels add slack --workspace <name>` names a SLACK workspace (commands/monitor addSlack), not the staff
  // override, which stripped it before the command saw it (2026-10-28)
  const args = noJson[0] === 'channels' ? noJson : extractTargetFlags(noJson);
  const realLog = console.log;
  if (json) console.log = () => {};
  // after an upgrade, the agent skill this CLI installed is brought up to its version (a line on stderr)
  if (!['skills', 'skill', 'login', 'logout', 'help', '--help', '-h', 'version', '--version', '-v', '-V', undefined].includes(args[0])) {
    try {
      refreshInstalledSkills();
      // once a day, the server's guide: a tool added since reaches the agent without a new CLI
      await refreshGuideIfStale();
    } catch {
      // never in the way of the command
    }
  }
  try {
    const result = await run(args);
    if (json) {
      console.log = realLog;
      console.log(JSON.stringify(result ?? { ok: true }, null, 2));
    }
  } catch (err) {
    console.log = realLog;
    const message = err instanceof Error ? err.message : String(err);
    // A tool's refusal carries a code (NOT_WATCHED, AMBIGUOUS, …) that a script can branch on.
    const code = (err as { code?: unknown } | null)?.code;
    if (json) console.log(JSON.stringify({ error: message, ...(typeof code === 'string' ? { code } : {}) }, null, 2));
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
