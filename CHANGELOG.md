# Changelog

## 1.7.0 — 2026-10-13

### Added — event metrics
- `metric define "<name>" --event <Event> [--read …] [--field …] [--value …]`: a number added up from events,
  each event a record with the views it needs read as of its own transaction (exactly: the block's earlier
  writes are laid over the previous block). Tried on the newest 24 hours of events first; `--preview` stops
  there. Ethereum, Avalanche and Sepolia, up to 89 days of history.
- `metric show <name>` reads one (its total, the largest contracts, a series, the records behind it),
  `metric events` lists them, `metric update` replaces parts of a definition, `metric delete` removes one.
- `metric monitor <metric>`: an alert on an event metric, a condition on each new record or a window rule
  (above, below, rises, falls, or a multiple of its usual window), in total or per contract.
- `track formula <contract>`: a calculated value, several views at one block and an expression over them.
- `metric item "<name>" --table …`: a number over an item table's rows, recorded each minute from now.

### Added — one guide for every agent
- The skill now carries the platform's guide (which command answers which question, how to answer, the
  starter pack), the same one the Slack and Telegram assistant reads. `skills install` writes the server's
  current copy into the skill (between `contract-dev:guide` markers), and the CLI checks for a newer one once
  a day, so a tool the platform adds reaches a coding agent without a new CLI. The packaged copy is the
  fallback offline or on an older server.
- `largest <Event>` (the biggest events and who made them), `who <address|ENS|name>` (with `--activity`,
  `--holdings`), `market` (lending markets and vaults: rates, utilisation, supplied, borrowed) and
  `read <contract> <function>` (any view call, now or `--at` a past time).
- `compare --by swaps|swapVolumeUsd|feesUsd` for pools, and `--window 1h` on compare and activity query.

### Added — the agent skill, installed by the CLI
- `skills install [--project] [--force]` copies the skill that ships in the package to
  `~/.claude/skills/contract-dev` (Claude Code; Cursor and GitHub Copilot read it too) and
  `~/.agents/skills/contract-dev` (Codex, Cursor, Gemini CLI, GitHub Copilot); `--project` writes
  both at the repository root instead, to be committed. Each copy carries a marker with the CLI
  version that wrote it; a folder without one (a copy or link made by hand) is never overwritten
  without `--force`, and a link to the package's own skill is left in place.
- `skills status` and `skills uninstall` (npm runs no script on uninstall, so this is the clean-up).
- `login` ends by offering the skill once (`--skill` installs without asking, `--no-skill` skips;
  a "no" is remembered in `~/.contract.dev/preferences.json`). With no terminal it prints the
  command instead.
- After an upgrade, the next command refreshes every copy it installed to the new version, with a
  line on stderr (stdout and `--json` are untouched).
- The skill's header is now valid YAML (its description held an unquoted colon) and says when to use
  it: setting up a protocol, groups, factories, tables, metrics, alerts and reports, and questions
  about activity on watched contracts.

### Added — item tables and full history
- Nothing is assumed to be a token amount any more. A table column, a group column or a roll-up is in a token only when it states one: `token <token>` (its 0x address, `self`, or a view each contract answers with it, like `asset()`); its decimals then scale it, and `show usd` puts it in dollars at the current price. `--sum "WithdrawalQueued.normalizedAmount:Requested token asset()"`, `--formula "Outstanding={Requested} - {Paid}; token asset(); show usd"`, `table update <table> --token "Requested=asset() show usd"` (empty after `=` clears it), `group column add … --token "asset()" --show usd`, `metric group … --token …`. Without a token a number is shown as the chain holds it; `decimals <n>` still scales a plain number. Formulas and rules can also price a token themselves: `price()`, `usd()`, `amount()`.
- `table list | show <table> | create "<name>" | update <table>`: the things inside contracts (withdrawal rounds,
  loans, requests), one row per id over their whole life. `show` gives openings and closings per period, how long
  rows stay open, column totals and the biggest rows; `--item <id>` one row with its own events. `create` builds a
  table from event names in the contracts' ABIs (`--opens`, `--closes`, `--count Event`, `--sum Event.field`);
  `--hidden` keeps it off the Tables page (removed 7 days after it was last read). `update --show | --hide | --name`.
- `history [<contract>] --event <Name>…`: every firing since launch (or `--since`, `--window`): counts by event and
  contract, a timeline by day, week or month (`--tz`), sizes per token with quartiles and USD buckets, top and
  repeat wallets, the weekday and hour shape, the newest and largest firings. A read too long for one answer is
  continued automatically (up to three calls; `--once` stops after one).

Needs the app deploy that adds the group tools (`describe_group`, `create_watch_rule`, `set_name_pattern`,
`add_table_column`, `add_group_monitor`), `factory_contracts` and `watch_contracts` to `/api/mainnet/tools`;
`table` and `history` need the one that adds `list_tables`, `describe_table`, `create_table`, `update_table` and
`event_history`.

### Removed
- `track <address> gas-p95`: the kind is no longer offered (the app's picker dropped it the same
  day, and the API refuses new rows of it). Metrics of that kind that already exist keep sampling
  and still show and rename as before.
- `track <token> total-supply` and `track <token> balance-of --holder`: both are a function call on
  the token, so they are `track <token> function --function "totalSupply() returns (uint256)"` and
  `… --function "balanceOf(address) returns (uint256)" --args <holder>`. The app's picker dropped
  them the same day. Existing metrics of either shape keep sampling.

### Changed
- The method kinds (`calls`, `reverts`, `revert-rate`, `callers`) are monitor inputs, not metrics:
  `metrics` no longer lists them (nor does the app's Metrics page), while `monitor add`, `metrics
  show` and `metrics rename` still find them by label or id. Needs the app deploy of the same day.

### Added
- Groups, through those tools:
  - `group show <group>` — the group at a glance: its rules and when each last synced, the columns of its table
    (key, read, unit, decimals), its monitors with their line and states, and its members with every column's
    value in the column's unit.
  - `group rule add <group> --factory <address> [--event <Name>] [--field <arg>] | --registry <address>
    --function "getAllMarkets()" [--chain] [--name-pattern "…"] [--preview]` — a rule that keeps the group filled:
    every contract the factory deploys or the registry lists is watched and tagged, now and later. Prints what
    it reads, the contracts it found, and the sync's tally; `--preview` shows the same and saves nothing.
  - `group name-pattern <group> "<pattern>" [--preview]` · `--clear` — name every member from its own reads
    (`"{token0().symbol()} pool"`); prints how many were named and a sample.
  - `group column add <group> --label "…" --read "totalAssets()" [--args a,b] [--word] [--decimals] [--decimals-from]
    [--unit usd|int|pct|duration|rate|raw] [--attribute] [--type] [--key] [--preview]` — a column on the group's table,
    one read on every member, tracked; prints the first readings so a wrong read shows before it is saved.
  - `group monitor add <group> --name "…" --column <key|label> (--above <n> | --below <n> | --above-column <key> |
    --below-column <key>) [--warn-pct <n>] [--preview]` — one monitor on every member, judged on a column; prints
    its sentence and how many contracts it covers.
- `factory <address> [--chain] [--event <Name>] [--field <arg>] [--limit]` — the contracts a factory deployed: what
  was read and whether it was a guess (the other events with an address argument are listed, so `--event --field`
  can correct it), how many, how many are watched, how far the history was read, the newest with their names and
  dates. `--watch --group <name>` then watches the ones not yet watched, tagged into the group, with the names the
  answer already knows; more than 25 needs `--yes`.
- `watch <address> <address>… [--group <name>] [--yes]` — several at once, or one straight into a group, through the
  `watch_contracts` tool: prints watched, already watched, skipped (wallets) and failed, each skipped or failed
  address on its own line. More than 25 needs `--yes`. One address without `--group` is as it was.

### Changed
- `report create` no longer needs `--to`: without a destination the report is created with none, runs on schedule,
  and its table shows on the report's page in the app until one is linked there. The command says so.

## 1.6.0 — 2026-10-13

Needs the app deploy that adds `/api/mainnet/tools` (the catalogue) and `/api/mainnet/tools/<name>` (run one):
the platform's tools, the same functions a chat agent calls, behind the API key like everything else.

### Added
- Questions, answered through those tools, so a person at the terminal and an agent read the same figures:
  - `find <query>` — what a name points at: watched contracts (by name, address or a kind word: pools, vaults,
    tokens), groups, tracked metrics, monitors, reports and destinations, one table per section.
  - `describe <contract> [--chain]` — what a contract is: kinds, standards, groups, TVL, owner, implementation,
    token; its events with their fields; its write functions (the first 20); what it calls over 7 days and the
    price feeds it reads.
  - `compare [--group <name> | --contract <ref> | --chain <id>] [--by <measure>] [--event <Name>] [--window] [--limit]`
    — the contracts in a scope ranked by transactions, activeWallets, volumeInUsd, volumeOutUsd, tvlUsd,
    revertedShare or an event's count, each against the window before; dollars, shares and counts print in
    their own unit, and a window the plan clamped says so.
  - `activity query --measure events|transactions|wallets [--event <Name>]… [scope] [--by contract,day,event]
    [--window] [--tz <zone>]` — grouped counts; by contract and day they print as a pivot (a column per day, a
    total), otherwise as a plain table. The rest of `activity` is unchanged.
- Monitors from a sentence. `monitor compile --on <contract> --event <Name> [--where "<field> <op> <value>"]…
  [--to <dest>]… [--name "…"]` prints the sentence the monitor will use, the conditions as the server read them,
  a 7-day backtest (how often it would have fired, the newest firings with sender and arguments), the notes, and
  the `monitor add` line that saves it. `--silence [--method <name> | --event <Name>] [--for 90m|24h|3d]`
  compiles a silence monitor (seen N times in 7 days, last when). `monitor add` with the same flags creates it;
  the threshold form (`monitor add <metric> --below …`) is as it was. `--to` is optional here: without one the
  monitor records alerts on its page and pages nobody.
- `tool list` · `tool show <name>` · `tool run <name> [--input '<json>' | --input @file.json]` — the tools by name,
  for scripts and agents: `run` always prints the result as JSON and a refusal exits 1 with the server's sentence
  (`--json` wraps it as `{"error", "code"}`).
- `skills/contract-dev/SKILL.md`, shipped in the package: a skill file for Claude Code, Cursor and similar agents —
  how to check the login, the find → read → act pattern, a command index by question, the vocabularies, the limits.

## 1.5.0 — 2026-10-13

Needs the app deploy that adds `/api/mainnet/reports` (list, create, show, edit, delete, run, runs, preview).

### Added
- `report` — a table of your metrics, sent on a schedule to the workspace's destinations:
  - `report list` (also `reports`) — every report: scope, cadence and time, destinations, next send on this
    machine's clock, last run.
  - `report create [--template daily|weekly] [--name "…"] [--scope workspace|tag:<group>|<contract>] [--row <kind>[:<param>]]…
    --to <dest>… [--at <hour>] [--on <weekday>] [--tz <zone>]` — from the app's template or row by row
    (`eventCount:Swap`, `trackedMetric:<id or label>`); `--to` resolves as `monitor add --to` does; `--on` makes
    a report weekly; the zone defaults to this machine's.
  - `report preview` — the same flags; prints the table a draft would send, computed now and saved nowhere.
  - `report show <id|name>` — settings, the latest table as sent, the run history with each delivery and its error.
  - `report run <id|name>` — Send now. `report pause` / `resume` / `delete <id|name>`.
- A flag given twice keeps every value (`--row a --row b`); elsewhere a repeated flag still takes the last.

## 1.4.0 — 2026-10-05

Needs the app as deployed on 2026-10-05: an API key on `/api/mainnet/contract/transfer-volume`,
`contract/token-parties`, `console/positions/detail`, `oracles/feed` and `invariants/<id>/sightings`.

### Added
- `events [<contract>]` — the Events tab: every event fired in the window, how often and in how many transactions,
  against the previous window, and the events a contract's ABI declares that never fired.
- `contracts show` covers the whole Overview tab: value held and its 24h change, the activity sparkline, a token's
  own transfer volume, where the ABI comes from, the contract's monitors and their states, its tracked metrics.
- `dependencies` opens with the price feeds the contract reads, as the Dependencies tab does: each Chainlink
  feed's value, how long since it updated against the heartbeat it promises, Fresh / Late / Not assessed, the
  stalest price any read in the window saw, and the reads. `address` on a feed's proxy, SVR proxy or aggregator
  prints the address page's panel: the reading, its age, the verdict, the published terms, the feed's addresses.
- `flows <token>` adds the token's own movements, holder to holder, as the home map shows them for a token: its
  top senders and receivers over the last 24h, with mints, burns and self-transfers left out.
- `positions <contract> <vault|market> [--range]` opens one position in full, the Positions tab's drill-down: a
  vault holding's value, shares, share price, withdrawable amount and vault size, or a lending account's health,
  collateral and debt; the series behind them as lines; the timeline of deposits, withdrawals, supplies, borrows,
  repays and liquidations with their transactions; where the history begins.
- `monitor show` on a silence monitor reads its sightings — the calls or emissions it counts — and says how
  many, how long it has been quiet, the longest gap, and every quiet stretch longer than its window with the
  sightings on either side. `monitor sightings <id|name> [--range 24h|7d|30d] [--limit]` lists them.

### Changed
- The package is `@contract-dev/cli` and the command is `contract-dev` (were both `contract.dev`). The dotted
  command never ran on Windows: PowerShell and cmd treat `.dev` as a file extension, find the POSIX shim npm
  writes next to the `.cmd` wrapper, and open it as a document. Install with `npm install -g @contract-dev/cli`
  or run `npx @contract-dev/cli <command>`. The `contract.dev` package is deprecated and gets no further releases.

- `metrics show` and `metrics export` say which window the server served when the plan narrowed it
  (Free reaches 90 days at a point a day since the 2026-10-06 app deploy; `all` stays paid).

### Fixed
- `status` and `monitors` read monitor states the way the app does. The server says `ok` / `breached` / `warming`;
  1.2.0 and 1.3.0 counted those as nothing, so a workspace with an open alert showed 0 healthy · 0 alerting.

## 1.3.0 — 2026-10-01

Needs the app deploy that lets a staff key name a workspace (`lib/apiAuth`, `lib/workspaceOverride`)
and lets an API key read the dashboard's data routes (every `/api/mainnet/*` route answers a key, with a
per-key limit of 120 requests a minute).

### Added
- Everything the dashboard shows, from the terminal. `<contract>` is an address or a watched contract's name:
  - `activity [<contract>] [--calls|--events|--transfers] [--failed] [--reads|--all] [--direct|--routed]` — the Activity tab.
  - `methods [<contract>]`, `methods <contract> <method> [--paths]` — calls per method; one method in full; the paths into it.
  - `flows [<contract>] [--in|--out] [--token]`, `counterparty <address>` — value in and out, by token and counterparty.
  - `users [<contract>] [--routes|--wallets]` — active wallets, how they arrive, the busiest.
  - `tvl [<contract>]`, `positions <contract>`, `holders <contract>` — value held and what it is made of.
  - `contracts show <contract>`, `contracts stats`, `dependencies <contract>`.
  - `tx <hash> [--trace] [--state]`, `address <0x…>`, `block <n>`, `wallet <0x…> [--approvals|--txs]`, `source <contract> [--out]`.
  - `--range 24h|7d|30d|90d` and `--chain` throughout; `--json` gives the full payload the dashboard renders.
- `--workspace <id|slug>` on any command, and `CONTRACT_DEV_WORKSPACE`: act on a named workspace instead of
  the one the credentials are bound to. The server honours it for contract.dev staff (a root admin on any
  workspace, hand-over staff on a workspace they belong to) and refuses any other key, so nothing changes for
  everyone else: the key still decides the workspace, and `workspace use` still logs in again.

## 1.2.0 — 2026-09-29

Needs the app deploy that adds `/api/cli/alert-channels/*`, `/api/cli/logout`, bearer auth on
`/api/stagenets` and `/api/mainnet/vitals`, and the `apiKeyId` in `/api/cli/whoami`.

### Added
- `status` — the workspace at a glance: contracts, TVL, 24h transactions, metrics, monitors, open alerts, stagenets.
- `--json` on every command, `--version`.
- `metrics export <id|label> [--range] [--format csv|json]` — a metric's history.
- `monitor exclude|include <default> <address> [--chain]` — leave a contract out of a default monitor.
- `channels test|enable|disable|remove <id|label>`.
- `stagenet create <name> --chain <id|name>`, `stagenet delete <ref> --yes`, `stagenet reset [--every 6h|12h|1d|off] [--show]`.
- `state resync <address>` — drop every local override on a mainnet contract.
- `watch --abi <file>` — an ABI for a contract without verified source.
- `--chain` accepts names (ethereum, arbitrum, avalanche, sepolia, …); `watch list` shows TVL.
- Noun aliases: `contracts list|add|rename|remove`, `metrics track|untrack`, `incident`, `channel`.
- Every command answers `help`.

### Changed
- Credentials are bound to one workspace; `workspace use` runs the login again for another one.
  The workspace header and `CONTRACT_DEV_WORKSPACE` are gone.
- `logout` revokes the key on the server before deleting the local file.
- `incidents` and `incidents show` print a default monitor's reading (sentence, numbers, transactions).
- `monitor show` on a default monitor lists the contracts it covers and their state.
- Requests time out after 30 s (stagenet RPC: 120 s); reads retry once.
- `watch` prefers the app's own name for an address; `--name` still wins.
- Default monitors resolve by slug (`revert-spike`) as well as by name.
- Help text and README point at the current docs and the Monitoring → Destinations location.

## 1.1.0 — 2026-09-18
- Metrics, monitors, incidents, channels and rename commands.
