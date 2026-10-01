# contract.dev

Command-line tool for [contract.dev](https://contract.dev): watch your mainnet
contracts, track their metrics, alert when a value crosses a line — and work
with a Stagenet from your terminal.

## Install

```bash
npm install -g contract.dev      # or run it without installing: npx contract.dev <command>
```

## Setup

```bash
contract.dev login                   # device-code sign-in, opens the browser
contract.dev whoami                  # the account + workspace the CLI acts as
contract.dev workspace list          # the workspaces you belong to
contract.dev workspace use my-team   # switch: logs in again for that workspace
contract.dev status                  # the workspace at a glance
contract.dev logout                  # revokes the key, deletes the local file
```

No config files. The CLI keeps its credentials in `~/.contract.dev/credentials.json`.
Credentials are bound to one workspace — the one active in the app when you approve
the login — so `workspace use` runs the login again; make the target workspace the
active one in the app before approving.

## Watch contracts

The workspace's watchlist — the contracts on the home map and /contracts:

```bash
contract.dev watch 0xA0b8... --chain 1                  # named from the app's address book, else the token's name() / its verified name
contract.dev watch 0xVault... --chain 43114 --name "Vault"
contract.dev watch 0xNew... --abi out/Vault.sol/Vault.json   # no verified source? name its methods, events and reverts
contract.dev watch list [--chain 43114]
contract.dev rename 0xA0b8... "USDC (proxy)" --chain 1  # the name shown everywhere in the app; "" clears it
contract.dev unwatch 0xA0b8... --chain 1
```

Contracts are watched per (chain, address); `--chain` disambiguates one
watched on several chains and takes a name (`arbitrum`) as well as an id. Watching is
available on Ethereum (1), Arbitrum (42161), Avalanche (43114) and Sepolia (11155111).
The CLI watches contracts only. The same commands read as nouns: `contracts list|add|rename|remove`.

## Track metrics

A tracked metric is an on-chain value sampled over time — charted on /metrics
and the thing a monitor judges. Kinds follow the app's Track Metric picker:

```bash
contract.dev track 0xToken... total-supply --label "USDC supply"
contract.dev track 0xSafe...  native-balance --chain 43114
contract.dev track 0xSafe...  erc20-balance --token 0xToken...
contract.dev track 0xToken... balance-of --holder 0xSafe...
contract.dev track 0xVault... function --function "convertToAssets(uint256) returns (uint256)" --args 1e18 --decimals 18
contract.dev track 0xPair...  function --function "getReserves() returns (uint112,uint112,uint32)" --word 1
contract.dev track 0xPool...  tvl
contract.dev track 0xPool...  calls --method "swap(address,bool,int256,uint160,bytes)" --window 15m
contract.dev track 0xPool...  revert-rate --except 0xBot1...,0xBot2...
```

`function` reads are ABI-encoded locally from the human-readable signature;
`--word` picks one value of a multi-value return, `int` returns are decoded as
signed automatically, `--calldata 0x…` bypasses encoding. The method kinds
(`calls`, `reverts`, `revert-rate`, `callers`, `gas-p95`) are available on the
same four chains as watching.

```bash
contract.dev metrics [--address 0x... --chain 1]        # id, kind, chain, address, label, current value
contract.dev metrics show "USDC supply" --range 7d      # the metric + its history
contract.dev metrics rename <id|label> "New label"
contract.dev metrics pause <id|label> / resume <id|label>
contract.dev metrics decimals <id|label> 6              # display scale — re-interprets stored history
contract.dev metrics export <id|label> --range 90d      # the history as CSV (--format json for JSON)
contract.dev untrack <id|label> [...]                   # also removes monitors that read it
```

Tracking a value that is already tracked returns the existing metric.

Anywhere a metric is named, its id or (unambiguous) label works.

## Monitor

A monitor is an alert rule on a tracked metric, an optional warning tier on the
healthy side of it, and the destinations it pages:

```bash
contract.dev channels                                   # alert destinations (connect them in the app under Monitoring → Destinations)
contract.dev channels test telegram                     # test / enable / disable / remove <id|label>
contract.dev monitor add "Treasury · Native balance" --below 25000 --warn 30000 --to telegram
contract.dev monitor add "Vault reserves" --below-metric "Vault liabilities" --warn-pct 5 --to "#alerts"
contract.dev monitors                                   # status, rule, open incident
contract.dev monitor show <id|name>
contract.dev monitor set <id|name> --below 20000 --to "#ops"   # edit the rule / warning / destinations
contract.dev monitor snooze <id|name> 2h                # mute pages, keep evaluating
contract.dev monitor pause <id|name> / resume / rename / unsnooze / delete
```

`--to` takes channel ids, labels (`#alerts`) or kinds (`telegram`, when the
workspace has one) — required on `add`, since a monitor with nowhere to send
alerts nobody. A new monitor is named after its metric unless you pass `--name`.

The three default monitors every watched contract gets — `control-change`,
`dependency-failure`, `revert-spike` — are listed by `monitors` and take
`pause` / `resume` / `snooze` / `set --to` by that slug:

```bash
contract.dev monitor exclude revert-spike 0xPool... --chain arbitrum   # leave a contract out
contract.dev monitor include revert-spike 0xPool... --chain arbitrum
contract.dev monitor show revert-spike                  # the contracts it covers, each one's state
```

```bash
contract.dev incidents [--days 30] [--limit 50]         # what fired (open episodes are always included)
contract.dev incidents show <id>                        # evidence, deliveries, who acked
contract.dev incidents ack <id> / unack <id>            # stop the reminders; the all-clear still comes
```

## Read your data

Everything the dashboard shows, from the terminal. `<contract>` is an address or a
watched contract's name (`steth` finds "Lido: stETH"); leave it out for the whole
workspace. Windows are `--range 24h|7d|30d|90d` (Free workspaces keep 24 hours).

```bash
contract.dev activity steth                     # transactions that reached it, newest first
contract.dev activity steth --calls             # every call into it, internal ones included (--events, --transfers)
contract.dev activity --failed --chain arbitrum # what reverted, across the workspace
contract.dev methods steth                      # calls per method: reverts, callers, gas
contract.dev methods steth transfer             # one method: callers, revert reasons, arguments, recent calls
contract.dev methods steth transfer --paths     # the contracts calls come through
contract.dev flows steth                        # value in and out: by token, by counterparty
contract.dev flows steth --in --limit 100       # every counterparty sending in, largest first
contract.dev counterparty 0x1b7a…               # one counterparty's dealings with your contracts
contract.dev users steth                        # active wallets, how they arrive, the busiest (--routes, --wallets)
contract.dev tvl                                # value held: now, its change, by chain and token
contract.dev contracts show steth               # one contract at a glance: proxy, owner, token, last 24h
contract.dev contracts stats --range 7d         # every contract side by side
contract.dev positions <contract>               # positions in lending markets and vaults
contract.dev holders <contract>                 # a token's holders
contract.dev dependencies steth                 # the contracts it calls out to
```

And any transaction, address or block on Ethereum, Arbitrum, Avalanche or Sepolia:

```bash
contract.dev tx 0x03d2… --trace --state         # decoded call, fees, transfers, logs; call tree; state changes
contract.dev address 0x889e…                    # balance, identity, recent transactions
contract.dev block 26093226 --chain ethereum
contract.dev wallet 0x47ac… [--approvals|--txs]
contract.dev source steth --out ./steth-src     # verified source, written to files
```

`--json` prints everything the matching dashboard tab has (series included), for
scripts and agents. API keys get 120 requests a minute on these.

## Stagenets

```bash
contract.dev stagenets                                    # list the active workspace's stagenets
contract.dev stagenet create eth-staging --chain ethereum # fork a chain at latest; becomes the active stagenet
contract.dev stagenet use avax-fork                       # pick the one to target (stored per workspace)
contract.dev stagenet reset [--every 12h|off] [--show]    # return its state to the live chain, keeping your wallets
contract.dev stagenet delete eth-staging --yes
```

One-off overrides on any stagenet command: `--stagenet <name>`, or `--rpc-url <url>`
for a direct URL that needs no login at all.

### Push contracts

From your Foundry/Hardhat project root, after `forge build` or `npx hardhat compile`:

```bash
contract.dev push-contracts
```

Pushed contracts are matched to deployments by bytecode, so each deployment gets
a dashboard with its name and ABI attached. Re-run after each rebuild — a push
that changes nothing is a no-op. Source/artifact dirs are auto-detected; pass
`--contracts <dir>` / `--artifacts <dir>` when your hardhat.config computes paths
dynamically.

## Commands

```
contract.dev login                Connect the CLI to your contract.dev account
contract.dev whoami               Show the signed-in account + workspace
contract.dev workspace            Show or switch the workspace the CLI acts on
contract.dev logout               Revoke the key and delete the saved credentials
contract.dev status               The workspace at a glance

contract.dev watch                Watch mainnet contracts
contract.dev rename               Rename a watched contract
contract.dev unwatch              Stop watching a contract

contract.dev metrics              List / show / export / rename / pause / resume tracked metrics
contract.dev track                Track an on-chain value
contract.dev untrack              Stop tracking

contract.dev activity             Transactions, calls, events and transfers on your contracts
contract.dev methods              Calls per method; one method in full; the paths into it
contract.dev flows                Value in and out, by token and counterparty
contract.dev counterparty         One counterparty's dealings with your contracts
contract.dev users                Active wallets, how they arrive, the busiest
contract.dev tvl                  Value held, its change, what it is made of
contract.dev contracts            show <contract> / stats: one contract, or all side by side
contract.dev positions            A contract's lending and vault positions
contract.dev holders              A token's holders
contract.dev dependencies         The contracts a contract calls out to
contract.dev tx                   A transaction; --trace, --state
contract.dev address              An address: balance, identity, recent transactions
contract.dev block                A block and its transactions
contract.dev wallet               A wallet's tokens, approvals, transactions
contract.dev source               A contract's verified source

contract.dev monitors             List monitors
contract.dev monitor              Add / show / set / pause / snooze / delete a monitor; exclude / include on a default
contract.dev incidents            List / show / ack alert episodes
contract.dev channels             List / test / enable / disable / remove alert destinations

contract.dev stagenets            List the workspace's stagenets
contract.dev stagenet             use / create / delete / reset a stagenet
contract.dev push-contracts       Push compiled artifacts
contract.dev generate-wallet      Generate + fund a wallet
contract.dev balance              Change native balances
contract.dev erc20-balance        Change ERC20 balances
contract.dev state                Override code / nonce / storage; resync a contract to mainnet
contract.dev impersonate          Impersonate an address
contract.dev follow               Pin contract state to live mainnet
contract.dev unfollow             Stop following
contract.dev function-override    Override contract function results
```

Run `contract.dev <command> help` for per-command flags. `--json` on any command prints its
result as JSON; `--version` prints the version.

## Docs

Full reference: [docs.contract.dev/cli](https://docs.contract.dev/cli).
