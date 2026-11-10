# @contract-dev/cli

Command-line tool for [contract.dev](https://contract.dev): watch your mainnet
contracts, track their metrics, ask questions about them, and alert when a value
crosses a line or an event fires.
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

After a command has printed, the CLI tells your contract.dev workspace what ran: the
command line (secrets taken out), whether it worked, the error shown, how long it took
and the requests it made, so a command that failed or dragged can be looked into. It goes
only to the server the CLI is logged in to. Set `CONTRACT_DEV_NO_TELEMETRY=1` to send nothing.

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

## Metrics

A metric is a number kept over time, of two kinds. A **state** metric says how things stand — a balance,
a supply, a view's result, a column added up — read every minute and drawn as a level. An **activity**
metric says what happened over a window — swaps, fees, deposits — added up from events and drawn as
bars. One command defines either; the words decide the kind, never a flag:

```bash
contract-dev metric define "stETH supply"   --on steth        --call "totalSupply()"                       # state, one contract
contract-dev metric define "Treasury USDC"  --on tag:treasury --call "balanceOf(self) on 0xA0b8…"         # state, every wallet of the group added up
contract-dev metric define "Share rate"     --on steth        --call "pooled=getTotalPooledEther() decimals 18" \
                                                              --call "shares=getTotalShares() decimals 18" --value "pooled / shares"
contract-dev metric define "Swap fees"      --on tag:pools    --each Swap --read "fee=fee()" --read "t0=token0()" \
                                                              --value "usd(abs(amount0) * fee / 1000000, t0)"   # activity, from events
contract-dev metric define "LP value"       --on table:"Positions" --column Value                          # state, a table's column added up
contract-dev metric define "Big swaps a day" --on table:"Big swaps" --aggregate count                      # activity, a table's rows counted
```

`--on` says what it is on: a contract or wallet by name or address, `tag:<group>`, `table:"<name>"`, or
`workspace`. A state metric works on any address, watched or not. An activity metric reads the past, so
its address must be watched: given an address nobody watches, the command watches it and says so.
`--split contract` keeps one line per member of a group; `--hidden` keeps a metric off the Metrics page
(one made for a report or an alert, deleted with it). `contract-dev metric define help` has the whole
grammar: reads (`"<name>=<call>[.<output>] [on <target>] [with <args>] [decimals <n>]"`), the expression
language (`amount()`, `usd()` through a stated token, `if()`, `min()`, `max()`, `ago()`), and the activity
flags (`--where`, `--field`, `--aggregate`, `--split`, `--unit`, `--keep`, `--pair`, `--history`).

```bash
contract-dev metrics [--kind state|activity] [--hidden]   # every metric: kind, name, on, reads, unit, id
contract-dev metric show "Swap fees" --days 7              # a state metric's readings; an activity metric's total, series and records
contract-dev metric rename <id|name> "New name"
contract-dev metric pause <id|name> / resume <id|name>     # a state metric: stop sampling (history kept) / go on
contract-dev metric decimals <id|name> 6                   # a state metric's display scale
contract-dev metric export <id|name> --range 90d           # the history as CSV (--format json for JSON)
contract-dev metric monitor "Swap fees" --name "Fee spike" --when "total(1h) > 3 * usual(1h, 7d)" --per total --to "#alerts"
contract-dev metric delete <id|name>…                      # with its history and the alerts that read it
```

The same words, inline, make a metric for one report or alert without listing it anywhere:
`--row "metric:Supply=on steth; call totalSupply()"` on a report, `--on "metric:Supply=on steth; call
totalSupply()"` on an alert. Any metric is named by its id or, when one has it, its name.

The older spellings still work and say the new one: `track <address> <kind>`, `track formula`,
`metric events`, `metric table`, `metric group`, `group column add`.

## Notifications

Everything the workspace sends, in the app's two types: a **report** sends figures on a schedule; an
**alert** sends a message when something happens (once per block, a block's matches in one message) or
when a condition is met (once, then the all-clear when it clears; `--remind` re-sends it hourly until
acknowledged). `notify` lists, makes and changes them all. Nothing sends for what happened before it
was made.

### Reports

A table of figures (one line per figure, one column per window) over the workspace, a group or one
contract, with up to three tables of rows under it.

```bash
contract-dev notify add report --template daily --to "#alerts"          # active wallets, transactions, reverted share, volume in and out
contract-dev notify add report --template weekly --scope tag:pools --on friday --at 17 --tz Europe/London --to telegram
contract-dev notify add report "Morning" --scope steth --row transactions --row eventCount:Swap --row metric:"Vault reserves" \
  --row "metric:Supply=on steth; call totalSupply()" --columns 24h,7d --compare --at 9
contract-dev notify add report "Hourly swaps" --every 1h --row eventCount:Swap --columns 1h --to telegram
contract-dev notify add report "Big swaps today" --table "Swaps | sort {Amount} | top 5 | days 1" --at 18
contract-dev notify run "Morning"                                       # send it now
contract-dev notify set "Morning" --add-row activeWallets --to "#ops"   # the parts that change
```

`--row` takes a line (`activeWallets`, `transactions`, `revertedShare`, `volumeInUsd`, `volumeOutUsd`,
`alertsOpened`, `eventCount:<event>`, `metric:<name or id>` for any metric, `"metric:<name>=<clauses>"`
to define one for the report, a `"formula:<Label>=<expr>"`), one per flag and in order; given, they
replace the template's. `--columns` are the windows every line prints. `--table "<name>=<clauses>"`
makes a live table for the report. What a report makes for itself is off the Metrics and Tables pages
and deleted with it.

### Alerts when something happens

```bash
contract-dev notify add alert "Large swaps" --on steth --event Swap --value "usd(abs(amount0), token0())" \
  --when "value >= 10000" --message "{name(sender())} swapped {value}" --to "#alerts"
contract-dev notify add alert "Supply moved" --on-value "stETH supply" --message "Now {value}, was {prev}"
contract-dev notify add alert "Loan repaid" --on-row "Loans:finished" --message "Loan {id} repaid: {Principal}"
contract-dev notify add alert "New markets" --on-member "Wildcat markets" --message "{name(contract)} joined"
```

`--group <g>` instead of `--on` covers every contract of a group. There are no digests: figures every
so often are a report with `--every`.

### Alerts when a condition is met

```bash
contract-dev notify add alert "Treasury low" --on metric:"Treasury ETH" --when "value < 25000" --remind --to telegram
contract-dev notify add alert "Supply low" --on "metric:stETH supply=on steth; call totalSupply()" --when "value < 9e24"
contract-dev notify add alert "Busy hour" --on metric:"Swaps" --when "total(1h) > 3 * usual(1h, 7d)"
contract-dev notify add alert "Rewards stopped" --on rewards --silence --event RewardPaid --for 24h
contract-dev notify add alert "Swaps failing" --on router --failures --rows '{method} == "swap"' --when "failed >= 5 and share > 0.5" --for 1h
contract-dev notify add alert "Withdrawal unclaimed" --on "Withdrawal Queue" --overdue --event WithdrawalRequested \
  --answer WithdrawalClaimed --match requestId --for 7d
contract-dev notify add alert "Loan at risk" --on table:"Loans" --column "Health factor" --when "value < 1.1" --to "#risk"
```

A condition has one line, `--when`: no warning tier. `--overdue` pairs an event that opens something with
the events that answer it, matched on the fields they share (`--match`); without `--match` any answer
closes the oldest open. `--on table:` is a row threshold: one rule on every open row of a state table, on
a read column, each row alerting and clearing on its own and sending where the rule does (`notify set
<name> --to …` changes it for every row; the plan caps the open rows one table may have under it). There is
no alert on a function call, and `--silence` watches an event: calls are not collected.

### Managing them

```bash
contract-dev notify                                     # every one: type, name, when it sends, status
contract-dev notify --type alert --status alerting
contract-dev notify show "Large swaps"                  # settings and history
contract-dev notify set "Treasury low" --when "value < 20000"
contract-dev notify pause "Large swaps" / resume / rename / delete
contract-dev notify ack "Treasury low"                  # a reminding alert: reminders stop, the all-clear still comes
contract-dev alerts [--days 30]                         # what alerts opened; alerts show <id> for the evidence
contract-dev channels                                   # destinations; channels add telegram|slack, channels test <id|label>
```

`--to` takes channel ids, labels (`#alerts`) or kinds (`telegram`). It is optional: without one a
notification still runs, and every run and alert shows on its page in the app. `report …` and `monitor …` were retired in 4.4.0: they answer with
the `notify` line to use.

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
contract-dev contracts show steth               # its Overview tab: what it is, last 24h, alerts, metrics
contract-dev holders <contract>                 # a token's holders
contract-dev who 0x1b7a…                        # who an address is
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

## Ask questions

The question commands go through the same tools a chat agent calls, so the terminal and the
agent give the same figures. `query` asks any dataset the platform keeps a question in one
grammar, the table language:

```bash
contract-dev find pools                                  # the watched contracts that behave like pools
contract-dev find lido                                   # contracts, groups, metrics, monitors, reports, destinations named like it
contract-dev describe steth                              # kinds, standards, owner; its events and their fields; write functions
contract-dev query contracts --group markets --sort "{Held}"                             # rank a group by a column
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
contract-dev metric define        A metric, state (--call) or activity (--each), on a contract, group or table
contract-dev metrics              Every metric, both kinds
contract-dev table                list / show / create / update / delete tables of things inside contracts (rounds, loans, proposals)

contract-dev query                One dataset as a table: contracts / table / metric / monitors / alerts / reports / transactions / transfers / wallets
contract-dev queries              show / csv / refresh / rename / delete the answers kept at a page (charts and tables)
contract-dev events               Events emitted, event by event; any question over recent events, in the formula language
contract-dev history              Every firing of an event since launch: counts by period, wallets, the largest
contract-dev contracts            list / show <contract> / set-abi
contract-dev holders              A token's holders
contract-dev find                 What a name points at: contracts, groups, metrics, monitors, reports, destinations
contract-dev describe             What a contract is: kinds, standards, owner, events, write functions
contract-dev who                  Who an address, ENS name or label is
contract-dev read                 Call a view function, now or at a past date or block
contract-dev tx                   A transaction: outcome, decoded call, fees, transfers, logs
contract-dev address              An address: balance, identity, recent transactions
contract-dev block                A block and its transactions
contract-dev wallet               A wallet's tokens, approvals, transactions
contract-dev source               A contract's verified source

contract-dev notify               List / add / show / set / rename / pause / resume / delete / run / ack reports and alerts
contract-dev alerts               List / show / ack / unack alert episodes (`incidents` still works)
contract-dev channels             List / test / enable / disable / remove alert destinations

contract-dev tool                 list / show / run the platform's tools by name, for agents and scripts
contract-dev skills               install / status / uninstall the agent skill
```

Run `contract-dev <command> help` for per-command flags. `--json` on any command prints its
result as JSON; `--version` prints the version.

## Docs

Full reference: [docs.contract.dev/cli](https://docs.contract.dev/cli).
