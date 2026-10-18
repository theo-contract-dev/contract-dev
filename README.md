# @contract-dev/cli

Command-line tool for [contract.dev](https://contract.dev): watch your mainnet
contracts, track their metrics, ask questions about them, alert when a value
crosses a line or an event fires — and work with a Stagenet from your terminal.
Every command speaks `--json`, so agents and scripts read what you read.

## Install

```bash
npm install -g @contract-dev/cli      # or run it without installing: npx @contract-dev/cli <command>
```

## Setup

```bash
contract-dev login                   # device-code sign-in, opens the browser
contract-dev whoami                  # the account + workspace the CLI acts as
contract-dev workspace list          # the workspaces you belong to
contract-dev workspace use my-team   # switch: logs in again for that workspace
contract-dev status                  # the workspace at a glance
contract-dev logout                  # revokes the key, deletes the local file
```

No config files. The CLI keeps its credentials in `~/.contract.dev/credentials.json`.
Credentials are bound to one workspace — the one active in the app when you approve
the login — so `workspace use` runs the login again; make the target workspace the
active one in the app before approving.

## Watch contracts

The workspace's watchlist — the contracts on the home map and /contracts:

```bash
contract-dev watch 0xA0b8... --chain 1                  # named from the app's address book, else the token's name() / its verified name
contract-dev watch 0xVault... --chain 43114 --name "Vault"
contract-dev watch 0xNew... --abi out/Vault.sol/Vault.json   # no verified source? name its methods, events and reverts
contract-dev watch list [--chain 43114]
contract-dev rename 0xA0b8... "USDC (proxy)" --chain 1  # the name shown everywhere in the app; "" clears it
contract-dev unwatch 0xA0b8... --chain 1
contract-dev watch 0xPoolA... 0xPoolB... 0xPoolC... --group pools   # several at once, tagged into a group; over 25 needs --yes
contract-dev factory 0x1F98...                           # what a factory deployed, newest first, and which are watched
contract-dev factory 0x1F98... --watch --group pools     # then watch the ones that are not, into the group
```

Contracts are watched per (chain, address); `--chain` disambiguates one
watched on several chains and takes a name (`arbitrum`) as well as an id. Watching is
available on Ethereum (1), Arbitrum (42161), Avalanche (43114) and Sepolia (11155111).
The CLI watches contracts only. The same commands read as nouns: `contracts list|add|rename|remove`.

## Groups

A group is a tag over contracts with a table of its own: rules keep it filled, a name
pattern names its members from their own reads, columns read one value on every member,
monitors judge a column on every member.

```bash
contract-dev group show pools                                      # rules, columns, monitors, members with each column's value
contract-dev group rule add pools --factory 0x1F98... --event PoolCreated --field pool --preview   # what it would find; drop --preview to save
contract-dev group rule add markets --registry 0xReg... --function "getAllMarkets()" --chain arbitrum
contract-dev group name-pattern pools "{token0().symbol()}/{token1().symbol()} pool"
contract-dev group column add vaults --label "Assets" --read "totalAssets()" --token "asset()" --show usd   # a read on every member, priced in its stated token
contract-dev group column add vaults --label "Headroom" --call "held=totalAssets()" --call "required=coverageLiquidity()" --formula "held - required" --token "asset()" --show usd
contract-dev group column add vaults --label "Breached" --formula "{Held} < {Required}"      # a yes/no column
contract-dev group monitor add vaults --name "Vault draining" --column assets --when "value < 1000000" --warn "value < 1100000"
contract-dev group monitor add vaults --name "Over cap" --column util --when "value > {Cap}"
```

`--preview` on `group rule add` shows what the rule would find and saves nothing. A column states
its token (`--token`: an address, `self`, or a view each member answers, like `asset()`) or it is
the plain number; `--show usd` puts it in dollars.

## Tables and history

An item table holds the things inside contracts — withdrawal rounds, loans, requests — one row per
id an event announces, open until its closing event, over their whole life. `history` reads every
firing of some events since launch, with no table.

```bash
contract-dev table list                                             # every table, hidden ones too
contract-dev table create "Withdrawal rounds" --group "Wildcat markets" --opens WithdrawalBatchCreated --closes WithdrawalBatchClosed --count WithdrawalQueued:Queued --hidden
contract-dev table show "Withdrawal rounds" --by week --among done   # openings and closings, how long rows stay open, the biggest
contract-dev query table "Withdrawal rounds" --where '{Stage} == "Paying"' --sort "{Outstanding}"   # its rows, filtered and ranked
contract-dev history --group "Wildcat markets" --event WithdrawalQueued --by week   # since launch: by week, sizes, top wallets, when
```

`--hidden` keeps a table off the Tables page (it goes 7 days after it was last read; `table update <table> --show`
puts it on the page).

## Track metrics

A tracked metric is an on-chain value sampled over time — charted on /metrics
and the thing a monitor judges. Kinds follow the app's Track Metric picker:

```bash
contract-dev track 0xToken... function --function "totalSupply() returns (uint256)" --label "USDC supply"
contract-dev track 0xSafe...  native-balance --chain 43114
contract-dev track 0xSafe...  erc20-balance --token 0xToken...
contract-dev track 0xVault... function --function "convertToAssets(uint256) returns (uint256)" --args 1e18 --decimals 18
contract-dev track 0xPair...  function --function "getReserves() returns (uint112,uint112,uint32)" --word 1
contract-dev track 0xPool...  tvl
contract-dev track 0xPool...  calls --method "swap(address,bool,int256,uint160,bytes)" --window 15m
contract-dev track 0xPool...  revert-rate --except 0xBot1...,0xBot2...
```

`function` reads are ABI-encoded locally from the human-readable signature;
`--word` picks one value of a multi-value return, `int` returns are decoded as
signed automatically, `--calldata 0x…` bypasses encoding. The method kinds
(`calls`, `reverts`, `revert-rate`, `callers`) are available on the
same four chains as watching; they create a value for monitors, which
`metrics` doesn't list and `monitor add` still finds by label or id.

```bash
contract-dev metrics [--address 0x... --chain 1]        # id, kind, chain, address, label, current value
contract-dev metrics show "USDC supply" --range 7d      # the metric + its history
contract-dev metrics rename <id|label> "New label"
contract-dev metrics pause <id|label> / resume <id|label>
contract-dev metrics decimals <id|label> 6              # display scale — re-interprets stored history
contract-dev metrics export <id|label> --range 90d      # the history as CSV (--format json for JSON)
contract-dev untrack <id|label> [...]                   # also removes monitors that read it
```

### Event metrics, open totals and roll-ups

An event metric adds up a figure from the contracts' events, each view read exactly as of the
event's own transaction, with the records behind every number; a table metric is a number over
a table's open rows; a group metric rolls a group column up across its members.

```bash
contract-dev metric define "Swap fees" --group pools --event Swap --read "fee=fee()" --read "t0=token0()" --read "t1=token1()" \
  --field "in0=if(amount0 > 0, amount0, 0)" --field "in1=if(amount1 > 0, amount1, 0)" \
  --value "usd(in0 * fee / 1000000, t0) + usd(in1 * fee / 1000000, t1)"       # saves at once; history fills in the background
contract-dev metric show "Swap fees" --days 7 --records 10                      # total, the largest contracts, a series, the records
contract-dev metric monitor "Swap fees" --name "Fee spike" --when "total(1h) > 3 * usual(1h, 7d)" --per total --to "#alerts"
contract-dev metric table "Outstanding" --table "Withdrawal rounds" --column "Outstanding" --among active
contract-dev metric group "Total held" --group vaults --column assets           # each member priced in its own token
contract-dev track formula 0xLido... --label "Share rate" --call "pooled=getTotalPooledEther() decimals 18" --call "shares=getTotalShares() decimals 18" --value "pooled / shares"
contract-dev metric update "Swap fees" --history 30 / metric delete "Swap fees"
```

`contract-dev metric define help` has the expression language: the event's parameters by name,
the reads, `amount(raw, token)`, `usd(raw, token)` (the token's price on the event's day), `if()`,
`min()`, `max()`. A metric monitor's `--when` is a condition on each new record (`value > 1000`)
or over a window: `total(1h) > 50000`, `total(24h) < before(24h) * 0.5`, `total(1h) > 3 * usual(1h, 7d)`.

Tracking a value that is already tracked returns the existing metric.

Anywhere a metric is named, its id or (unambiguous) label works.

## Monitor

A monitor is one `--when` formula, in the language of metrics and tables, with an optional
warning tier on the healthy side of it and the destinations it pages. It saves at once and
replays nothing; one that turns out noisy is deleted.

```bash
contract-dev channels                                   # alert destinations (connect them in the app under Monitoring → Destinations)
contract-dev channels test telegram                     # test / enable / disable / remove <id|label>
contract-dev monitor add "Treasury · Native balance" --when "value < 25000" --warn "value < 30000" --to telegram
contract-dev monitor add "Vault liabilities" --when "value > {Vault reserves}" --warn "value > {Vault reserves} * 0.95" --to "#alerts"
contract-dev monitor add "stETH share rate" --when "value < ago(24h) * 0.8"    # against itself a day ago (up to 90 days); previous for the reading before
contract-dev monitors                                   # status, rule, open alert
contract-dev monitor show <id|name>
contract-dev monitor show "Rewards stopped"             # a silence monitor: its sightings, how long quiet, the quiet stretches
contract-dev monitor sightings "Rewards stopped" --range 7d   # every sighting it counts, newest first
contract-dev monitor set <id|name> --when "value < 20000" --to "#ops"   # edit the rule / warning (--warn, --no-warn) / destinations
contract-dev monitor snooze <id|name> 2h                # mute pages, keep evaluating
contract-dev monitor pause <id|name> / resume / rename / unsnooze / delete
```

`--to` takes channel ids, labels (`#alerts`) or kinds (`telegram`, when the workspace has
one). It is optional: without one the monitor records alerts on its page in the app until a
destination is linked there. A new monitor is named after its value unless you pass `--name`.

The three default monitors every watched contract gets — `control-change`,
`dependency-failure`, `revert-spike` — are listed by `monitors` and take
`pause` / `resume` / `snooze` / `set --to` by that slug:

```bash
contract-dev monitor exclude revert-spike 0xPool... --chain arbitrum   # leave a contract out
contract-dev monitor include revert-spike 0xPool... --chain arbitrum
contract-dev monitor show revert-spike                  # the contracts it covers, each one's state
```

```bash
contract-dev alerts [--days 30] [--limit 50]            # what fired (open episodes are always included)
contract-dev alerts show <id>                           # evidence, deliveries, who acked
contract-dev alerts ack <id> / unack <id>               # stop the reminders; the all-clear still comes
```

### Event and silence monitors

An event monitor fires when a contract emits an event, on a condition over its fields; a
silence monitor when a contract goes quiet. `--group` instead of `--on` makes one monitor on
each contract of the group that has the event:

```bash
contract-dev monitor add --on steth --event Transfer --when "amount(value, emitter()) >= 1000" --to "#alerts"
contract-dev monitor add --on pool --event Swap --when "usd(abs(amount0), token0()) > 1000000 and recipient != 0x0000000000000000000000000000000000000000" --name "Big swaps"
contract-dev monitor add --group pools --event Upgraded --event Paused --event AdminChanged   # every control change, one call
contract-dev monitor add --on steth --silence --event Submitted --for 3d                      # no Submitted event for 3 days
```

`--when` is comparisons of the event's fields joined by `and`, or one field's values joined by
`or`. A field compared bare is in base units; `amount(field, token)` is a token amount and
`usd(abs(field), token)` a dollar line (turned into the token at today's price, once). The token
is a 0x address, `emitter()` for the contract itself, or a view the contract answers with one
(`token0()`, `asset()`), as `describe` shows each field checked; nothing is read from a field's
name. Without `--when` every emission alerts. `--for` takes `90m`, `24h`, `3d`. How often a rule
would have fired is a question for `contract-dev events` with the same condition.

## Read your data

Everything the dashboard shows, from the terminal. `<contract>` is an address or a
watched contract's name (`steth` finds "Lido: stETH"); leave it out for the whole
workspace. Activity comes from the activity ledger: what the chain emitted about every
watched contract, kept over the plan's window (90 days on Free, a year on Team), `--days <n>`.
The other windows are `--range 24h|7d|30d|90d` (Free workspaces keep 24 hours there).

```bash
contract-dev query transactions --contract steth --days 7                   # transactions that reached it, newest first: who, via what, which method
contract-dev query transactions --group pools --days 30 --by day --count    # per day; --failed, --direct, --method <name>, --signer 0x…
contract-dev query transfers --contract steth --out --by counterparty --sum "{USD}"   # value out, by who received it (--in, --token USDC)
contract-dev query wallets --group pools --days 7 --where '{Status} == "new"'          # the wallets behind them: new or returning, first and last seen
contract-dev events steth                       # events emitted, event by event, and the ones that never fired
contract-dev events --group pools --event Swap --read "t0=token0()" --fixed t0 --by contract --sum "usd(abs(amount0), t0)"   # volume per pool
contract-dev history steth --event WithdrawalQueued --by week   # every firing since launch
contract-dev tvl                                # value held: now, its change, by chain and token
contract-dev contracts show steth               # its Overview tab: what it is, value and its change, last 24h, monitors, metrics
contract-dev holders <contract>                 # a token's holders
contract-dev who 0x1b7a… --holdings             # who an address is; what it holds
contract-dev read steth getTotalPooledEther --decimals 18 --at 2026-01-01   # a view function, now or in the past
```

And any transaction, address or block on Ethereum, Arbitrum, Avalanche or Sepolia:

```bash
contract-dev tx 0x03d2…                         # outcome, decoded call, fees, transfers, logs
contract-dev address 0x889e…                    # balance, identity, recent transactions; a Chainlink feed's reading
contract-dev block 26093226 --chain ethereum
contract-dev wallet 0x47ac… [--approvals|--txs]
contract-dev source steth --out ./steth-src     # verified source, written to files
```

`--json` prints everything the matching dashboard tab has (series included), for
scripts and agents. API keys get 120 requests a minute on these.

### Reports

A report is a table of those figures — active wallets, transactions, reverted share,
volume in and out, TVL, an event's count, a tracked metric — over the workspace, a
group or one contract, sent to the workspace's destinations on a schedule. A daily
report prints the last 24h, its change against the day before, then 7d and 30d; a
weekly one 7d, its change, then 30d and 90d.

```bash
contract-dev report create --template daily --to "#alerts"          # the app's daily template, 09:00 in this machine's zone
contract-dev report create --template weekly --scope tag:pools --on friday --at 17 --tz Europe/London --to telegram
contract-dev report create --name "Swaps" --scope steth --row transactions --row eventCount:Swap --row "trackedMetric:Vault reserves" --to "#alerts"
contract-dev report list                                            # scope, cadence, destinations, next send, last run
contract-dev report show "Daily report"                             # settings, the latest table, every run and where it went
contract-dev report run "Daily report"                              # send it now
contract-dev report update "Daily report" --to "#ops"               # the parts that change
contract-dev report pause "Daily report" / resume / delete
```

`--row` takes a kind (`activeWallets`, `transactions`, `revertedShare`, `volumeInUsd`,
`volumeOutUsd`, `tvlUsd`, `alertsOpened`, `eventCount:<event>`, `trackedMetric:<id|label>`,
`customMetric:<name>`),
one per flag and in order; given, they replace the template's rows. `--to` takes the
same destinations as `monitor add`; without one the report still runs on schedule and its
table shows on the report's page in the app until a destination is linked there. Anywhere
a report is named, its id or (unambiguous) name works.

## Ask questions

The question commands go through the same tools a chat agent calls, so the terminal and the
agent give the same figures. `query` asks any dataset the platform keeps a question in one
grammar, the table language:

```bash
contract-dev find pools                                  # the watched contracts that behave like pools
contract-dev find lido                                   # contracts, groups, metrics, monitors, reports, destinations named like it
contract-dev describe steth                              # kinds, standards, owner, TVL; its events and their fields; write functions
contract-dev query contracts --group pools --sort "{TVL}"                                # rank a group by a column
contract-dev query contracts --group markets --show headroom="{Held} - {Required}" --where "headroom < 0" --sort headroom --asc
contract-dev query contracts --group markets --read cov="coverageLiquidity() in asset()" --sort cov --asc   # a view read on every member now
contract-dev query contracts --group markets --by kind --sum "{Supplied}"                # fold rows into groups
contract-dev query table "Withdrawal rounds" --where '{Stage} == "Paying" and age > 7d' --sort "{Outstanding}"
contract-dev query metric Deposits --days 30 --by day --sum "{value}"                    # what is behind a metric
contract-dev query monitors --where '{State} == "breached"'
contract-dev query alerts --days 30 --by monitor --count
contract-dev query reports
```

The clauses are the same for every dataset (transactions, transfers and wallets above included):
`--where "<expr>"` keeps rows, `--show <name>="<expr>"` works out a column usable below it,
`--sort "<expr>" [--asc]` ranks, `--by <a,b>` with `--count` or `--sum|--avg|--min|--max "<expr>"`
folds rows into groups, `--total <a,b>` adds columns up over every matching row, `--limit <n>` pages
(the answer says how many matched). Columns are named by label in braces (`{Held}`) or by key; a
status column holds its option name; durations read `24h`, `7d`. Scope is the whole workspace,
`--group <name>`, `--contract <address|name>` or `--chain <id|name>`.

## Agents

Every command takes `--json` and prints the server's payload, nothing else. Underneath, the
question commands, `query` and `events` call the platform's tools, which an agent can also call by
name:

```bash
contract-dev tool list                                   # every tool: name, scope, title
contract-dev tool show query_transactions                # its description and input schema
contract-dev tool run find --input '{"query":"pools"}'   # run one; the result as JSON, a refusal exits 1
contract-dev tool run compile_monitor --input @monitor.json
```

### The agent skill (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot)

The package ships a skill that teaches a coding agent this CLI: how to check the login, the
find → read → act pattern, setting up a protocol (addresses from the repo or the docs, a group,
a watch rule, a daily report, columns, metrics and monitors), a command index by question, the
vocabularies and the limits. `login` offers to install it; or:

```bash
npm i -g @contract-dev/cli
contract-dev login                 # ends with: Install the agent skill …? (Y/n)
contract-dev skills install        # the same, any time; --project for this repository
contract-dev skills status         # where it is, and which version
# then ask your agent: "set up our protocol on contract.dev"
```

The skill also carries the platform's guide (which command answers which question, how to answer,
the starter pack): the same one the Slack and Telegram assistant reads, written in from the server on
install and refreshed once a day, so new tools reach your agent without a new CLI.

It goes to `~/.claude/skills/contract-dev` (Claude Code; Cursor and Copilot read it too) and
`~/.agents/skills/contract-dev` (Codex, Cursor, Gemini CLI, Copilot). After an upgrade, the
next command refreshes both to the new version. Run `contract-dev skills uninstall` before
`npm uninstall -g @contract-dev/cli`: npm runs no script on uninstall.

## Stagenets

```bash
contract-dev stagenets                                    # list the active workspace's stagenets
contract-dev stagenet create eth-staging --chain ethereum # fork a chain at latest; becomes the active stagenet
contract-dev stagenet use avax-fork                       # pick the one to target (stored per workspace)
contract-dev stagenet reset [--every 12h|off] [--show]    # return its state to the live chain, keeping your wallets
contract-dev stagenet delete eth-staging --yes
```

One-off overrides on any stagenet command: `--stagenet <name>`, or `--rpc-url <url>`
for a direct URL that needs no login at all.

### Push contracts

From your Foundry/Hardhat project root, after `forge build` or `npx hardhat compile`:

```bash
contract-dev push-contracts
```

Pushed contracts are matched to deployments by bytecode, so each deployment gets
a dashboard with its name and ABI attached. Re-run after each rebuild — a push
that changes nothing is a no-op. Source/artifact dirs are auto-detected; pass
`--contracts <dir>` / `--artifacts <dir>` when your hardhat.config computes paths
dynamically.

## Commands

```
contract-dev login                Connect the CLI to your contract.dev account
contract-dev whoami               Show the signed-in account + workspace
contract-dev workspace            Show or switch the workspace the CLI acts on
contract-dev logout               Revoke the key and delete the saved credentials
contract-dev status               The workspace at a glance

contract-dev watch                Watch mainnet contracts, one or several; --group tags them; watch wallet <address> for a wallet
contract-dev wallets              list / add / rename / remove watched wallets (addresses with no code)
contract-dev rename               Rename a watched contract
contract-dev unwatch              Stop watching a contract
contract-dev factory              The contracts a factory deployed; --watch --group watches the new ones
contract-dev group                show / rule add / name-pattern / column add / monitor add on a group

contract-dev metrics              List / show / export / rename / pause / resume tracked metrics
contract-dev metric               define / show / update / delete / monitor / table / group: event metrics and roll-ups
contract-dev track                Track an on-chain value; track formula for a value worked out from several views
contract-dev untrack              Stop tracking
contract-dev table                list / show / create / update / delete tables of things inside contracts (rounds, loans, proposals)

contract-dev query                One dataset as a table: contracts / table / metric / monitors / alerts / reports / transactions / transfers / wallets
contract-dev events               Events emitted, event by event; any question over recent events, in the formula language
contract-dev history              Every firing of an event since launch: counts by period, wallets, the largest
contract-dev tvl                  Value held, its change, what it is made of
contract-dev contracts            list / show <contract> / set-abi
contract-dev holders              A token's holders
contract-dev find                 What a name points at: contracts, groups, metrics, monitors, reports, destinations
contract-dev describe             What a contract is: kinds, standards, owner, TVL, events, write functions
contract-dev who                  Who an address, ENS name or label is; --holdings for what it holds
contract-dev read                 Call a view function, now or at a past date or block
contract-dev tx                   A transaction: outcome, decoded call, fees, transfers, logs
contract-dev address              An address: balance, identity, recent transactions
contract-dev block                A block and its transactions
contract-dev wallet               A wallet's tokens, approvals, transactions
contract-dev source               A contract's verified source

contract-dev monitors             List monitors
contract-dev monitor              Add / show / set / rename / pause / snooze / delete a monitor; exclude / include on a default; sightings on a silence monitor
contract-dev alerts               List / show / ack / unack alert episodes (`incidents` still works)
contract-dev channels             List / test / enable / disable / remove alert destinations

contract-dev report               List / create / show / run / update / pause / resume / delete a scheduled report

contract-dev tool                 list / show / run the platform's tools by name, for agents and scripts

contract-dev stagenets            List the workspace's stagenets
contract-dev stagenet             use / create / delete / reset a stagenet
contract-dev push-contracts       Push compiled artifacts
contract-dev generate-wallet      Generate + fund a wallet
contract-dev balance              Change native balances
contract-dev erc20-balance        Change ERC20 balances
contract-dev state                Override code / nonce / storage; resync a contract to mainnet
contract-dev impersonate          Impersonate an address
contract-dev follow               Pin contract state to live mainnet
contract-dev unfollow             Stop following
contract-dev function-override    Override contract function results
```

Run `contract-dev <command> help` for per-command flags. `--json` on any command prints its
result as JSON; `--version` prints the version.

## Docs

Full reference: [docs.contract.dev/cli](https://docs.contract.dev/cli).
