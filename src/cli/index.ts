#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushContractsCommand } from './commands/push-contracts';
import { generateWalletCommand } from './commands/generate-wallet';
import { functionOverrideCommand } from './commands/function-override';
import { balanceCommand, erc20BalanceCommand } from './commands/balance';
import { stateCommand } from './commands/state';
import { impersonateCommand } from './commands/impersonate';
import { followCommand, unfollowCommand } from './commands/follow';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login';
import { workspaceCommand } from './commands/workspace';
import { stagenetCommand, stagenetsCommand } from './commands/stagenet';
import { watchCommand, unwatchCommand, renameCommand, contractsCommand } from './commands/watch';
import { metricsCommand, trackCommand, untrackCommand } from './commands/metrics';
import { monitorCommand, monitorsCommand, channelsCommand } from './commands/monitor';
import { incidentsCommand } from './commands/incidents';
import { statusCommand } from './commands/status';
import { activityCommand } from './commands/activity';
import { methodsCommand } from './commands/methods';
import { flowsCommand, counterpartyCommand } from './commands/flows';
import { usersCommand } from './commands/users';
import { tvlCommand, positionsCommand, holdersCommand } from './commands/tvl';
import { dependenciesCommand } from './commands/inspect';
import { txCommand, addressCommand, blockCommand, walletCommand, sourceCommand } from './commands/explorer';
import { extractTargetFlags } from './target';

const HELP = `contract.dev — your contracts, from the command line

Account:
  contract.dev login                      Connect the CLI to your contract.dev account (try: login help)
  contract.dev whoami                     Show which account + workspace the CLI acts as
  contract.dev workspace <sub>            Show or switch the workspace the CLI acts on (try: workspace help)
  contract.dev logout                     Revoke the key and delete the saved credentials
  contract.dev status                     The workspace at a glance: contracts, TVL, transactions, alerts

Watch contracts:
  contract.dev watch <address>            Watch a mainnet contract (try: watch help)
  contract.dev watch list                 List watched contracts
  contract.dev rename <address> <name>    Rename a watched contract
  contract.dev unwatch <address>          Stop watching a contract

Metrics:
  contract.dev metrics                    List tracked metrics (try: metrics help)
  contract.dev metrics export <id|label>  A metric's history as CSV or JSON
  contract.dev track <address> <kind>     Track a balance, supply, call result, TVL or method telemetry (try: track help)
  contract.dev untrack <id|label>         Stop tracking

Data (what the dashboard shows; <contract> is an address or a watched contract's name):
  contract.dev activity [<contract>]      Transactions, calls, events and transfers, newest first (try: activity help)
  contract.dev methods [<contract>]       Calls per method: reverts, callers, gas; one method in full (try: methods help)
  contract.dev flows [<contract>]         Value in and out: by token, by counterparty (try: flows help)
  contract.dev users [<contract>]         Active wallets, how they arrive, the busiest (try: users help)
  contract.dev tvl [<contract>]           Value held: now, its change, what it is made of (try: tvl help)
  contract.dev contracts show <contract>  One contract at a glance · contracts stats: all of them side by side
  contract.dev positions <contract>       Positions in lending markets and vaults
  contract.dev holders <contract>         A token's holders
  contract.dev dependencies <contract>    The contracts it calls out to
  contract.dev counterparty <address>     One counterparty's dealings with your contracts

Explorer (any address on a supported chain):
  contract.dev tx <hash>                  A transaction; --trace for the call tree, --state for what it changed
  contract.dev address <0x…>              Balance, identity and recent transactions
  contract.dev block <number>             A block and its transactions
  contract.dev wallet <0x…>               Tokens; --approvals, --txs
  contract.dev source <contract>          Verified source; --out <dir> writes the files

Monitoring:
  contract.dev monitors                   List monitors
  contract.dev monitor add <metric> …     Alert when a metric crosses a line (try: monitor help)
  contract.dev monitor exclude <default> <address>   Leave a contract out of a default monitor
  contract.dev incidents                  What fired (try: incidents help)
  contract.dev channels                   Alert destinations (try: channels help)

Stagenets:
  contract.dev stagenets                  List the active workspace's stagenets
  contract.dev stagenet use <name>        Set the active stagenet (stored per workspace)
  contract.dev stagenet create <name> --chain <id|name>   Create a stagenet (try: stagenet help)
  contract.dev stagenet reset             Return the stagenet's state to the live chain, keeping your wallets
  --stagenet <name> / --rpc-url <url>     One-off target override on any stagenet command
  contract.dev push-contracts             Push this directory's compiled contracts so deployments get dashboards
  contract.dev generate-wallet            Generate a fresh wallet and fund it with 1,000,000 native tokens
  contract.dev balance <sub>              Change native balances (try: balance help)
  contract.dev erc20-balance <sub>        Change ERC20 balances (try: erc20-balance help)
  contract.dev state <sub>                Override code / nonce / storage, resync to mainnet (try: state help)
  contract.dev impersonate <sub>          Impersonate an address (try: impersonate help)
  contract.dev follow <sub>               Pin contract state to live mainnet (try: follow help)
  contract.dev unfollow <address>         Stop following (mirrors follow's flags)
  contract.dev function-override <sub>    Override contract function results (try: function-override help)

Nouns work too: contracts list|add|rename|remove · metrics track|untrack · monitor list · incidents list · stagenet list.

Global flags:
  --json                                  Print the command's result as JSON instead of text
  --workspace <id|slug>                   Act on a named workspace instead of the one the login is bound to (contract.dev staff)
  --version                               Print the CLI version
  contract.dev help                       Show this help
`;

export function cliVersion(): string {
  try {
    // dist/cli/index.js and src/cli/index.ts both sit two levels under the package root.
    return String(JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version);
  } catch {
    return 'unknown';
  }
}

// Dispatch one invocation; returns whatever the command returns (what --json prints).
export async function run(args: string[]): Promise<unknown> {
  const [cmd, ...rest] = args;

  switch (cmd) {
    case 'push-contracts':
      return await pushContractsCommand(rest);
    case 'import-contracts': // pre-rename spelling, kept as a quiet alias
      console.error('Note: `import-contracts` is now `push-contracts`.');
      return await pushContractsCommand(rest);
    case 'generate-wallet':
      return await generateWalletCommand(rest);
    case 'function-override':
      return await functionOverrideCommand(rest);
    case 'balance':
      return await balanceCommand(rest);
    case 'erc20-balance':
      return await erc20BalanceCommand(rest);
    case 'state':
      return await stateCommand(rest);
    case 'impersonate':
      return await impersonateCommand(rest);
    case 'follow':
      return await followCommand(rest);
    case 'unfollow':
      return await unfollowCommand(rest);
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
    case 'stagenets':
      return await stagenetsCommand(rest);
    case 'stagenet':
      return await stagenetCommand(rest);
    case 'watch':
      return await watchCommand(rest);
    case 'contracts':
    case 'contract':
      return await contractsCommand(rest);
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
    case 'incidents':
    case 'incident':
      return await incidentsCommand(rest);
    case 'channels':
    case 'channel':
      return await channelsCommand(rest);
    case 'activity':
      return await activityCommand(rest);
    case 'methods':
    case 'method':
      return await methodsCommand(rest);
    case 'flows':
    case 'flow':
      return await flowsCommand(rest);
    case 'counterparty':
      return await counterpartyCommand(rest);
    case 'users':
      return await usersCommand(rest);
    case 'tvl':
    case 'value':
      return await tvlCommand(rest);
    case 'positions':
      return await positionsCommand(rest);
    case 'holders':
      return await holdersCommand(rest);
    case 'dependencies':
    case 'deps':
      return await dependenciesCommand(rest);
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
    case 'version':
    case '--version':
    case '-v':
    case '-V': {
      const version = cliVersion();
      console.log(`contract.dev ${version}`);
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
  const args = extractTargetFlags(raw.filter((a) => a !== '--json'));
  const realLog = console.log;
  if (json) console.log = () => {};
  try {
    const result = await run(args);
    if (json) {
      console.log = realLog;
      console.log(JSON.stringify(result ?? { ok: true }, null, 2));
    }
  } catch (err) {
    console.log = realLog;
    const message = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ error: message }, null, 2));
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
