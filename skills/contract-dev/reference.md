# contract.dev from the CLI: the reference

Every command's syntax, flags and examples (the first half), then the guide's worked examples, the rules for
making monitors, metrics, reports and tables, and the packs by kind (the second half, written by `contract-dev
skills install` from the server: the same guide the Slack and Telegram assistant reads). `SKILL.md` beside this
file is what every agent reads first; this is what it opens when it needs a command or a definition.

## Commands by question

**What is in this workspace?**
- `contract-dev workspace` — the workspace, its plan, its brief on the protocol and what it holds (first, every session);
  `contract-dev workspace brief "<text>" | --file <path> [--append]` writes the brief
- `contract-dev status` — contracts, transactions, alerts at a glance
- `contract-dev find <query>` — contracts, groups, metrics, monitors, reports, destinations by name
- `contract-dev contracts list [--chain <id>]` — the watched contracts
- `contract-dev describe <contract>` — kinds, standards, groups, owner, implementation, token;
  its events with their fields and types, its write functions. Fast: it reads the ABI, not activity.
- `contract-dev events <contract>` — the events that have fired, event by event, with the declared-but-silent
  ones apart; `contract-dev source <contract>` — the verified source (where an event is emitted, which token a
  field counts in)

**Anything the platform keeps, as a table**
- `contract-dev query contracts [--group <g>] [--kind pool|vault|token]` — the watched contracts, with a group's own columns:
  Name, Kind, Chain (by name: `--by chain`, `--where '{Chain} == "Arbitrum"'`), Groups, and Watched for, a duration
  (`--where "{Watched for} < 1d"`: what was added today)
- `contract-dev query contracts --read cov="coverageLiquidity() in asset()" --read held="totalAssets() in asset()" --read gap="held - cov"` —
  a figure read on every contract now (priced in the stated token), or an expression over earlier reads
- `contract-dev query transactions --group "<g>" --days 30 --by day --count` · `query transactions --signer 0x… --days 90` (what one address did here) · `query transfers --contract Treasury --out --days 30` (a watched wallet's outflows) ·
  `query transfers --out --by counterparty --sum "{USD}"` · `query wallets --days 7 --where '{Status} == "new"'` — the activity ledger: what the
  chain emitted about the watched contracts over the plan's window (transactions, transfers, wallets with active and new counts)
- `contract-dev query table "<name>" [--among active|done|all]` (each row's `age` is a duration: `--where "age > 7d"`) · `query metric "<name>" [--days <n>]`
  (`query metric "Swap volume" --where "{Value} > 10000"`) · `query monitors` · `query alerts [--days <n>]` · `query reports`
- `contract-dev table create "<name>" --from events --group <group> | --contract <ref> --event <Event> [--event …]
  [--field "<name>=<expr>[ on <Event>]"]… [--read "<name>=<call>"]… [--pair "<Event> on <field>"]… [--keep <param>[,…]] [--days <n>]
  [--column <name>]… [--detail <name>]… [--status "<Label>: <Opt>=<rule>; <Opt>"]… --description "<sentence>"` with the query's flags below (`--where`, `--by`, `--measure`, `--breakdown`,
  `--sort`…) — a live table straight from events, one step. The events are kept as rows underneath (off the Metrics page, named
  after the table, gone with it), each with its `--field` figures (`usd(raw, token)` in dollars on the event's day,
  `amount(raw, token)` in whole tokens scaled by the token's decimals, a `--read` as of its transaction, a paired event's field as
  `Event.field`); a field once per event with `on` when the events name the same thing differently.
  A table that lists its rows (no `--by`) shows only the columns you name with `--column`, in that order, and nothing else: each
  a `--field`, or the row's own `time`, `day`, `tx`, `chain`, `contract`, `event` or `wallet` (the wallet that signed it). Name
  none and it shows its `--field` columns alone; a parameter a formula reads is never a column by itself. Choose them for what the
  table is for (a swaps table: time, tx, the tokens in and out, the amounts in and out, the dollars, a fee where the event has
  one). Field names are the column headers in words (`amountIn` reads "Amount in"); an `amount()` column prints its token's
  symbol after each figure, so use `amount()` for token amounts, never the raw base units.
  An event whose parts are lists (a batch swap: `swapInfo.fromToken`, `swapInfo.fromAmount`… one entry per swap) is one row
  that opens onto its parts: `--detail` names the columns of those lines (one line per part; a single swap is one line), and
  the row itself shows `--column`s that are whole (its time, tx, the dollars as `sum(usd(…))` on the batch event and
  `usd(…)` on the single). A field that is one value on one event and a list on another is one list field, so single and
  batch events sit in one table; a shared field over such a parameter needs no `on`.
  `--status "Type: Batch={Event} == \"DZapBatchTokenSwapped\"; Single"` sets a category drawn as a pill on each row (its
  options in order, each with its rule, the last without one the rest; usable by name in the clauses and as a `--column`).
  Only when the person wants rows categorised: a table has no pills otherwise.
  `--where` is the question's, over the rows in the table language, never a filter on what is kept. `--days`: how far back the rows
  reach (the plan's history unless said). A table's own rows are off every list (`table list`, `metrics`): `table show "<name>"`
  reads them once every row is in; while the table is still indexing it says so and shows none.
- `contract-dev table create "<name>" --from "<table>"` with the query's flags — a second table built on the first's rows (its own
  `--where` carries in; a table that folds its rows cannot be built on: build on what it reads). `contract-dev table create
  "<name>" --from transactions|transfers|wallets|contracts` — a live table over rows the workspace already keeps.
  `contract-dev query table "<name>"` asks any table a question once. `contract-dev table list|show|delete` cover the live tables.
  `contract-dev table create "Volume by token" --from transfers --group DZap --days 30 --by day,token --sum "{USD}" --description "…"`
- The integrators table, ranked by volume, every swap and bridge event in one table with a `--measure` per column (DZap's swaps are DZapTokenSwapped
  and DZapBatchTokenSwapped, a struct array summed; its bridges BridgeStarted and CctpBridgeTransferStarted; a swap carries its
  integrator, a bridge's is on the paired DZapBridgeStarted; `0xEeee…EEeE`, the native coin, prices as it is):
  `table create "Top integrators" --from events --group "DZap Routers" --event DZapTokenSwapped --event DZapBatchTokenSwapped
  --event BridgeStarted --event CctpBridgeTransferStarted --pair "DZapBridgeStarted on transactionId"
  --field "vol=usd(swapInfo.fromAmount, swapInfo.fromToken) on DZapTokenSwapped"
  --field "vol=sum(usd(swapInfo.fromAmount, swapInfo.fromToken)) on DZapBatchTokenSwapped"
  --field "vol=usd(amount, from) on BridgeStarted" --field "vol=usd(amountIn, from) on CctpBridgeTransferStarted"
  --field "integrator=integrator on DZapTokenSwapped" --field "integrator=integrator on DZapBatchTokenSwapped"
  --field "integrator=DZapBridgeStarted.integrator on BridgeStarted" --field "integrator=DZapBridgeStarted.integrator on CctpBridgeTransferStarted"
  --by integrator --measure swaps='count where {Event} == "DZapTokenSwapped" or {Event} == "DZapBatchTokenSwapped"'
  --measure bridges='count where {Event} == "BridgeStarted" or {Event} == "CctpBridgeTransferStarted"' --measure volume="sum(vol)"
  --sort volume --breakdown chain --description "…"` (without `--sort`, groups rank by their first measure: here the swap count).
  "Every swap, newest first", single and batch in one table, each batch opening onto its swaps:
  `table create "Swaps, 30 days" --from events --group "DZap Routers" --event DZapTokenSwapped --event DZapBatchTokenSwapped --days 30
  --field "fromToken=swapInfo.fromToken" --field "toToken=swapInfo.toToken"
  --field "amountIn=amount(swapInfo.fromAmount, swapInfo.fromToken)" --field "amountOut=amount(swapInfo.returnToAmount, swapInfo.toToken)"
  --field "swapDollars=first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken))"
  --field "dollars=first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken)) on DZapTokenSwapped" --field "dollars=sum(first(usd(swapInfo.fromAmount, swapInfo.fromToken), usd(swapInfo.returnToAmount, swapInfo.toToken))) on DZapBatchTokenSwapped"
  --status 'Type: Batch={Event} == "DZapBatchTokenSwapped"; Single'
  --column time --column chain --column tx --column Type --column dollars
  --detail fromToken --detail amountIn --detail toToken --detail amountOut --detail swapDollars --sort time --description "…"`;
  "every swap over $10k" is that table with `--where "dollars > 10000"`;
  "daily bridge volume by chain" the bridge events with `--by day,chain --measure volume="sum(vol)"`. (`contract-dev query metrics
  --metric "<name>"… --split <param>` still lays separate metrics split the same way side by side.)
- Clauses, the same for all: `--where "{Held} < {Required}"` · `--show headroom="{Held} - {Required}"` (repeatable; usable in
  the clauses after it) · `--sort "<expr>" [--asc]` · `--by <a,b> --sum|--avg|--min|--max|--distinct|--first|--last "<expr>" | --count` ·
  `--measure <name>="<fn>(<expr>) [where <rule>]"` (with `--by`, repeatable: several named values per group; fn count, sum, avg, min,
  max, distinct, first, last; `--measure chains="distinct(chain)"`, `--measure last_seen="max({Time})"`) · `--having "volume > 10000"`
  (keeps groups by their values) · `--sort <measure>` with `--by` ranks the groups · `--total <a,b>` ·
  `--limit <n>` · `--breakdown <column>` (with `--by`: each group split again, its parts under it and counted: the top wallets
  across chains is `query metric "<volume>" --by wallet --sum "{Value}" --breakdown chain`, each wallet's total and how
  many chains, then its total on each). Columns by label in braces or by key; a status column holds its option name; durations read 24h, 7d.
  A duration column is held in seconds and prints compactly (`42s`, `3h`, `12d`), so compare it with a duration, never a count.
  `contract-dev query contracts --group "Wildcat markets" --show headroom="{Held} - {Required}" --where "headroom < 0" --sort headroom --asc`
- `contract-dev query contracts --group Vaults --read sp="convertToAssets(1000000000000000000)" --series 30d --every 1d` — a value
  read at every step over a window, one row per time per contract (share price over a month); `--read bal7="balanceOf(0x…) in asset() at 7d"`
  reads one figure as it was then, so `--show apr="(bal - bal7) / bal7 * 52"` is a week's APR with no metric kept.

**What happened?**
- `contract-dev events <contract>` · `holders <contract>`
- `contract-dev tx <hash>` · `address <0x…> --chain <id>` · `block <n> --chain <id>` · `wallet <0x…> [--chain <id>]` (its transactions; `--approvals`) · `source <contract>`
- `contract-dev events [<contract> | --group <g>] --event <Name> [--read "t0=token0()" --fixed t0] [--where "<expr>"]
  [--sort "<expr>"] [--show "<name>=<expr>"] [--by contract|day|week|sender|<name>] [--sum|--avg|--min|--max "<expr>" | --count]`
  — any question over recent events, in the formula language of `metric define`: a filter, the biggest by any measure, a
  breakdown per contract, day or sender. Tokens are named in the formula, `usd(abs(amount0), t0)`: a 0x address or a view the
  contract answers with one (`token0()`, `asset()`). Each listed event says who made it. Volume per pool:
  `events --group <g> --event Swap --read "t0=token0()" --fixed t0 --by contract --sum "usd(abs(amount0), t0)"`
- `contract-dev who <address|ENS|name>` — who it is
- `contract-dev read <contract> <function> [<arg>…] [--decimals 18] [--at <date>]` — call a view function, now or in the past
- `contract-dev history [<contract>] | --group <g> --event <Name>… [--since <date>] [--by week] [--who <field>]
  [--read "a=asset()"] [--value "usd(assets, a)"] [--tz <zone>]` — every firing over the plan's history (90 days on
  Team, 7 on Free), from the store: counts by period, top and repeat wallets, when, the newest and largest; with
  `--value`, what each firing is worth (a formula as `events` takes one, its reads read once per contract), its spread
  and each wallet's total. Whom it counts is the transaction's signer unless `--who` names an address field (a Wildcat
  lender is `account`). `events` answers a window; this one folds the whole plan window by period, wallet and size.

**Tables (things inside contracts: withdrawal rounds, loans, requests, proposals — one row per id, over its whole life)**
- `contract-dev table list` · `table show <table> [--by week] [--among done]` · `table show <table> --row <id>`
  — findings and endings per period, rows per status, how long rows take, the biggest active rows, one row with its
  statuses and events.
- `contract-dev table create "<name>" --group <g> | --contract <ref> --opens <Event> [--id <field>] [--count "<Event> [on <field>]"] [--sum "<Event>.<field>:<Label> [on <field>] [token <token> [show usd]]"] [--event "<Event>.<field>"]
  [--formula "<Label>=<expr>[; call <name>=<call>]…[; token <token>; show usd]"] [--status "<Label>: <Opt>=<rule>; <Opt>=<rule>; <Opt>"] [--finished "<rule>"] [--hidden]`
  — a table from the contracts' events, its whole history read. Rules are expressions over the row: columns as
  `{Label}`, events by name with `seen(E)`, `at(E)`, `latest(E)`, `inList()`, `now()`, `found()`, `timeIn({Status})`,
  `and` / `or` / `not`, comparisons, arithmetic, durations like `24h`. A status column tries its options in order, first
  match wins, an option with no rule is Otherwise. `--finished` ends a row (it stops being read, keeps its values; an
  event can bring it back). `--closes <Event>` is the shorthand for a pinned Stage with one option Closed, finished once
  it is. `--formula "Trader=first(Opened.trader)"` keeps an address (or a fixed bytes) field as it was emitted, and a
  call takes the row's own cells and the formula's other calls as arguments, as many as the view takes:
  `call c=getOpenTrade(address,uint16,uint8).collateral on 0x… with {Trader}, {Pair}, {Index}` (see `table help`).
  Name only what the protocol has (Scheduled → Ready → Executed | Cancelled); no status is fine. `--hidden` when
  it is only to answer a question. `table update <table> [--status …] [--formula …] [--finished "<rule>"]` adds status or
  formula columns, replaces their rules by label (every row is judged again), or sets the finish rule later.
- Every table, live or item, takes `--description "<sentence>"` on create (what its rows are and what it shows, in the
  person's terms); `table update <table> --description "…"` sets or changes one later, `--description ""` removes it.

**Numbers over time**
- `contract-dev metrics` · `metrics show <id|label> --range 30d` · `metrics export <id|label>` — tracked metrics and their history
- `contract-dev track <address> <kind> …` — start tracking a value (`track help` lists the kinds)
- `contract-dev tool run get_metrics --input '{"scope":{"kind":"group","group":"pools"},"rows":[{"kind":"transactions"},{"kind":"volumeInUsd"}]}'`
  — a report-shaped table, computed now
- `contract-dev metric define "<name>" --group <g> --event <Event> [--read "<name>=<call>[.<output>] [on <target>] [with <args>]"]…
  [--field "<name>=<expr>"]… [--value "<expr>"] [--where "<rule>"] [--aggregate sum|count|avg|min|max|latest]
  [--split contract|none|<name>] [--line "<an index>"] [--history <days>]
  [--keep <param>,…|all] [--pair "<Event> [on <field>]"]… --description "<one sentence>"`
  — an event metric: each event a record, its `value` added up per hour, one series per contract by default. A count of
  events is `--aggregate count` with no `--value`. A field once per event with `on` when the events name the same thing
  differently: `--field "amt=amount on BridgeStarted" --field "amt=amountIn on CctpBridgeTransferStarted"`; a field with no
  `on` is for every event. `--description` heads the metric's page (`metric table` and `metric group` take it too;
  `metric update <name> --description "…"` sets it later). `--split <name>` takes `--line`, what one line of the split is
  (`--split index --line "an index"`, `--split DZapBridgeStarted.integrator --line "an integrator"`, `--split sender
  --line "a wallet"`; a split by contract may take one too: `--line "a router"`). `--keep` puts parameters the formulas
  never read on every record (so `query metric` can show, filter or group by them); `--pair` adds another event of the
  SAME transaction, its fields read as `Event.field` (`--event BridgeStarted --pair "DZapBridgeStarted on transactionId"
  --split DZapBridgeStarted.integrator`: bridge dollars per integrator, the amount on one event and the integrator on
  the other). Pairs match by position in the transaction; when it has one paired event and several main ones, every main
  event gets that one (a rebalance round's single `CumulativeRebalanceCompleted` beside each `GardenRedistributed`). A
  read calls a view as of the start of the event's own transaction, exactly; one that reads no storage is read once.
  Expressions use the event's parameters by name (a struct's member as `swapInfo.fromAmount`, a string as text, a struct
  array's member as a list: `sum(usd(swapInfo.fromAmount, swapInfo.fromToken))`), the reads, earlier fields, `emitter()`, `sender()`, `time()`,
  `amount(raw, token)`, `usd(raw, token)` (the token's price on the event's day), `if()`, `min()`, `max()`; arithmetic
  is exact. Uniswap v3 swap fees in dollars: `--event Swap --read "fee=fee()" --read "t0=token0()" --read "t1=token1()"
  --field "in0=if(amount0 > 0, amount0, 0)" --field "in1=if(amount1 > 0, amount1, 0)" --value "usd(in0 * fee / 1000000, t0)
  + usd(in1 * fee / 1000000, t1)"`. It saves at once and reads its history in the background; `contract-dev metric show`
  reads it back with its records. Every chain the workspace watches; up to a year back (the plan's history: 7 days on
  Free). `--aggregate latest` reads a level: each split's newest value carried forward until its next event, the splits
  added up (an index's AUM from the per-Garden value each rebalance round emits).
- `contract-dev metric show <name> [--days 7] [--records 10] [--newest]` (`--days` 1 to 365, within the plan's history) — its total, the largest contracts, a series,
  and the records behind it (the transaction, parameters, reads and fields of each), which is how a figure is explained;
  `--json` prints the definition whole. `metric events` lists them; `metric update <name> …` replaces parts of the
  definition (the history is read again), while `metric update <name> --description "…"` or `--line "…"` alone changes
  the words and keeps every record; `metric delete <name>` removes an event metric, or a tracked value by its label or id (its history and the monitors that read it go with it; `untrack` is the same).
- `contract-dev metric pin <name>` puts a metric in the overview's header, after Contracts and Activity, with its figure
  and the day's shape; five at most, in the order pinned, and `metric unpin <name>` takes one off. For the protocol's
  signature numbers and headline values (a tracked value, or an event, table or group metric), not every metric.
- `contract-dev metric monitor <metric> --name "<name>" --when "<formula>" [--per total|each] [--to <dest>]` — an alert
  on an event metric, one formula: `value > 1000` on each new record (pages with its transaction; `value` is always the
  record's own number, and an event parameter itself called value is `Transfer.value`), or the metric over a
  window of 5 minutes to 7 days: `total(1h) > 50000` against a line, `total(1h) > before(1h) * 1.1` up more than 10% on
  the hour before (`total(24h) < before(24h) * 0.5`: down by half on the day before), `total(1h) > 3 * usual(1h, 7d)`
  over three times its usual hour across a week. `--per` goes only on a window rule (`total(…)`) of a split metric (event
  metrics split by contract unless defined with `--split none`), or on a table or group metric's level: `--per each` judges
  every contract on its own and `--per total` the metric as a whole, and one of them is required there. A record rule on
  an event metric (`value > 1000`) never takes `--per`: each record already pages on its own, and `--per` is refused.
  Every part comes from the person; a missing one is refused.
- `contract-dev metric table "<name>" --table "<table>" --column "<label>" [--among active]` — a number over a table's rows (an item
  table's rows (the total outstanding across open withdrawal rounds), recorded each minute from now with its past read back where the table can say it, in dollars when the
  column counts in a token; monitored with `metric monitor <name> --when "value > <n>" --per total --to <dest>` (on a
  table or group metric `value` is its level now, so `--per` applies when it is split; on an event metric `value` is each
  record, with no `--per`).
- ONE READ GRAMMAR everywhere (`track formula`, a group's formula column, a table's `--formula … ; call …`, a metric's
  `--read`): CALLS, each named, each a view (`totalAssets()`, `getFee(address) with 0x…`), a coin balance
  (`balance(self)`, `balance(0x…)`), or one storage word (`slot(self, 7)`; `slot(self, keccak(<key>, 3))` for a mapping
  entry); then an EXPRESSION over the calls' names and the host's other columns: arithmetic (`^` with any exponent; a number
  may be written `1e18` or `2.5e6`, so 18 decimals is `/ 1e18`), min/max/abs/round/sqrt/ln/exp/if,
  comparisons for a yes/no, `usd(x, <token>)` and `amount(x, <token>)` through a stated token only (its 0x address, or a
  call that answers one), `keccak(…)`, and lists when a view returns an array (`owners[1]`,
  `owners[indexOf(owners, x)]`, `len()`, `sum()`, `contains()`; at most 256 elements, more and the read fails). A view that
  returns `bytes32` (an id, a hash, a role) answers its `0x` hex as text, not a number: compare it
  (`INDEX_TYPE() == 0x6f69…`) or show it in a text column such as `query contracts --read`. A target
  is `self`, a 0x address, or a view the contract answers with one (`asset()`, `token0()`); an argument is a literal,
  `self`, `id()` on a table row, a column, or an earlier call. Nothing is guessed: state the token or get the plain number.
  `usd()` and `amount()` take a BASE-UNIT amount (an event field, a call read without `decimals`); a call read with
  `decimals` is already in token units, so its dollars are the call times `price(<token>)` (`sh * rate * price(0x…)`),
  and `usd()` over it is refused.
- `contract-dev track formula <contract> --label "<name>" --call "pooled=getTotalPooledEther() decimals 18"
  --call "shares=getTotalShares() decimals 18" --value "pooled / shares"` — a value worked out from several views at one
  block, then charted, reported and monitored like any tracked value; it reads the value now before saving. In a
  calculated value (`track formula`, a group's formula column, a report's formula row) `ago(<call>, 7d)` is that call as
  it answered that long before the value's block (1m to 365d, a duration as written): a staking token's trailing yield is
  `--call "rate=stEthPerToken() decimals 18" --value "(rate - ago(rate, 7d)) / ago(rate, 7d) * 365 / 7 * 100"`, which a
  leveraged position's net yield needs beside its lending rates. Tables and event metrics have no earlier block to read.

**Alerts** (every rule is one `--when` formula, in the language of metrics and tables)
- `contract-dev monitors` (each one's state, rule and where it sends) · `monitor show <id|name>` · `alerts [--days 30]` · `alerts show <id>` (what fired: one row per alert, its evidence with `show`)
- `contract-dev monitor add --on <contract> --event <Name> [--when "<formula>"] [--to <dest>]… [--name "…"]` — comparisons
  of the event's fields joined by and (`amount(value, emitter()) >= 1000 and to != 0x…`, `usd(abs(amount0), token0()) >
  1000000`), one field's values joined by or (`to == 0xA or to == 0xB`); without `--when` every emission alerts. A
  dollar line's token may be one of the event's own address fields when each event names its token (an Aave
  Withdraw: `usd(amount, reserve) > 25000000`): the monitor is then judged on an event metric that prices every event
  in its own token on the event's day, which `monitor add` makes (or reuses, when the workspace has the same one) and
  names in its answer; with `--group` it is one monitor over the whole group, not one per contract. It saves at once.
- `contract-dev monitor add --group <group> --event <Name> [--when "<formula>"] [--name "…"]` — one monitor on each
  contract of the group that has the event, in one call (every upgrade, every pause, every large swap); contracts
  without the event are left out and listed.
- `contract-dev monitor add --on <contract> --silence [--method <name> | --event <Name>] [--for 24h] [--to <dest>]…`
  — a contract gone quiet for `--for`; it looks back its window from its first check, so one already quiet that long
  alerts at once.
- `contract-dev monitor add <tracked value> --when "value < 25000" [--warn "value < 30000"] [--to <dest>]` — a tracked
  value against a line, another value (`value > {Other value} * 1.05`), its previous reading (`value < previous * 0.99`)
  or itself a while ago (`value < ago(24h) * 0.8`, up to 90 days); `--warn` is the same comparison nearer the healthy side
- `contract-dev monitor set <id|name> --when "<formula>"` — a tracked value's new rule; `--warn "<formula>"` or
  `--no-warn` its warning tier; `--to`, `--name` and `--max-age` as on add
- `contract-dev group monitor add <group> --name "…" --column <c> --when "value < 1000000" [--warn "value < 1100000"]`
  — a group column on every member; `value > {Other column}` against another column
- `contract-dev monitor delete <id|name>` — remove one
- `contract-dev channels` — where alerts can go: ids, labels (`#alerts`), kinds (`telegram`)
- `contract-dev channels add telegram` / `channels add slack [--channel <name>]` — connect one (the person
  opens a Telegram link or approves Slack once in a browser; the command waits for it)

**Reports**
- `contract-dev report list` · `report show <id|name>` · `report create … [--to <dest>]` · `report run <id|name>` ·
  `report update <id|name> …` (the parts that change)
- `contract-dev report create --every 1m|10m|1h|6h --name "<name>" --row <kind>[:<param>]… [--columns 1h,24h] [--snapshot]
  [--only-when "<expr>"] [--scope <scope>] [--to <dest>]` — "every 10 minutes, the current buffer": a table every N
  minutes on the UTC clock, any interval from `1m` to `7d` (`1m`, `7m`, `90m`, `4h`, `1d`); `--snapshot` prints the figures alone (no change column); `--only-when` sends only when a
  condition over the rows by label holds (`{Breached markets} > 0`; a run it fails is kept as skipped). `--columns`
  picks the windows every row prints, in order (`--columns 15m,1h,24h`; `1m` at the least); the change against the window before follows
  the first. A row stands without its change column with `--row "transactions | nocompare"`.
- `contract-dev report create --each --name "<name>" --metric "<event metric>" --when "value >= 10000" --message "<text>" [--to <dest>]`
  — "let me know whenever / every time …": a message on every new record of the metric that meets --when, never for the
  history. The message is text with {expressions} over the record (see the guide below); it saves at once and sends
  from then on. How many it would have sent is a question for `contract-dev metric show` over the metric's records.
- The same, on what else can happen (one trigger per report; `--when` a condition over it, `--message` a template over
  it, `--digest 30m|1h|1d` to bundle the matches into one message, any interval from `1m` to `7d`): `--on-event "Swap" [--value "usd(amount0, token0())"]`
  (an event on the scope's contracts: the report keeps an event metric of its own, off the lists, deleted with it),
  `--on-call "transfer(address,uint256)" --scope <scope>` (a method called: `{name(caller)}`, `{method}`, `{ok}`),
  `--on-value "<tracked value>"` (a reading: `{value}`, `{prev}`, `{label}`), `--on-row "<table>[:opened|finished|both]"`
  (a row of a table: its columns by `{Label}`, `{id}`, `{what}`), `--on-member "<group>[:joined|left|both]"`
  (`{name(contract)}`, `{what}`, `{group}`), `--on-monitor "any|<monitor>[:fired|recovered|both]"` (`{monitor}`,
  `{level}`, `{what}`: information about monitoring; it never makes a monitor). Nothing to preview: it sends from now.
- A webhook destination gets every run as JSON (`report.table` with the rows, `report.message` with the text).

**Groups (a protocol's contracts together: compared, reported, monitored, kept complete)**
- `contract-dev group show <group>` — its contracts with their table values, the rules that fill it, its name
  pattern, its columns and group monitors.
- `contract-dev watch <address>=<Name>… --chain <id> --group <name> --about "<role>"` — watch several contracts into a
  group (a group is made on first use), each with its name: `0xae7a…fE84=stETH "0x889e…F9B1=Withdrawal Queue"` (quote
  one whose name has spaces). A bare address takes the explorer's name, often none for a proxy, so give names you
  hold. Each address is checked as it is watched: what is not a contract is skipped and listed.
- **Every watch says what it adds**: `--about "<one or two sentences on its role>"` on `watch`, `watch wallet` and
  `group rule add`, read from its source (`contract-dev source <contract>`), never from its name. It goes under the
  workspace's brief, after the names (or the group). Without `--about` an agent's watch is refused; `--no-about` is
  for a setup, which ends by writing the whole brief.
- `contract-dev factory <address> --chain <id> --event <Name> --field <arg> [--watch --group <name>]` — what a
  factory deployed, newest first, and with `--watch` each one watched into the group. A small factory is read
  whole; a big one (thousands of pools) is read back from now for about 20 seconds and says how far back it got,
  so its total is a lower bound.
- `contract-dev group add <group> <address|name>… [--chain <id>]` — watched contracts into a group, made if new; a
  contract can be in several groups (the protocol's, and one per chain or per kind beside it). `contract-dev group
  remove <group> <ref>…` takes them out, still watched, dropping only what the group gave them (its columns' readings,
  its monitors); a contract a rule added comes back on the rule's next pass.
- `contract-dev group rule add <group> --factory <address> --event <Name> --field <arg> --chain <id>` or
  `--registry <address> --function "getAllMarkets()"` — keep the group complete: what the factory deploys or the
  registry lists later joins by itself. `--name-pattern "{token0().symbol()}/{token1().symbol()} pool"` names
  what it finds.
- `contract-dev group column add <group> --label "Headroom" --call "assets=totalAssets()" --call "reserve=coverageLiquidity()"
  --formula "assets - reserve" --token "asset()" [--show usd]` — a FORMULA column: calls resolved on every member (a view,
  `balance(self)`, `slot(self, <key>)`), an expression over them and the group's other columns (`{Held} - {Required}`),
  one calculated value per member; `--formula "{Held} < {Required}"` is a yes/no column, which a count roll-up counts.
- `contract-dev group column add <group> --label "Total assets" --read "totalAssets()" --token "asset()" [--show usd]`
  — a column read on every contract of the group, refreshed every minute (a group monitor on it makes it a
  tracked value per contract, kept with history). `--token` states which token the
  reading is an amount of (an address, self, or a view each contract answers, like asset()); nothing is assumed, and
  without it the reading is the plain number.
- `contract-dev group monitor add <group> --name "High utilisation" --column utilisation --when "value > 95"` — one
  monitor per contract, judged on a column.
- `contract-dev group name-pattern <group> "<pattern>"` — how the group names its contracts from their own reads.

### Commands for the starter pack

- **Tracked numbers**, the protocol's headline values, each one command:
  `contract-dev track <address> function --function "<view>() returns (uint256)" --decimals 18 --label "<Name>"`
  (a token's supply is `--function "totalSupply() returns (uint256)"`; a treasury's balance of it is
  `contract-dev track <treasury> erc20-balance --token <token> --label "<Name>"`). A function call is never
  assumed to be a token amount, balanceOf included: give `--decimals` to scale it, or use `erc20-balance`.
  A value worked out from several views at one block is one calculated reading:
  `contract-dev track formula <contract> --label "<Name>" --call "pooled=getTotalPooledEther() decimals 18"
  --call "shares=getTotalShares() decimals 18" --value "pooled / shares"` (it reads the value now and prints it).
- **A signature metric from events** (what the protocol earns or what flows through it):
  `contract-dev metric define "<Name>" --group "<Protocol> <kind>" | <contract> --event <Event> [--read "<name>=<view>()"]…
  [--field "<name>=<expr>"]… --value "<expr>" --unit usd --description "<sentence>"` — `contract-dev metric define help` shows the
  expression language and a Uniswap v3 swap-fees example; an amount in native ETH is priced with
  `usd(amount, 0x0000000000000000000000000000000000000000)`. It saves at once; its history is indexed in the background.
- **Tables, two or three, chosen for what people look at.** Rows first, the busiest event with its dollars:
  `contract-dev table create "Swaps" --from events --group "<Protocol> pools" --event Swap --read "t0=token0()" --read "t1=token1()"
  --field "dollars=max(usd(abs(amount0), t0), usd(abs(amount1), t1))" --field "in0=amount(abs(amount0), t0)" --field "in1=amount(abs(amount1), t1)"
  --column time --column contract --column tx --column wallet --column dollars --sort time --description "<sentence>"`
  (a lending market's liquidations with who was liquidated, a vault's deposits and withdrawals, the same way; every
  amount priced in the token the source names for its field). Then a ranking built on that table, never made alone:
  `contract-dev table create "Top traders" --from "Swaps" --by wallet --measure volume="sum(dollars)" --measure swaps=count
  --sort volume --days 30 --description "<sentence>"`. Where the protocol's money moves with no event of its own (a
  treasury), a table over the ledger: `contract-dev table create "Outflows" --from transfers --contract Treasury --out --by
  counterparty --sum "{USD}" --days 30 --description "<sentence>"`.
- **An item table**, where the protocol has things that open and close (withdrawal rounds or requests, loans,
  proposals), with its amounts, what is still owed, where each row is and whether it needs attention:
  `contract-dev table create "<Rows>" --group "<Protocol> <kind>" | <contract> --opens <Event> --sum "<Event>.<field>:<Label> on <idField> token <token>"
  --formula "Outstanding=max({Requested} - {Paid}, 0); token <token>; show usd"
  --status "Stage: <Opt>=seen(<Event>); <Opt>=latest(<Event>); <Default>"
  [--status "Health: Overdue={Stage} == \"Expired\" and timeIn({Stage}) > 24h; Healthy"] [--finished "<rule>"] --description "<sentence>"`
  — `contract-dev table create help` has the rule language and a full Wildcat example. Each event's field that holds
  the row id is stated when more than one could (`on expiry` on a column, `--event WithdrawalBatchExpired.expiry` for an
  event a rule names, `--closes-on` for `--closes`): nothing is matched by name. State every amount's token:
  `token asset()` where each contract answers asset() with it, or the token's address where it does not
  (Lido's withdrawal queue counts stETH: `--sum "WithdrawalRequested.amountOfStETH:Requested token
  0xae7ab96520de3a18e5e111b5eaab095312d7fe84"`); without one an amount is shown as the chain holds it. A formula's own
  calls count in the formula's token (`--formula "Balance=bal; call bal=balanceOf(address) with id(); token asset(); show usd"`
  is a lender's balance in the market's asset) unless a call states `decimals <n>`. Then its open total:
  `contract-dev metric table "<Name>" --table "<Rows>" --column "<Label>" --among active`.
- **Last, the brief on the protocol:** `contract-dev workspace brief --file <path>` — a page of plain words from
  what this setup read and nothing from memory (see step 5 above). Later watches add their own line with `--about`;
  `contract-dev workspace brief "<text>" --append` adds anything else.

<!-- contract-dev:reference:start version=2026-10-30.10 -->
<!-- Written by `contract-dev skills install` from the server: the same guide the Slack and Telegram assistant reads. Edit it in the server's lib/agent/guide.ts, not here. -->

## Worked examples

The figures in them are made up; yours come from the tools.

- "How much did we make in fees last week?" → `contract-dev workspace` (the brief: fees are the Protocol fee revenue metric, the escrow's Credited event) → `contract-dev query metric "<name>"` on it, days 7, by day → "**$11.3k** in protocol fees, last 7 days (Protocol fee revenue: `Credited` on the fee escrow, each credit priced in its own token on its day). Read up to 25 Sep; later days are still being read."
- "Which tokens are hot?" → `contract-dev events <contract> --event <Name>` over the hook's fee-collected event by contract with the sum of dollars, days 7 → a five-row table (pool · fees · swaps), then "Fees paid to the hook, last 7 days; the top two are two thirds of it."
- "Biggest swap this month and who did it?" → `contract-dev events <contract> --event <Name>` on the pools, Swap, sorted by max(usd(abs(amount0), t0), usd(abs(amount1), t1)) with t0 = token0() and t1 = token1(), days 30 → "**$412k** WETH→PONS on PONS/WETH 0.3% on 14 Oct, by 0x9bb8…32ec (a Safe; signer 0x2a…). Last 30 days." A mint and burn of liquidity in one transaction is not a swap, however much it moved.
- "Is anything paused?" → `contract-dev query contracts` on the group with the read paused = paused() (and the protocol's own state views the source names) → "Nothing paused: 7 of 7 markets answer paused() = false as of 12:40 UTC; the factory's isStopped() is false too. Not checked: the oracle (it has no pause view)."
- "How are active wallets doing?" → `contract-dev query wallets` days 7 → "**1,284** active wallets, last 7 days, against 1,102 the 7 before (+17%); 412 of them new. Active = distinct signers."
- "How does the withdrawal queue work?" → `contract-dev source` on the queue without a function (its about, what it inherits, writeFunctions), then requestWithdrawals, finalize and claimWithdrawal read whole → plain words: a request locks the token and mints a claim; the oracle report finalizes requests up to a rate; a claim pays out at the lower of the request's rate and the finalization rate. "Read from the queue contract; the oracle's submit path was not read."
- The figure is still being read → "Still indexing: Buybacks has read to 27 Aug, nothing of the last 30 days yet. Ask again in about 12 minutes." No figure, not even a partial one.

## Setting things up

- Every monitor's rule is one formula, when, in the language of metrics and tables; there is no other way to write one. An event monitor (`contract-dev monitor add`): comparisons of the event's fields joined by and, one field's values joined by or (to == 0xA or to == 0xB), a token amount as amount(field, token) >= 50 and a dollar line as usd(abs(field), token) > 1000000, the token a 0x address, emitter() for the contract itself or a view like token0() that the source names for the field; a field compared without amount() or usd() is in base units. A tracked value (`contract-dev monitor add <value> --when "<formula>"`): value < 25000, value > {Other value} * 1.05, value < previous * 0.99 (never falls 1% in a step), value < ago(24h) * 0.8 (down more than 20% on a day ago; ago() up to 90 days). A group column (`contract-dev group monitor add`): value < 1000000, value > {Other column}. A metric (`contract-dev metric monitor`): value > 1000 on each record of an event metric; a window, total(1h) > 5000000 (a line), total(1h) > before(1h) * 1.1 (up more than 10% on the hour before; total(24h) < before(24h) * 0.5 is down by half), total(1h) > 3 * usual(1h, 7d) (three times a normal hour over the last week); value > 50000 on an item or group metric. warn is the same comparison nearer the healthy side. Nothing is read from a field's name.
- A monitor's threshold is in a token only when the formula names the field's token, never guessed from its name: "a deposit over 50,000 USDC" is amount(assets, asset()) > 50000 in when, the token the one the contract's source names for the field. An alert when one event is "worth more than $X" (a swap, a deposit, a withdrawal) is an event metric of that event's dollar size and an alert on it: `contract-dev metric define` with the size as its value, in the token the source names for each field (a swap: usd(abs(amount0), t0) with t0 = token0(), on a side the platform prices; a vault deposit: usd(assets, asset())), history 7 days unless the person wants more, reusing one the workspace already has (`contract-dev metric show` lists them); then `contract-dev metric monitor` with when value > X. When the token is one of the event's own fields (a lending pool's Withdraw names its reserve), `contract-dev monitor add` with when usd(amount, reserve) > X does both at once, reusing a metric that already prices it. Each event is priced at its own day's price in any token, and the same sizes chart and report. For a plain token amount, `contract-dev monitor add` with when usd(abs(field), token) > X, which turns the dollars into the token at today's price once. `contract-dev monitor add` saves at once and replays no history; how often a rule would have fired is a question for the events query with the same condition, never a replay. A monitor that turns out noisy or wrong is removed.
- "Let me know whenever", "every time", "tell me when" something happens is news, not trouble: an each-time report (`contract-dev report create` with cadence each), never a monitor. What it listens for is its trigger: an event on the scope's contracts (trigger {kind: event, event: "Swap", value: usd(amount0, token0())}: the report keeps an event metric of its own, off the lists), a method called (kind call, method: "transfer(address,uint256)", with a scope), a tracked value moving (kind value, with {value} and {prev}), a row of a table opening or finishing (kind row, table, on), a contract joining or leaving a group (kind member, group, on), or a monitor firing or recovering (kind monitor: information about monitoring, never a monitor made for the report). An event metric the workspace already has can be followed directly (metric + when). Give when only when the person says which ones ("over $10K": value >= 10000), a message in the person's words over what happened, and digestMinutes when they want them bundled ("every hour, the swaps"). It saves at once and sends on every new match from then on, never for the history; how many it would have sent is only for when the person asks, and only an event metric can say. Call it a report, not an alert: a monitor is for "alert me if", something wrong, with a level.
- "Every 10 minutes, the current buffer", "each hour, the open total": a scheduled report with cadence interval (`contract-dev report create`: everyMinutes, rows; compare false for the figures alone, onlyWhen to send only when a condition over the rows holds, like {Breached markets} > 0); everyMinutes is any whole number of minutes from 1 ("every minute") to a week. The columns are windows the person chooses, in order (columns: ["24h", "7d", "30d"] is the daily default, ["7d", "30d", "90d"] weekly, ["24h"] interval; any duration from 1m: "1m", "15m", "6h", "2w", "1y"); every row prints each, the change against the window before follows the first, and a column past the plan's history is refused. A row of kind formula carries the read grammar (calls as `contract-dev track formula` takes them and an expression; a token for dollars) on every contract in the scope, summed, so a value need not be tracked to be reported; in it, ago(call, window) is each column's own window, so "what the treasury's positions earned" is one row, shares * (rate - ago(rate, window)), that reads a week back in the 7d column and a month in the 30d one, its change column the window before. A webhook destination gets every report as JSON.
- A table in a report: "send me the top 10 wallets by volume every morning", "the 5 biggest swaps of the day in the daily report", "every Monday, our enclaves" is a scheduled report with tables (`contract-dev report create`, or `contract-dev tool run update_report` to add them to one that exists): each names a table of the workspace (`contract-dev table list`) and how each run asks it again: sort (a column, measure or expression, largest first; asc for smallest), limit (the rows sent, 10 when left out, 25 at most), days (how far back a table over transactions, transfers or events reaches: 1 for a daily report's day, 7 for a weekly one), where (on top of the table's own), columns. "Top wallets" is a table folded by wallet, "biggest swaps" a table of swaps sorted by their amount: when none fits, make the live table first, then the report on it. A report may be tables alone, with no rows; at most 3 tables. The figures (rows) are single numbers per window and never list things: anything per chain, per pool, per wallet or per row is a table.
- An each-time message names who acted as the protocol does. A swap's trader is the signer, {name(sender())}: the pool's own sender and recipient are routers. A supply, deposit, borrow, repay, withdrawal or liquidation usually names its account in the event: which parameter it is, you read from the contract's source (where the event is emitted), never from its name alone, and say which you used; the signer only when the person asks who sent it, or when the source does not settle it. A figure the person asks about ("how much", "which asset") is the amount in its token, its symbol and its dollars: {amount(assets, t)} {symbol(t)} ({usd(assets, t)}), t a read like asset() or the token the event names; a usd() figure prints as dollars by itself.
- Uniswap-style swaps: amount0 and amount1 are signed, positive into the pool, so amount0 > 0 means the trader paid token0 (sold it): say which way ({if(amount0 > 0, "sold", "bought")} {symbol(t0)}). The fee is charged on the token paid in: fee = fee() read once, fee_usd = if(amount0 > 0, usd(amount0 * fee / 1000000, t0), usd(amount1 * fee / 1000000, t1)). A Curve-style exchange names its coins by index: coins(sold_id) and coins(bought_id) as reads, the amounts tokens_sold and tokens_bought. The chain's own coin (ETH staked with Lido, an ETH transfer) is the token 0x0000000000000000000000000000000000000000: 18 decimals, priced as its wrapped token.
- In the reply, quote only what the tools returned: the count, the window, the examples as they read, the largest figures. No figure the tools did not give, and no claim about where the conversation is happening beyond what this conversation says.
- Several events on one contract or one group are one `contract-dev monitor add` each in chat, one command with several --event flags in the CLI. "Any of our pools" or "every market" is one monitor per contract: pass the group, not a contract.
- Never guess a threshold the person asked for and did not give: ask, offering a round one from the protocol's size as the default.
- An event metric is defined exactly as the person asks: which events, what each one adds and in which unit, per contract or in total. A count of events (rounds run, swaps made) is aggregate count with no value, never a value of 1 added up (it reads back as "sum of 1"). Every metric takes a description, one sentence in the person's own words saying what it measures ("Dollars bridged out through the DZap routers, priced on the day"), and a split by a field takes its line, what one line is as the person would say it ("an integrator", "a wallet"). aggregate latest reads a LEVEL off the events, each split's newest value carried forward and the splits added up, so the figure is the value now, never a sum over the period: for an event that carries a balance or a total, not an amount moved. It saves at once and reads its history in the background; when a part is unclear, ask.
- A silence monitor (`contract-dev monitor add` with silence and for) looks back its whole window from its first check, the time before it was made included: a contract already quiet that long alerts at once. Every other monitor judges only what happens after it is made.
- A failures monitor (`contract-dev monitor add` with mode failures) is the alert for "tell me when our swaps through a provider start failing": each minute it counts the contract's direct calls over its window (for, an hour unless said) from the activity ledger, the failed ones and their share, per value of by when given (args.swapExecutionData[0].dex judges each provider on its own, method each method), over the rows that count (rows, a where over the transactions' columns and {args.<path>}: {method} == "swap"); when is a rule over failed, total and share ("failed >= 5 and share > 0.5" unless said). A single failure is never an alert: the rule is over counts, so a user's slip (slippage, an expired quote, a missing approval) does not page anyone, and a provider failing every call does within a minute. Its episode carries the counts and the last reason (revert).
- Read the group before adding anything to it (`contract-dev group show`: its contracts, rules, columns and monitors), so nothing is made twice.
- Alerts on an event metric (`contract-dev metric monitor`): a condition on each new record ("any single swap fee over $1,000": value > 1000) or a window ("fees over an hour above $50,000": total(1h) > 50000; "more than 3× the usual hour over the last 7 days": total(1h) > 3 * usual(1h, 7d); "up 50% on the day before": total(24h) > before(24h) * 1.5). Take every part from the person: the window, the comparison and its number, per contract or in total, and where it pages; it refuses a missing part rather than guess one.
- A number over a table's rows over time ("the total outstanding across open withdrawal rounds"): `contract-dev metric table`, recorded each minute from when it is made with its past read back where the table can say it, in dollars when the column counts in a token.
- Every label is a column header, so it is short: one to three words, only what tells it apart from its neighbours (Fees token0, not Protocol fees token0; Held, not Total assets held). Leave out what the group, table or contract already names and any unit: a token amount shows its symbol beside each figure. This holds for group columns, table columns and formulas, report rows and tracked values alike.
- A number across a group's contracts over time ("total held across the Wildcat markets"): first the read as a column of the group (`contract-dev group column add`: totalAssets() on every market), then the column rolled up (`contract-dev metric group`), each contract priced in its own asset; per-contract rules stay on the column (`contract-dev group monitor add`). A number worked out per contract ("headroom: held minus required", "utilisation", "is the market breached") is a FORMULA column of the group (`contract-dev group column add` with calls and formula): calls resolved on every member, an expression over them and the group's other columns by {Label}; a yes/no column's count roll-up counts the yeses.
- ONE READ GRAMMAR everywhere (a calculated tracked value, a group's formula column, a table's formula, an event metric's reads): CALLS, each named, each a view (totalAssets(), getFee(address) with arguments), a coin balance (balance(self), balance(0x…)), or one storage word (slot(self, 7); slot(self, keccak(<key>, 3)) for a mapping entry); then an EXPRESSION over the calls' names and the host's other columns: arithmetic (^ with any exponent), min/max/abs/round/sqrt/ln/exp/if, comparisons for a yes/no, usd(x, <token>) and amount(x, <token>) through a stated token only (its 0x address, or a call that answers one), keccak(…), and lists when a view returns an array (owners[1], owners[indexOf(owners, x)], len(), sum(), contains()). A target is self, a 0x address, or a view the contract answers with one (asset(), token0()); an argument is a literal, self, or the host's own: on an item table's row, id() and any of the row's cells by label ({Trader}, {Pair}: an event column keeping a field as it was emitted, another read, a formula) and the formula's other calls by name; on a group's member, an attribute column ({Asset}, read once). As many arguments as the view takes, lists included. Nothing is guessed: a token is stated or the value is the plain number. usd() and amount() take a BASE-UNIT amount (an event field, a call read without decimals); a call read with decimals is already in token units, so its dollars are the call times price(token), and usd() over it is refused.
- A value worked out from several reads at the same block on one contract ("the free buffer: buffer minus debt", "assets per share", "the vault's ETH plus its USDC in dollars"): `contract-dev track formula`, saved at once; it is then charted, reported and monitored like any tracked value. A call can also be read as it was a while before the value's block, with ago(call, 7d) (1m to 365d): a staking token's trailing yield is (rate - ago(rate, 7d)) / ago(rate, 7d) * 365 / 7 * 100 over its rate view (stEthPerToken(), getRate(), convertToAssets(1e18)), so a leveraged position's net yield can count the intrinsic yield its lending rates leave out. Every value says what it is in, or it prints as a bare number: a price, a market cap or fees in dollars (the value written as usd(…), or unit usd), a share in % (unit %, or a label that writes %: Burned %), a token amount in its symbol (amount(raw, 0x…), or unit PONS). usd() and amount() take a base-unit amount: a call read with decimals is already in token units, so its dollars are the call times price(token) (shares * rate * price(0x…)), never usd() over it, which the formula refuses.
- A factory's children are the protocol's ESTATE or its PRODUCT, and `contract-dev factory` says which first (its pace: children in the last 7 days). Estate (vaults, markets, pools: bounded, a few a week, each something the team runs): `contract-dev group rule add` on the group, stating the factory's creation event and its address argument that is the new contract (read the factory's source; nothing is picked from names), adds every contract the factory has ever made, in the background, however many (thousands take a while), then each new one; for a few hundred or fewer, also `contract-dev factory` with watch so they are in the group now, and never leave an estate's children out because there are many. Product (a launchpad's tokens and pools, a token factory, a pump-style curve: more than 25 a week, most dead within a day): no group and no rule, which the tool refuses; watch the factory, what holds or receives its fees (lockers, fee vaults, routers) and the protocol's token, loose; an item table keyed by the child from the creation event (`contract-dev table create` with opens that event and id its address field: every child ever made, reads on :id, status columns like graduated or locked), monitors on the table's columns (`contract-dev tool run add_table_monitor`) and on the factory's and lockers' events, metrics over those events (launches, graduations, fees). Per-pool alerts go on the pools that matter, not on every one. A rule that should stop adding (the factory outgrew the plan, the wrong event) comes off with `contract-dev tool run delete_watch_rule`; the contracts it added stay until unwatched.
- A contract already watched joins a group with `contract-dev group add <group> <a> <b>…` (a contract can be in several: the protocol's and one per chain, or one per kind) and leaves it with `contract-dev group remove <group> <a> <b>…`, staying watched; `contract-dev unwatch <a> <b>…` is for one gone from the workspace altogether.
- Every watch says what it adds to the protocol: `--about "<role>"` on `contract-dev watch`, `watch wallet` and `group rule add`, one or two sentences on its role read from its source (`contract-dev source`), never from its name; it is added to the workspace's brief under the names of what was watched (or the group), so the next conversation knows it. A setup watches with `--no-about` instead, since it ends by writing the whole brief; otherwise skip it only when the person asks. Anything else worth adding (a mechanism, a correction) is `contract-dev workspace brief` with append, which never touches what a person wrote; the whole brief is replaced only in a setup or when the person asks for a rewrite.
- A contract with no ABI (never verified on Etherscan, or on a chain with no explorer: Ink, Scroll, ZKsync and the like) still watches, shows its activity and answers a read given its full signature, but nothing can be built on its events: a metric, table or monitor on it answers "Events they declare: none" or "No ABI is known", and `contract-dev describe` lists no events. Its events are never guessed from a common shape (Transfer, Deposit). When `contract-dev watch` says no ABI was found, or what was asked needs a contract's events, get its ABI first: look for it in the project you are working in, the contract's own build output (Foundry `out/<File>.sol/<Contract>.json`, Hardhat `artifacts/contracts/<File>.sol/<Contract>.json`), and set that file as it is with `contract-dev contracts set-abi <address> --chain <chain> --abi <file>` (or `--abi <file>` on `contract-dev watch`); with no project at hand, or no build of that contract in it, ask the person for the ABI file and set it the same way. Then do what was asked.

## Packs by kind

Definitions known to be right; copy, do not invent.

- DEX pools (Uniswap v3-style): volume per pool is `contract-dev events <contract> --event <Name>` over Swap by contract with the sum of max(usd(abs(amount0), t0), usd(abs(amount1), t1)), t0 = token0() and t1 = token1(); fees in dollars are the swap-fee metric (fee() read once, charged on the token paid in: amount0 > 0 means token0 was sold); large swaps a metric of the swap's dollar size with an alert on it. A Curve-style exchange names its coins by index: coins(sold_id) and coins(bought_id), the amounts tokens_sold and tokens_bought. No item table: a pool has no row id; its tables are its swaps as rows (`contract-dev table create "<name>" --from events --group <g> --event <E> --description "<sentence>" [--field "<name>=<expr>[ on <Event>]"]… [--pair "<Event> on <field>"]… [--keep <param>…] [--column <name>]… [--detail <name>]… [--status "<Label>: <Opt>=<rule>; <Opt>"]…` with the query's flags (the events kept as rows underneath, off the Metrics page, gone with the table)) and top traders built on them.
- Launchpads and token factories: the factory, its lockers, fee escrows or vaults and the protocol's token watched loose; a table of launches opened by the creation event, keyed by the new token's address field, with reads on it (graduated, locked); launch fees and protocol fees as metrics over the escrow's credit event, each amount priced in the token the event names for it (usd(amount, token)): the quote assets differ pool by pool, so one fixed token (ETH) misprices them; buybacks the same way; hot tokens the fee-collected or swap event by pool; graduations a count. The protocol's own token, the quote assets (WETH, USDC, a stable) and the launched tokens are three different things in every answer.
- Lending markets: utilisation as a formula over the market's views (borrowed / supplied), liquidations as a metric priced in the collateral the event names (usd(liquidatedCollateralAmount, collateralAsset)), large borrows and withdrawals as alerts on their dollar size, bad debt or delinquency as a group column with an alert on value > 0. What a market holds is not what lenders have in it: deposits are lent out.
- Vaults (ERC-4626): share price as a formula, convertToAssets(1e18) / 1e18; large withdrawals usd(assets, asset()); a share price falling between readings as an alert (value < previous * 0.99).
- Staking and withdrawal queues: the requests as a table (opened by the request event, closed by the claim, the last finalized id read), what is outstanding as an item metric, an oracle report going quiet as a silence alert (only where a contract must never go quiet). Requests are often in one token and claims paid in another: say which.
- Governance: proposals as a table (Scheduled → Ready → Executed | Cancelled); emergency actions and control changes (Upgraded, Paused, AdminChanged, OwnershipTransferred) as alerts.
- Aggregator and bridge routers (DZap-style): one group per contract across chains; a router's placeholder for the native coin in a token field (0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE) prices and scales as the native coin as it is; a batch swap's parts are lists, one row that opens onto them; the integrator of a bridge sits on the paired event of the same transaction (pair on its transaction id). A Wildcat-style market names its lender in the event's account field, never the signer.

<!-- contract-dev:reference:end -->

## Vocabulary

- Report row kinds (`report --row`, `get_metrics` rows): `activeWallets`, `transactions`, `revertedShare`,
  `volumeInUsd`, `volumeOutUsd`, `alertsOpened`, `eventCount:<event>`, `trackedMetric:<id|label>`,
  `customMetric:<name>`, and `"formula:<Label>=<expr>; call <name>=<call>…; token <t>; show usd"` (the read
  grammar on every contract in the scope, summed, with its change against the start of the window; `ago(<call>, window)`
  in it is each column's own window, so "what the positions earned" is one row: `sh * (rate - ago(rate, window))`).
- Activity (`query transactions|transfers|wallets`, the activity ledger): `--by` takes `day`, `contract`, `wallet`,
  `who`, `via`, `method`, `status`, `chain` on transactions; `day`, `token`, `direction`, `counterparty`, `who`,
  `wallet`, `contract`, `chain` on transfers; `status`, `who`, `contracts` on wallets; with `--count` or
  `--sum|--avg|--min|--max "<expr>"` (`--sum "{USD}"`). Rankings of activity are these queries by contract;
  anything about a contract's own events is `events`. `--days <n>` is the window, up to the plan's (7 days on
  Free, 90 days on Team); the answer says where the ledger's history starts for the scope.
- Windows: `24h`, `7d`, `30d`, `90d` (`--range`); `events --window` also takes `1h` and `365d`, `history --window` `all` and `1y`; a window past the plan's history (7 days on Free, 90 days on Team) is served as the widest that fits.
- Scope: the workspace (default), `--group <name>`, `--contract <address|name>`, `--chain <id|name>`;
  reports take `--scope workspace|tag:<group>|<contract>`.
- The chain is always said. An address is on every chain, so nothing defaults to Ethereum: `watch`, `watch wallet`
  and `block` take `--chain` every time; `address`, `track` and a group rule take the chain a watched contract is on
  and refuse anything else without `--chain`; a `tx` hash is looked up on every chain. Pass `--chain` whenever you
  know it (it is in the protocol's address list).
- An alert's `--when` is one formula: `==`, `!=`, `>`, `>=`, `<`, `<=` joined by `and`, one field's values joined
  by `or` (`to == 0xA or to == 0xB`); a field is in base units unless the formula names its token
  (`amount(assets, asset()) >= 12500`, `usd(abs(amount0), token0()) > 1000000`, or a token field of the event:
  `usd(amount, reserve) > 25000000`).
